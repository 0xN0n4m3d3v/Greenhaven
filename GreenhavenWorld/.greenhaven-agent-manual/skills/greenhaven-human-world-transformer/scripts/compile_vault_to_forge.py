from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import sys
from typing import Any, Iterable

from compile_vault_preview import visual_asset_rows
from generate_vault_images import asset_role, entity_root, target_for
from vault_scan import (
    Entity,
    active_world_dir,
    default_vault_root,
    duplicate_mentions,
    get_slug,
    mention_index,
    prose_edges,
    scan_vault,
    structure_edges,
    write_text,
)
from vault_sections import (
    NoteSections,
    all_mentions,
    enclosing_location_slug,
    location_parent_slug,
    mentions_in_text,
    owner_slug,
    parse_currency_values,
    parse_manifest,
    parse_materializes,
    parse_companion_rule_contract,
    parse_merchant_offers,
    parse_quest_sections,
    parse_quest_reward_contract,
    parse_relationship_trigger_rules,
    public_summary,
    section,
    short_text,
)
from vault_validation import (
    ValidationError,
    ValidationReport,
    validate_vault,
)

BOOT_MEDIA_ROLES_BY_EXT = {
    ".png": "poster",
    ".jpg": "poster",
    ".jpeg": "poster",
    ".webp": "poster",
    ".mp4": "video",
    ".webm": "video",
    ".mp3": "music",
    ".ogg": "music",
    ".m4a": "music",
    ".wav": "music",
}

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
VIDEO_EXTENSIONS = {".mp4", ".webm"}
AUDIO_EXTENSIONS = {".mp3", ".ogg", ".m4a", ".wav"}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS
MEDIA_DIR_NAMES = {"images", "portraits", "media", "music", "audio"}


class DuplicateEntityError(ValidationError):
    """Raised before any Forge output is written when the live vault has
    duplicate canonical names or slugs.

    The compiler keeps a single ``records_by_slug`` map; if two notes
    collapse onto the same slug, the second silently overwrites the
    first and the Forge project would be wrong-by-design. Surfacing a
    deterministic error keeps the writer in control: pick a unique
    name and rerun. Inherits from :class:`ValidationError` so callers
    that want to handle any fatal validation outcome uniformly can
    catch the base class.
    """

    def __init__(self, message: str, report: ValidationReport | None = None) -> None:
        # ``ValidationError`` requires a report; pass an empty one when
        # the legacy duplicate path raises directly.
        report = report or ValidationReport(())
        # Skip ValidationError's auto-built message and use the caller's.
        RuntimeError.__init__(self, message)
        self.report = report


class MergeIdentityConflictError(ValidationError):
    """OWV-13: ambiguous reconciliation against the donor cartridge.

    Raised when a generated record's slug matches one donor identity
    but its ``payload.source_path`` matches a *different* donor
    identity (or several generated records collapse onto the same
    donor slug). The Forge writer cannot deterministically pick which
    donor row to merge against, so SQL export is blocked until the
    writer renames or merges by hand. The audit JSONL + Markdown
    report are written *before* the exception fires so the human has
    everything they need to resolve the collision.
    """

    def __init__(self, conflicts: list[dict[str, Any]]) -> None:
        report = ValidationReport(())
        lines = ["merge identity conflicts detected before Forge write:"]
        for row in conflicts:
            notes = "; ".join(row.get("notes") or []) or "ambiguous reconciliation"
            lines.append(
                f"  - {row.get('kind')} `{row.get('slug')}` "
                f"(source `{row.get('source_path') or 'unknown'}`): {notes}"
            )
        RuntimeError.__init__(self, "\n".join(lines))
        self.report = report
        self.conflicts = conflicts


class NumericDbIdInGeneratedRecordError(ValidationError):
    """OWV-13: a generated record carries a numeric DB id.

    Generated cartridge-forge records are keyed by ``(kind, slug,
    source_path)`` and must never carry numeric DB identifiers — those
    belong to the donor ``grinhaven-full-current`` cartridge that was
    imported from a previous SQL ingest pass. Surfacing a hard error
    keeps reconciliation deterministic: the donor cartridge owns the
    numeric id, the generated record owns the slug/source_path.
    """

    def __init__(self, violations: list[dict[str, Any]]) -> None:
        report = ValidationReport(())
        lines = ["generated records must not carry numeric DB ids:"]
        for v in violations:
            lines.append(
                f"  - {v.get('kind')} `{v.get('slug')}`: "
                f"payload.{v.get('key')}={v.get('value')!r}"
            )
        RuntimeError.__init__(self, "\n".join(lines))
        self.report = report
        self.violations = violations


RECORD_FILES: dict[str, str] = {
    "activity": "activities.jsonl",
    "dialogue": "dialogues.jsonl",
    "event": "events.jsonl",
    "faction": "factions.jsonl",
    "item": "items.jsonl",
    "location": "locations.jsonl",
    "person": "npcs.jsonl",
    "quest": "quests.jsonl",
    "relationship": "relationships.jsonl",
    "scene": "scenes.jsonl",
    "world_fact": "world-facts.jsonl",
}

SOURCE_ID = "src:greenhaven:obsidian-vault"
PROJECT_SLUG = "greenhaven-obsidian-world"

# OWV-13: generated cartridge-forge records may not carry numeric DB
# identifiers. The donor `grinhaven-full-current` cartridge stores its
# original SQL provenance under these payload keys; if any of them
# appear on a freshly compiled record it means a refactor leaked donor
# state into the writer-facing pipeline.
NUMERIC_DB_ID_KEYS: frozenset[str] = frozenset(
    {"db_entity_id", "db_id", "entity_id", "id"}
)

# OWV-13: status enum returned from ``reconcile_against_current_cartridge``.
MERGE_STATUS_EXACT_SLUG = "exact_slug_match"
MERGE_STATUS_SOURCE_PATH = "source_path_match"
MERGE_STATUS_NEW = "new"
MERGE_STATUS_AMBIGUOUS = "ambiguous_conflict"


def compile_vault(
    vault: Path,
    out_dir: Path | None = None,
    current_cartridge_root: Path | None = None,
    world_dir: str | None = None,
) -> dict[str, Any]:
    vault = vault.resolve()
    active_dir = active_world_dir(vault, world_dir)
    entities = scan_vault(vault, active_dir)
    notes = load_note_sections(entities)
    by_mention = mention_index(entities)
    by_slug = {entity.slug: entity for entity in entities}
    manifest = parse_manifest(vault, entities)
    structural = structure_edges(entities)
    prose, unresolved = prose_edges(entities)
    duplicates = duplicate_mentions(entities)
    visual_rows, unmapped_visuals = visual_asset_rows(vault, entities, active_dir)

    # OWV-4: validate the parsed vault before any Forge project bytes
    # are written. The report is surfaced unconditionally at the
    # preview-level location so writers can read findings even when
    # the compiler refuses to write a cartridge project.
    report = validate_vault(
        vault=vault,
        entities=entities,
        notes=notes,
        manifest=manifest,
        unresolved=unresolved,
        duplicate_mention_groups=duplicates,
        visual_rows=visual_rows,
        unmapped_visuals=unmapped_visuals,
    )
    preview_dir = vault / ".greenhaven-agent-manual" / "generated"
    write_text(preview_dir / "validation.md", report.render_markdown())
    write_text(preview_dir / "validation.jsonl", report.render_jsonl())

    _raise_for_validation_errors(report)

    output = out_dir or preview_dir / "cartridge-forge-project"
    reset_output_dir(output)

    records = build_records(vault, notes, by_mention, by_slug, structural, prose)

    # OWV-13: reconcile every freshly compiled record against the
    # current donor cartridge so we can spot slug/source-path drift
    # before SQL export. The audit artifacts are written even when no
    # conflict fires so the human gets a stable diff each run.
    if current_cartridge_root is None:
        current_cartridge_root = default_current_cartridge_root()
    merge_rows = reconcile_against_current_cartridge(records, current_cartridge_root)
    write_jsonl(output / "audit" / "merge-records.jsonl", merge_rows)
    write_text(
        output / "audit" / "merge-conflicts.md",
        render_merge_conflicts(merge_rows),
    )
    db_id_violations = collect_numeric_db_id_violations(records)
    if db_id_violations:
        raise NumericDbIdInGeneratedRecordError(db_id_violations)
    merge_conflicts = [
        row for row in merge_rows if row.get("status") == MERGE_STATUS_AMBIGUOUS
    ]
    if merge_conflicts:
        raise MergeIdentityConflictError(merge_conflicts)

    write_project(output, manifest.start_slug, active_dir)
    write_sources(output, active_dir)
    write_records(output, records)
    write_audits(
        vault,
        output,
        notes,
        records,
        manifest,
        structural,
        prose,
        unresolved,
        duplicates,
        active_dir,
    )
    # Mirror the validation report inside the Forge audit folder so a
    # consumer of the project can see findings without crawling back up
    # to the preview-level generated directory.
    write_text(output / "audit" / "validation.md", report.render_markdown())
    write_text(output / "audit" / "validation.jsonl", report.render_jsonl())

    counts: dict[str, int] = defaultdict(int)
    for record in records:
        counts[record["kind"]] += 1
    merge_counts: dict[str, int] = defaultdict(int)
    for row in merge_rows:
        merge_counts[str(row.get("status") or MERGE_STATUS_NEW)] += 1
    return {
        "ok": True,
        "project": str(output),
        "records": len(records),
        "counts": dict(sorted(counts.items())),
        "unresolved": len({(item["mention"], item["source"]) for item in unresolved}),
        "duplicates": len(duplicates),
        "start_location": manifest.start_mention,
        "world_dir": active_dir,
        "validation": report.counts(),
        "merge_status_counts": dict(sorted(merge_counts.items())),
    }


