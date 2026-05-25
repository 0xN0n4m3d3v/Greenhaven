"""Focused unittests for the OWV-17 generated runtime-bridge artifacts.

Each test builds a small writer-shaped Obsidian vault under a temp
directory, runs the full ``compile_vault`` pipeline, and asserts the
shape + deterministic ordering of one audit artifact:

* ``audit/currency-rates.json`` is rendered from authored coin items
  and the world currency master note;
* ``audit/scene-instructions.jsonl`` carries one flattened row per
  scene record with owner + location + visual + state fields;
* ``audit/materializes.jsonl`` rows now carry ``source_slug`` and
  ``source_kind`` and sort deterministically;
* ``audit/merchant-contracts.jsonl`` rows now carry ``source_slug``
  and ``source_kind`` and sort deterministically;
* ``audit/visual-assets.jsonl`` rows now carry ``source_path``.

The Forge record payloads under ``records/`` are not asserted here:
those are pinned indirectly by the other compiler tests and by
``forge validate``. These tests only cover the generated runtime
bridge artifacts the OWV-17 spec adds.
"""

from __future__ import annotations

import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import compile_vault_to_forge as compiler  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip("\n"), encoding="utf-8")


def _build_vault(tmp: Path) -> Path:
    """Seed a small vault that exercises every OWV-17 artifact.

    The layout intentionally matches the live writer-shaped vault so
    placement helpers in ``vault_scan`` resolve naturally: a manifest
    with a start location, a city/square location chain, two coins +
    the currency master fact, an NPC with both a Merchant block and a
    Materializes block, a free-floating item with an icon under
    ``images/``, and one NPC-owned scene + one location-owned scene.
    """

    vault = tmp / "vault"
    world = vault / "GreenHavenWorld"
    world.mkdir(parents=True)
    _write(
        vault / "WORLD_MANIFEST.md",
        """
        # Manifest

        ## Начало игры

        Player begins at [[TownSquareMind|@Town square]].
        """,
    )
    _write(
        world / "Locations" / "@City of Greenhaven" / "CityOfGreenhavenMind.md",
        "# @City of Greenhaven\n\nThe city.\n",
    )
    _write(
        world / "Locations" / "@City of Greenhaven" / "@Town square" / "TownSquareMind.md",
        "# @Town square\n\nThe central plaza.\n",
    )
    # Economy: two coins so the currency-rates.json sort by copper
    # ascending is observable, plus the currency master fact.
    _write(
        world / "Economy" / "items" / "@Copper coin" / "CopperCoinMind.md",
        "# @Copper coin\n\nCanonical copper coin.\n",
    )
    _write(
        world / "Economy" / "items" / "@Silver coin" / "SilverCoinMind.md",
        "# @Silver coin\n\nCanonical silver coin.\n",
    )
    _write(
        world / "Economy" / "Currency.md",
        "# Currency of Greenhaven\n\nValuta blueprint.\n",
    )
    # NPC under Town square with Merchant + Materializes blocks.
    _write(
        world / "Locations" / "@City of Greenhaven" / "@Town square" / "npc" / "@Mikka" / "MikkaMind.md",
        """
        # @Mikka

        ## Identity

        @Mikka is the info-broker on @Town square.

        ## Merchant

        - городской слух без риска - 3 @Copper coin;
        - адрес, имя или приватный слух - 2 @Silver coin;

        ## Materializes

        - Entity: @Hidden cache
          Type: clue
          Scope: scene
          Effect: surfaces during stage 1.
        """,
    )
    # Free-floating item with a visual asset on disk so the
    # visual-assets.jsonl row has `exists=True` and the new
    # `source_path` field can be asserted.
    item_dir = (
        world
        / "Locations"
        / "@City of Greenhaven"
        / "@Town square"
        / "items"
        / "@Barrels in the square"
    )
    _write(item_dir / "BarrelsMind.md", "# @Barrels in the square\n\nThe barrels.\n")
    (item_dir / "images").mkdir(parents=True, exist_ok=True)
    (item_dir / "images" / "icon.png").write_bytes(b"")
    # Two scenes: one owned by @Mikka under npc/@Mikka/scenes/, one
    # owned by the location under @Town square/scenes/.
    _write(
        world
        / "Locations"
        / "@City of Greenhaven"
        / "@Town square"
        / "npc"
        / "@Mikka"
        / "scenes"
        / "@Mikka first glance.md",
        """
        # @Mikka first glance

        ## Триггер

        - Локация: @Town square
        - Участники: @Mikka, герой

        ## Поведение

        Mikka watches and pretends not to.

        ## Не делать

        Do not let Mikka speak first.
        """,
    )
    _write(
        world
        / "Locations"
        / "@City of Greenhaven"
        / "@Town square"
        / "scenes"
        / "@Morning crowd opens the square.md",
        """
        # @Morning crowd opens the square

        ## Триггер

        - Локация: @Town square

        ## Поведение

        The crowd opens.
        """,
    )
    return vault


