from __future__ import annotations

from pathlib import Path

from compile_vault_to_forge import item_payload, location_payload, quest_payload
from vault_scan import Entity
from vault_sections import (
    NoteSections,
    parse_companion_rule_contract,
    parse_quest_sections,
    parse_quest_reward_contract,
    parse_relationship_trigger_rules,
    section,
    split_sections,
)


def make_note(kind: str, slug: str, display: str, text: str) -> NoteSections:
    path = f"GreenHavenWorld/Locations/@Test/{display}Mind.md"
    entity = Entity(
        display=display,
        mention=f"@{display}",
        kind=kind,
        slug=slug,
        path=path,
        abs_path=Path(path),
        owner=None,
        parent=None,
        relation=None,
        text=text,
        parts=tuple(path.split("/")),
    )
    heading, sections = split_sections(text)
    return NoteSections(entity=entity, heading=heading, sections=sections)


def assert_equal(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def test_location_english_headings() -> None:
    note = make_note(
        "location",
        "test-plaza",
        "Test Plaza",
        """# @Test Plaza

## Place Canon
Canonical location frame.

## Location Brief
Brief for narrator.

## First Entry Bubble
The first time the player enters, the plaza answers with bells.

## Sensory Identity
Warm stone, orange peel, brass bells.

## Visible Exits
North to @North Gate, east to @Dawn Steps.

## Points Of Interest
The fountain, the notice board, the laughing courier.

## Immediate Player Actions
Read the board; question the courier; inspect the fountain.

## Hostile And Rival Pressure
A rival crew watches from the awning.

## Adventure Threat
A hatch below the fountain shakes when nobody is touching it.

## Memory And Consequence Hooks
If helped, the courier remembers the player.

## Public Scenes
- @Bell Argument

## Companion Stake
The guide decides whether the hero is worth following.

## Establishing Image Brief
Square adventure-fantasy plaza art.

## Do Not Do Here
Do not make the plaza empty.
""",
    )
    payload = location_payload(
        note,
        {note.entity.slug: note.entity},
        {},
        {},
    )
    assert_equal(payload["location_canon"], "Canonical location frame.", "location_canon")
    assert_equal(payload["location_brief"], "Brief for narrator.", "location_brief")
    assert_equal(
        payload["first_entry_bubble"],
        "The first time the player enters, the plaza answers with bells.",
        "first_entry_bubble",
    )
    assert_equal(payload["sensory_identity"], "Warm stone, orange peel, brass bells.", "sensory_identity")
    assert_equal(
        payload["visible_exits_prose"],
        "North to @North Gate, east to @Dawn Steps.",
        "visible_exits_prose",
    )
    assert_equal(
        payload["points_of_interest"],
        "The fountain, the notice board, the laughing courier.",
        "points_of_interest",
    )
    assert_equal(
        payload["immediate_player_actions"],
        "Read the board; question the courier; inspect the fountain.",
        "immediate_player_actions",
    )
    assert_equal(
        payload["hostile_pressure"],
        "A rival crew watches from the awning.",
        "hostile_pressure",
    )
    assert_equal(
        payload["adventure_threat"],
        "A hatch below the fountain shakes when nobody is touching it.",
        "adventure_threat",
    )
    assert_equal(
        payload["location_memory_hooks"],
        "If helped, the courier remembers the player.",
        "location_memory_hooks",
    )
    assert_equal(payload["public_scenes_prose"], "- @Bell Argument", "public_scenes_prose")
    assert_equal(
        payload["companion_stake"],
        "The guide decides whether the hero is worth following.",
        "companion_stake",
    )
    assert_equal(
        payload["establishing_image_brief"],
        "Square adventure-fantasy plaza art.",
        "establishing_image_brief",
    )
    assert_equal(payload["location_rules"], "Do not make the plaza empty.", "location_rules")


def test_gamemasters_v2_explanatory_heading_suffixes() -> None:
    location = make_note(
        "location",
        "manual-port",
        "Manual Port",
        """# @Manual Port

## First Entry Bubble — первый кадр
The port opens with sun, salt, and trouble under the planks.

## Place Canon — паспорт места
A bright harbor hub for first adventures.

## Sensory Identity — пять чувств
Salt wind, warm pitch, orange peel, gull cries, polished rope.

## Visible Exits — куда можно пойти
Up to @Manual Square.

## Points Of Interest — что здесь можно потрогать
The notice post, blue cellar hatch, customs desk.

## Immediate Player Actions — первые движения
Read the notice, question the clerk, listen under the warehouse.

## Hostile And Rival Pressure — угрозы
Black-banded dockers are watching arrivals.

## Memory And Consequence Hooks — что мир запомнит
Public accusations at the pier become permanent port gossip.

## Establishing Image Brief — брифинг общей картинки
Square sunlit harbor establishing art.

## Do Not Do Here — границы повествователя
Do not make the port safe or empty.
""",
    )
    location_out = location_payload(location, {location.entity.slug: location.entity}, {}, {})
    assert_equal(
        location_out["first_entry_bubble"],
        "The port opens with sun, salt, and trouble under the planks.",
        "manual first_entry_bubble",
    )
    assert_equal(location_out["location_canon"], "A bright harbor hub for first adventures.", "manual location_canon")
    assert_equal(location_out["hostile_pressure"], "Black-banded dockers are watching arrivals.", "manual hostile_pressure")
    assert_equal(location_out["location_rules"], "Do not make the port safe or empty.", "manual location_rules")

    item = make_note(
        "item",
        "manual-token",
        "Manual Token",
        """# @Manual Token

## Item Canon — паспорт предмета
A stamped brass ferry token.

## Description — описание
Warm brass with a tiny sunburst.

## Usage — как использовать
Spend it to claim one ferry favor.

## Visual Brief — брифинг иконки
Square brass token icon.

## Do Not Do Here — границы повествователя
Do not treat it as generic coin loot.
""",
    )
    item_out = item_payload(item, {item.entity.slug: item.entity})
    assert_equal(item_out["item_canon"], "A stamped brass ferry token.", "manual item_canon")
    assert_equal(item_out["item_description"], "Warm brass with a tiny sunburst.", "manual item_description")
    assert_equal(item_out["item_usage"], "Spend it to claim one ferry favor.", "manual item_usage")
    assert_equal(item_out["visual_brief"], "Square brass token icon.", "manual item_visual_brief")
    assert_equal(item_out["do_not_do_here"], "Do not treat it as generic coin loot.", "manual item_do_not")

    npc = make_note(
        "person",
        "manual-npc",
        "Manual NPC",
        """# @Manual NPC

## Identity — кто я
I am a named witness with a reason to stay.

## Role — роль в мире
Quest giver and possible companion.

## Relationship Triggers — что движет отношения
+strings: hero protects witnesses.

## Companion Rules — правила спутничества
- Join condition: hero proves the route is safe.

## Appearance For Portrait — брифинг портрета
Bright square portrait prompt.
""",
    )
    assert_equal(section(npc, "identity"), "I am a named witness with a reason to stay.", "manual npc identity")
    assert_equal(section(npc, "npc_role"), "Quest giver and possible companion.", "manual npc role")
    assert_equal(section(npc, "npc_relationship_triggers"), "+strings: hero protects witnesses.", "manual npc relationship triggers")
    assert_equal(section(npc, "npc_companion_rules"), "- Join condition: hero proves the route is safe.", "manual npc companion rules")
    assert_equal(section(npc, "npc_appearance_for_portrait"), "Bright square portrait prompt.", "manual npc portrait")

    scene = make_note(
        "scene",
        "manual-scene",
        "Manual Scene",
        """# @Manual Scene

## Where And When — где и когда
Triggers when the witness sees the hero read the notice.

## Beat By Beat — покадровый сценарий
1. The witness steps into the sun.
2. The player chooses whether to listen.

## Player Choices — выборы игрока
- Listen.
- Walk away.

## Memory And String Changes
The witness remembers the first answer.

## Do Not Do Here — границы повествователя
Do not resolve the mystery off-screen.
""",
    )
    assert_equal(section(scene, "scene_trigger"), "Triggers when the witness sees the hero read the notice.", "manual scene trigger")
    assert_equal(section(scene, "scene_beat_by_beat"), "1. The witness steps into the sun.\n2. The player chooses whether to listen.", "manual scene beats")
    assert_equal(section(scene, "scene_player_choices"), "- Listen.\n- Walk away.", "manual scene choices")
    assert_equal(section(scene, "scene_memory_and_string_changes"), "The witness remembers the first answer.", "manual scene memory")
    assert_equal(section(scene, "scene_do_not"), "Do not resolve the mystery off-screen.", "manual scene do not")

    quest = make_note(
        "quest",
        "manual-quest",
        "Manual Quest",
        """# @Manual Quest

## Source — источник
- Giver: @Manual NPC

## Hook — крючок
The notice trembles in the harbor wind.

## Objective — цель
Find why the passenger did not arrive.

## Stages — этапы
1. Talk to @Manual NPC.
2. Inspect @Manual Port.

## Reward And Consequence — награды и последствия
The harbor route opens.

## Do Not Do Here — границы повествователя
Do not reveal the culprit before the evidence.
""",
    )
    assert_equal(section(quest, "quest_source"), "- Giver: @Manual NPC", "manual quest source")
    assert_equal(section(quest, "quest_hook"), "The notice trembles in the harbor wind.", "manual quest hook")
    assert_equal(section(quest, "quest_objective"), "Find why the passenger did not arrive.", "manual quest objective")
    assert_equal(section(quest, "quest_rewards"), "The harbor route opens.", "manual quest rewards")
    assert_equal(section(quest, "quest_failure"), "Do not reveal the culprit before the evidence.", "manual quest do not")


def test_item_english_headings() -> None:
    note = make_note(
        "item",
        "test-token",
        "Test Token",
        """# @Test Token

## Item Canon
A stamped brass token.

## Description
Warm brass with a sunburst edge.

## Usage
Spend it to claim a ferry favor.

## Threat Profile
The token marks the holder for a public dare.

## Cross-Hub Reach
The dare follows the holder from the guild to the square.

## Visual Brief
Square icon, brass token, saturated adventure palette.

## Do Not Do Here
Do not let the token become generic coin loot.
""",
    )
    payload = item_payload(note, {note.entity.slug: note.entity})
    assert_equal(payload["item_canon"], "A stamped brass token.", "item_canon")
    assert_equal(payload["item_description"], "Warm brass with a sunburst edge.", "item_description")
    assert_equal(payload["item_usage"], "Spend it to claim a ferry favor.", "item_usage")
    assert_equal(
        payload["threat_profile"],
        "The token marks the holder for a public dare.",
        "threat_profile",
    )
    assert_equal(
        payload["cross_hub_reach"],
        "The dare follows the holder from the guild to the square.",
        "cross_hub_reach",
    )
    assert_equal(
        payload["visual_brief"],
        "Square icon, brass token, saturated adventure palette.",
        "visual_brief",
    )
    assert_equal(
        payload["do_not_do_here"],
        "Do not let the token become generic coin loot.",
        "do_not_do_here",
    )


def test_scene_beat_by_beat_does_not_become_behavior() -> None:
    note = make_note(
        "scene",
        "test-scene",
        "Test Scene",
        """# @Test Scene

## Beat By Beat
1. The rival blocks the door.
2. The player chooses pressure or charm.

## Scene State
Track whether the door is open.
""",
    )
    assert_equal(
        section(note, "scene_beat_by_beat"),
        "1. The rival blocks the door.\n2. The player chooses pressure or charm.",
        "scene_beat_by_beat",
    )
    assert_equal(section(note, "scene_behavior"), "", "scene_behavior")
    assert_equal(section(note, "scene_state"), "Track whether the door is open.", "scene_state")


def test_legacy_scene_and_quest_headings() -> None:
    scene = make_note(
        "scene",
        "short-scene",
        "Short Scene",
        """# @Short Scene

## Trigger
When the bell rings twice.

## Scene
The rival blocks the stairs.

## Player Choice
- Press forward.
- Look for the witness.
""",
    )
    assert_equal(section(scene, "scene_trigger"), "When the bell rings twice.", "scene_trigger")
    assert_equal(section(scene, "scene_behavior"), "The rival blocks the stairs.", "scene_behavior")
    assert_equal(
        section(scene, "scene_player_choices"),
        "- Press forward.\n- Look for the witness.",
        "scene_player_choices",
    )

    quest = make_note(
        "quest",
        "short-quest",
        "Short Quest",
        """# @Short Quest

## Given By
@Test Giver at the blue gate.
""",
    )
    assert_equal(section(quest, "quest_source"), "@Test Giver at the blue gate.", "quest_source")


def test_memory_hooks_are_kind_specific() -> None:
    npc = make_note(
        "person",
        "memory-npc",
        "Memory NPC",
        """# @Memory NPC

## Memory Hooks
Remember public mercy.
""",
    )
    scene = make_note(
        "scene",
        "memory-scene",
        "Memory Scene",
        """# @Memory Scene

## Memory Hooks
Write a string when the witness forgives the hero.
""",
    )

    assert_equal(section(npc, "npc_memory_hooks"), "Remember public mercy.", "npc_memory_hooks")
    assert_equal(
        section(scene, "scene_memory_and_string_changes"),
        "Write a string when the witness forgives the hero.",
        "scene_memory_and_string_changes",
    )


def test_quest_stages_emit_runtime_ids_and_linear_links() -> None:
    quest = make_note(
        "quest",
        "runtime-quest",
        "Runtime Quest",
        """# @Runtime Quest

## Stages
1. Talk to @Manual NPC.
2. Inspect @Manual Port.
3. Return to @Manual NPC.
""",
    )
    payload = quest_payload(quest, {quest.entity.slug: quest.entity}, {}, {}, [quest])
    stages = payload["stages"]
    assert_equal(stages[0]["id"], "stage-1", "stage 1 id")
    assert_equal(stages[0]["stage_slug"], "stage-1", "stage 1 stage_slug alias")
    assert_equal(stages[0]["next_stage"], "stage-2", "stage 1 next")
    assert_equal(stages[1]["id"], "stage-2", "stage 2 id")
    assert_equal(stages[1]["next_stage"], "stage-3", "stage 2 next")
    assert_equal(stages[2]["id"], "stage-3", "stage 3 id")
    assert_equal("next_stage" in stages[2], False, "terminal stage has no next")


def test_quest_choice_and_timer_from_gamemasters_v2_markdown() -> None:
    quest = make_note(
        "quest",
        "branching-quest",
        "Branching Quest",
        """# @Branching Quest

## Stages
1. Find the companion.
2. Choose the route.
3. next_stage:
   - kind: choice
   - options:
     - target_stage_id: harbour_route
       label: Take the harbour route
       prerequisites:
         - type: skill_check
           skill: sailing
           dc: 12
     - target_stage_id: street_route
       label: Take the street route
4. harbour_route: Cross the harbour with @Manual NPC.
   - turns_remaining: 5
   - timeout_action: advance_to
   - timeout_target: street_route
5. street_route: Cross the market street.
""",
    )
    parsed = parse_quest_sections(quest)
    assert_equal(parsed.stages[1].next_stage["kind"], "choice", "choice kind")
    options = parsed.stages[1].next_stage["options"]
    assert_equal(options[0]["target_stage_id"], "harbour_route", "first choice target")
    assert_equal(options[0]["prerequisites"][0]["dc"], 12, "choice prerequisite dc")
    assert_equal(parsed.stages[2].stage_id, "harbour_route", "explicit branch id")
    assert_equal(parsed.stages[2].turns_remaining, 5, "timer turns")
    assert_equal(
        parsed.stages[2].on_timeout,
        {"action": "advance_to", "target_stage_id": "street_route"},
        "timer timeout",
    )

    payload = quest_payload(quest, {quest.entity.slug: quest.entity}, {}, {}, [quest])
    stages = payload["stages"]
    assert_equal(stages[1]["next_stage"]["kind"], "choice", "payload choice kind")
    assert_equal(stages[2]["id"], "harbour_route", "payload branch id")
    assert_equal(stages[2]["turns_remaining"], 5, "payload timer")
    assert_equal(stages[2]["on_timeout"]["target_stage_id"], "street_route", "payload timeout target")


def test_npc_relationship_triggers_parse_to_typed_rules() -> None:
    rules = parse_relationship_trigger_rules(
        """+strings:

- The hero protects @Mara Sunledger in public.
- The hero exposes the smuggler's wax pattern
  before accepting any reward.

-strings:

- The hero sells the witness to @Rook Vargan.
"""
    )

    assert_equal(len(rules), 3, "relationship rule count")
    assert_equal(rules[0]["kind"], "strings_delta", "relationship rule kind")
    assert_equal(rules[0]["delta"], 1, "positive strings delta")
    assert_equal(
        rules[0]["mentions"],
        ["@Mara Sunledger"],
        "positive trigger mentions",
    )
    assert_equal(
        rules[1]["condition"],
        "The hero exposes the smuggler's wax pattern before accepting any reward.",
        "wrapped relationship trigger",
    )
    assert_equal(rules[2]["delta"], -1, "negative strings delta")
    assert_equal(rules[2]["mentions"], ["@Rook Vargan"], "negative trigger mentions")


def test_npc_companion_rules_parse_to_contract() -> None:
    contract = parse_companion_rule_contract(
        """- Join condition: the hero protects @Mara Sunledger.
- Refusal condition: the hero takes @Rook Vargan's offer.
- Loyalty pressure: I will not enter @Greenhaven Adventurers' Guild while Cassian is unexposed.
- Depart condition: the hero abandons two civilians in a row.
- How I follow: I scout roofs and mark exits in chalk.
- Inventory baseline: curved blade, pins, compass.
- New-world reaction (cartridge travel): I follow into one later cartridge if trust is earned.
"""
    )

    assert contract is not None
    assert_equal(contract["schema_version"], "greenhaven.companion_rules.v1", "companion schema")
    assert_equal(contract["can_be_companion"], True, "companion flag")
    assert_equal(contract["portability"], "conditional_portable", "companion portability")
    rules = contract["rules"]
    assert_equal(len(rules), 7, "companion rule count")
    assert_equal(rules[0]["kind"], "join_condition", "join rule kind")
    assert_equal(rules[1]["kind"], "refusal_condition", "refusal rule kind")
    assert_equal(rules[2]["kind"], "loyalty_pressure", "loyalty rule kind")
    assert_equal(rules[3]["kind"], "depart_condition", "depart rule kind")
    assert_equal(rules[4]["kind"], "follow_style", "follow rule kind")
    assert_equal(rules[5]["kind"], "inventory_baseline", "inventory rule kind")
    assert_equal(rules[6]["kind"], "new_world_reaction", "new-world rule kind")
    assert_equal(rules[0]["mentions"], ["@Mara Sunledger"], "join mentions")


def test_quest_reward_contract_parses_supported_rewards_and_manuals() -> None:
    rewards = parse_quest_reward_contract(
        """- +10 XP
- +strings with `@Mara Sunledger` if the testimony is handled well.
- Strong +strings with `@Tessa Wrenlight` and `@Orren Sealward`.
- -strings with `@Rook Vargan` if the hero exposes his proxy.
- Inventory: `@Guild Trust Token` x2.
- Status: `@Rook Vargan` hostile = exposed fixer, intensity=0.8.
- Companion: `@Tessa Wrenlight` becomes the hero's first companion.
"""
    )

    assert_equal(rewards["schema_version"], "greenhaven.quest_rewards.v1", "quest reward schema")
    assert_equal(rewards["xp"], 10, "quest reward xp")
    strings = rewards["strings"]
    assert_equal(len(strings), 4, "quest reward string count")
    assert_equal(strings[0]["npc"], "@Mara Sunledger", "positive string npc")
    assert_equal(strings[0]["delta"], 1, "positive string delta")
    assert_equal(strings[1]["npc"], "@Tessa Wrenlight", "multi string first npc")
    assert_equal(strings[1]["delta"], 2, "strong positive string delta")
    assert_equal(strings[2]["npc"], "@Orren Sealward", "multi string second npc")
    assert_equal(strings[3]["npc"], "@Rook Vargan", "negative string npc")
    assert_equal(strings[3]["delta"], -1, "negative string delta")
    assert_equal(
        rewards["items"],
        [
            {
                "item": "@Guild Trust Token",
                "count": 2,
                "reason": "Inventory: `@Guild Trust Token` x2.",
            }
        ],
        "inventory reward",
    )
    assert_equal(rewards["statuses"][0]["actor"], "@Rook Vargan", "status actor")
    assert_equal(rewards["statuses"][0]["status_kind"], "hostile", "status kind")
    assert_equal(rewards["statuses"][0]["intensity"], 0.8, "status intensity")
    assert_equal(
        rewards["companions"],
        [
            {
                "npc": "@Tessa Wrenlight",
                "action": "follow",
                "reason": "Companion: `@Tessa Wrenlight` becomes the hero's first companion.",
            }
        ],
        "companion reward",
    )
    assert_equal("manual_only" in rewards, False, "companion reward no longer manual-only")


def main() -> None:
    test_location_english_headings()
    test_gamemasters_v2_explanatory_heading_suffixes()
    test_item_english_headings()
    test_scene_beat_by_beat_does_not_become_behavior()
    test_legacy_scene_and_quest_headings()
    test_memory_hooks_are_kind_specific()
    test_quest_stages_emit_runtime_ids_and_linear_links()
    test_quest_choice_and_timer_from_gamemasters_v2_markdown()
    test_npc_relationship_triggers_parse_to_typed_rules()
    test_npc_companion_rules_parse_to_contract()
    test_quest_reward_contract_parses_supported_rewards_and_manuals()


if __name__ == "__main__":
    main()