def load_note_sections(entities: Iterable[Entity]) -> list[NoteSections]:
    from vault_sections import note_sections

    return [note_sections(entity) for entity in entities]


def build_records(
    vault: Path,
    notes: list[NoteSections],
    by_mention: dict[str, list[Entity]],
    by_slug: dict[str, Entity],
    structural: list[dict[str, str]],
    prose: list[dict[str, str]],
) -> list[dict[str, Any]]:
    notes_by_path = {note.entity.path: note for note in notes}
    slugs_by_mention = {
        mention: group[0].slug for mention, group in by_mention.items() if len(group) == 1
    }
    children = collect_children(structural, slugs_by_mention)
    prose_links = collect_prose_links(prose, slugs_by_mention)
    # OWV-7: every `location/hidden-exit` materializer marks its
    # target location as initially hidden so the live cartridge SQL
    # does not advertise the unlocked route until the player
    # applies the materializer. `hidden_targets[target_slug]` is
    # the unlock source-note slug (purely a breadcrumb;
    # `move_player` only checks the truthiness of
    # `profile.hidden_until_stage`).
    hidden_targets = collect_hidden_exit_targets(notes, by_slug)
    records: list[dict[str, Any]] = []

    for note in sorted(notes, key=lambda item: (forge_kind(item.entity), item.entity.path)):
        entity = note.entity
        kind = forge_kind(entity)
        payload = payload_for(
            vault, note, notes_by_path, by_slug, children, prose_links, hidden_targets
        )
        links = links_for(entity, children, prose_links, by_slug)
        records.append(
            {
                "schema_version": "greenhaven.cartridge_ingest_record.v1",
                "record_id": record_id(kind, entity.slug),
                "kind": kind,
                "slug": entity.slug,
                "operation": "upsert",
                "source_language": "ru",
                "canonical_name": entity.display[:120],
                "summary": public_summary(note),
                "tags": tags_for(kind, note),
                "payload": payload,
                "links": links,
                "provenance": [
                    {
                        "source_id": SOURCE_ID,
                        "use": "internal_greenhaven_canon",
                        "confidence": 1,
                        "note": f"Compiled from Obsidian note {entity.path}.",
                    }
                ],
                "quality": {
                    "review_status": "agent_reviewed",
                    "playable": True,
                    "density_role": density_role(kind, note),
                    "risk_flags": risk_flags(note),
                },
            }
        )
    return records


def payload_for(
    vault: Path,
    note: NoteSections,
    notes_by_path: dict[str, NoteSections],
    by_slug: dict[str, Entity],
    children: dict[str, dict[str, list[str]]],
    prose_links: dict[str, list[str]],
    hidden_targets: dict[str, str] | None = None,
) -> dict[str, Any]:
    entity = note.entity
    kind = forge_kind(entity)
    payload: dict[str, Any] = {
        "source_slug": entity.slug,
        "source_path": entity.path,
        "source_markdown": entity.text,
        "canonical_mention": entity.mention,
    }

    if kind == "location":
        payload.update(
            location_payload(note, by_slug, children, prose_links, hidden_targets or {})
        )
    elif kind == "person":
        payload.update(person_payload(note, by_slug, children))
    elif kind == "item":
        payload.update(item_payload(note, by_slug))
    elif kind == "quest":
        payload.update(quest_payload(note, by_slug, children, prose_links, notes_by_path.values()))
    elif kind == "scene":
        payload.update(scene_payload(note, by_slug, prose_links))
    else:
        payload.update(world_fact_payload(note))

    visual = visual_asset_payload(vault, note.entity)
    if visual:
        payload["visual_assets"] = [visual]

    materializes = [
        entry.__dict__
        for entry in parse_materializes(note, all_mentions(notes_by_path.values()))
    ]
    if materializes:
        payload["materializes"] = materializes

    merchant_offers = [offer.__dict__ for offer in parse_merchant_offers(note)]
    if merchant_offers:
        payload["merchant_offers"] = normalize_dataclass_json(merchant_offers)

    return normalize_dataclass_json(payload)


def location_payload(
    note: NoteSections,
    by_slug: dict[str, Entity],
    children: dict[str, dict[str, list[str]]],
    prose_links: dict[str, list[str]],
    hidden_targets: dict[str, str] | None = None,
) -> dict[str, Any]:
    entity = note.entity
    child = children.get(entity.slug, {})
    parent = location_parent_slug(entity, by_slug.values())
    hidden_map = hidden_targets or {}
    exits = location_exits(
        entity, by_slug, children, prose_links, parent, hidden_map
    )
    brief = first_present(
        section(note, "location_brief"),
        section(note, "location_canon"),
        public_summary(note),
    )
    hooks = default_hooks(entity, note, child)
    # OWV-7: strip hidden-target slugs from sibling locations' hooks
    # so the narrator preamble does not advertise a route the player
    # has not unlocked yet.
    hooks = [hook for hook in hooks if hook not in hidden_map or hook == entity.slug]
    payload: dict[str, Any] = {
        "location_kind": "district" if parent is None else "room",
        "parent_slug": parent,
        "exits": exits,
        "child_location_slugs": location_child_slugs(entity, by_slug),
        "resident_npc_slugs": child.get("contains_npc", []),
        "scene_slugs": child.get("location_scene", []),
        "quest_slugs": child.get("quest_source", []),
        "location_brief": section(note, "location_brief"),
        "location_canon": section(note, "location_canon"),
        "location_rules": section(note, "location_rules"),
        "first_entry_bubble": section(note, "location_first_entry"),
        "sensory_identity": section(note, "location_sensory_identity"),
        "visible_exits_prose": section(note, "location_visible_exits"),
        "points_of_interest": section(note, "location_points_of_interest"),
        "immediate_player_actions": section(note, "location_immediate_actions"),
        "hostile_pressure": section(note, "location_hostile_pressure"),
        "adventure_threat": section(note, "location_adventure_threat"),
        "location_memory_hooks": section(note, "location_memory_hooks"),
        "establishing_image_brief": section(note, "location_establishing_image"),
        "public_scenes_prose": section(note, "location_public_scenes"),
        "companion_stake": section(note, "location_companion_stake"),
        "media_script": parse_media_script(section(note, "media_script")),
        "narrator_brief": short_text(brief, 500),
        "mood_axes": mood_axes_for(entity),
        "default_hooks": hooks,
    }
    # OWV-7: emit `hidden_until_stage` so `move_player` rejects pre-
    # action travel. The runtime materializer clears this field on
    # apply (`packages/web-server/src/tools/materializer.ts`).
    if entity.slug in hidden_map:
        payload["hidden_until_stage"] = f"materializer:hidden-exit:{hidden_map[entity.slug]}"
    return payload