def _run_compile(vault: Path) -> tuple[Path, dict[str, object]]:
    output = vault / ".greenhaven-agent-manual" / "generated" / "cartridge-forge-project"
    result = compiler.compile_vault(vault, output)
    return output, result


class CurrencyRatesTests(unittest.TestCase):
    def test_currency_rates_json_has_coins_and_world_fact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            output, _ = _run_compile(vault)
            rates_path = output / "audit" / "currency-rates.json"
            self.assertTrue(rates_path.is_file())
            doc = json.loads(rates_path.read_text(encoding="utf-8"))
            self.assertEqual(doc["schema_version"], "greenhaven.currency_rates.v1")
            self.assertEqual(doc["source_project"], compiler.PROJECT_SLUG)
            # Coins are sorted ascending by copper_value.
            coin_slugs = [coin["slug"] for coin in doc["coins"]]
            self.assertEqual(coin_slugs, ["copper-coin", "silver-coin"])
            for coin in doc["coins"]:
                self.assertIn("mention", coin)
                self.assertIn("source_path", coin)
                self.assertIsInstance(coin["copper_value"], int)
                # No DB ids leak in.
                self.assertNotIn("id", coin)
            # World currency fact mirrored from the world_fact payload.
            facts = doc["world_currency_facts"]
            self.assertEqual(len(facts), 1)
            fact = facts[0]
            self.assertEqual(fact["slug"], "currency-of-greenhaven")
            self.assertEqual(fact["rates"], {"copper_coin": 1, "gold_coin": 100, "silver_coin": 10})


class SceneInstructionsTests(unittest.TestCase):
    def test_compile_vault_uses_manifest_active_world_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            world = vault / "GreenhavenNoir"
            _write(
                vault / "WORLD_MANIFEST.md",
                """
                # Noir Manifest

                ## Start Of The Game

                Start location: @Noir Station.

                ## Active World Root

                ```text
                GreenhavenNoir
                ```
                """,
            )
            _write(
                world / "Locations" / "@Noir Station" / "NoirStationMind.md",
                "# @Noir Station\n\nThe midnight platform.\n",
            )
            boot = world / "media" / "boot"
            boot.mkdir(parents=True)
            (boot / "01.mp3").write_bytes(b"fake mp3")

            output = vault / ".greenhaven-agent-manual" / "generated" / "cartridge-forge-project"
            result = compiler.compile_vault(vault, output)

            self.assertEqual(result["world_dir"], "GreenhavenNoir")
            self.assertEqual(result["start_location"], "@Noir Station")
            locations = (output / "records" / "locations.jsonl").read_text(encoding="utf-8")
            self.assertIn("GreenhavenNoir/Locations/@Noir Station/NoirStationMind.md", locations)
            visuals = (output / "audit" / "visual-assets.jsonl").read_text(encoding="utf-8")
            self.assertIn("GreenhavenNoir/media/boot/01.mp3", visuals)

    def test_parse_media_script_accepts_chat_media_commands(self) -> None:
        commands = compiler.parse_media_script(
            """
            show_media("ledger-closeup.png", title="The torn ledger", caption="Wax and blue thread.")
            show_media("rain-loop.webm", title="Rain over the alley", alt="Looping rain.")
            """
        )
        self.assertEqual(
            commands,
            [
                {
                    "action": "show",
                    "asset_role": "media_ledger_closeup",
                    "title": "The torn ledger",
                    "caption": "Wax and blue thread.",
                },
                {
                    "action": "show",
                    "asset_role": "video_rain_loop",
                    "title": "Rain over the alley",
                    "alt": "Looping rain.",
                },
            ],
        )

    def test_scene_instructions_jsonl_carries_full_bridge_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            output, _ = _run_compile(vault)
            jsonl = (output / "audit" / "scene-instructions.jsonl").read_text(encoding="utf-8")
            rows = [json.loads(line) for line in jsonl.splitlines() if line.strip()]
            self.assertGreaterEqual(len(rows), 2)
            scene_slugs = [row["scene_slug"] for row in rows]
            # Deterministic ascending sort by scene_slug.
            self.assertEqual(scene_slugs, sorted(scene_slugs))
            owned_row = next(
                row for row in rows if row["scene_slug"] == "mikka-first-glance"
            )
            self.assertEqual(owned_row["schema_version"], "greenhaven.scene_instructions.v1")
            self.assertEqual(owned_row["source_kind"], "scene")
            self.assertEqual(owned_row["owner_npc_slug"], "mikka")
            self.assertEqual(owned_row["location_slug"], "town-square")
            self.assertIn("mikka", owned_row["participant_slugs"])
            self.assertIn("trigger", owned_row)
            self.assertIn("priority", owned_row)
            self.assertIn("behavior", owned_row)
            self.assertIsInstance(owned_row["model_instructions"], list)
            self.assertIsInstance(owned_row["state_fields"], list)
            self.assertIn("do_not", owned_row)
            self.assertIn("visual_asset", owned_row)
            location_row = next(
                row
                for row in rows
                if row["scene_slug"] == "morning-crowd-opens-the-square"
            )
            self.assertIsNone(location_row["owner_npc_slug"])
            self.assertEqual(location_row["location_slug"], "town-square")


