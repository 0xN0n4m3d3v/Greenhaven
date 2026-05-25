"""Shared Obsidian vault validation/diff for OWV-4.

This module is the single source of truth for *what counts as a
reviewable problem* when the Obsidian vault is compiled into a
Cartridge Forge project (or rendered as a preview diff). Both
``compile_vault_to_forge`` and ``compile_vault_preview`` feed their
parsed data into ``validate_vault`` and consume the resulting
``ValidationReport``:

* the **preview** writes ``validation.md`` / ``validation.jsonl``
  alongside ``import-diff.md`` so writers can read findings before any
  DB write is attempted;
* the **Forge compiler** writes the same artifacts under
  ``cartridge-forge-project/audit/`` *and* raises
  :class:`ValidationError` when any error-severity finding is present,
  so invalid cartridge references cannot silently flow into the SQL
  importer.

The validator deliberately turns previously-silent fallbacks
(``first_location_slug``, self-exits, synthetic
default hooks, missing materialiser targets) into explicit
warnings/questions; writers see the ambiguity and decide. See
``references/cartridge-output-contract.md`` §13 ("ambiguity becomes a
question in the diff, not a guessed DB write") for the contract this
implements.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
from pathlib import Path
from typing import Iterable

from vault_scan import Entity, get_slug
from vault_sections import (
    ManifestInfo,
    NoteSections,
    all_mentions,
    duplicate_display_names,
    duplicate_slugs,
    enclosing_location_slug,
    location_parent_slug,
    mentions_in_text,
    owner_slug,
    parse_materializes,
)


class Severity(str, Enum):
    """Triage levels for validation findings.

    ``ERROR`` blocks Forge/SQL output paths via :class:`ValidationError`;
    ``WARNING`` is surfaced to the writer but does not block; ``QUESTION``
    is an explicit ambiguity that the human author must resolve (the
    canonical example is a ``Materializes`` block whose target entity
    does not yet exist).
    """

    ERROR = "error"
    WARNING = "warning"
    QUESTION = "question"


@dataclass(frozen=True)
class Finding:
    """One reviewable item produced by the validator.

    ``code`` is a stable dotted identifier (``duplicate.slug``,
    ``materializes.create_candidate`` …); tests and downstream tooling
    key on it instead of message text so wording can be improved
    without breaking pinned behaviour.
    """

    severity: Severity
    code: str
    source_path: str
    message: str
    suggestion: str
    slug: str | None = None
    mention: str | None = None
    target_mention: str | None = None

    def to_dict(self) -> dict[str, str]:
        out: dict[str, str] = {
            "severity": self.severity.value,
            "code": self.code,
            "source_path": self.source_path,
            "message": self.message,
            "suggestion": self.suggestion,
        }
        if self.slug:
            out["slug"] = self.slug
        if self.mention:
            out["mention"] = self.mention
        if self.target_mention:
            out["target_mention"] = self.target_mention
        return out


@dataclass(frozen=True)
class ValidationReport:
    """Immutable bundle of every :class:`Finding` produced by one pass.

    Iteration order is the order findings were appended by
    ``validate_vault``; tests should not depend on cross-category
    ordering beyond what ``validate_vault`` documents.
    """

    findings: tuple[Finding, ...]

    @property
    def errors(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity is Severity.ERROR)

    @property
    def warnings(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity is Severity.WARNING)

    @property
    def questions(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity is Severity.QUESTION)

    @property
    def has_errors(self) -> bool:
        return any(f.severity is Severity.ERROR for f in self.findings)

    def by_code(self, code: str) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.code == code)

    def counts(self) -> dict[str, int]:
        out = {"error": 0, "warning": 0, "question": 0}
        for finding in self.findings:
            out[finding.severity.value] += 1
        return out

    def render_markdown(self) -> str:
        counts = self.counts()
        lines: list[str] = [
            "# Greenhaven Vault Validation",
            "",
            (
                f"Findings: {counts['error']} error / "
                f"{counts['warning']} warning / {counts['question']} question"
            ),
            "",
        ]
        for severity in (Severity.ERROR, Severity.WARNING, Severity.QUESTION):
            block = tuple(f for f in self.findings if f.severity is severity)
            lines.append(f"## {severity.value.title()} ({len(block)})")
            lines.append("")
            if not block:
                lines.append("- none")
                lines.append("")
                continue
            for finding in block:
                target = (
                    f" -> {finding.target_mention}" if finding.target_mention else ""
                )
                identity = (
                    f" `{finding.mention}`"
                    if finding.mention
                    else f" `{finding.slug}`"
                    if finding.slug
                    else ""
                )
                lines.append(
                    f"- **{finding.code}**{identity}{target} in `{finding.source_path}`"
                )
                lines.append(f"  - {finding.message}")
                lines.append(f"  - suggest: {finding.suggestion}")
            lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    def render_jsonl(self) -> str:
        return (
            "".join(
                json.dumps(finding.to_dict(), ensure_ascii=False, sort_keys=True) + "\n"
                for finding in self.findings
            )
            or ""
        )


class ValidationError(RuntimeError):
    """Raised when validate_vault produced one or more error-severity
    findings and a caller chose to enforce them (typically the Forge
    compiler before any project bytes are written).
    """

    def __init__(self, report: ValidationReport) -> None:
        self.report = report
        head = "; ".join(
            f"{finding.code}: {finding.message}" for finding in report.errors[:5]
        )
        suffix = "" if len(report.errors) <= 5 else f" (+{len(report.errors) - 5} more)"
        super().__init__(f"vault validation failed: {head}{suffix}")


def validate_vault(
    *,
    vault: Path,
    entities: Iterable[Entity],
    notes: Iterable[NoteSections],
    manifest: ManifestInfo,
    unresolved: Iterable[dict[str, str]] = (),
    duplicate_mention_groups: dict[str, list[Entity]] | None = None,
    visual_rows: Iterable[dict[str, object]] = (),
    unmapped_visuals: Iterable[Path] = (),
) -> ValidationReport:
    """Produce a deterministic :class:`ValidationReport` for ``vault``.

    The function is pure given its inputs: no filesystem reads beyond
    the visual-asset paths the caller already discovered, and no
    mutation of the entity/notes structures. Both
    ``compile_vault_to_forge`` and ``compile_vault_preview`` build the
    same parsed shape so the report is identical regardless of which
    entry point produced it.
    """

    entity_list = list(entities)
    note_list = list(notes)
    by_slug: dict[str, Entity] = {entity.slug: entity for entity in entity_list}
    by_mention: dict[str, list[Entity]] = {}
    for entity in entity_list:
        by_mention.setdefault(entity.mention, []).append(entity)
    mention_idx = all_mentions(note_list)

    findings: list[Finding] = []

    _check_start_location(findings, manifest, by_slug)
    _check_duplicates(findings, entity_list, duplicate_mention_groups)
    _check_unresolved_mentions(findings, unresolved)
    _check_per_entity(findings, note_list, entity_list, by_slug, mention_idx)
    _check_visual_assets(findings, vault, visual_rows, unmapped_visuals)

    return ValidationReport(tuple(findings))


def _check_start_location(
    findings: list[Finding],
    manifest: ManifestInfo,
    by_slug: dict[str, Entity],
) -> None:
    if not manifest.start_slug:
        findings.append(
            Finding(
                severity=Severity.ERROR,
                code="start_location.unresolved",
                source_path=manifest.source_path,
                message=(
                    "WORLD_MANIFEST.md does not declare a resolvable start "
                    "location wikilink or @mention."
                ),
                suggestion=(
                    "Edit the `## Начало игры` / `## Start of the game` section "
                    "so the wikilink points at an existing location note."
                ),
                mention=manifest.start_mention,
            )
        )
        return
    if manifest.start_slug not in by_slug:
        findings.append(
            Finding(
                severity=Severity.ERROR,
                code="start_location.invalid_target",
                source_path=manifest.source_path,
                message=(
                    f"Manifest start location slug `{manifest.start_slug}` does "
                    "not match any compiled vault entity."
                ),
                suggestion=(
                    "Rename the manifest target or create the corresponding "
                    "location note under GreenHavenWorld/Locations/."
                ),
                slug=manifest.start_slug,
                mention=manifest.start_mention,
            )
        )


def _check_duplicates(
    findings: list[Finding],
    entities: list[Entity],
    duplicate_mention_groups: dict[str, list[Entity]] | None,
) -> None:
    for slug, group in sorted(duplicate_slugs(entities).items()):
        paths = ", ".join(item.path for item in group)
        findings.append(
            Finding(
                severity=Severity.ERROR,
                code="duplicate.slug",
                source_path=group[0].path,
                message=(
                    f"Slug `{slug}` is shared by {len(group)} notes ({paths}); the "
                    "compiler keeps a single record per slug."
                ),
                suggestion=(
                    "Rename one of the colliding notes so display names produce "
                    "distinct slugs, then recompile."
                ),
                slug=slug,
            )
        )
    for name, group in sorted(duplicate_display_names(entities).items()):
        paths = ", ".join(item.path for item in group)
        findings.append(
            Finding(
                severity=Severity.ERROR,
                code="duplicate.display_name",
                source_path=group[0].path,
                message=(
                    f"Display name `{name}` is shared by {len(group)} notes "
                    f"({paths})."
                ),
                suggestion=(
                    "Give each entity a unique canonical name; runtime "
                    "`@mention` lookups depend on it."
                ),
                mention=f"@{name}",
            )
        )
    if duplicate_mention_groups:
        for mention, group in sorted(duplicate_mention_groups.items()):
            if len(group) <= 1:
                continue
            paths = ", ".join(item.path for item in group)
            findings.append(
                Finding(
                    severity=Severity.ERROR,
                    code="duplicate.mention",
                    source_path=group[0].path,
                    message=(
                        f"Mention `{mention}` resolves to {len(group)} notes "
                        f"({paths})."
                    ),
                    suggestion=(
                        "Disambiguate the conflicting notes; ambiguous "
                        "@mentions cannot be safely linked at runtime."
                    ),
                    mention=mention,
                )
            )


def _check_unresolved_mentions(
    findings: list[Finding],
    unresolved: Iterable[dict[str, str]],
) -> None:
    seen: set[tuple[str, str]] = set()
    for item in unresolved:
        mention = item.get("mention", "")
        source = item.get("source", "")
        key = (mention, source)
        if key in seen:
            continue
        seen.add(key)
        findings.append(
            Finding(
                severity=Severity.WARNING,
                code="mention.unresolved",
                source_path=source,
                message=(
                    f"Prose mention `{mention}` does not resolve to any vault "
                    "entity; runtime `@`-resolution will skip it."
                ),
                suggestion=(
                    "Either author the target note or rewrite the prose so the "
                    "mention is no longer required."
                ),
                mention=mention,
            )
        )


def _check_per_entity(
    findings: list[Finding],
    notes: list[NoteSections],
    entities: list[Entity],
    by_slug: dict[str, Entity],
    mention_idx: dict[str, list[Entity]],
) -> None:
    prose_persons_by_source = _index_prose_person_targets(entities, by_slug)
    for note in notes:
        entity = note.entity
        kind = entity.kind
        if kind == "location":
            _check_location(findings, entity, by_slug)
        elif kind == "scene":
            _check_scene(findings, entity, by_slug, prose_persons_by_source)
        elif kind == "quest":
            _check_quest(findings, entity, by_slug, prose_persons_by_source)
        for entry in parse_materializes(note, mention_idx):
            if entry.target_status == "new":
                findings.append(
                    Finding(
                        severity=Severity.QUESTION,
                        code="materializes.create_candidate",
                        source_path=entry.source_path,
                        message=(
                            f"`Materializes` target `{entry.entity}` does not "
                            "exist yet; the writer wants it created."
                        ),
                        suggestion=(
                            "Confirm the target is intended as a new entity, "
                            "then author its note (or accept the create-"
                            "candidate in the import diff)."
                        ),
                        mention=entity.mention,
                        target_mention=entry.entity,
                    )
                )


def _check_location(
    findings: list[Finding],
    entity: Entity,
    by_slug: dict[str, Entity],
) -> None:
    parent = location_parent_slug(entity, by_slug.values())
    has_child_location = any(
        child.kind == "location"
        and child.slug != entity.slug
        and location_parent_slug(child, by_slug.values()) == entity.slug
        for child in by_slug.values()
    )
    if parent is None and not has_child_location:
        findings.append(
            Finding(
                severity=Severity.WARNING,
                code="location.no_exits",
                source_path=entity.path,
                message=(
                    f"Location `{entity.mention}` has no parent or child "
                    "locations and no prose exits; the compiler would emit a "
                    "self-exit placeholder."
                ),
                suggestion=(
                    "Add a parent location folder, a child location, or an "
                    "@mention of a neighbouring location in the prose."
                ),
                slug=entity.slug,
                mention=entity.mention,
            )
        )


def _check_scene(
    findings: list[Finding],
    entity: Entity,
    by_slug: dict[str, Entity],
    prose_persons_by_source: dict[str, list[str]],
) -> None:
    raw_owner = owner_slug(entity)
    if raw_owner and raw_owner not in by_slug:
        findings.append(
            Finding(
                severity=Severity.ERROR,
                code="scene.owner_unresolved",
                source_path=entity.path,
                message=(
                    f"Scene owner slug `{raw_owner}` (from folder `@{entity.owner}`) "
                    "does not resolve to a person entity."
                ),
                suggestion=(
                    "Rename the npc folder to an existing @NPC, or author the "
                    "owner's NPC note before recompiling."
                ),
                slug=entity.slug,
                mention=entity.mention,
            )
        )
        return
    if enclosing_location_slug(entity, by_slug.values()) is None:
        findings.append(
            Finding(
                severity=Severity.WARNING,
                code="scene.location_fallback",
                source_path=entity.path,
                message=(
                    f"Scene `{entity.mention}` is not nested under a location "
                    "folder; the compiler would guess the first available "
                    "location as the scene location."
                ),
                suggestion=(
                    "Move the scene under the correct `Locations/@…/` parent "
                    "or NPC-owned scene folder."
                ),
                slug=entity.slug,
                mention=entity.mention,
            )
        )
    if raw_owner:
        return


def _check_quest(
    findings: list[Finding],
    entity: Entity,
    by_slug: dict[str, Entity],
    prose_persons_by_source: dict[str, list[str]],
) -> None:
    parent_slug = get_slug(entity.parent) if entity.parent else None
    parent = by_slug.get(parent_slug or "")
    if parent_slug and not parent:
        findings.append(
            Finding(
                severity=Severity.ERROR,
                code="quest.parent_unresolved",
                source_path=entity.path,
                message=(
                    f"Quest folder parent `@{entity.parent}` (slug `{parent_slug}`) "
                    "does not resolve to a vault entity."
                ),
                suggestion=(
                    "Rename the folder to an existing @NPC / @Item, or author the "
                    "parent note before recompiling."
                ),
                slug=entity.slug,
                mention=entity.mention,
            )
        )
        return
    # The compiler currently routes any non-person parent through
    # ``first_person_slug``; surface the silent fallback so the writer
    # decides whether to nest the quest under an NPC, accept the
    # guessed giver, or leave the giver explicitly unset in a future
    # compiler iteration.
    if not parent or parent.kind != "person":
        kind_label = parent.kind if parent else "no parent"
        prose_persons = prose_persons_by_source.get(entity.path, [])
        hint = (
            f"the quest's prose mentions {', '.join(prose_persons)} — "
            "consider naming that NPC as the giver"
            if prose_persons
            else "the quest's prose does not name an NPC giver either"
        )
        findings.append(
            Finding(
                severity=Severity.WARNING,
                code="quest.giver_fallback",
                source_path=entity.path,
                message=(
                    f"Quest `{entity.mention}` has parent kind `{kind_label}`; "
                    "the compiler would guess the first available person as the "
                    f"giver. ({hint})"
                ),
                suggestion=(
                    "Either move the quest under an `npc/@…/quests/` folder, "
                    "name the giver in the quest body, or accept that the "
                    "guessed giver is acceptable for this action-unlock."
                ),
                slug=entity.slug,
                mention=entity.mention,
            )
        )
    if enclosing_location_slug(entity, by_slug.values()) is None:
        findings.append(
            Finding(
                severity=Severity.WARNING,
                code="quest.location_fallback",
                source_path=entity.path,
                message=(
                    f"Quest `{entity.mention}` is not nested under a location "
                    "folder; the compiler would guess the first available "
                    "location as the start."
                ),
                suggestion=(
                    "Move the quest folder under the correct "
                    "`Locations/@…/` parent or name the start location in prose."
                ),
                slug=entity.slug,
                mention=entity.mention,
            )
        )


def _check_visual_assets(
    findings: list[Finding],
    vault: Path,
    visual_rows: Iterable[dict[str, object]],
    unmapped_visuals: Iterable[Path],
) -> None:
    for row in visual_rows:
        if row.get("exists"):
            continue
        target = str(row.get("target") or "")
        source = str(row.get("source") or "")
        mention = str(row.get("mention") or "") or None
        findings.append(
            Finding(
                severity=Severity.WARNING,
                code="visual_asset.missing",
                source_path=source or target,
                message=(
                    f"Expected visual asset `{target}` is not present on disk."
                ),
                suggestion=(
                    "Generate the asset via the image planner or drop the "
                    "matching file into the expected `images/`/`portraits/` "
                    "folder."
                ),
                mention=mention,
            )
        )
    for path in unmapped_visuals:
        try:
            rel = path.relative_to(vault).as_posix()
        except ValueError:
            rel = path.as_posix()
        findings.append(
            Finding(
                severity=Severity.WARNING,
                code="visual_asset.unmapped",
                source_path=rel,
                message=(
                    f"Local image `{rel}` is not referenced by any vault entity."
                ),
                suggestion=(
                    "Either move/remove the orphan file or add a matching "
                    "`@Display` entity so the asset is consumed."
                ),
            )
        )


def _index_prose_person_targets(
    entities: list[Entity],
    by_slug: dict[str, Entity],
) -> dict[str, list[str]]:
    """Group person slugs mentioned in each note's prose by source path.

    The map is keyed by ``Entity.path`` and lists the slugs of every
    person whose ``@mention`` appears anywhere in the source text (the
    crude prose-link signal the runtime uses). It exists so the scene
    and quest checks can detect "no NPC in prose either" without
    re-running the full ``prose_edges`` pass per call.
    """

    out: dict[str, list[str]] = {}
    persons_by_mention: dict[str, str] = {
        entity.mention: entity.slug
        for entity in entities
        if entity.kind == "person"
    }
    for entity in entities:
        names: list[str] = []
        for mention in mentions_in_text(entity.text):
            slug = persons_by_mention.get(mention)
            if slug and slug != entity.slug and slug not in names:
                names.append(slug)
        out[entity.path] = names
    return out