def person_payload(
    note: NoteSections,
    by_slug: dict[str, Entity],
    children: dict[str, dict[str, list[str]]],
) -> dict[str, Any]:
    entity = note.entity
    child = children.get(entity.slug, {})
    voice = section(note, "voice")
    relationship_triggers = section(note, "npc_relationship_triggers")
    companion_rules = section(note, "npc_companion_rules")
    # OBSIDIAN-VAULT-IMPORT-1 (2026-05-18) — expose the structured
    # live-vault NPC headings so the GUI cartridge persists the full
    # writer-authored frame (role/want/fear/secret/routine/relationship
    # triggers/memory hooks/companion rules/portrait brief) instead of
    # collapsing into the H1+identity fallback. Each field is the raw
    # section block; the runtime renderer is responsible for any
    # downstream summarisation.
    return {
        "species": infer_species(note),
        "pronouns": "she/her" if entity.display in {"Mikka", "Sable Vey"} else "they/them",
        "home_slug": enclosing_location_slug(entity, by_slug.values()),
        "identity": section(note, "identity"),
        "archetype": short_text(section(note, "identity"), 160) or "Greenhaven NPC",
        "voice": voice,
        "speech_style": short_text(voice, 500) or "Specific, scene-aware Greenhaven speech.",
        "registers": [
            {
                "register_slug": "default",
                "trigger": "player engages this NPC",
                "sample_line": sample_line(voice),
            }
        ],
        "appearance": section(note, "appearance"),
        "sexual_appearance": section(note, "sexual_appearance"),
        "relationship": section(note, "relationship"),
        "romance": section(note, "romance"),
        "skills": section(note, "skills"),
        "behavior": section(note, "behavior"),
        "inventory": section(note, "inventory"),
        "role": section(note, "npc_role"),
        "want": section(note, "npc_want"),
        "fear": section(note, "npc_fear"),
        "secret_pressure": section(note, "npc_secret"),
        "routine": section(note, "npc_routine"),
        "relationship_triggers": relationship_triggers,
        "relationship_trigger_rules": parse_relationship_trigger_rules(relationship_triggers),
        "memory_hooks": section(note, "npc_memory_hooks"),
        "companion_rules": companion_rules,
        "companion_rule_contract": parse_companion_rule_contract(companion_rules),
        "appearance_for_portrait": section(note, "npc_appearance_for_portrait"),
        "media_script": parse_media_script(section(note, "media_script")),
        "npc_scene_slugs": child.get("npc_scene", []),
        "quest_slugs": child.get("quest_source", []),
    }


def item_payload(note: NoteSections, by_slug: dict[str, Entity]) -> dict[str, Any]:
    currency = parse_currency_values(note)
    payload: dict[str, Any] = {
        "item_kind": "currency" if currency else infer_item_kind(note),
        "location_slug": enclosing_location_slug(note.entity, by_slug.values()),
        "holder_slug": owner_slug(note.entity),
        "item_description": section(note, "item_description"),
        "item_usage": section(note, "item_usage"),
        "item_canon": section(note, "item_canon"),
        "threat_profile": section(note, "item_threat_profile"),
        "cross_hub_reach": section(note, "item_cross_hub_reach"),
        "visual_brief": section(note, "item_visual_brief"),
        "do_not_do_here": section(note, "item_do_not"),
        "description": first_present(section(note, "item_description"), public_summary(note)),
        "use_contract": first_present(section(note, "item_usage"), section(note, "item_canon")),
    }
    if currency:
        payload.update(currency)
        payload["stackable"] = True
    return payload


def quest_payload(
    note: NoteSections,
    by_slug: dict[str, Entity],
    children: dict[str, dict[str, list[str]]],
    prose_links: dict[str, list[str]],
    notes: Iterable[NoteSections],
) -> dict[str, Any]:
    entity = note.entity
    parent_slug = get_slug(entity.parent) if entity.parent else None
    parent = by_slug.get(parent_slug or "")
    location_slug = enclosing_location_slug(entity, by_slug.values())
    giver_slug = parent.slug if parent and parent.kind == "person" else first_person_slug(by_slug)
    start_location = location_slug or first_location_slug(by_slug)
    parsed = parse_quest_sections(note, all_mentions=all_mentions(notes))
    prepared = unique_strings(
        [
            value
            for value in [
                parent_slug,
                location_slug,
                *prose_links.get(entity.slug, []),
                *parsed.materialized_slugs,
            ]
            if value and value != entity.slug
        ]
    )
    stages: list[dict[str, Any]] = []
    for stage in parsed.stages:
        row: dict[str, Any] = {
            "id": stage.stage_id,
            # Temporary compatibility alias for generated artifacts and
            # older diagnostics. Runtime reads `id`.
            "stage_slug": stage.stage_slug,
            "title": stage.goal,
            "goal": stage.goal,
            "location_slug": start_location,
        }
        if stage.next_stage is not None:
            row["next_stage"] = stage.next_stage
        if stage.prerequisites:
            row["prerequisites"] = list(stage.prerequisites)
        if stage.turns_remaining is not None:
            row["turns_remaining"] = stage.turns_remaining
        if stage.on_timeout:
            row["on_timeout"] = stage.on_timeout
        if stage.advance_on:
            row["advance_on"] = stage.advance_on
        stages.append(row)
    # OWV-12 hardening: action-unlock quests sit under an item's
    # `quests/` folder, so the parent_slug is an *item* slug rather
    # than a person. Surface that under `source_item_slug` while
    # keeping `quest_source_slug` populated for compatibility.
    source_item_slug = (
        parent.slug if parent and parent.kind == "item" else None
    )
    objective_fallback = (
        parsed.objective
        or parsed.hook
        or short_text(
            _strip_note_h1(note.entity.text),
            600,
        )
    )
    reward_text = section(note, "quest_rewards")
    reward_contract = parse_quest_reward_contract(reward_text)
    # OBSIDIAN-VAULT-IMPORT-1 — preserve the live-vault quest frame.
    # `success_result` / `failure_result` / `reward_and_consequence` /
    # `do_not_do_here` were collapsed into `rewards` / `failure` only;
    # surfacing them separately lets the GUI cartridge show the
    # writer's two-sided outcome plan and "don't do here" guard rails.
    return {
        "quest_type": "relationship" if parent and parent.kind == "person" else "exploration",
        "giver_slug": giver_slug,
        "source_slug": entity.slug,
        "quest_source_slug": parent_slug,
        "source_item_slug": source_item_slug,
        "start_location_slug": start_location,
        "quest_objective": parsed.objective,
        "quest_stages": section(note, "quest_stages"),
        "quest_rewards": reward_text,
        "objective": objective_fallback,
        "hook": parsed.hook,
        "rewards": reward_contract,
        "prepared_entity_slugs": prepared,
        "stages": stages,
        "stage_mentions": list(parsed.stage_mentions),
        "quest_source": parsed.source,
        "quest_failure": parsed.failure,
        "success_result": section(note, "quest_success_result"),
        "failure_result": section(note, "quest_failure_result"),
        "reward_and_consequence": reward_text,
        "do_not_do_here": section(note, "quest_failure"),
    }


def _strip_note_h1(text: str) -> str:
    """Drop the leading single `# Title` line from raw note text.

    Mirrors :func:`vault_sections._strip_h1` for the compiler so
    quest payloads never carry the H1 heading into ``objective``
    when the writer omitted both ``## Цель`` aliases and the
    parser had no objective/hook to fall back on.
    """

    if not text:
        return text
    lines = text.splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and re.match(r"^\s*#\s+", lines[0]):
        lines.pop(0)
    return "\n".join(lines).lstrip()


_SCENE_PRIORITY_LABEL_RE = re.compile(
    r"(?im)^\s*[-*]?\s*(?:приоритет|priority)\s*[:\-—]\s*(.+?)\s*$"
)
_SCENE_PRIORITY_HIGH = {
    "высокий",
    "высший",
    "критический",
    "критичный",
    "high",
    "critical",
}
_SCENE_PRIORITY_LOW = {"низкий", "low"}
_SCENE_PRIORITY_NORMAL = {
    "средний",
    "обычный",
    "нормальный",
    "normal",
    "medium",
}


def scene_priority(note: NoteSections, default: str = "normal") -> str:
    """Map authored ``Приоритет: ...`` / ``Priority: ...`` lines to a
    canonical Forge token (``high`` / ``normal`` / ``low``).

    Scene notes label priority on a bullet line under ``## Владелец
    сцены`` such as ``- Приоритет: высокий``. The SceneInstructionBridge
    ranks ``high`` scenes ahead of the default-normal cohort at the
    same location, so authored "high" must survive the compile.
    """

    text = note.entity.text or ""
    match = _SCENE_PRIORITY_LABEL_RE.search(text)
    if not match:
        return default
    raw = match.group(1).strip().lower().rstrip(".,;:!?")
    if raw in _SCENE_PRIORITY_HIGH:
        return "high"
    if raw in _SCENE_PRIORITY_LOW:
        return "low"
    if raw in _SCENE_PRIORITY_NORMAL:
        return "normal"
    return default


def split_function_args(raw: str) -> list[str]:
    args: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escape = False
    for char in raw:
        if escape:
            current.append(char)
            escape = False
            continue
        if char == "\\" and quote:
            escape = True
            continue
        if quote:
            if char == quote:
                quote = None
            else:
                current.append(char)
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char == ",":
            value = "".join(current).strip()
            if value:
                args.append(value)
            current = []
            continue
        current.append(char)
    value = "".join(current).strip()
    if value:
        args.append(value)
    return args


def parse_bool(value: str) -> bool | None:
    lowered = value.strip().lower()
    if lowered in {"true", "yes", "1", "on"}:
        return True
    if lowered in {"false", "no", "0", "off"}:
        return False
    return None