class ScenePriorityMappingTests(unittest.TestCase):
    """OWV-9: authored ``Приоритет: ...`` lines must map to canonical
    Forge tokens so the SceneInstructionBridge ranks ``high`` scenes
    ahead of the default-normal cohort at the same location.
    """

    def _make_note(self, body: str) -> object:
        import vault_scan
        import vault_sections

        entity = vault_scan.Entity(
            display="@Test scene",
            mention="@Test scene",
            kind="scene",
            slug="test-scene",
            path="GreenHavenWorld/test.md",
            abs_path=Path("/tmp/test.md"),
            owner=None,
            parent=None,
            relation=None,
            text=body,
            parts=tuple(),
        )
        return vault_sections.note_sections(entity)

    def test_russian_high_maps_to_high(self) -> None:
        note = self._make_note(
            "# @Test scene\n\n## Владелец сцены\n\n- Приоритет: высокий\n"
        )
        self.assertEqual(compiler.scene_priority(note), "high")

    def test_russian_critical_maps_to_high(self) -> None:
        note = self._make_note(
            "# @Test scene\n\n- Приоритет: критический\n"
        )
        self.assertEqual(compiler.scene_priority(note), "high")

    def test_russian_low_maps_to_low(self) -> None:
        note = self._make_note(
            "# @Test scene\n\n- Приоритет: низкий\n"
        )
        self.assertEqual(compiler.scene_priority(note), "low")

    def test_english_high_maps_to_high(self) -> None:
        note = self._make_note(
            "# @Test scene\n\n- Priority: high\n"
        )
        self.assertEqual(compiler.scene_priority(note), "high")

    def test_missing_label_falls_back_to_normal(self) -> None:
        note = self._make_note("# @Test scene\n\nNo priority label here.\n")
        self.assertEqual(compiler.scene_priority(note), "normal")

    def test_unknown_value_falls_back_to_normal(self) -> None:
        note = self._make_note(
            "# @Test scene\n\n- Приоритет: какой-то-новый-уровень\n"
        )
        self.assertEqual(compiler.scene_priority(note), "normal")


