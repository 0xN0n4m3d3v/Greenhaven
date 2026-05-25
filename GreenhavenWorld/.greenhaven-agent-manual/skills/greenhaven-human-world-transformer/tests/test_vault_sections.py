"""Focused unittests for ``vault_sections.py``.

OWV-12 — pin the parser surface the compiler depends on so the human-
first vault contract doesn't drift silently:

* manifest start-location wikilink resolves to an entity ``@mention``;
* section aliases (Russian + English) resolve into the same canonical
  key (``Appearance`` ≠ ``Sexual Appearance``);
* ``public_summary`` prefers safe sections, never leaks adult-only
  appearance text;
* ``parse_materializes`` decodes entity/type/scope/effect blocks;
* ``parse_merchant_offers`` sums coin totals in copper across
  multi-coin lines;
* ``parse_currency_values`` reads copper / silver / gold defaults;
* ``mentions_in_text`` keeps exact ``@Display`` casing across mixed
  Russian/English prose;
* ``parse_quest_sections`` decodes source / hook / objective / stages /
  rewards / failure / mentions / materialized slugs;
* ``duplicate_slugs`` / ``duplicate_display_names`` surface vault
  collisions so the compiler can fail before writing the Forge project;
* ``compile_vault_to_forge._ensure_unique_entities`` raises
  ``DuplicateEntityError`` on a duplicate-slug fixture vault.
"""

from __future__ import annotations

import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import compile_vault_to_forge as compiler  # noqa: E402
import vault_scan  # noqa: E402
import vault_sections as vs  # noqa: E402


def make_entity(
    *,
    display: str,
    kind: str,
    path: str,
    text: str,
    owner: str | None = None,
    parent: str | None = None,
    relation: str | None = None,
) -> vault_scan.Entity:
    """Build a minimal ``Entity`` directly from a text fixture.

    Tests usually don't need a real vault on disk: every helper under
    test takes either an ``Entity`` or a ``NoteSections`` and only
    reads the ``.text``/``.path``/``.kind``/``.display`` fields.
    """

    parts = tuple(path.split("/"))
    return vault_scan.Entity(
        display=display,
        mention=f"@{display}",
        kind=kind,
        slug=vault_scan.get_slug(display),
        path=path,
        abs_path=Path(path),
        owner=owner,
        parent=parent,
        relation=relation,
        text=text,
        parts=parts,
    )


def make_note(**kwargs) -> vs.NoteSections:
    entity = make_entity(**kwargs)
    return vs.note_sections(entity)


class SectionAliasTests(unittest.TestCase):
    def test_english_and_russian_aliases_resolve_to_same_key(self) -> None:
        text = textwrap.dedent(
            """
            # @Mikka

            ## Внешний вид

            Невысокая, рыжие волосы, шрам через бровь.

            ## Sexual Appearance

            21+ details should never leak into the public appearance.
            """
        ).strip()
        note = make_note(
            display="Mikka",
            kind="person",
            path="GreenHavenWorld/Locations/@Town square/npc/@Mikka/MikkaMind.md",
            text=text,
        )
        self.assertIn("рыжие волосы", vs.section(note, "appearance"))
        self.assertIn(
            "21+", vs.section(note, "sexual_appearance"),
        )
        # The two sections must not bleed into each other.
        self.assertNotIn("21+", vs.section(note, "appearance"))
        self.assertNotIn("рыжие волосы", vs.section(note, "sexual_appearance"))

    def test_public_summary_uses_safe_sections_only(self) -> None:
        text = textwrap.dedent(
            """
            # @Mikka

            ## Identity

            @Mikka — info-broker on @Town square.

            ## Sexual Appearance

            21+ never-shown content.
            """
        ).strip()
        note = make_note(
            display="Mikka",
            kind="person",
            path="GreenHavenWorld/Locations/@Town square/npc/@Mikka/MikkaMind.md",
            text=text,
        )
        summary = vs.public_summary(note)
        self.assertIn("info-broker", summary)
        self.assertNotIn("21+", summary)


