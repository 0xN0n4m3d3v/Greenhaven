"""Markdown exporter from a Cartridge Forge project to the human Obsidian
``GreenHavenWorld/`` folder layout.

OWV-11 — three operating modes:

* ``diff``  — write only ``.greenhaven-agent-manual/generated/export-diff.md``
              describing what would change (create / update / conflict /
              unplaced). The visible vault is not touched.
* ``stage`` — write proposed files only under
              ``.greenhaven-agent-manual/generated/export-staging/``. The
              visible vault is not touched.
* ``write`` — write visible notes. Requires the explicit safety flag
              ``--allow-write``. A target file is overwritten only when (a)
              it does not currently exist, or (b) its current SHA-256 hash
              matches the last hash this exporter recorded for that path
              (i.e. the writer has not edited the file by hand since the
              last export). All other targets are skipped and reported as
              ``conflict`` so writer edits are never silently overwritten.

Visible Markdown is prose only. The exporter prefers ``payload.source_path``
and ``payload.source_markdown`` from the Forge records (which the
``compile_vault_to_forge.py`` pipeline already captured straight from the
authored notes). When those are missing or unsafe, the exporter falls back to
a placement derived from kind / slugs / location_slug, and a minimal
prose-only template that mirrors the donor TS exporter in
``packages/web-server/src/scripts/obsidian-roundtrip-smoke.ts``.

Usage::

    python export_cartridge_to_vault.py \\
        --source ../generated/cartridge-forge-project \\
        --vault-root C:\\Greenhaven\\GreenhavenWorld \\
        --mode diff
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

try:
    # When invoked as a module (`python -m ...`) or with the scripts/
    # directory on ``sys.path`` (which is the default when running the
    # file directly) ``vault_scan`` is importable. We reuse its helpers
    # for slug + write_text + default_vault_root.
    from vault_scan import (  # type: ignore[import-not-found]
        default_vault_root,
        get_slug,
        write_text,
    )
except ImportError:  # pragma: no cover - exercised only when the path is missing
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from vault_scan import default_vault_root, get_slug, write_text  # type: ignore[import-not-found]


RECORD_KINDS = (
    "locations",
    "npcs",
    "items",
    "quests",
    "scenes",
    "world-facts",
)


@dataclass(frozen=True)
class ExportPlan:
    """A planned export for one record.

    ``status`` is one of ``create`` / ``update`` / ``conflict`` /
    ``unplaced``. ``conflict`` only fires in write mode — diff and stage
    modes describe the intent without inspecting writer-edited content.
    """

    record_id: str
    kind: str
    slug: str
    display: str
    target: str
    content: str
    status: str
    note: str = ""


@dataclass
class ExportContext:
    """Loaded Forge project: records keyed by slug + the `forge.project.json`."""

    project: dict[str, object]
    records: list[dict[str, object]]
    records_by_slug: dict[str, dict[str, object]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for record in self.records:
            slug = str(record.get("slug") or "").strip()
            if slug:
                self.records_by_slug.setdefault(slug, record)


# ---------------------------------------------------------------------------
# Filename / folder helpers (mirror the donor TS `obsidian-roundtrip-smoke.ts`)
# ---------------------------------------------------------------------------


_BAD_FILENAME_CHARS = '<>:"/\\|?*'


def safe_file_name(name: str) -> str:
    """Strip filesystem-hostile characters and collapse whitespace.

    Apostrophes are intentionally preserved so vault notes like
    ``@Thief's market`` stay readable on disk.
    """

    cleaned = "".join(
        ch for ch in name if ch not in _BAD_FILENAME_CHARS and ord(ch) >= 0x20
    )
    return " ".join(cleaned.split()).strip()


def at_folder(name: str) -> str:
    raw = name.lstrip("@")
    return f"@{safe_file_name(raw)}"


def at_file(name: str) -> str:
    return f"{at_folder(name)}.md"


def mind_file(name: str) -> str:
    """Build the canonical ``XyzMind.md`` filename for an entity note.

    Mirrors the donor TS: collapse non-alphanumeric runs, title-case each
    surviving word, and concatenate. ``@Mikka`` → ``MikkaMind.md``;
    ``@Thief's market`` → ``ThiefsMarketMind.md``.
    """

    stem_raw = name.lstrip("@")
    parts: list[str] = []
    current: list[str] = []
    for ch in stem_raw:
        if ch.isalnum():
            current.append(ch)
        else:
            if current:
                parts.append("".join(current))
                current = []
    if current:
        parts.append("".join(current))
    stem = "".join(part[0].upper() + part[1:] for part in parts if part)
    return f"{stem or 'Entity'}Mind.md"


def to_posix(value: str) -> str:
    return value.replace("\\", "/")


VAULT_ROOT_SEGMENT = "GreenHavenWorld"
VAULT_ROOT_PREFIX = f"{VAULT_ROOT_SEGMENT}/"


def is_safe_vault_path(relative: object) -> bool:
    """Return True when ``relative`` is a *vault-relative* path that
    points inside ``GreenHavenWorld/`` with no traversal.

    The previous implementation used ``relative.lstrip("./")`` for
    "normalization", which silently stripped leading ``../`` or ``./``
    sequences and let bypasses like ``../GreenHavenWorld/foo.md`` or
    ``./../GreenHavenWorld/foo.md`` pass as "safe" — the stripped
    prefix happened to start with the canonical root. This is a
    full segment-by-segment validator: every part must be a real
    non-empty filename, and no segment may be ``..``. Absolute paths,
    Windows drive letters, and UNC roots are rejected outright.
    """

    if not isinstance(relative, str) or not relative:
        return False
    # Reject Windows drive letters and UNC prefixes in the raw input
    # *before* we normalize backslashes to slashes, otherwise the
    # backslash run could be split into segments that pass the per-
    # segment check.
    if len(relative) >= 2 and relative[1:2] == ":":
        return False
    if relative.startswith("\\\\") or relative.startswith("//"):
        return False
    posix = to_posix(relative)
    # Reject absolute paths in either flavour.
    if posix.startswith("/"):
        return False
    parts = posix.split("/")
    if not parts:
        return False
    # Every segment must be a real, non-empty filename. Reject `.`,
    # `..`, empty segments, and segments that still contain a colon
    # or backslash after normalization (defensive — should not happen
    # after `to_posix`).
    for part in parts:
        if part in ("", ".", ".."):
            return False
        if ":" in part or "\\" in part:
            return False
    # Finally, the canonical root segment must be at the *front*.
    return parts[0] == VAULT_ROOT_SEGMENT


def is_within_root(target: Path, root: Path) -> bool:
    """Return True when ``target`` resolves to a path inside ``root``.

    Defense-in-depth: even if a future change produced an unsafe
    ``ExportPlan``, ``write_staging`` / ``perform_write`` use this
    helper to refuse the write. ``Path.resolve`` normalizes ``..``
    so any traversal is exposed before any filesystem touch.
    """

    try:
        resolved_target = target.resolve(strict=False)
        resolved_root = root.resolve(strict=False)
    except (OSError, ValueError, RuntimeError):
        return False
    if resolved_target == resolved_root:
        return True
    try:
        return resolved_target.is_relative_to(resolved_root)
    except AttributeError:  # pragma: no cover - Python < 3.9
        try:
            resolved_target.relative_to(resolved_root)
            return True
        except ValueError:
            return False


# ---------------------------------------------------------------------------
# Forge project IO
# ---------------------------------------------------------------------------


def load_project(source: Path) -> ExportContext:
    project_path = source / "forge.project.json"
    if not project_path.exists():
        raise FileNotFoundError(f"forge.project.json not found in {source}")
    project = json.loads(project_path.read_text(encoding="utf-8"))

    records: list[dict[str, object]] = []
    records_dir = source / "records"
    for kind in RECORD_KINDS:
        file = records_dir / f"{kind}.jsonl"
        if not file.exists():
            continue
        with file.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                records.append(json.loads(line))
    return ExportContext(project=project, records=records)


# ---------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------


def _payload(record: dict[str, object]) -> dict[str, object]:
    payload = record.get("payload")
    return payload if isinstance(payload, dict) else {}


def _str_field(record: dict[str, object], key: str) -> str | None:
    value = _payload(record).get(key)
    if isinstance(value, str) and value.strip():
        return value
    return None


def _display(record: dict[str, object]) -> str:
    name = (
        record.get("canonical_name")
        or _str_field(record, "canonical_mention")
        or record.get("slug")
        or "Entity"
    )
    if isinstance(name, str):
        return name.lstrip("@") or "Entity"
    return "Entity"


def _location_folder(record: dict[str, object], ctx: ExportContext) -> str:
    """Return the canonical folder for a *location* record.

    Walks ``payload.parent_slug`` recursively so districts nest correctly
    (e.g. ``Locations/@City of Greenhaven/@Town square``).
    """

    if record.get("kind") != "location":
        return f"GreenHavenWorld/Locations/{at_folder(_display(record))}"
    existing = _str_field(record, "source_path")
    if existing and is_safe_vault_path(existing):
        return to_posix(existing).rsplit("/", 1)[0]
    parent_slug = _payload(record).get("parent_slug")
    parent = (
        ctx.records_by_slug.get(parent_slug)
        if isinstance(parent_slug, str)
        else None
    )
    parent_folder = (
        _location_folder(parent, ctx) if parent else "GreenHavenWorld/Locations"
    )
    return f"{parent_folder}/{at_folder(_display(record))}"


def _location_record_for(slug: object, ctx: ExportContext) -> dict[str, object] | None:
    if not isinstance(slug, str) or not slug:
        return None
    candidate = ctx.records_by_slug.get(slug)
    if candidate and candidate.get("kind") == "location":
        return candidate
    return None


def note_path_for(record: dict[str, object], ctx: ExportContext) -> str | None:
    """Compute the visible ``GreenHavenWorld/...`` path for one record.

    Returns ``None`` for records that can't be placed (e.g. a free-floating
    quest with no giver / start location). Those land in the ``unplaced``
    diff bucket.
    """

    payload = _payload(record)
    existing = payload.get("source_path")
    if isinstance(existing, str) and is_safe_vault_path(existing):
        return to_posix(existing)

    display = _display(record)
    kind = record.get("kind")

    if kind == "location":
        return f"{_location_folder(record, ctx)}/{mind_file(display)}"

    if kind == "person":
        home = _location_record_for(payload.get("home_slug"), ctx)
        folder = _location_folder(home, ctx) if home else "GreenHavenWorld/NPC"
        return f"{folder}/npc/{at_folder(display)}/{mind_file(display)}"

    if kind == "item":
        item_kind = payload.get("item_kind")
        if isinstance(item_kind, str) and item_kind.lower() == "currency":
            return (
                f"GreenHavenWorld/Economy/items/{at_folder(display)}/"
                f"{mind_file(display)}"
            )
        location = _location_record_for(payload.get("location_slug"), ctx)
        folder = (
            _location_folder(location, ctx) if location else "GreenHavenWorld/items"
        )
        return f"{folder}/items/{at_folder(display)}/{mind_file(display)}"

    if kind == "quest":
        giver_slug = payload.get("giver_slug")
        giver = ctx.records_by_slug.get(giver_slug) if isinstance(giver_slug, str) else None
        if giver and giver.get("kind") == "person":
            giver_path = note_path_for(giver, ctx)
            if giver_path:
                folder = to_posix(giver_path).rsplit("/", 1)[0]
                return f"{folder}/quests/{safe_file_name(display)}.md"
        location = _location_record_for(payload.get("start_location_slug"), ctx)
        folder = (
            _location_folder(location, ctx) if location else "GreenHavenWorld/quests"
        )
        return f"{folder}/quests/{safe_file_name(display)}.md"

    if kind == "scene":
        owner_slug = payload.get("owner_npc_slug")
        owner = ctx.records_by_slug.get(owner_slug) if isinstance(owner_slug, str) else None
        if owner and owner.get("kind") == "person":
            owner_path = note_path_for(owner, ctx)
            if owner_path:
                folder = to_posix(owner_path).rsplit("/", 1)[0]
                return f"{folder}/scenes/{at_file(display)}"
        location = _location_record_for(payload.get("location_slug"), ctx)
        folder = (
            _location_folder(location, ctx) if location else "GreenHavenWorld/scenes"
        )
        return f"{folder}/scenes/{at_file(display)}"

    if kind == "world_fact":
        if "currency" in display.lower():
            return "GreenHavenWorld/Economy/Currency.md"

    return None


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


def render_note(record: dict[str, object]) -> str:
    """Return the prose Markdown body for a record.

    Strong preference for the authored ``source_markdown`` captured at
    import time. Falls back to a minimal prose template (title + summary)
    so freshly-AI-generated records without source markdown still produce
    reviewable Obsidian notes.
    """

    source_md = _str_field(record, "source_markdown")
    if source_md:
        return source_md.rstrip() + "\n"

    display = _display(record)
    lines: list[str] = [f"# @{display}", ""]

    summary = record.get("summary")
    if isinstance(summary, str) and summary.strip():
        lines.extend([summary.strip(), ""])

    canon = _str_field(record, "location_canon") or _str_field(record, "item_canon")
    if canon:
        lines.extend(["## Canon", "", canon.strip(), ""])

    description = (
        _str_field(record, "description")
        or _str_field(record, "item_description")
        or _str_field(record, "narrator_brief")
    )
    if description:
        lines.extend(["## Description", "", description.strip(), ""])

    return "\n".join(lines).rstrip() + "\n"


def render_manifest(records: Iterable[dict[str, object]]) -> str:
    """Render a small ``WORLD_MANIFEST.md`` overview for the diff bucket.

    Always returns a single deterministic string so the staged output is
    stable across repeated runs.
    """

    counts: dict[str, int] = {}
    for record in records:
        kind = str(record.get("kind") or "unknown")
        counts[kind] = counts.get(kind, 0) + 1
    lines = ["# Cartridge Forge export manifest", ""]
    for kind in sorted(counts):
        lines.append(f"- {kind}: {counts[kind]}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Hash-based conflict guard
# ---------------------------------------------------------------------------


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_store_path(vault_root: Path) -> Path:
    return (
        vault_root
        / ".greenhaven-agent-manual"
        / "generated"
        / "export-hashes.json"
    )


def load_hash_store(vault_root: Path) -> dict[str, str]:
    path = hash_store_path(vault_root)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(v, (str, int))}


def save_hash_store(vault_root: Path, store: dict[str, str]) -> None:
    path = hash_store_path(vault_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(dict(sorted(store.items())), ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
        newline="\n",
    )


# ---------------------------------------------------------------------------
# OWV-16: hidden roundtrip-state artifacts
# ---------------------------------------------------------------------------


ROUNDTRIP_DIRNAME = "roundtrip-state"


def roundtrip_state_dir(vault_root: Path) -> Path:
    """Hidden directory that holds every machine-only roundtrip artifact.

    The exporter never reads or writes inside the visible
    ``GreenHavenWorld/`` tree here — every output is under
    ``.greenhaven-agent-manual/generated/roundtrip-state/``.
    """

    return (
        vault_root
        / ".greenhaven-agent-manual"
        / "generated"
        / ROUNDTRIP_DIRNAME
    )


def note_hashes_path(vault_root: Path) -> Path:
    return roundtrip_state_dir(vault_root) / "note-hashes.jsonl"


def render_note_hashes_jsonl(
    plans: Iterable[ExportPlan],
    project: dict[str, object],
    exported_at: str,
) -> str:
    """Render one JSONL line per plan with the OWV-16 contract fields.

    Stable sort by ``target`` then ``record_id`` so repeated runs over
    the same project produce byte-identical files (good for grep, good
    for diffs, good for the eventual git review).
    """

    project_slug = str(project.get("project_slug") or "")
    rows: list[dict[str, object]] = []
    for plan in plans:
        rows.append(
            {
                "target": plan.target,
                "record_id": plan.record_id,
                "kind": plan.kind,
                "slug": plan.slug,
                "generated_hash": sha256_text(plan.content) if plan.content else "",
                "source_project": project_slug,
                "status": plan.status,
                "exported_at": exported_at,
            }
        )
    rows.sort(key=lambda row: (str(row.get("target") or ""), str(row.get("record_id") or "")))
    return "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows
    )


def render_conflicts_report(plans: Iterable[ExportPlan]) -> str:
    """Human-readable list of writer-side conflicts that block a write.

    Conflicts come from two sources: a real writer edit that diverges
    from the recorded export hash, and a duplicate target path where
    two records would land on the same file. Both require a human
    decision before write mode can proceed.
    """

    conflicts = sorted(
        (plan for plan in plans if plan.status == "conflict"),
        key=lambda plan: (plan.target, plan.record_id),
    )
    lines = ["# Roundtrip conflicts", ""]
    if not conflicts:
        lines.append("- none")
        return "\n".join(lines).rstrip() + "\n"
    lines.append(
        "Each entry below requires a human decision before the exporter "
        "is allowed to overwrite the visible note."
    )
    lines.append("")
    for plan in conflicts:
        reason = plan.note or "writer-edited since last export"
        lines.append(
            f"- **{plan.target}**"
            f" — record `{plan.record_id}`"
            f" ({plan.kind} `{plan.slug}`); reason: {reason}."
        )
        lines.append(
            "  - Resolution: review the writer's edit, fold any keepers "
            "into the source record, then re-run export."
        )
    return "\n".join(lines).rstrip() + "\n"


def render_orphaned_report(plans: Iterable[ExportPlan]) -> str:
    """Forge/DB records the exporter could not place under a vault home.

    Surfaced explicitly so the writer knows *something* came out of the
    cartridge that the human folder layout has no slot for — for
    example a quest with no NPC parent and no start location, or a
    free-floating world fact with no canonical home.
    """

    orphans = sorted(
        (plan for plan in plans if plan.status == "unplaced"),
        key=lambda plan: (plan.kind, plan.slug),
    )
    lines = ["# Orphaned DB / Forge records", ""]
    if not orphans:
        lines.append("- none")
        return "\n".join(lines).rstrip() + "\n"
    lines.append(
        "These cartridge records exist but have no canonical vault path."
        " The exporter never writes them; review and either add the "
        "missing parent (NPC / location / item) or accept that the "
        "record stays runtime-only."
    )
    lines.append("")
    for plan in orphans:
        reason = plan.note or "no placement rule"
        lines.append(
            f"- **{plan.kind}** `{plan.slug}` "
            f"(record `{plan.record_id}`): {reason}."
        )
    return "\n".join(lines).rstrip() + "\n"


def render_deleted_note_candidates(
    plan_targets: set[str],
    hash_store: dict[str, str],
    vault_root: Path,
) -> str:
    """Notes previously tracked by the hash store that the current plan
    no longer references.

    These are *candidates* — the exporter never deletes a visible note
    or a DB row on their basis. The report exists so the writer can
    review the disappearance: it might be a real deletion (a quest
    archived, a scene retired) or an accidental rename. Either way,
    the decision belongs to a human.
    """

    candidates = sorted(set(hash_store.keys()) - plan_targets)
    lines = ["# Deleted-note candidates", ""]
    if not candidates:
        lines.append("- none")
        return "\n".join(lines).rstrip() + "\n"
    lines.append(
        "These vault notes were tracked by a previous export but no "
        "Cartridge Forge record currently points at them. The exporter "
        "never deletes anything on their basis; review each entry and "
        "decide whether to delete the visible note, restore the missing "
        "Forge record, or archive both."
    )
    lines.append("")
    for target in candidates:
        abs_target = vault_root / target
        still_on_disk = abs_target.exists()
        suffix = "" if still_on_disk else " (already removed from disk)"
        lines.append(f"- `{target}`{suffix}")
    return "\n".join(lines).rstrip() + "\n"


def write_roundtrip_state(
    plans: list[ExportPlan],
    project: dict[str, object],
    vault_root: Path,
    hash_store: dict[str, str],
    *,
    exported_at: str | None = None,
) -> Path:
    """Write every OWV-16 artifact under the roundtrip-state directory.

    Returns the directory path. The visible vault is *never* touched
    here: every file produced lives under
    ``.greenhaven-agent-manual/generated/roundtrip-state/``.
    """

    state_dir = roundtrip_state_dir(vault_root)
    timestamp = exported_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_text(
        state_dir / "note-hashes.jsonl",
        render_note_hashes_jsonl(plans, project, timestamp),
    )
    write_text(
        state_dir / "conflicts.md",
        render_conflicts_report(plans),
    )
    write_text(
        state_dir / "orphaned-db-records.md",
        render_orphaned_report(plans),
    )
    plan_targets = {plan.target for plan in plans if plan.target}
    write_text(
        state_dir / "deleted-note-candidates.md",
        render_deleted_note_candidates(plan_targets, hash_store, vault_root),
    )
    return state_dir


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


def plan_exports(
    ctx: ExportContext,
    vault_root: Path,
    hashes: dict[str, str],
) -> list[ExportPlan]:
    plans: list[ExportPlan] = []
    seen: set[str] = set()
    # Stable order: by kind then slug so repeated runs always produce the
    # same diff document.
    sorted_records = sorted(
        ctx.records,
        key=lambda r: (str(r.get("kind") or ""), str(r.get("slug") or "")),
    )
    for record in sorted_records:
        target = note_path_for(record, ctx)
        slug = str(record.get("slug") or "")
        kind = str(record.get("kind") or "")
        record_id = str(record.get("record_id") or f"{kind}:{slug}")
        display = _display(record)
        if not target:
            plans.append(
                ExportPlan(
                    record_id=record_id,
                    kind=kind,
                    slug=slug,
                    display=display,
                    target="",
                    content="",
                    status="unplaced",
                    note="no source_path and no kind/slug placement rule",
                )
            )
            continue
        if target in seen:
            # Deterministic: skip the duplicate; first record wins.
            plans.append(
                ExportPlan(
                    record_id=record_id,
                    kind=kind,
                    slug=slug,
                    display=display,
                    target=target,
                    content="",
                    status="conflict",
                    note="duplicate target path with an earlier record",
                )
            )
            continue
        seen.add(target)
        content = render_note(record)
        abs_target = vault_root / target
        if abs_target.exists():
            current = abs_target.read_text(encoding="utf-8")
            current_hash = sha256_text(current)
            new_hash = sha256_text(content)
            if current_hash == new_hash:
                status, note = "update", "content unchanged"
            elif hashes.get(target) == current_hash:
                status, note = "update", "writer-untouched; safe to overwrite"
            else:
                status, note = "conflict", "writer-edited since last export"
        else:
            status, note = "create", "new note"
        plans.append(
            ExportPlan(
                record_id=record_id,
                kind=kind,
                slug=slug,
                display=display,
                target=target,
                content=content,
                status=status,
                note=note,
            )
        )
    return plans


# ---------------------------------------------------------------------------
# Mode runners
# ---------------------------------------------------------------------------


def render_diff_markdown(plans: list[ExportPlan], project: dict[str, object]) -> str:
    by_status: dict[str, list[ExportPlan]] = {
        "create": [],
        "update": [],
        "conflict": [],
        "unplaced": [],
    }
    for plan in plans:
        by_status.setdefault(plan.status, []).append(plan)
    lines: list[str] = [
        "# Cartridge → Obsidian export diff",
        "",
        f"- project_slug: {project.get('project_slug', '<unknown>')}",
        f"- total records: {len(plans)}",
        f"- create: {len(by_status['create'])}",
        f"- update: {len(by_status['update'])}",
        f"- conflict: {len(by_status['conflict'])}",
        f"- unplaced: {len(by_status['unplaced'])}",
        "",
    ]
    for bucket in ("create", "update", "conflict", "unplaced"):
        items = by_status.get(bucket, [])
        if not items:
            continue
        lines.append(f"## {bucket} ({len(items)})")
        lines.append("")
        for plan in items:
            target = plan.target or "(no path)"
            note = f" — {plan.note}" if plan.note else ""
            lines.append(f"- `{plan.kind}` `{plan.slug}` → `{target}`{note}")
        lines.append("")
    # OWV-16: surface the hidden roundtrip-state companion artifacts so
    # reviewers know where the conflict / orphan / deleted-note details
    # live. The visible diff stays at its existing path for
    # compatibility; the new reports sit under
    # `.greenhaven-agent-manual/generated/roundtrip-state/`.
    lines.append("## Roundtrip-state companions")
    lines.append("")
    lines.append("- `roundtrip-state/note-hashes.jsonl` (machine-readable hashes per target)")
    lines.append("- `roundtrip-state/conflicts.md` (writer-edited targets that block write mode)")
    lines.append("- `roundtrip-state/orphaned-db-records.md` (records with no vault placement)")
    lines.append("- `roundtrip-state/deleted-note-candidates.md` (paths last seen, now missing)")
    return "\n".join(lines).rstrip() + "\n"


def write_diff(plans: list[ExportPlan], project: dict[str, object], vault_root: Path) -> Path:
    out = (
        vault_root
        / ".greenhaven-agent-manual"
        / "generated"
        / "export-diff.md"
    )
    write_text(out, render_diff_markdown(plans, project))
    return out


def write_staging(plans: list[ExportPlan], vault_root: Path) -> Path:
    """Write every placeable plan under the staging tree.

    Each target is double-checked against the staging root via
    :func:`is_within_root` before any file is touched. A plan that
    resolves outside the staging root is skipped (its ``ExportPlan``
    is left untouched so the caller can still see it via the diff).
    """

    staging_root = (
        vault_root
        / ".greenhaven-agent-manual"
        / "generated"
        / "export-staging"
    )
    for plan in plans:
        if plan.status == "unplaced" or not plan.target:
            continue
        candidate = staging_root / plan.target
        if not is_within_root(candidate, staging_root):
            continue
        write_text(candidate, plan.content)
    return staging_root


def perform_write(
    plans: list[ExportPlan],
    vault_root: Path,
    hashes: dict[str, str],
    allow_write: bool,
) -> dict[str, list[ExportPlan]]:
    """Write visible notes under the vault root.

    Every target is double-checked against ``<vault-root>/GreenHavenWorld``
    before any file is touched. A plan that resolves outside that
    visible root is skipped and added to the ``skipped`` bucket so
    callers can audit the rejection.
    """

    if not allow_write:
        raise RuntimeError(
            "write mode refused: pass --allow-write to authorize visible writes"
        )
    visible_root = vault_root / "GreenHavenWorld"
    written: list[ExportPlan] = []
    skipped: list[ExportPlan] = []
    for plan in plans:
        if plan.status in ("conflict", "unplaced") or not plan.target:
            skipped.append(plan)
            continue
        abs_target = vault_root / plan.target
        if not is_within_root(abs_target, visible_root):
            skipped.append(plan)
            continue
        write_text(abs_target, plan.content)
        hashes[plan.target] = sha256_text(plan.content)
        written.append(plan)
    return {"written": written, "skipped": skipped}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a Cartridge Forge project into GreenHavenWorld/",
    )
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Path to a cartridge-forge-project directory (with forge.project.json)",
    )
    parser.add_argument(
        "--vault-root",
        type=Path,
        default=None,
        help="GreenhavenWorld vault root (the folder that contains GreenHavenWorld/)",
    )
    parser.add_argument(
        "--mode",
        choices=("diff", "stage", "write"),
        default="diff",
    )
    parser.add_argument(
        "--allow-write",
        action="store_true",
        help="Required for --mode write. No-op for other modes.",
    )
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    vault_root = (
        args.vault_root.resolve()
        if args.vault_root
        else default_vault_root(__file__)
    )
    ctx = load_project(args.source.resolve())
    hashes = load_hash_store(vault_root)
    plans = plan_exports(ctx, vault_root, hashes)
    exported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if args.mode == "diff":
        out = write_diff(plans, ctx.project, vault_root)
        state = write_roundtrip_state(
            plans, ctx.project, vault_root, hashes, exported_at=exported_at
        )
        print(f"wrote diff to {out}")
        print(f"wrote roundtrip-state to {state}")
    elif args.mode == "stage":
        diff = write_diff(plans, ctx.project, vault_root)
        staging = write_staging(plans, vault_root)
        state = write_roundtrip_state(
            plans, ctx.project, vault_root, hashes, exported_at=exported_at
        )
        print(f"wrote diff to {diff}")
        print(f"wrote staged tree to {staging}")
        print(f"wrote roundtrip-state to {state}")
    elif args.mode == "write":
        result = perform_write(plans, vault_root, hashes, args.allow_write)
        save_hash_store(vault_root, hashes)
        diff = write_diff(plans, ctx.project, vault_root)
        state = write_roundtrip_state(
            plans, ctx.project, vault_root, hashes, exported_at=exported_at
        )
        print(f"wrote diff to {diff}")
        print(f"wrote roundtrip-state to {state}")
        print(f"wrote {len(result['written'])} notes; skipped {len(result['skipped'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