class MaterializesUpgradeTests(unittest.TestCase):
    def test_rows_carry_source_slug_and_source_kind(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            output, _ = _run_compile(vault)
            jsonl = (output / "audit" / "materializes.jsonl").read_text(encoding="utf-8")
            rows = [json.loads(line) for line in jsonl.splitlines() if line.strip()]
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual(row["source_slug"], "mikka")
            self.assertEqual(row["source_kind"], "person")
            self.assertEqual(row["entity"], "@Hidden cache")
            # Pre-existing fields preserved.
            for required in ("entity_slug", "type", "scope", "effect", "source_mention", "source_path"):
                self.assertIn(required, row)


class MerchantContractsUpgradeTests(unittest.TestCase):
    def test_rows_carry_source_slug_kind_and_sort_stable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            output, _ = _run_compile(vault)
            jsonl_a = (output / "audit" / "merchant-contracts.jsonl").read_text(encoding="utf-8")
            rows_a = [json.loads(line) for line in jsonl_a.splitlines() if line.strip()]
            self.assertEqual(len(rows_a), 2)
            for row in rows_a:
                self.assertEqual(row["source_slug"], "mikka")
                self.assertEqual(row["source_kind"], "person")
                self.assertIn("line", row)
                self.assertIn("coins", row)
                self.assertIn("copper_value", row)
            # Deterministic: re-running the compiler produces a
            # byte-identical merchant-contracts.jsonl.
            _, _ = _run_compile(vault)
            jsonl_b = (output / "audit" / "merchant-contracts.jsonl").read_text(encoding="utf-8")
            self.assertEqual(jsonl_a, jsonl_b)


class VisualAssetsUpgradeTests(unittest.TestCase):
    def test_rows_carry_source_path_and_sort_by_kind_then_slug(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            output, _ = _run_compile(vault)
            jsonl = (output / "audit" / "visual-assets.jsonl").read_text(encoding="utf-8")
            rows = [json.loads(line) for line in jsonl.splitlines() if line.strip()]
            self.assertGreaterEqual(len(rows), 1)
            for row in rows:
                self.assertIn("source_path", row)
                # source_path is the authored note, not the asset file.
                self.assertTrue(row["source_path"].endswith(".md"))
            sort_keys = [(row["kind"], row["slug"]) for row in rows]
            self.assertEqual(sort_keys, sorted(sort_keys))


# ---------------------------------------------------------------------------
# OWV-13: merge / alias reconciliation against the donor cartridge
# ---------------------------------------------------------------------------


def _write_donor_cartridge(donor_root: Path, records_by_file: dict[str, list[dict]]) -> None:
    """Seed a minimal donor cartridge under ``donor_root``.

    Writes JSONL records under ``records/<file>``. Empty list means an
    empty file so OWV-13 reconciliation has a parseable but
    side-effect-free donor index for that kind.
    """

    records_dir = donor_root / "records"
    records_dir.mkdir(parents=True, exist_ok=True)
    for file_name, records in records_by_file.items():
        path = records_dir / file_name
        path.write_text(
            "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in records),
            encoding="utf-8",
        )


def _run_compile_with_donor(vault: Path, donor_root: Path | None) -> tuple[Path, dict[str, object]]:
    output = vault / ".greenhaven-agent-manual" / "generated" / "cartridge-forge-project"
    result = compiler.compile_vault(vault, output, donor_root)
    return output, result


class MergeIdentityCleanCompileTests(unittest.TestCase):
    def test_empty_donor_produces_all_new_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            donor = Path(tmp) / "donor"  # never created on disk
            output, _ = _run_compile_with_donor(vault, donor)
            jsonl = (output / "audit" / "merge-records.jsonl").read_text(encoding="utf-8")
            rows = [json.loads(line) for line in jsonl.splitlines() if line.strip()]
            self.assertGreater(len(rows), 0)
            for row in rows:
                self.assertEqual(row["schema_version"], "greenhaven.merge_records.v1")
                self.assertEqual(row["status"], compiler.MERGE_STATUS_NEW)
                self.assertIsNone(row["current_cartridge_slug"])
                self.assertEqual(row["notes"], [])
            # Deterministic sort: (kind, slug, source_path) ascending.
            keys = [(row["kind"], row["slug"], row["source_path"]) for row in rows]
            self.assertEqual(keys, sorted(keys))
            conflicts_md = (output / "audit" / "merge-conflicts.md").read_text(encoding="utf-8")
            self.assertIn("# Merge Alias Conflicts", conflicts_md)
            self.assertIn("- none", conflicts_md)

    def test_exact_slug_match_resolves_against_donor(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            donor = Path(tmp) / "donor"
            _write_donor_cartridge(
                donor,
                {
                    "npcs.jsonl": [
                        {
                            "kind": "person",
                            "slug": "mikka",
                            "payload": {
                                "source_path": (
                                    "GreenHavenWorld/Locations/@City of Greenhaven/"
                                    "@Town square/npc/@Mikka/MikkaMind.md"
                                ),
                            },
                        }
                    ],
                },
            )
            output, _ = _run_compile_with_donor(vault, donor)
            rows = [
                json.loads(line)
                for line in (output / "audit" / "merge-records.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line.strip()
            ]
            mikka = next(row for row in rows if row["kind"] == "person" and row["slug"] == "mikka")
            self.assertEqual(mikka["status"], compiler.MERGE_STATUS_EXACT_SLUG)
            self.assertEqual(mikka["current_cartridge_slug"], "mikka")
            self.assertEqual(mikka["notes"], [])
            # Conflict report stays clean.
            conflicts_md = (output / "audit" / "merge-conflicts.md").read_text(encoding="utf-8")
            self.assertIn("- none", conflicts_md)


class MergeIdentityAmbiguousConflictTests(unittest.TestCase):
    def test_slug_and_source_path_pointing_at_different_donors_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            donor = Path(tmp) / "donor"
            # Donor has TWO different identities that the generated
            # `person:mikka` could merge into:
            #   * slug match -> donor `mikka` whose source_path points
            #     at a different note
            #   * source_path match -> donor `mikka-old` whose slug
            #     differs from the generated row
            # The compiler cannot deterministically pick a target and
            # must block SQL export.
            _write_donor_cartridge(
                donor,
                {
                    "npcs.jsonl": [
                        {
                            "kind": "person",
                            "slug": "mikka",
                            "payload": {
                                "source_path": "GreenHavenWorld/legacy/elsewhere.md",
                            },
                        },
                        {
                            "kind": "person",
                            "slug": "mikka-old",
                            "payload": {
                                "source_path": (
                                    "GreenHavenWorld/Locations/@City of Greenhaven/"
                                    "@Town square/npc/@Mikka/MikkaMind.md"
                                ),
                            },
                        },
                    ],
                },
            )
            with self.assertRaises(compiler.MergeIdentityConflictError) as ctx:
                _run_compile_with_donor(vault, donor)
            self.assertTrue(ctx.exception.conflicts)
            offending = next(
                row
                for row in ctx.exception.conflicts
                if row["kind"] == "person" and row["slug"] == "mikka"
            )
            self.assertEqual(offending["status"], compiler.MERGE_STATUS_AMBIGUOUS)
            self.assertTrue(any("mikka-old" in note for note in offending["notes"]))
            # Audit artifacts were written BEFORE the raise so the
            # human can read the conflict in context.
            output = vault / ".greenhaven-agent-manual" / "generated" / "cartridge-forge-project"
            conflicts_md = (output / "audit" / "merge-conflicts.md").read_text(encoding="utf-8")
            # The report names both donor candidates so the writer
            # knows exactly which two identities collided.
            self.assertIn("mikka-old", conflicts_md)
            self.assertIn("blocks SQL export", conflicts_md)
            jsonl = (output / "audit" / "merge-records.jsonl").read_text(encoding="utf-8")
            self.assertIn("ambiguous_conflict", jsonl)

    def test_donor_db_profile_json_source_path_is_honored(self) -> None:
        # Imported-current donor rows hide the authored source_path
        # inside `payload.db_profile_json` (a JSON-encoded string).
        # Reconciliation must reach into that blob, otherwise the
        # ambiguity check misses real conflicts and the writer is
        # blind to legacy collisions.
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            donor = Path(tmp) / "donor"
            mikka_source = (
                "GreenHavenWorld/Locations/@City of Greenhaven/"
                "@Town square/npc/@Mikka/MikkaMind.md"
            )
            _write_donor_cartridge(
                donor,
                {
                    "npcs.jsonl": [
                        {
                            "kind": "person",
                            "slug": "mikka",
                            "payload": {
                                "source_path": "GreenHavenWorld/legacy/elsewhere.md",
                            },
                        },
                        {
                            "kind": "person",
                            "slug": "mikka-legacy",
                            "payload": {
                                "db_profile_json": json.dumps(
                                    {"source_path": mikka_source}
                                ),
                            },
                        },
                    ],
                },
            )
            with self.assertRaises(compiler.MergeIdentityConflictError):
                _run_compile_with_donor(vault, donor)


class GeneratedRecordsNumericDbIdTests(unittest.TestCase):
    def test_generated_records_have_no_numeric_db_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            output, _ = _run_compile(vault)
            records_dir = output / "records"
            for jsonl_path in sorted(records_dir.glob("*.jsonl")):
                for line in jsonl_path.read_text(encoding="utf-8").splitlines():
                    if not line.strip():
                        continue
                    record = json.loads(line)
                    payload = record.get("payload") or {}
                    for forbidden in compiler.NUMERIC_DB_ID_KEYS:
                        self.assertNotIn(
                            forbidden,
                            payload,
                            f"{jsonl_path.name}: {record.get('record_id')} carries forbidden key {forbidden}",
                        )

    def test_compiler_blocks_when_numeric_db_id_is_injected(self) -> None:
        # Sanity guard: the violation collector + raise path is alive.
        # We can't easily inject from a vault note, so call the helper
        # directly and assert it surfaces the violation.
        violations = compiler.collect_numeric_db_id_violations(
            [
                {
                    "record_id": "ghc:person:demo",
                    "kind": "person",
                    "slug": "demo",
                    "payload": {"db_entity_id": "230000"},
                }
            ]
        )
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["key"], "db_entity_id")
        self.assertEqual(violations[0]["value"], "230000")


class MergeIdentityStableOrderingTests(unittest.TestCase):
    def test_merge_records_jsonl_is_byte_stable_across_runs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            donor = Path(tmp) / "donor"
            _write_donor_cartridge(
                donor,
                {
                    "npcs.jsonl": [
                        {
                            "kind": "person",
                            "slug": "mikka",
                            "payload": {
                                "source_path": (
                                    "GreenHavenWorld/Locations/@City of Greenhaven/"
                                    "@Town square/npc/@Mikka/MikkaMind.md"
                                ),
                            },
                        }
                    ],
                    "locations.jsonl": [
                        {
                            "kind": "location",
                            "slug": "town-square",
                            "payload": {
                                "source_path": (
                                    "GreenHavenWorld/Locations/@City of Greenhaven/"
                                    "@Town square/TownSquareMind.md"
                                ),
                            },
                        }
                    ],
                },
            )
            output, _ = _run_compile_with_donor(vault, donor)
            first = (output / "audit" / "merge-records.jsonl").read_text(encoding="utf-8")
            first_conflicts = (output / "audit" / "merge-conflicts.md").read_text(encoding="utf-8")
            _run_compile_with_donor(vault, donor)
            second = (output / "audit" / "merge-records.jsonl").read_text(encoding="utf-8")
            second_conflicts = (output / "audit" / "merge-conflicts.md").read_text(encoding="utf-8")
            self.assertEqual(first, second)
            self.assertEqual(first_conflicts, second_conflicts)


class HiddenExitMaterializerTests(unittest.TestCase):
    """OWV-7: a ``location/hidden-exit`` materializer marks its
    target location as initially hidden and strips the pre-action
    exit from sibling locations.

    Vault fixture mirrors the live Greenhaven case: ``@Town square``
    is a normal city location and ``@Thief's market`` is a sibling
    that authors no Materializes of its own, but a third quest note
    under the @Town square's barrels item authors:

        ## Materializes

        - Entity: @Thief's market
          Type: location/hidden-exit
          Scope: @Town square
          Effect: opens the hatch.

    After compile we expect the generated location records to show:

      * ``thiefs-market.profile.hidden_until_stage`` is a non-empty
        breadcrumb string;
      * ``town-square.exits`` does NOT contain ``thiefs-market``;
      * ``thiefs-market.exits`` does NOT contain ``town-square``
        (it keeps only its parent district);
      * ``city-of-greenhaven.default_hooks`` does NOT advertise the
        hidden target.
    """

    def _build_hidden_exit_vault(self, tmp: Path) -> Path:
        vault = tmp / "vault"
        world = vault / "GreenHavenWorld"
        world.mkdir(parents=True)
        _write(
            vault / "WORLD_MANIFEST.md",
            """
            # Manifest

            ## Начало игры

            Player begins at [[TownSquareMind|@Town square]].
            """,
        )
        _write(
            world
            / "Locations"
            / "@City of Greenhaven"
            / "CityOfGreenhavenMind.md",
            "# @City of Greenhaven\n\nThe city.\n",
        )
        _write(
            world
            / "Locations"
            / "@City of Greenhaven"
            / "@Town square"
            / "TownSquareMind.md",
            "# @Town square\n\nThe central plaza.\n",
        )
        _write(
            world
            / "Locations"
            / "@City of Greenhaven"
            / "@Thief's market"
            / "Thief'sMarketMind.md",
            "# @Thief's market\n\nThe hidden market.\n",
        )
        # Quest note hanging off the @Barrels item under @Town square
        # carries the hidden-exit Materializes block — same shape as
        # the live `Way to Thief's market.md` quest in the vault.
        _write(
            world
            / "Locations"
            / "@City of Greenhaven"
            / "@Town square"
            / "items"
            / "@Barrels in the square"
            / "BarrelsMind.md",
            "# @Barrels in the square\n\nThe barrels.\n",
        )
        _write(
            world
            / "Locations"
            / "@City of Greenhaven"
            / "@Town square"
            / "items"
            / "@Barrels in the square"
            / "quests"
            / "Way to Thief's market.md",
            """
            # Way to Thief's market

            ## Materializes

            - Entity: @Thief's market
              Type: location/hidden-exit
              Scope: @Town square
              Effect: opens the hatch under the barrels.
            """,
        )
        return vault

    def _load_records(self, output: Path) -> dict[str, dict[str, object]]:
        records: dict[str, dict[str, object]] = {}
        for path in sorted((output / "records").glob("*.jsonl")):
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                records[(row.get("kind") or "") + ":" + (row.get("slug") or "")] = row
        return records

    def test_hidden_exit_target_carries_hidden_until_stage_and_strips_sibling_exits(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = self._build_hidden_exit_vault(Path(tmp))
            output, _ = _run_compile(vault)
            records = self._load_records(output)
            town = records["location:town-square"]["payload"]
            market = records["location:thiefs-market"]["payload"]
            city = records["location:city-of-greenhaven"]["payload"]

            self.assertIn(
                "hidden_until_stage",
                market,
                "thiefs-market should carry hidden_until_stage after compile",
            )
            self.assertTrue(
                isinstance(market["hidden_until_stage"], str)
                and market["hidden_until_stage"].startswith(
                    "materializer:hidden-exit:"
                ),
                f"hidden_until_stage breadcrumb missing or shape wrong: "
                f"{market.get('hidden_until_stage')!r}",
            )
            self.assertNotIn(
                "hidden_until_stage",
                town,
                "open town-square must not carry hidden_until_stage",
            )

            town_exits = town["exits"]
            market_exits = market["exits"]
            self.assertNotIn(
                "thiefs-market",
                town_exits,
                f"town-square exits leaked the hidden target: {town_exits!r}",
            )
            self.assertNotIn(
                "town-square",
                market_exits,
                f"thiefs-market exits leaked town-square: {market_exits!r}",
            )
            # The hidden target still belongs under its district
            # parent so static topology stays consistent.
            self.assertIn(
                "city-of-greenhaven",
                market_exits,
                f"hidden market lost its parent exit: {market_exits!r}",
            )

            # Default hooks on the district must not advertise the
            # hidden target either (the narrator preamble uses these
            # as quick-look mentions).
            self.assertNotIn(
                "thiefs-market",
                city.get("default_hooks", []),
                f"city default_hooks leaked the hidden target: "
                f"{city.get('default_hooks')!r}",
            )

    def test_collect_hidden_exit_targets_helper(self) -> None:
        # Direct unit test on the new compiler helper so a future
        # refactor can change the threading without losing the
        # type/target-kind filter behavior.
        with tempfile.TemporaryDirectory() as tmp:
            vault = self._build_hidden_exit_vault(Path(tmp))
            entities = compiler.scan_vault(vault)
            notes = compiler.load_note_sections(entities)
            by_slug = {entity.slug: entity for entity in entities}
            hidden = compiler.collect_hidden_exit_targets(notes, by_slug)
            self.assertIn("thiefs-market", hidden)
            # The source breadcrumb is the slug of the note that
            # authored the Materializes block.
            self.assertTrue(hidden["thiefs-market"])
            # No other target should sneak in.
            self.assertEqual(set(hidden.keys()), {"thiefs-market"})


if __name__ == "__main__":
    unittest.main()
