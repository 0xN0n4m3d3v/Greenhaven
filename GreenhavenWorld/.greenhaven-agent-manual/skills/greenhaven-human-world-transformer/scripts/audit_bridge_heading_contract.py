from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path
import sys

from vault_scan import default_vault_root, scan_vault
from vault_sections import SECTION_ALIASES, normalize_heading, split_sections


KIND_SECTION_KEYS: dict[str, set[str]] = {
    "location": {
        "location_canon",
        "location_brief",
        "location_rules",
        "location_first_entry",
        "location_sensory_identity",
        "location_visible_exits",
        "location_points_of_interest",
        "location_immediate_actions",
        "location_hostile_pressure",
        "location_adventure_threat",
        "location_memory_hooks",
        "location_establishing_image",
        "location_public_scenes",
        "location_companion_stake",
        "materializes",
    },
    "item": {
        "item_canon",
        "item_description",
        "item_usage",
        "item_threat_profile",
        "item_cross_hub_reach",
        "item_visual_brief",
        "item_do_not",
        "materializes",
    },
    "person": {
        "identity",
        "appearance",
        "sexual_appearance",
        "voice",
        "relationship",
        "romance",
        "skills",
        "behavior",
        "merchant",
        "materializes",
        "inventory",
        "npc_role",
        "npc_want",
        "npc_fear",
        "npc_secret",
        "npc_routine",
        "npc_relationship_triggers",
        "npc_memory_hooks",
        "npc_companion_rules",
        "npc_appearance_for_portrait",
    },
    "quest": {
        "quest_source",
        "quest_hook",
        "quest_objective",
        "quest_stages",
        "quest_rewards",
        "quest_failure",
        "quest_success_result",
        "quest_failure_result",
        "materializes",
    },
    "scene": {
        "scene_trigger",
        "scene_hook",
        "scene_behavior",
        "scene_state",
        "scene_do_not",
        "scene_beat_by_beat",
        "scene_player_choices",
        "scene_memory_and_string_changes",
        "scene_success_result",
        "scene_failure_result",
        "materializes",
    },
}


def bridge_heading_index() -> dict[str, list[str]]:
    index: dict[str, list[str]] = defaultdict(list)
    for canonical, aliases in SECTION_ALIASES.items():
        for alias in aliases:
            index[normalize_heading(alias)].append(canonical)
    return index


def bridge_heading_index_for_kind(kind: str) -> dict[str, list[str]]:
    allowed = KIND_SECTION_KEYS.get(kind)
    if not allowed:
        return bridge_heading_index()
    index: dict[str, list[str]] = defaultdict(list)
    for canonical in sorted(allowed):
        aliases = SECTION_ALIASES.get(canonical, {canonical})
        for alias in aliases:
            index[normalize_heading(alias)].append(canonical)
    return index


def main(argv: list[str] | None = None) -> int:
    argv = argv or sys.argv[1:]
    vault_root = Path(argv[0]).resolve() if argv else default_vault_root(__file__)
    alias_index = bridge_heading_index()
    alias_index_by_kind = {
        kind: bridge_heading_index_for_kind(kind) for kind in KIND_SECTION_KEYS
    }
    unknown: dict[str, Counter[str]] = defaultdict(Counter)
    unsupported_for_kind: dict[str, Counter[str]] = defaultdict(Counter)

    for entity in scan_vault(vault_root):
        _, sections = split_sections(entity.text)
        kind_alias_index = alias_index_by_kind.get(entity.kind, alias_index)
        for heading in sections:
            if heading not in alias_index:
                unknown[entity.kind][heading] += 1
            elif heading not in kind_alias_index:
                unsupported_for_kind[entity.kind][heading] += 1

    if not unknown and not unsupported_for_kind:
        print("ok: all visible vault headings are known to kind-aware SECTION_ALIASES")
        return 0

    print("error: visible vault has unsupported bridge headings")
    for kind in sorted(unknown):
        print(f"{kind} - unknown globally")
        for heading, count in unknown[kind].most_common():
            print(f"  {count:3} {heading}")
    for kind in sorted(unsupported_for_kind):
        print(f"{kind} - known alias, but not supported for this entity kind")
        for heading, count in unsupported_for_kind[kind].most_common():
            print(f"  {count:3} {heading}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