def normalize_media_asset_ref(raw: str) -> str:
    value = raw.strip().strip("'\"")
    suffix = Path(value).suffix.lower()
    stem = Path(value).stem if suffix else value
    slug = get_slug(stem)
    if suffix in AUDIO_EXTENSIONS and not slug.startswith("music-"):
        return f"music_{slug}".replace("-", "_")
    if suffix in VIDEO_EXTENSIONS and not slug.startswith("video-"):
        return f"video_{slug}".replace("-", "_")
    if suffix in IMAGE_EXTENSIONS and not slug.startswith(("media-", "image-", "portrait-")):
        return f"media_{slug}".replace("-", "_")
    return get_slug(value).replace("-", "_")


def parse_media_script(text: str | None) -> list[dict[str, Any]]:
    """Parse author-facing media commands from a note section.

    Supported lines:
      play_music("music_port_theme", label="Port", loop=true, volume=0.7)
      switch_music("music_combat")
      pause_music()
      resume_music()
      stop_music()
      show_media("media_ledger_closeup", title="Ledger", caption="Wax seal.")
    """

    if not text:
        return []
    commands: list[dict[str, Any]] = []
    action_by_function = {
        "play_music": "play",
        "switch_music": "switch",
        "pause_music": "pause",
        "resume_music": "resume",
        "stop_music": "stop",
        "show_media": "show",
        "send_media": "show",
        "post_media": "show",
    }
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(("-", "*")):
            line = line[1:].strip()
        open_paren = line.find("(")
        close_paren = line.rfind(")")
        if open_paren <= 0 or close_paren <= open_paren:
            continue
        fn = line[:open_paren].strip().lower()
        action = action_by_function.get(fn)
        if action is None:
            continue
        args = split_function_args(line[open_paren + 1 : close_paren])
        positional: list[str] = []
        named: dict[str, str] = {}
        for arg in args:
            if "=" in arg:
                key, value = arg.split("=", 1)
                named[key.strip().lower()] = value.strip().strip("'\"")
            else:
                positional.append(arg.strip().strip("'\""))
        command: dict[str, Any] = {"action": action}
        if positional:
            command["asset_role"] = normalize_media_asset_ref(positional[0])
        if named.get("role"):
            command["asset_role"] = normalize_media_asset_ref(named["role"])
        if named.get("label"):
            command["label"] = named["label"]
        if named.get("title"):
            command["title"] = named["title"]
        if named.get("caption"):
            command["caption"] = named["caption"]
        if named.get("alt"):
            command["alt"] = named["alt"]
        if named.get("loop"):
            parsed = parse_bool(named["loop"])
            if parsed is not None:
                command["loop"] = parsed
        if named.get("volume"):
            try:
                command["volume"] = max(0.0, min(1.0, float(named["volume"])))
            except ValueError:
                pass
        commands.append(command)
    return commands


def scene_payload(
    note: NoteSections,
    by_slug: dict[str, Entity],
    prose_links: dict[str, list[str]],
) -> dict[str, Any]:
    entity = note.entity
    location_slug = enclosing_location_slug(entity, by_slug.values()) or first_location_slug(by_slug)
    owner = owner_slug(entity)
    participant_slugs = [owner] if owner else []
    participant_slugs.extend(
        slug for slug in prose_links.get(entity.slug, []) if by_slug.get(slug) and by_slug[slug].kind == "person"
    )
    participant_slugs = unique_strings([slug for slug in participant_slugs if slug])
    # OBSIDIAN-VAULT-IMPORT-1 — preserve the live-vault scene frame.
    # `beat_by_beat`, `player_choices`, `memory_and_string_changes`,
    # `success_result` and `failure_result` previously collapsed into
    # `behavior` only. Each block is now its own payload field so the
    # GUI cartridge can render the writer's beat list, the action
    # menu, the two-sided outcome plan, and the post-scene memory /
    # strings plan distinctly. The `model_instructions` compact list
    # is extended so the runtime instruction surface picks them up
    # too without forcing a second migration on the bridge schema.
    beat_by_beat = section(note, "scene_beat_by_beat")
    player_choices = section(note, "scene_player_choices")
    memory_changes = section(note, "scene_memory_and_string_changes")
    success_result = section(note, "scene_success_result")
    failure_result = section(note, "scene_failure_result")
    scene_hook = section(note, "scene_hook")
    media_script = parse_media_script(section(note, "media_script"))
    return {
        "location_slug": location_slug,
        "owner_npc_slug": owner,
        "participant_slugs": participant_slugs,
        "scene_trigger": section(note, "scene_trigger"),
        "scene_behavior": section(note, "scene_behavior"),
        "scene_state": section(note, "scene_state"),
        "scene_do_not": section(note, "scene_do_not"),
        "voice": section(note, "voice"),
        "hook": scene_hook,
        "beat_by_beat": beat_by_beat,
        "player_choices": player_choices,
        "memory_and_string_changes": memory_changes,
        "success_result": success_result,
        "failure_result": failure_result,
        "media_script": media_script,
        "trigger": first_present(section(note, "scene_trigger"), "scene is available in context"),
        "priority": scene_priority(note),
        "behavior": first_present(section(note, "scene_behavior"), beat_by_beat, public_summary(note)),
        "state_fields": scene_state_fields(note),
        "model_instructions": compact_list(
            [
                scene_hook,
                section(note, "scene_behavior"),
                beat_by_beat,
                player_choices,
                memory_changes,
                success_result,
                failure_result,
                section(note, "media_script"),
                section(note, "scene_state"),
                section(note, "voice"),
                section(note, "scene_do_not"),
            ]
        ),
    }


def world_fact_payload(note: NoteSections) -> dict[str, Any]:
    payload = {
        "fact_kind": "currency" if "currency" in note.entity.slug else "world_note",
        "body": short_text(note.entity.text, 2000),
    }
    if "currency" in note.entity.slug:
        payload["currency_rates"] = {
            "gold_coin": 100,
            "silver_coin": 10,
            "copper_coin": 1,
        }
    return payload


def location_exits(
    entity: Entity,
    by_slug: dict[str, Entity],
    children: dict[str, dict[str, list[str]]],
    prose_links: dict[str, list[str]],
    parent: str | None,
    hidden_targets: dict[str, str] | None = None,
) -> list[str]:
    exits: list[str] = []
    exits.extend(
        slug for slug in prose_links.get(entity.slug, []) if by_slug.get(slug) and by_slug[slug].kind == "location"
    )
    exits.extend(children.get(entity.slug, {}).get("contains_location", []))
    if parent:
        exits.append(parent)
    for child_slug, child in by_slug.items():
        if child.kind == "location" and location_parent_slug(child, by_slug.values()) == entity.slug:
            exits.append(child_slug)
    exits = unique_strings([slug for slug in exits if slug != entity.slug])
    # OWV-7: a `location/hidden-exit` materializer pins its target
    # behind a runtime action. The compiler must not pre-wire the
    # exit in either direction: every OTHER location drops the
    # hidden target slug; the hidden target itself drops every
    # non-parent sibling so its only initial neighbor is its
    # enclosing district (or none). `apply_materializer_bridge`
    # appends the scope/target bidirectional exits on apply.
    if hidden_targets:
        if entity.slug in hidden_targets:
            exits = [slug for slug in exits if slug == parent]
        else:
            exits = [slug for slug in exits if slug not in hidden_targets]
    if not exits:
        exits = [entity.slug]
    return exits


def collect_hidden_exit_targets(
    notes: list[NoteSections],
    by_slug: dict[str, Entity],
) -> dict[str, str]:
    """OWV-7: walk every Materializes block and collect the slugs of
    target locations that should ship initially hidden.

    A target qualifies when the materializer `type` is
    `location/hidden-exit` AND the resolved target slug matches a
    `location` entity in the vault. Returns a `target_slug →
    source_slug` mapping. The source slug is the unlocking note's
    slug (e.g. `way-to-thiefs-market`); the runtime materializer
    tool clears `profile.hidden_until_stage` outright so this
    string is purely a breadcrumb that helps a reader of the
    compiled SQL see why a location is gated.
    """
    mentions = all_mentions(notes)
    hidden: dict[str, str] = {}
    for note in notes:
        for entry in parse_materializes(note, mentions):
            if entry.type.strip().lower() != "location/hidden-exit":
                continue
            target_slug = (entry.entity_slug or "").strip()
            if not target_slug:
                continue
            target_entity = by_slug.get(target_slug)
            if target_entity is None or target_entity.kind != "location":
                continue
            # First materializer that names this target wins; later
            # duplicates from other notes are ignored (the value is
            # just a breadcrumb).
            hidden.setdefault(target_slug, note.entity.slug)
    return hidden