class MentionTests(unittest.TestCase):
    def test_mentions_preserve_exact_display_in_mixed_script(self) -> None:
        # Use Russian connector words between mentions so the existing
        # vault MENTION_PATTERN (allows space + apostrophe inside the
        # token) doesn't try to absorb an English trailing word like
        # "on". The point of this check is that *exact* @Display tokens
        # are returned, with apostrophes preserved, across Cyrillic prose.
        text = (
            "@Mikka переводит письма для @Town square; иногда заходит к "
            "@Sable Vey в @Thief's market."
        )
        mentions = vs.mentions_in_text(text)
        # Order preserved, no duplicates, exact display casing kept,
        # apostrophe preserved.
        self.assertEqual(
            mentions,
            ["@Mikka", "@Town square", "@Sable Vey", "@Thief's market"],
        )


class MaterializesTests(unittest.TestCase):
    def test_parse_materializes_decodes_entity_type_scope_effect(self) -> None:
        text = textwrap.dedent(
            """
            # @Mikka

            ## Materializes

            - Entity: @Hidden note from Mikka
              Type: clue
              Scope: scene
              Effect: reveals a follower watching the square.
            """
        ).strip()
        note = make_note(
            display="Mikka",
            kind="person",
            path="GreenHavenWorld/Locations/@Town square/npc/@Mikka/MikkaMind.md",
            text=text,
        )
        entries = vs.parse_materializes(note, all_mentions={})
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry.entity, "@Hidden note from Mikka")
        self.assertEqual(entry.type, "clue")
        self.assertEqual(entry.scope, "scene")
        self.assertIn("follower", entry.effect)
        self.assertEqual(entry.target_status, "new")


class MerchantAndCurrencyTests(unittest.TestCase):
    def test_merchant_offer_totals_sum_in_copper(self) -> None:
        # 1 silver + 5 copper = 15 copper.
        text = textwrap.dedent(
            """
            # @Sable Vey

            ## Merchant

            - @Red ledger: 1 @Silver coin and 5 @Copper coin
            - @Hint about Town square: 2 @Gold coin
            """
        ).strip()
        note = make_note(
            display="Sable Vey",
            kind="person",
            path="GreenHavenWorld/Locations/@Thief's market/npc/@Sable Vey/SableVeyMind.md",
            text=text,
        )
        offers = vs.parse_merchant_offers(note)
        self.assertEqual(len(offers), 2)
        self.assertEqual(offers[0].copper_value, 15)
        self.assertEqual(offers[1].copper_value, 200)

    def test_parse_currency_values_resolves_coin_defaults(self) -> None:
        for display, expected in (
            ("Copper coin", 1),
            ("Silver coin", 10),
            ("Gold coin", 100),
        ):
            note = make_note(
                display=display,
                kind="item",
                path=f"GreenHavenWorld/Economy/items/@{display}/{display.replace(' ', '')}Mind.md",
                text=f"# @{display}\n\nCanonical coin entry.\n",
            )
            self.assertEqual(
                vs.parse_currency_values(note),
                {"copper_value": expected},
                msg=f"coin {display} should map to {expected}",
            )


class ManifestTests(unittest.TestCase):
    def test_manifest_start_wikilink_resolves_to_entity_mention(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            world = vault / "GreenHavenWorld"
            world.mkdir()
            (vault / "WORLD_MANIFEST.md").write_text(
                textwrap.dedent(
                    """
                    # Greenhaven manifest

                    ## Начало игры

                    Player begins at [[TownSquareMind|@Town square]].
                    """
                ).strip(),
                encoding="utf-8",
            )
            location_dir = world / "Locations" / "@Town square"
            location_dir.mkdir(parents=True)
            (location_dir / "TownSquareMind.md").write_text(
                "# @Town square\n\nThe central plaza.\n",
                encoding="utf-8",
            )
            entities = vault_scan.scan_vault(vault)
            info = vs.parse_manifest(vault, entities)
            self.assertEqual(info.start_wikilink, "TownSquareMind")
            self.assertEqual(info.start_mention, "@Town square")
            self.assertEqual(info.start_slug, "town-square")


class QuestParserTests(unittest.TestCase):
    def _quest_note(self, body: str | None = None) -> vs.NoteSections:
        default = textwrap.dedent(
            """
            # Mikka's got problems

            Quest summary.

            ## Источник

            - Кто запускает: @Mikka
            - Где начинается: @Town square

            ## Крючок

            @Mikka shows the threatening letter to the hero.

            ## Цель

            Find out who threatens @Mikka and decide how to respond.

            ## Стадии

            1. Письмо: попросить @Mikka перевести угрозу.
            2. Слежка: искать наблюдателя на @Town square.
            3. След: пройти через @Thief's market.

            ## Награды и последствия

            - +1 string у @Mikka, если герой помогает.
            - Возможный выход к городским зацепкам.

            ## Не делать

            Не считать квест закрытым только потому, что герой сказал «я все решил».

            ## Materializes

            - Entity: @Hidden note from Mikka
              Type: clue
              Scope: scene
              Effect: surfaces during stage 1.
            """
        ).strip()
        return make_note(
            display="Mikka's got problems",
            kind="quest",
            path=(
                "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/"
                "npc/@Mikka/quests/Mikka's got problems.md"
            ),
            text=body if body is not None else default,
        )

    def test_parses_full_quest_into_structured_view(self) -> None:
        note = self._quest_note()
        mention_idx: dict[str, list[vault_scan.Entity]] = {}
        parsed = vs.parse_quest_sections(note, all_mentions=mention_idx)
        self.assertIn("@Mikka", parsed.source)
        self.assertIn("letter", parsed.hook)
        self.assertIn("@Mikka", parsed.objective)
        self.assertIn("string", parsed.rewards)
        self.assertIn("закрытым", parsed.failure)
        self.assertEqual(len(parsed.stages), 3)
        self.assertEqual(parsed.stages[0].stage_slug, "stage-1")
        self.assertIn("@Mikka", parsed.stages[0].mentions)
        # Stage mentions are dedup'd and ordered by first appearance.
        # ParsedQuest is frozen, so stage_mentions is a tuple.
        self.assertEqual(
            list(parsed.stage_mentions),
            ["@Mikka", "@Town square", "@Thief's market"],
        )
        # Materialized slugs come from the optional materializes block.
        self.assertIn("hidden-note-from-mikka", parsed.materialized_slugs)

    def test_quest_without_stages_synthesises_stage_one_from_objective(self) -> None:
        body = textwrap.dedent(
            """
            # Quick errand

            ## Цель

            Помочь @Mikka собрать слухи.
            """
        ).strip()
        note = self._quest_note(body)
        parsed = vs.parse_quest_sections(note)
        self.assertEqual(len(parsed.stages), 1)
        self.assertEqual(parsed.stages[0].stage_slug, "stage-1")
        self.assertIn("@Mikka", parsed.stages[0].goal)

    def test_wrapped_stages_merge_into_one_logical_stage(self) -> None:
        # OWV-12 hardening regression: the writer wraps long numbered
        # stages onto an indented second line. The pre-hardening parser
        # stripped digits + dashes line-by-line and emitted each wrap
        # as a fake stage (`полностью`, `ошибкой`, `только при
        # взаимном согласии`). The new parser merges continuations
        # into the active stage.
        body = textwrap.dedent(
            """
            # Wrapped quest

            ## Цель

            Дойти до конца.

            ## Стадии

            1. Письмо: герой видит угрозу и может попросить @Mikka перевести/прочитать ее
               полностью.
            2. Слежка: герой ищет наблюдателя на @Town square или рядом с палаткой.
            3. След: найденная зацепка ведет к городским должникам, конкурентам или к
               скрытому пути вроде @Thief's market.
            """
        ).strip()
        note = self._quest_note(body)
        parsed = vs.parse_quest_sections(note)
        self.assertEqual(len(parsed.stages), 3)
        # The wrapped tail must be folded into stage-1, not emitted
        # as a phantom stage-2.
        self.assertIn("полностью", parsed.stages[0].goal)
        # Stage-3 must include both its lead-in and the indented tail.
        self.assertIn("скрытому пути", parsed.stages[2].goal)
        # No standalone "полностью" / "ошибкой" / "только при" stages.
        for stage in parsed.stages:
            self.assertFalse(
                stage.goal.startswith("полностью"),
                msg=f"continuation leaked as a new stage: {stage.goal}",
            )

    def test_action_unlock_aliases_populate_source_and_objective(self) -> None:
        # Live action-unlock quests author `## Источник действия`,
        # `## Условия`, and `## Как игрок может это сделать` instead
        # of `## Источник` / `## Цель` / `## Стадии`. The pre-hardening
        # parser fell all the way through to the whole-note text,
        # leaking the H1 heading into the generated payload.
        body = textwrap.dedent(
            """
            # Way to Thief's market

            Коротко: действие-открытие.

            ## Источник действия

            - Где происходит: @Town square
            - С чем взаимодействует игрок: @Barrels in the square

            ## Как игрок может это сделать

            Герой может осмотреть бочки, заметить следы движения,
            упереться плечом или попросить помощи.
            """
        ).strip()
        note = self._quest_note(body)
        parsed = vs.parse_quest_sections(note)
        self.assertIn("@Town square", parsed.source)
        self.assertIn("@Barrels in the square", parsed.source)
        self.assertIn("Герой может осмотреть", parsed.objective)
        # Synthesised stage-1 falls back to the now-populated objective
        # rather than the raw `# Way to Thief's market` heading.
        self.assertEqual(len(parsed.stages), 1)
        self.assertFalse(parsed.stages[0].goal.startswith("#"))
        self.assertIn("Герой", parsed.stages[0].goal)

    def test_no_stages_no_objective_falls_back_without_h1(self) -> None:
        body = textwrap.dedent(
            """
            # Bare quest

            Short body without any structured headings.
            """
        ).strip()
        note = self._quest_note(body)
        parsed = vs.parse_quest_sections(note)
        # Single synthesised stage, no leading `#` from the H1.
        self.assertEqual(len(parsed.stages), 1)
        self.assertFalse(parsed.stages[0].goal.startswith("#"))
        self.assertIn("Short body", parsed.stages[0].goal)

    def test_stage_cap_and_short_text(self) -> None:
        bullets = "\n".join(f"{i+1}. Step {i+1}." for i in range(10))
        body = f"# Many stages\n\n## Стадии\n\n{bullets}\n"
        note = self._quest_note(body)
        parsed = vs.parse_quest_sections(note, max_stages=4, stage_goal_max_chars=20)
        self.assertEqual(len(parsed.stages), 4)
        for stage in parsed.stages:
            self.assertLessEqual(len(stage.goal), 21)


class DuplicateDetectionTests(unittest.TestCase):
    def _entity(self, display: str, path: str) -> vault_scan.Entity:
        return make_entity(
            display=display,
            kind="person",
            path=path,
            text=f"# @{display}\n",
        )

    def test_duplicate_slugs_groups_collisions(self) -> None:
        a = self._entity("Mikka-1", "GreenHavenWorld/x/AMind.md")
        b = self._entity("Mikka 1", "GreenHavenWorld/y/BMind.md")
        c = self._entity("Sable Vey", "GreenHavenWorld/z/CMind.md")
        groups = vs.duplicate_slugs([a, b, c])
        self.assertIn("mikka-1", groups)
        self.assertEqual({e.path for e in groups["mikka-1"]}, {a.path, b.path})
        self.assertNotIn(c.slug, groups)

    def test_duplicate_display_names_groups_collisions(self) -> None:
        a = make_entity(display="Mikka", kind="person", path="x/AMind.md", text="")
        b = make_entity(display="Mikka", kind="location", path="y/BMind.md", text="")
        c = make_entity(display="Town square", kind="location", path="z/CMind.md", text="")
        groups = vs.duplicate_display_names([a, b, c])
        self.assertIn("Mikka", groups)
        self.assertEqual({e.path for e in groups["Mikka"]}, {a.path, b.path})

    def test_compiler_raises_before_write_on_slug_collision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            world = vault / "GreenHavenWorld" / "Locations"
            (world / "@Mikka-1").mkdir(parents=True)
            (world / "@Mikka 1").mkdir(parents=True)
            # Two location notes whose display names collapse onto the
            # same slug. The compiler must refuse to write anything.
            (world / "@Mikka-1" / "Mikka1Mind.md").write_text(
                "# @Mikka-1\n", encoding="utf-8"
            )
            (world / "@Mikka 1" / "Mikka1Mind.md").write_text(
                "# @Mikka 1\n", encoding="utf-8"
            )
            output_dir = vault / "out"
            with self.assertRaises(compiler.DuplicateEntityError) as ctx:
                compiler.compile_vault(vault, output_dir)
            message = str(ctx.exception)
            self.assertIn("slug", message)
            self.assertIn("mikka-1", message)
            # Pre-write guarantee: no Forge project written.
            self.assertFalse(output_dir.exists())


class ImagePromptTests(unittest.TestCase):
    def test_image_prompt_excludes_sexual_appearance(self) -> None:
        # Import is local to the test so the script's CLI argparse path
        # is never exercised at import time.
        from generate_vault_images import build_prompt  # noqa: WPS433

        text = textwrap.dedent(
            """
            # @Mikka

            ## Appearance

            Невысокая, рыжие волосы.

            ## Sexual Appearance

            21+ explicit detail that must never reach a prompt.
            """
        ).strip()
        entity = make_entity(
            display="Mikka",
            kind="person",
            path="GreenHavenWorld/Locations/@Town square/npc/@Mikka/MikkaMind.md",
            text=text,
        )
        prompt = build_prompt(entity)
        self.assertIn("Appearance", prompt)
        # No leak of the adult-only section content into the image
        # generation prompt body. The boilerplate itself mentions
        # "non-explicit" as a guardrail, so check for the test
        # fixture's adult-specific tokens instead of the generic
        # word "explicit".
        self.assertNotIn("21+", prompt)
        self.assertNotIn("explicit detail", prompt)
        self.assertNotIn("Sexual Appearance\n\n21+", prompt)


class LiveVaultShapeTests(unittest.TestCase):
    """OBSIDIAN-VAULT-IMPORT-1 regression tests.

    The live English vault active world directory
    authors NPCs with `## Role`, `## Want`, `## Fear`,
    `## Secret / Pressure`, `## Routine`, `## Relationship Triggers`,
    `## Memory Hooks`, `## Companion Rules`, and
    `## Appearance For Portrait`. The previous parser had no aliases
    for any of them, so the GUI cartridge collapsed the whole NPC
    frame into the identity+H1 fallback. Live quests use English
    `## Source / ## Hook / ## Objective / ## Stages / ## Success
    Result / ## Failure Result / ## Reward And Consequence /
    ## Materializes / ## Do Not Do Here`; scenes use
    `## Where And When / ## Hook / ## Beat By Beat / ## Player
    Choices / ## Success Result / ## Failure Result / ## Memory And
    String Changes / ## Materializes / ## Do Not Do Here`. These
    tests pin the parser/compiler so the GUI cartridge persists the
    full writer-authored frame.
    """

    def test_npc_structured_headings_extracted(self) -> None:
        text = textwrap.dedent(
            """
            # @Tessa Wrenlight

            ## Identity

            I am @Tessa Wrenlight. The harbor knows me as a scout.

            ## Role

            - Harbor scout and informal route guide.
            - Recruitable companion for the hero.

            ## Want

            I want to find what happened to my brother Joran.

            ## Fear

            I am afraid another good person will sign a corrupt contract.

            ## Secret / Pressure

            I have been quietly tracking the fixer's wax pattern.

            ## Routine

            - Early morning: harbor arrivals post.
            - Mid-morning: Charter Steps second landing.

            ## Relationship Triggers

            +strings:
            - The hero defends a civilian publicly.

            ## Memory Hooks

            I remember what the hero did at @Dockside Accusation.

            ## Companion Rules

            - Join condition: refuse the fixer in public.

            ## Appearance For Portrait

            Portrait target: portraits/default.png. Tall lean half-elf.
            """
        ).strip()
        entity = make_entity(
            display="Tessa Wrenlight",
            kind="person",
            path="GreenHavenWorld/Locations/@Greenhaven Port/npc/@Tessa Wrenlight/NPCMind.md",
            text=text,
            owner=None,
            parent="Greenhaven Port",
            relation="contains_npc",
        )
        note = vs.note_sections(entity)
        self.assertIn("Harbor scout", vs.section(note, "npc_role"))
        self.assertIn("Joran", vs.section(note, "npc_want"))
        self.assertIn("corrupt contract", vs.section(note, "npc_fear"))
        self.assertIn("wax pattern", vs.section(note, "npc_secret"))
        self.assertIn("Early morning", vs.section(note, "npc_routine"))
        self.assertIn(
            "+strings",
            vs.section(note, "npc_relationship_triggers"),
        )
        self.assertIn(
            "@Dockside Accusation",
            vs.section(note, "npc_memory_hooks"),
        )
        self.assertIn(
            "Join condition",
            vs.section(note, "npc_companion_rules"),
        )
        self.assertIn(
            "Portrait target",
            vs.section(note, "npc_appearance_for_portrait"),
        )
        # And the compiler's person_payload surfaces all of them.
        payload = compiler.person_payload(note, {}, {})
        self.assertTrue(payload["role"])
        self.assertTrue(payload["want"])
        self.assertTrue(payload["fear"])
        self.assertTrue(payload["secret_pressure"])
        self.assertTrue(payload["routine"])
        self.assertTrue(payload["relationship_triggers"])
        self.assertTrue(payload["memory_hooks"])
        self.assertTrue(payload["companion_rules"])
        self.assertTrue(payload["appearance_for_portrait"])

    def test_quest_english_two_sided_outcome_extracted(self) -> None:
        text = textwrap.dedent(
            """
            # Recruit Tessa Wrenlight

            ## Source

            - Giver: @Tessa Wrenlight
            - Where it starts: @Greenhaven Port.

            ## Hook

            Tessa will turn the question around.

            ## Objective

            Meet the three companion conditions, then ask Tessa to follow.

            ## Stages

            1. Public refusal of the fixer.
            2. Bring her a cross-hub wax pattern.

            ## Success Result

            @Tessa Wrenlight joins the hero's party as a companion.

            ## Failure Result

            Tessa refuses politely.

            ## Reward And Consequence

            - Companion: Tessa becomes the first companion.

            ## Materializes

            - When @Tessa Wrenlight accepts:
              - Entity: @Tessa Wrenlight
              - Type: state / companion-active

            ## Do Not Do Here

            Do not let charm replace evidence.
            """
        ).strip()
        entity = make_entity(
            display="Recruit Tessa Wrenlight",
            kind="quest",
            path="GreenHavenWorld/Locations/@Greenhaven Port/npc/@Tessa Wrenlight/quests/Recruit Tessa Wrenlight.md",
            text=text,
            owner="Tessa Wrenlight",
            parent="Tessa Wrenlight",
            relation="quest_source",
        )
        note = vs.note_sections(entity)
        self.assertIn(
            "Tessa Wrenlight joins",
            vs.section(note, "quest_success_result"),
        )
        self.assertIn(
            "refuses politely",
            vs.section(note, "quest_failure_result"),
        )
        self.assertIn(
            "Companion: Tessa",
            vs.section(note, "quest_rewards"),
        )
        self.assertIn(
            "charm replace evidence",
            vs.section(note, "quest_failure"),
        )

    def test_scene_english_beat_and_choices_extracted(self) -> None:
        text = textwrap.dedent(
            """
            # @Dockside Accusation

            ## Where And When

            - Location: @Greenhaven Port
            - Visibility: triggers within the first minute of play.

            ## Hook

            A customs clerk is shouting at a porter.

            ## Beat By Beat

            1. The customs clerk threatens to call the port guard.
            2. The rival team raises the pressure.

            ## Player Choices

            - Defuse: speak for the porter.
            - Accuse: pick a different target.

            ## Success Result

            The porter is not arrested wrongly.

            ## Failure Result

            The wrong porter is arrested.

            ## Memory And String Changes

            - Customs clerk: warmer if defended.
            - Missing passenger's friend: opens up if treated as a witness.

            ## Materializes

            - When the player demands the daybook:
              - Entity: @Stolen Guild Seal
              - Type: state

            ## Do Not Do Here

            Do not let the crowd pick a victim.
            """
        ).strip()
        entity = make_entity(
            display="Dockside Accusation",
            kind="scene",
            path="GreenHavenWorld/Locations/@Greenhaven Port/scenes/@Dockside Accusation.md",
            text=text,
            owner=None,
            parent="Greenhaven Port",
            relation="location_scene",
        )
        note = vs.note_sections(entity)
        self.assertIn(
            "customs clerk is shouting",
            vs.section(note, "scene_hook"),
        )
        self.assertIn(
            "customs clerk threatens",
            vs.section(note, "scene_beat_by_beat"),
        )
        self.assertIn(
            "Defuse: speak for the porter",
            vs.section(note, "scene_player_choices"),
        )
        self.assertIn(
            "Customs clerk: warmer",
            vs.section(note, "scene_memory_and_string_changes"),
        )
        self.assertIn(
            "The porter is not arrested",
            vs.section(note, "scene_success_result"),
        )
        self.assertIn(
            "wrong porter is arrested",
            vs.section(note, "scene_failure_result"),
        )
        self.assertIn(
            "pick a victim",
            vs.section(note, "scene_do_not"),
        )
        # And the compiler payload surfaces them.
        payload = compiler.scene_payload(note, {}, {})
        self.assertTrue(payload["hook"])
        self.assertTrue(payload["beat_by_beat"])
        self.assertTrue(payload["player_choices"])
        self.assertTrue(payload["memory_and_string_changes"])
        self.assertTrue(payload["success_result"])
        self.assertTrue(payload["failure_result"])
        # `model_instructions` carries the assembled per-scene
        # instruction list. Tessa's first-pier scene proved this is
        # the field the runtime SceneInstructionBridge consumes.
        instructions = payload["model_instructions"]
        self.assertIsInstance(instructions, list)
        self.assertTrue(len(instructions) >= 4)

    def test_scene_payload_does_not_fallback_to_first_person(self) -> None:
        scene = make_entity(
            display="Silent Console",
            kind="scene",
            path="GreenHavenWorld/Locations/@Iron Row/scenes/@Silent Console.md",
            text="# @Silent Console\n\n## Hook\n\nA terminal waits.",
            parent="Iron Row",
            relation="location_scene",
        )
        person = make_entity(
            display="Captain Harrow",
            kind="person",
            path="GreenHavenWorld/Locations/@Precinct/npc/@Captain Harrow/NPCMind.md",
            text="# @Captain Harrow\n",
            parent="Precinct",
            relation="npc",
        )
        by_slug = {scene.slug: scene, person.slug: person}

        payload = compiler.scene_payload(
            vs.note_sections(scene),
            by_slug,
            prose_links={scene.slug: []},
        )

        self.assertEqual(payload["participant_slugs"], [])

    def test_scene_payload_keeps_explicit_person_mentions(self) -> None:
        scene = make_entity(
            display="Precinct Briefing",
            kind="scene",
            path="GreenHavenWorld/Locations/@Precinct/scenes/@Precinct Briefing.md",
            text="# @Precinct Briefing\n\n## Hook\n\n@Captain Harrow waits.",
            parent="Precinct",
            relation="location_scene",
        )
        person = make_entity(
            display="Captain Harrow",
            kind="person",
            path="GreenHavenWorld/Locations/@Precinct/npc/@Captain Harrow/NPCMind.md",
            text="# @Captain Harrow\n",
            parent="Precinct",
            relation="npc",
        )
        by_slug = {scene.slug: scene, person.slug: person}

        payload = compiler.scene_payload(
            vs.note_sections(scene),
            by_slug,
            prose_links={scene.slug: [person.slug]},
        )

        self.assertEqual(payload["participant_slugs"], ["captain-harrow"])


if __name__ == "__main__":
    unittest.main()