def location_child_slugs(entity: Entity, by_slug: dict[str, Entity]) -> list[str]:
    return unique_strings(
        child_slug
        for child_slug, child in by_slug.items()
        if child.kind == "location"
        and child.slug != entity.slug
        and location_parent_slug(child, by_slug.values()) == entity.slug
    )


def collect_children(
    structural: Iterable[dict[str, str]],
    slugs_by_mention: dict[str, str],
) -> dict[str, dict[str, list[str]]]:
    children: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for edge in structural:
        source = slugs_by_mention.get(edge["from"])
        target = slugs_by_mention.get(edge["to"])
        if not source or not target:
            continue
        relation = edge["relation"]
        children[source][relation].append(target)
    return {
        parent: {relation: unique_strings(values) for relation, values in relations.items()}
        for parent, relations in children.items()
    }


def collect_prose_links(
    prose: Iterable[dict[str, str]],
    slugs_by_mention: dict[str, str],
) -> dict[str, list[str]]:
    links: dict[str, list[str]] = defaultdict(list)
    for edge in prose:
        source = slugs_by_mention.get(edge["from"])
        target = slugs_by_mention.get(edge["to"])
        if source and target:
            links[source].append(target)
    return {source: unique_strings(values) for source, values in links.items()}


def links_for(
    entity: Entity,
    children: dict[str, dict[str, list[str]]],
    prose_links: dict[str, list[str]],
    by_slug: dict[str, Entity],
) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for relation, slugs in children.get(entity.slug, {}).items():
        rel = relation.replace("-", "_")
        for slug in slugs:
            if slug != entity.slug and slug in by_slug:
                out.append({"rel": rel, "target": slug})
    for slug in prose_links.get(entity.slug, []):
        if slug != entity.slug and slug in by_slug:
            out.append({"rel": "mentions", "target": slug})
    return dedupe_links(out)


def canonical_asset_path(vault: Path, entity: Entity) -> Path | None:
    target = target_for(entity, vault)
    if target is None:
        return None
    candidates = [target]
    candidates.extend(
        target.with_suffix(ext)
        for ext in sorted(MEDIA_EXTENSIONS)
        if ext != target.suffix.lower()
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def visual_asset_payload(vault: Path, entity: Entity) -> dict[str, Any] | None:
    target = canonical_asset_path(vault, entity)
    if target is None:
        return None
    return {
        "role": asset_role(entity),
        "path": target.relative_to(vault).as_posix(),
    }


def media_asset_role(entity: Entity, path: Path, canonical: Path | None) -> str:
    if canonical is not None and path.resolve() == canonical.resolve():
        return asset_role(entity)
    stem_slug = get_slug(path.stem).replace("-", "_")
    ext = path.suffix.lower()
    parts = {part.lower() for part in path.parts}
    if "portraits" in parts:
        return "portrait" if stem_slug == "default" else f"portrait_{stem_slug}"
    if ext in AUDIO_EXTENSIONS:
        return f"music_{stem_slug}"
    if ext in VIDEO_EXTENSIONS:
        return f"video_{stem_slug}"
    if entity.kind == "item" and stem_slug == "icon":
        return "item_icon"
    if entity.kind == "location" and stem_slug == "establishing":
        return "location_view"
    if entity.kind == "scene" and stem_slug in {entity.slug, "key"}:
        return "scene_plate"
    return f"media_{stem_slug}"


def media_asset_payloads(vault: Path, entity: Entity) -> list[dict[str, Any]]:
    root = entity_root(entity, vault)
    if not root.is_dir():
        return []
    canonical = canonical_asset_path(vault, entity)
    rows: list[dict[str, Any]] = []
    seen_roles: set[str] = set()
    for path in scoped_media_files(root, entity, canonical):
        role = media_asset_role(entity, path, canonical)
        if role in seen_roles:
            continue
        seen_roles.add(role)
        rows.append(
            {
                "role": role,
                "path": path.relative_to(vault).as_posix(),
            }
        )
    return rows


def scoped_media_files(root: Path, entity: Entity, canonical: Path | None) -> list[Path]:
    """Return media owned by one entity without stealing child-entity assets.

    Location folders contain nested ``npc/`` and ``items/`` trees, and scene
    entities often live in a location/NPC ``scenes`` folder while their plate is
    stored in the owner's ``images`` directory. A blind ``root.rglob("*")`` makes
    parent locations inherit child portraits/icons. Keep ownership explicit:
    normal entities read their own direct media folders; scenes read only their
    canonical plate plus scene-named audio/video helpers.
    """

    found: list[Path] = []
    if canonical and canonical.is_file():
        found.append(canonical)

    direct_dirs = [
        root / name
        for name in ("images", "portraits", "media", "music", "audio")
        if (root / name).is_dir()
    ]
    scene_slug = entity.slug.replace("-", "_")
    for folder in direct_dirs:
        for path in sorted(folder.rglob("*"), key=lambda item: item.as_posix().lower()):
            if not path.is_file() or path.suffix.lower() not in MEDIA_EXTENSIONS:
                continue
            if canonical and path.resolve() == canonical.resolve():
                continue
            if entity.kind == "scene":
                stem = get_slug(path.stem).replace("-", "_")
                if stem != scene_slug and not stem.startswith(f"{scene_slug}_"):
                    continue
            found.append(path)
    return sorted(dict.fromkeys(found), key=lambda item: item.as_posix().lower())


def boot_bundle_key(path: Path) -> str:
    stem = path.stem
    for suffix in (".poster", ".video", ".music"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    key = re.sub(r"[^a-zA-Z0-9_-]+", "-", stem.strip()).strip("-_").lower()
    return key or "default"


def boot_media_rows(vault: Path, world_dir: str) -> list[dict[str, Any]]:
    boot_root = vault / world_dir / "media" / "boot"
    if not boot_root.is_dir():
        # Legacy/manual fallback for older local experiments. The portable
        # cartridge contract keeps boot media inside the active world root.
        boot_root = vault / "media" / "boot"
    if not boot_root.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    for path in sorted(boot_root.iterdir(), key=lambda p: p.name.lower()):
        if not path.is_file():
            continue
        role_kind = BOOT_MEDIA_ROLES_BY_EXT.get(path.suffix.lower())
        if role_kind is None:
            continue
        bundle = boot_bundle_key(path)
        rel_path = path.relative_to(vault).as_posix()
        rows.append(
            {
                "mention": f"@Boot {bundle}",
                "slug": "boot",
                "kind": "cartridge",
                "source_path": rel_path,
                "role": f"boot_{role_kind}_{bundle}",
                "path": rel_path,
            }
        )
    return rows


def slug_from_world_dir(world_dir: str) -> str:
    out: list[str] = []
    prev = ""
    for char in world_dir.strip():
        if char.isalnum():
            if char.isupper() and prev and (prev.islower() or prev.isdigit()):
                out.append("-")
            out.append(char.lower())
            prev = char
        elif out and out[-1] != "-":
            out.append("-")
            prev = char
    slug = "".join(out).strip("-")
    return slug or PROJECT_SLUG


def title_from_world_dir(world_dir: str) -> str:
    chars: list[str] = []
    prev = ""
    for char in world_dir.strip():
        if char.isalnum():
            if char.isupper() and prev and (prev.islower() or prev.isdigit()):
                chars.append(" ")
            chars.append(char)
            prev = char
        else:
            if chars and chars[-1] != " ":
                chars.append(" ")
            prev = char
    title = " ".join("".join(chars).split())
    return title or "Greenhaven World"


def write_project(
    output: Path,
    start_location_slug: str | None,
    world_dir: str,
) -> None:
    # FEAT-HERO-CONTINUITY-6 — `live:hero-continuity` needs two
    # distinct cartridges from two compiled vaults. The compiler used
    # to hardcode `grinhaven-full`, which collapsed both vaults into
    # one row. The override is read from an optional env var so
    # production / Obsidian path stays unchanged; smoke + tests can
    # set it per spawn.
    default_project_slug = slug_from_world_dir(world_dir)
    project_slug = os.environ.get(
        "GREENHAVEN_FORGE_PROJECT_SLUG", default_project_slug
    )
    target_cartridge_id = os.environ.get(
        "GREENHAVEN_FORGE_TARGET_CARTRIDGE_ID", project_slug
    )
    project_title = os.environ.get(
        "GREENHAVEN_FORGE_PROJECT_TITLE", title_from_world_dir(world_dir)
    )
    project = {
        "schema_version": "greenhaven.cartridge_forge_project.v1",
        "project_slug": project_slug,
        "pack_slug": project_slug,
        "target_cartridge_id": target_cartridge_id,
        "title": project_title,
        "starting_location_slug": start_location_slug,
        "mode": "append_patch",
        "source_language": "ru",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "density_goal": {
            "power_centers": ["town-square", "thiefs-market"],
            "minimum_hooks_per_location": 3,
        },
        "provider": {
            "base_url": "https://api.deepseek.com",
            "model": "deepseek-chat",
            "api_key_env": "DEEPSEEK_API_KEY",
        },
    }
    write_json(output / "forge.project.json", project)


def write_sources(output: Path, world_dir: str) -> None:
    source_title = os.environ.get(
        "GREENHAVEN_FORGE_SOURCE_TITLE",
        f"{title_from_world_dir(world_dir)} Obsidian vault",
    )
    write_jsonl(
        output / "sources.jsonl",
        [
            {
                "source_id": SOURCE_ID,
                "title": source_title,
                "retrieved_at": datetime.now(timezone.utc).date().isoformat(),
                "license": "internal",
                "robots_status": "internal",
                "notes": "Human-authored GreenhavenWorld Obsidian vault content.",
            }
        ],
    )


def write_records(output: Path, records: list[dict[str, Any]]) -> None:
    records_dir = output / "records"
    records_dir.mkdir(parents=True, exist_ok=True)
    grouped: dict[str, list[dict[str, Any]]] = {kind: [] for kind in RECORD_FILES}
    for record in records:
        grouped[record["kind"]].append(record)
    for kind, file_name in RECORD_FILES.items():
        rows = sorted(grouped[kind], key=lambda row: row["slug"])
        write_jsonl(records_dir / file_name, rows)


def write_audits(
    vault: Path,
    output: Path,
    notes: list[NoteSections],
    records: list[dict[str, Any]],
    manifest: Any,
    structural: list[dict[str, str]],
    prose: list[dict[str, str]],
    unresolved: list[dict[str, str]],
    duplicates: dict[str, list[Entity]],
    world_dir: str,
) -> None:
    audit = output / "audit"
    audit.mkdir(parents=True, exist_ok=True)
    materializes: list[dict[str, Any]] = []
    merchants: list[dict[str, Any]] = []
    visuals: list[dict[str, Any]] = []
    mentions = all_mentions(notes)

    for note in notes:
        kind = forge_kind(note.entity)
        # OWV-17: every audit row carries `source_slug` + `source_kind`
        # so the future runtime bridge can join the audit JSONL back
        # onto the Forge `records/*.jsonl` without re-parsing the
        # ``source_path`` string.
        for entry in parse_materializes(note, mentions):
            row = normalize_dataclass_json(entry.__dict__)
            row["source_slug"] = note.entity.slug
            row["source_kind"] = kind
            materializes.append(row)
        for offer in parse_merchant_offers(note):
            row = normalize_dataclass_json(offer.__dict__)
            row["source_slug"] = note.entity.slug
            row["source_kind"] = kind
            merchants.append(row)
        for visual in media_asset_payloads(vault, note.entity):
            visuals.append(
                {
                    "mention": note.entity.mention,
                    "slug": note.entity.slug,
                    "kind": kind,
                    "source_path": note.entity.path,
                    **visual,
                }
            )

    visuals.extend(boot_media_rows(vault, world_dir))

    # Deterministic ordering — repeated runs over the same vault must
    # produce byte-identical audit JSONLs so a diff against a previous
    # cartridge-forge-project run reads cleanly.
    materializes.sort(
        key=lambda row: (
            str(row.get("source_slug") or ""),
            str(row.get("entity_slug") or ""),
            str(row.get("entity") or ""),
        )
    )
    merchants.sort(
        key=lambda row: (
            str(row.get("source_slug") or ""),
            str(row.get("line") or ""),
        )
    )
    visuals.sort(
        key=lambda row: (
            str(row.get("kind") or ""),
            str(row.get("slug") or ""),
            str(row.get("role") or ""),
            str(row.get("path") or ""),
        )
    )

    write_jsonl(audit / "materializes.jsonl", materializes)
    write_jsonl(audit / "merchant-contracts.jsonl", merchants)
    write_jsonl(audit / "visual-assets.jsonl", visuals)
    write_currency_rates_json(audit, notes, records)
    scenes = write_scene_instructions_jsonl(audit, records)
    write_text(audit / "unresolved-links.md", render_unresolved(unresolved))
    write_text(audit / "conflicts.md", render_conflicts(duplicates))
    write_text(
        audit / "import-diff.md",
        render_import_diff(
            records,
            manifest,
            structural,
            prose,
            unresolved,
            materializes,
            merchants,
            visuals,
            scenes,
        ),
    )


def write_currency_rates_json(
    audit: Path,
    notes: list[NoteSections],
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    """OWV-17 generated runtime-bridge artifact for currency.

    Renders ``audit/currency-rates.json`` from authored coin items and
    any world-fact records that already carry a ``currency_rates``
    payload (the Greenhaven currency master note). The artifact is
    human-readable JSON (not JSONL) because consumers need it as one
    config blob, and it ships with stable slugs/mentions/copper
    values/source paths so the runtime bridge can wire it without
    re-parsing prose.
    """

    coins: list[dict[str, Any]] = []
    for note in notes:
        if note.entity.kind != "item":
            continue
        currency = parse_currency_values(note)
        if not currency:
            continue
        coins.append(
            {
                "slug": note.entity.slug,
                "mention": note.entity.mention,
                "copper_value": int(currency.get("copper_value", 1)),
                "source_path": note.entity.path,
            }
        )
    coins.sort(key=lambda row: (int(row.get("copper_value", 0)), str(row.get("slug") or "")))

    world_facts: list[dict[str, Any]] = []
    for record in records:
        if record.get("kind") != "world_fact":
            continue
        payload = record.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        rates = payload.get("currency_rates")
        if not isinstance(rates, dict) or not rates:
            continue
        world_facts.append(
            {
                "slug": record.get("slug"),
                "mention": payload.get("canonical_mention"),
                "source_path": payload.get("source_path"),
                "rates": dict(sorted(rates.items())),
            }
        )
    world_facts.sort(key=lambda row: str(row.get("slug") or ""))

    rates_doc: dict[str, Any] = {
        "schema_version": "greenhaven.currency_rates.v1",
        "source_project": PROJECT_SLUG,
        "coins": coins,
        "world_currency_facts": world_facts,
    }
    write_json(audit / "currency-rates.json", rates_doc)
    return rates_doc


def write_scene_instructions_jsonl(
    audit: Path,
    records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """OWV-17 generated runtime-bridge artifact for scene instructions.

    One JSONL row per scene record, flattened from the Forge scene
    payload so the runtime bridge can build behavior/state/visual
    instructions without traversing the full Forge tree. NPC-owned and
    location-owned scenes use the same shape; the ``owner_npc_slug``
    field is the differentiator.
    """

    rows: list[dict[str, Any]] = []
    for record in records:
        if record.get("kind") != "scene":
            continue
        payload = record.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        visual_assets = payload.get("visual_assets")
        first_visual: dict[str, Any] | None = None
        if isinstance(visual_assets, list) and visual_assets:
            candidate = visual_assets[0]
            if isinstance(candidate, dict):
                first_visual = {
                    "role": candidate.get("role"),
                    "path": candidate.get("path"),
                }
        rows.append(
            {
                "schema_version": "greenhaven.scene_instructions.v1",
                "scene_slug": record.get("slug"),
                "scene_mention": payload.get("canonical_mention"),
                "source_path": payload.get("source_path"),
                "source_kind": "scene",
                "location_slug": payload.get("location_slug"),
                "owner_npc_slug": payload.get("owner_npc_slug"),
                "participant_slugs": list(payload.get("participant_slugs") or []),
                "trigger": payload.get("trigger"),
                "priority": payload.get("priority"),
                "hook": payload.get("hook"),
                "beat_by_beat": payload.get("beat_by_beat"),
                "player_choices": payload.get("player_choices"),
                "memory_and_string_changes": payload.get("memory_and_string_changes"),
                "success_result": payload.get("success_result"),
                "failure_result": payload.get("failure_result"),
                "behavior": payload.get("behavior"),
                "model_instructions": list(payload.get("model_instructions") or []),
                "state_fields": list(payload.get("state_fields") or []),
                "do_not": payload.get("scene_do_not"),
                "voice": payload.get("voice"),
                "media_script": list(payload.get("media_script") or []),
                "visual_asset": first_visual,
            }
        )
    rows.sort(key=lambda row: str(row.get("scene_slug") or ""))
    write_jsonl(audit / "scene-instructions.jsonl", rows)
    return rows


def render_import_diff(
    records: list[dict[str, Any]],
    manifest: Any,
    structural: list[dict[str, str]],
    prose: list[dict[str, str]],
    unresolved: list[dict[str, str]],
    materializes: list[dict[str, Any]],
    merchants: list[dict[str, Any]],
    visuals: list[dict[str, Any]],
    scenes: list[dict[str, Any]] | None = None,
) -> str:
    counts: dict[str, int] = defaultdict(int)
    for record in records:
        counts[record["kind"]] += 1
    lines = [
        "# Obsidian Vault To Cartridge Forge Diff",
        "",
        f"Generated: {datetime.now().isoformat(timespec='seconds')}",
        "",
        "## Start Location",
        "",
        f"- wikilink: {manifest.start_wikilink or 'none'}",
        f"- mention: {manifest.start_mention or 'unresolved'}",
        f"- slug: {manifest.start_slug or 'unresolved'}",
        "",
        "## Record Counts",
    ]
    for kind, count in sorted(counts.items()):
        lines.append(f"- {kind}: {count}")
    lines.extend(
        [
            "",
            "## Link Counts",
            "",
            f"- structural: {len(structural)}",
            f"- prose: {len(prose)}",
            f"- unresolved: {len({(item['mention'], item['source']) for item in unresolved})}",
            f"- materializes: {len(materializes)}",
            f"- merchant offers: {len(merchants)}",
            f"- visual assets: {len(visuals)}",
            f"- scene instructions: {len(scenes or [])}",
            "",
            "## Records",
        ]
    )
    for record in sorted(records, key=lambda row: (row["kind"], row["slug"])):
        lines.append(
            f"- {record['kind']} `{record['slug']}` from `{record['payload']['source_path']}`"
        )
    return "\n".join(lines)


def render_unresolved(unresolved: list[dict[str, str]]) -> str:
    lines = ["# Unresolved Runtime Mentions", ""]
    unique = sorted({(item["mention"], item["source"]) for item in unresolved})
    if not unique:
        lines.append("- none")
    else:
        for mention, source in unique:
            lines.append(f"- {mention} in `{source}`")
    return "\n".join(lines)


def render_conflicts(duplicates: dict[str, list[Entity]]) -> str:
    lines = ["# Roundtrip Conflicts", ""]
    if not duplicates:
        lines.append("- none")
    else:
        for mention, group in sorted(duplicates.items()):
            paths = "; ".join(entity.path for entity in group)
            lines.append(f"- duplicate {mention}: {paths}")
    return "\n".join(lines)


def forge_kind(entity: Entity) -> str:
    if entity.kind == "note":
        return "world_fact"
    return entity.kind


def record_id(kind: str, slug: str) -> str:
    return f"ghc:{kind.replace('_', '-')}:{slug}"


def tags_for(kind: str, note: NoteSections) -> list[str]:
    tags = [kind, "obsidian-vault"]
    if kind == "person":
        tags.append("npc")
    if kind == "item" and parse_currency_values(note):
        tags.extend(["currency", "stackable"])
    if section(note, "sexual_appearance"):
        tags.append("adult-canon")
    return unique_strings(tags)


def risk_flags(note: NoteSections) -> list[str]:
    flags: list[str] = []
    if section(note, "sexual_appearance"):
        flags.append("adult-only-section")
    return flags


def density_role(kind: str, note: NoteSections) -> str:
    if kind == "location" and "market" in note.entity.slug:
        return "hidden_reveal"
    if kind == "location":
        return "hub_spoke"
    if kind == "quest":
        return "quest_site"
    return "none"


def first_location_slug(by_slug: dict[str, Entity]) -> str:
    for slug, entity in by_slug.items():
        if entity.kind == "location":
            return slug
    return "town-square"


def first_person_slug(by_slug: dict[str, Entity]) -> str:
    for slug, entity in by_slug.items():
        if entity.kind == "person":
            return slug
    return "mikka"


_DUPLICATE_CODES = frozenset(
    {"duplicate.slug", "duplicate.display_name", "duplicate.mention"}
)


def _raise_for_validation_errors(report: ValidationReport) -> None:
    """Translate error-severity findings into the appropriate exception.

    Duplicate-entity findings still raise :class:`DuplicateEntityError`
    so OWV-12's pre-write contract (and the existing duplicate test)
    stay green. Any other error-severity finding raises the more
    general :class:`ValidationError`. Both happen *before* any Forge
    project bytes hit disk.
    """

    if not report.has_errors:
        return
    duplicate_findings = [
        finding for finding in report.errors if finding.code in _DUPLICATE_CODES
    ]
    if duplicate_findings:
        lines = ["duplicate entities detected before Forge write:"]
        for finding in duplicate_findings:
            identity = finding.slug or finding.mention or "?"
            lines.append(f"  - {finding.code} `{identity}`: {finding.message}")
        raise DuplicateEntityError("\n".join(lines), report)
    raise ValidationError(report)


def scene_state_fields(note: NoteSections) -> list[dict[str, Any]]:
    slug = note.entity.slug
    return [
        {
            "key": f"{slug}_seen",
            "type": "bool",
            "default": False,
            "scope": "session",
            "description": f"Whether {note.entity.mention} has been used in this session.",
        }
    ]


def default_hooks(entity: Entity, note: NoteSections, child: dict[str, list[str]]) -> list[str]:
    hooks = [
        *child.get("contains_npc", []),
        *child.get("contains_item", []),
        *child.get("location_scene", []),
    ]
    if len(hooks) < 3:
        hooks.extend(get_slug(mention) for mention in mentions_in_text(note.entity.text))
    while len(hooks) < 3:
        hooks.append(f"{entity.slug}-hook-{len(hooks) + 1}")
    return unique_strings(hooks)[:5]


def mood_axes_for(entity: Entity) -> dict[str, int]:
    lowered = entity.display.lower()
    if "thief" in lowered:
        return {"warmth": -1, "danger": 3, "intimacy": 1, "pressure": 3}
    if "square" in lowered:
        return {"warmth": 1, "danger": 1, "intimacy": 0, "pressure": 2}
    return {"warmth": 0, "danger": 1, "intimacy": 0, "pressure": 1}


def infer_species(note: NoteSections) -> str:
    text = f"{note.entity.display} {section(note, 'identity')} {section(note, 'appearance')}".lower()
    if "гоблин" in text or "goblin" in text:
        return "goblin"
    return "human"


def infer_item_kind(note: NoteSections) -> str:
    text = note.entity.text.lower()
    if "контейнер" in text or "box" in text or "ящик" in text:
        return "container"
    if "бочки" in text or "fountain" in text or "stall" in text:
        return "fixture"
    return "item"


def sample_line(voice: str) -> str:
    for line in voice.splitlines():
        cleaned = line.strip("- ").strip()
        if cleaned:
            return short_text(cleaned, 140)
    return "Say what you mean before the street changes its mind."


def compact_list(values: Iterable[str]) -> list[str]:
    out = [short_text(value, 500) for value in values if value and value.strip()]
    return unique_strings(out)[:8]


def first_present(*values: str | None) -> str:
    for value in values:
        if value and value.strip():
            return value.strip()
    return ""


def unique_strings(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        cleaned = value.strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    return out


def dedupe_links(values: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, str]] = []
    for value in values:
        key = (value["rel"], value["target"])
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return sorted(out, key=lambda item: (item["rel"], item["target"]))


def normalize_dataclass_json(value: Any) -> Any:
    if isinstance(value, tuple):
        return [normalize_dataclass_json(item) for item in value]
    if isinstance(value, list):
        return [normalize_dataclass_json(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_dataclass_json(child) for key, child in value.items()}
    return value


def reset_output_dir(output: Path) -> None:
    generated = output.resolve()
    if generated.exists():
        if ".greenhaven-agent-manual" not in generated.parts or "generated" not in generated.parts:
            raise ValueError(f"Refusing to clean non-generated output path: {generated}")
        shutil.rmtree(generated)
    (generated / "records").mkdir(parents=True, exist_ok=True)
    (generated / "audit").mkdir(parents=True, exist_ok=True)


def write_json(path: Path, value: Any) -> None:
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def write_jsonl(path: Path, values: Iterable[dict[str, Any]]) -> None:
    text = "".join(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n" for value in values)
    write_text(path, text)


# ---------------------------------------------------------------------------
# OWV-13: merge / alias reconciliation against the donor cartridge
# ---------------------------------------------------------------------------


def default_current_cartridge_root() -> Path | None:
    """Locate the live ``grinhaven-full-current`` cartridge inside the repo.

    Returns ``None`` when the path doesn't exist (e.g. tests running
    outside the monorepo). Callers fall back to an empty donor index,
    which makes every generated record classify as ``new``.
    """

    # The script lives at
    # ``<repo>/GreenhavenWorld/.greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/compile_vault_to_forge.py``
    # so ``parents[5]`` is the repo root.
    try:
        repo_root = Path(__file__).resolve().parents[5]
    except IndexError:
        return None
    candidate = (
        repo_root
        / "packages"
        / "cartridge-forge"
        / "forge-projects"
        / "grinhaven-full-current"
    )
    return candidate if candidate.is_dir() else None


def load_current_cartridge_records(
    root: Path | None,
) -> dict[tuple[str, str], dict[str, Any]]:
    """Index donor cartridge records by ``(kind, slug)``.

    Empty mapping when ``root`` is ``None`` or missing — that lets
    test fixtures pin a small in-memory donor without paying for the
    full 1.3k-record cartridge on disk.
    """

    if root is None or not root.is_dir():
        return {}
    records_dir = root / "records"
    if not records_dir.is_dir():
        return {}
    by_slug: dict[tuple[str, str], dict[str, Any]] = {}
    for file in sorted(records_dir.iterdir()):
        if file.suffix != ".jsonl":
            continue
        try:
            text = file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            kind = str(record.get("kind") or "")
            slug = str(record.get("slug") or "")
            if kind and slug:
                by_slug.setdefault((kind, slug), record)
    return by_slug


def _extract_current_source_path(record: dict[str, Any]) -> str | None:
    """Read the authored source path from a donor cartridge record.

    Two shapes are supported because the donor cartridge is mixed:

    * Compiled-from-vault rows expose ``payload.source_path`` directly.
    * ``imported-current`` rows store the original SQL provenance as a
      JSON-encoded string under ``payload.db_profile_json``; the
      ``source_path`` lives one level deeper inside that blob.

    Returns ``None`` when neither shape produces a usable path.
    """

    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    direct = payload.get("source_path")
    if isinstance(direct, str) and direct.strip():
        return direct
    raw = payload.get("db_profile_json")
    if isinstance(raw, str) and raw.strip():
        try:
            decoded = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if isinstance(decoded, dict):
            path = decoded.get("source_path")
            if isinstance(path, str) and path.strip():
                return path
    return None


def reconcile_against_current_cartridge(
    records: list[dict[str, Any]],
    current_root: Path | None,
) -> list[dict[str, Any]]:
    """Classify every generated record against the donor cartridge.

    Each returned row carries:

    * ``kind``, ``slug``, ``canonical_name``, ``canonical_mention``,
      ``source_path`` — generated-side identity.
    * ``status`` — one of :data:`MERGE_STATUS_EXACT_SLUG`,
      :data:`MERGE_STATUS_SOURCE_PATH`, :data:`MERGE_STATUS_NEW`,
      :data:`MERGE_STATUS_AMBIGUOUS`.
    * ``current_cartridge_slug`` — donor slug we'd merge against,
      or ``None`` when the status is ``new`` / ``ambiguous_conflict``.
    * ``notes`` — list of strings explaining ambiguity.

    Rows are sorted by ``(kind, slug, source_path)`` so repeated runs
    produce byte-identical audit JSONL.
    """

    current_by_slug = load_current_cartridge_records(current_root)
    current_by_kind_path: dict[tuple[str, str], dict[str, Any]] = {}
    for (kind, _slug), record in current_by_slug.items():
        source_path = _extract_current_source_path(record)
        if source_path:
            current_by_kind_path.setdefault((kind, source_path), record)

    rows: list[dict[str, Any]] = []
    for record in records:
        kind = str(record.get("kind") or "")
        slug = str(record.get("slug") or "")
        if not kind or not slug:
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        source_path = payload.get("source_path") if isinstance(payload, dict) else None
        canonical_mention = payload.get("canonical_mention") if isinstance(payload, dict) else None
        slug_hit = current_by_slug.get((kind, slug))
        path_hit = (
            current_by_kind_path.get((kind, source_path))
            if isinstance(source_path, str) and source_path
            else None
        )

        status = MERGE_STATUS_NEW
        target_current_slug: str | None = None
        notes: list[str] = []
        if slug_hit and path_hit and slug_hit.get("slug") != path_hit.get("slug"):
            status = MERGE_STATUS_AMBIGUOUS
            notes.append(
                "slug matched donor "
                f"`{slug_hit.get('slug')}` but source_path matched donor "
                f"`{path_hit.get('slug')}`"
            )
        elif slug_hit:
            status = MERGE_STATUS_EXACT_SLUG
            target_current_slug = str(slug_hit.get("slug") or "")
        elif path_hit:
            status = MERGE_STATUS_SOURCE_PATH
            target_current_slug = str(path_hit.get("slug") or "")
            notes.append(
                f"source_path matched donor `{target_current_slug}` "
                "(slug differs from generated)"
            )

        rows.append(
            {
                "schema_version": "greenhaven.merge_records.v1",
                "kind": kind,
                "slug": slug,
                "canonical_name": str(record.get("canonical_name") or ""),
                "canonical_mention": str(canonical_mention or ""),
                "source_path": str(source_path or ""),
                "status": status,
                "current_cartridge_slug": target_current_slug,
                "notes": notes,
            }
        )

    # Second ambiguity shape: multiple generated records collapse onto
    # the same donor slug. Reclassify every collider to
    # ``ambiguous_conflict`` so the writer is warned about the merge
    # collision rather than silently overwriting one identity with
    # another at SQL export time.
    by_target: dict[tuple[str, str], list[int]] = {}
    for idx, row in enumerate(rows):
        target = row.get("current_cartridge_slug")
        if not target:
            continue
        by_target.setdefault((row["kind"], str(target)), []).append(idx)
    for (kind, target), indices in by_target.items():
        if len(indices) <= 1:
            continue
        for idx in indices:
            row = rows[idx]
            row["status"] = MERGE_STATUS_AMBIGUOUS
            existing_notes = list(row.get("notes") or [])
            existing_notes.append(
                f"multiple generated records map onto donor `{kind}:{target}`"
            )
            row["notes"] = existing_notes
            row["current_cartridge_slug"] = None

    rows.sort(
        key=lambda row: (
            str(row.get("kind") or ""),
            str(row.get("slug") or ""),
            str(row.get("source_path") or ""),
        )
    )
    return rows


def render_merge_conflicts(rows: list[dict[str, Any]]) -> str:
    """Human-readable merge/alias conflict report (OWV-13).

    Always returns a single trailing newline so the file is stable for
    grep/diff and the clean 34-record demo produces a deterministic
    ``- none`` marker.
    """

    conflicts = [row for row in rows if row.get("status") == MERGE_STATUS_AMBIGUOUS]
    lines = ["# Merge Alias Conflicts", ""]
    if not conflicts:
        lines.append("- none")
        return "\n".join(lines) + "\n"
    lines.append(
        "Each entry below blocks SQL export. Resolve by renaming the "
        "generated entity to a unique slug, merging the duplicate vault "
        "note, or accepting the donor identity in a follow-up merge pass."
    )
    lines.append("")
    for row in conflicts:
        notes = "; ".join(row.get("notes") or []) or "ambiguous reconciliation"
        lines.append(
            f"- **{row.get('kind')}** `{row.get('slug')}` "
            f"(source `{row.get('source_path') or 'unknown'}`): {notes}."
        )
    return "\n".join(lines) + "\n"


def collect_numeric_db_id_violations(
    records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return any generated record whose payload carries a numeric DB id.

    The donor cartridge stores its SQL-side identifiers under keys in
    :data:`NUMERIC_DB_ID_KEYS`. A freshly compiled record must never
    carry those — its identity is the ``(kind, slug, source_path)``
    triple. We block SQL export when a violation appears so a future
    refactor doesn't silently leak donor state into the writer-facing
    pipeline.
    """

    out: list[dict[str, Any]] = []
    for record in records:
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        for key in sorted(NUMERIC_DB_ID_KEYS):
            if key in payload:
                out.append(
                    {
                        "record_id": str(record.get("record_id") or ""),
                        "kind": str(record.get("kind") or ""),
                        "slug": str(record.get("slug") or ""),
                        "key": key,
                        "value": payload[key],
                    }
                )
                break
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compile GreenhavenWorld vault into a Cartridge Forge project.")
    parser.add_argument(
        "--vault-root",
        default=str(default_vault_root(__file__)),
        help="Path to GreenhavenWorld vault root.",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help="Output directory. Defaults to .greenhaven-agent-manual/generated/cartridge-forge-project.",
    )
    parser.add_argument(
        "--current-cartridge",
        default=None,
        help=(
            "Path to the donor cartridge (`grinhaven-full-current`) used "
            "by OWV-13 merge/alias reconciliation. Defaults to the live "
            "cartridge inside the monorepo."
        ),
    )
    parser.add_argument(
        "--world-dir",
        default=None,
        help="Active world content directory under the vault root.",
    )
    args = parser.parse_args(argv)
    report = compile_vault(
        Path(args.vault_root),
        Path(args.out_dir).resolve() if args.out_dir else None,
        Path(args.current_cartridge).resolve() if args.current_cartridge else None,
        args.world_dir,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
