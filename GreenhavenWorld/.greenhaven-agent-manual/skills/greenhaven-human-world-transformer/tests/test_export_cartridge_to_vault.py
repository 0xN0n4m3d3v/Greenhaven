"""Focused unittests for the OWV-11 Cartridge → Obsidian exporter.

Covers the four spec acceptance gates:

* placement rules for location / NPC / item / quest / scene
* markdown rendering prefers ``payload.source_markdown`` and stays prose
* diff and stage modes never touch the visible vault
* unsafe ``source_path`` values are refused; placement falls back to slugs
* write mode is hash-guarded — a writer-edited file is left alone
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import export_cartridge_to_vault as exporter  # noqa: E402  (sys.path edit above)


def make_project(tmp_root: Path, records: dict[str, list[dict]]) -> Path:
    """Create a minimal ``cartridge-forge-project`` directory under
    ``tmp_root`` and return its path. ``records`` maps a kind filename
    (``"locations"``, ``"npcs"``, …) to a list of JSON-encodable dicts.
    """

    source = tmp_root / "cartridge-forge-project"
    (source / "records").mkdir(parents=True)
    (source / "forge.project.json").write_text(
        json.dumps(
            {
                "schema_version": "greenhaven.cartridge_forge_project.v1",
                "project_slug": "test-project",
                "pack_slug": "test-project",
                "target_cartridge_id": "test",
                "starting_location_slug": "town-square",
                "mode": "append_patch",
                "source_language": "en",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    for kind, items in records.items():
        path = source / "records" / f"{kind}.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            for item in items:
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
    return source


def base_location(slug: str, name: str, parent_slug: str | None = None) -> dict:
    return {
        "canonical_name": name,
        "kind": "location",
        "slug": slug,
        "record_id": f"ghc:location:{slug}",
        "summary": f"Test location {name}.",
        "payload": {
            "parent_slug": parent_slug,
            "location_kind": "district",
        },
    }


def base_npc(slug: str, name: str, home_slug: str | None) -> dict:
    return {
        "canonical_name": name,
        "kind": "person",
        "slug": slug,
        "record_id": f"ghc:person:{slug}",
        "summary": f"Test NPC {name}.",
        "payload": {
            "home_slug": home_slug,
        },
    }


def base_item(
    slug: str,
    name: str,
    *,
    item_kind: str = "fixture",
    location_slug: str | None = None,
) -> dict:
    return {
        "canonical_name": name,
        "kind": "item",
        "slug": slug,
        "record_id": f"ghc:item:{slug}",
        "summary": f"Test item {name}.",
        "payload": {
            "item_kind": item_kind,
            "location_slug": location_slug,
        },
    }


def base_quest(
    slug: str,
    name: str,
    *,
    giver_slug: str | None = None,
    start_location_slug: str | None = None,
) -> dict:
    return {
        "canonical_name": name,
        "kind": "quest",
        "slug": slug,
        "record_id": f"ghc:quest:{slug}",
        "summary": f"Test quest {name}.",
        "payload": {
            "giver_slug": giver_slug,
            "start_location_slug": start_location_slug,
        },
    }


def base_scene(
    slug: str,
    name: str,
    *,
    owner_npc_slug: str | None = None,
    location_slug: str | None = None,
) -> dict:
    return {
        "canonical_name": name,
        "kind": "scene",
        "slug": slug,
        "record_id": f"ghc:scene:{slug}",
        "summary": f"Test scene {name}.",
        "payload": {
            "owner_npc_slug": owner_npc_slug,
            "location_slug": location_slug,
        },
    }


class PlacementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.vault_root = Path(self.tmp.name)
        (self.vault_root / "GreenHavenWorld").mkdir()
        records = {
            "locations": [
                base_location("city-of-greenhaven", "City of Greenhaven"),
                base_location(
                    "town-square", "Town square", parent_slug="city-of-greenhaven"
                ),
                base_location(
                    "thiefs-market",
                    "Thief's market",
                    parent_slug="city-of-greenhaven",
                ),
            ],
            "npcs": [
                base_npc("mikka", "Mikka", home_slug="town-square"),
                base_npc("sable-vey", "Sable Vey", home_slug="thiefs-market"),
            ],
            "items": [
                base_item("gold-coin", "Gold coin", item_kind="currency"),
                base_item(
                    "barrels-in-the-square",
                    "Barrels in the square",
                    location_slug="town-square",
                ),
            ],
            "quests": [
                base_quest(
                    "pay-the-quiet-toll",
                    "Pay the quiet toll",
                    giver_slug="sable-vey",
                ),
                base_quest(
                    "way-to-thiefs-market",
                    "Way to Thief's market",
                    start_location_slug="town-square",
                ),
            ],
            "scenes": [
                base_scene(
                    "mikka-first-glance",
                    "Mikka first glance",
                    owner_npc_slug="mikka",
                ),
                base_scene(
                    "morning-crowd-opens-the-square",
                    "Morning crowd opens the square",
                    location_slug="town-square",
                ),
            ],
        }
        self.source = make_project(self.vault_root, records)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_locations_use_parent_chain(self) -> None:
        ctx = exporter.load_project(self.source)
        plans = exporter.plan_exports(ctx, self.vault_root, {})
        by_slug = {(p.kind, p.slug): p.target for p in plans}
        self.assertEqual(
            by_slug[("location", "city-of-greenhaven")],
            "GreenHavenWorld/Locations/@City of Greenhaven/CityOfGreenhavenMind.md",
        )
        self.assertEqual(
            by_slug[("location", "town-square")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/TownSquareMind.md",
        )
        # Multi-word + apostrophe name: apostrophe preserved in the folder
        # but stripped in the canonical Mind filename (matches the donor
        # TS `mindFile` algorithm, which collapses all non-alnum runs).
        self.assertEqual(
            by_slug[("location", "thiefs-market")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Thief's market/ThiefSMarketMind.md",
        )

    def test_source_path_is_preserved_when_safe(self) -> None:
        # When the record carries an authored ``payload.source_path`` that
        # already resolves under ``GreenHavenWorld/``, the exporter honors
        # it verbatim — so hand-authored filenames like
        # ``Thief'sMarketMind.md`` survive round-trips intact.
        location = base_location("thiefs-market", "Thief's market")
        location["payload"]["source_path"] = (
            "GreenHavenWorld/Locations/@City of Greenhaven/"
            "@Thief's market/Thief'sMarketMind.md"
        )
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            source = make_project(vault, {"locations": [location]})
            ctx = exporter.load_project(source)
            plans = exporter.plan_exports(ctx, vault, {})
        target = next(p.target for p in plans if p.slug == "thiefs-market")
        self.assertEqual(
            target,
            "GreenHavenWorld/Locations/@City of Greenhaven/@Thief's market/Thief'sMarketMind.md",
        )

    def test_npc_lives_under_home_location(self) -> None:
        ctx = exporter.load_project(self.source)
        plans = exporter.plan_exports(ctx, self.vault_root, {})
        by_slug = {(p.kind, p.slug): p.target for p in plans}
        self.assertEqual(
            by_slug[("person", "mikka")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/npc/@Mikka/MikkaMind.md",
        )
        self.assertEqual(
            by_slug[("person", "sable-vey")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Thief's market/npc/@Sable Vey/SableVeyMind.md",
        )

    def test_currency_items_live_in_economy(self) -> None:
        ctx = exporter.load_project(self.source)
        plans = exporter.plan_exports(ctx, self.vault_root, {})
        by_slug = {(p.kind, p.slug): p.target for p in plans}
        self.assertEqual(
            by_slug[("item", "gold-coin")],
            "GreenHavenWorld/Economy/items/@Gold coin/GoldCoinMind.md",
        )
        # Non-currency items live under their location's items folder.
        self.assertEqual(
            by_slug[("item", "barrels-in-the-square")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/items/@Barrels in the square/BarrelsInTheSquareMind.md",
        )

    def test_quests_route_through_giver_or_start_location(self) -> None:
        ctx = exporter.load_project(self.source)
        plans = exporter.plan_exports(ctx, self.vault_root, {})
        by_slug = {(p.kind, p.slug): p.target for p in plans}
        # giver_slug wins over start_location_slug
        self.assertEqual(
            by_slug[("quest", "pay-the-quiet-toll")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Thief's market/npc/@Sable Vey/quests/Pay the quiet toll.md",
        )
        # giverless quests fall through to start_location_slug
        self.assertEqual(
            by_slug[("quest", "way-to-thiefs-market")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/quests/Way to Thief's market.md",
        )

    def test_scenes_route_through_owner_or_location(self) -> None:
        ctx = exporter.load_project(self.source)
        plans = exporter.plan_exports(ctx, self.vault_root, {})
        by_slug = {(p.kind, p.slug): p.target for p in plans}
        self.assertEqual(
            by_slug[("scene", "mikka-first-glance")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/npc/@Mikka/scenes/@Mikka first glance.md",
        )
        self.assertEqual(
            by_slug[("scene", "morning-crowd-opens-the-square")],
            "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/scenes/@Morning crowd opens the square.md",
        )

    def test_stable_repeated_runs(self) -> None:
        ctx_a = exporter.load_project(self.source)
        ctx_b = exporter.load_project(self.source)
        a = [(p.kind, p.slug, p.target) for p in exporter.plan_exports(ctx_a, self.vault_root, {})]
        b = [(p.kind, p.slug, p.target) for p in exporter.plan_exports(ctx_b, self.vault_root, {})]
        self.assertEqual(a, b)


class SafetyAndRenderingTests(unittest.TestCase):
    def test_is_safe_vault_path_rejects_traversal(self) -> None:
        self.assertTrue(
            exporter.is_safe_vault_path("GreenHavenWorld/Locations/@A/AMind.md")
        )
        self.assertFalse(exporter.is_safe_vault_path("../etc/passwd"))
        self.assertFalse(exporter.is_safe_vault_path("/etc/passwd"))
        self.assertFalse(
            exporter.is_safe_vault_path("GreenHavenWorld/../escape.md")
        )
        self.assertFalse(exporter.is_safe_vault_path(""))
        # Anything outside GreenHavenWorld/ is rejected.
        self.assertFalse(exporter.is_safe_vault_path("other/note.md"))

    def test_is_safe_vault_path_rejects_traversal_prefix_reentry(self) -> None:
        # Regression: a previous version stripped leading `./` and `../`
        # before checking the prefix, so a traversal that re-entered
        # `GreenHavenWorld/` from the parent directory bypassed the
        # guard. The hardened validator rejects every variant.
        for bypass in (
            "../GreenHavenWorld/foo.md",
            "./../GreenHavenWorld/foo.md",
            "../../GreenHavenWorld/foo.md",
            r"..\GreenHavenWorld\foo.md",
            r"..\..\GreenHavenWorld\foo.md",
            r".\GreenHavenWorld\foo.md",
            "GreenHavenWorld/./inside.md",
            "GreenHavenWorld/sub/../foo.md",
        ):
            self.assertFalse(
                exporter.is_safe_vault_path(bypass),
                msg=f"validator must reject {bypass!r}",
            )

    def test_is_safe_vault_path_rejects_absolute_and_unc_paths(self) -> None:
        for bypass in (
            "/GreenHavenWorld/foo.md",
            "//server/share/GreenHavenWorld/foo.md",
            r"\\server\share\GreenHavenWorld\foo.md",
            r"C:\GreenHavenWorld\foo.md",
            "C:/GreenHavenWorld/foo.md",
            "D:GreenHavenWorld/foo.md",
        ):
            self.assertFalse(
                exporter.is_safe_vault_path(bypass),
                msg=f"validator must reject {bypass!r}",
            )

    def test_is_safe_vault_path_rejects_non_string_input(self) -> None:
        # The validator is sometimes fed JSON values straight from the
        # forge project, so non-string inputs (None, lists, dicts) must
        # be rejected without raising.
        self.assertFalse(exporter.is_safe_vault_path(None))  # type: ignore[arg-type]
        self.assertFalse(exporter.is_safe_vault_path(123))  # type: ignore[arg-type]
        self.assertFalse(exporter.is_safe_vault_path({"x": 1}))  # type: ignore[arg-type]

    def test_unsafe_source_path_falls_back_to_slug_placement(self) -> None:
        # source_path tries to escape — exporter must ignore it and route
        # the npc into the home_slug-derived folder instead.
        record = base_npc("mikka", "Mikka", home_slug="town-square")
        record["payload"]["source_path"] = "../escape/mikka.md"
        location = base_location("town-square", "Town square")
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            source = make_project(
                vault,
                {"npcs": [record], "locations": [location]},
            )
            ctx = exporter.load_project(source)
            plans = exporter.plan_exports(ctx, vault, {})
        target = next(
            p.target for p in plans if p.kind == "person" and p.slug == "mikka"
        )
        self.assertNotIn("..", target)
        self.assertEqual(
            target,
            "GreenHavenWorld/Locations/@Town square/npc/@Mikka/MikkaMind.md",
        )

    def test_note_path_for_ignores_traversal_prefix_source_path(self) -> None:
        # Regression: even when `payload.source_path` re-enters the vault
        # name after a `..`, the planner must reject it and fall back to
        # slug-based placement.
        record = base_npc("mikka", "Mikka", home_slug="town-square")
        record["payload"]["source_path"] = "../GreenHavenWorld/sneaky.md"
        location = base_location("town-square", "Town square")
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            source = make_project(
                vault,
                {"npcs": [record], "locations": [location]},
            )
            ctx = exporter.load_project(source)
            plans = exporter.plan_exports(ctx, vault, {})
        target = next(
            p.target for p in plans if p.kind == "person" and p.slug == "mikka"
        )
        self.assertNotIn("..", target)
        self.assertEqual(
            target,
            "GreenHavenWorld/Locations/@Town square/npc/@Mikka/MikkaMind.md",
        )

    def test_render_prefers_source_markdown(self) -> None:
        record = base_npc("mikka", "Mikka", home_slug=None)
        record["payload"]["source_markdown"] = "# @Mikka\n\nAuthored prose.\n"
        body = exporter.render_note(record)
        self.assertEqual(body, "# @Mikka\n\nAuthored prose.\n")
        # No DB ids, no JSON frontmatter, no YAML.
        self.assertNotIn("record_id", body)
        self.assertNotIn("---", body[:3])

    def test_render_fallback_is_prose_only(self) -> None:
        record = {
            "canonical_name": "Town square",
            "kind": "location",
            "slug": "town-square",
            "record_id": "ghc:location:town-square",
            "summary": "A busy square at dawn.",
            "payload": {
                "location_canon": "- Type: square\n- Daylight: yes",
            },
        }
        body = exporter.render_note(record)
        self.assertIn("# @Town square", body)
        self.assertIn("A busy square at dawn.", body)
        self.assertIn("## Canon", body)
        self.assertNotIn("ghc:location:town-square", body)
        self.assertNotIn("{", body)

    def test_unplaced_world_fact_goes_to_bucket(self) -> None:
        record = {
            "canonical_name": "Unrelated fact",
            "kind": "world_fact",
            "slug": "unrelated-fact",
            "record_id": "ghc:world_fact:unrelated-fact",
            "summary": "",
            "payload": {},
        }
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            source = make_project(vault, {"world-facts": [record]})
            ctx = exporter.load_project(source)
            plans = exporter.plan_exports(ctx, vault, {})
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0].status, "unplaced")


class DiffAndStageTests(unittest.TestCase):
    def test_diff_does_not_touch_visible_vault(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            world = vault / "GreenHavenWorld"
            world.mkdir()
            source = make_project(
                vault,
                {"locations": [base_location("town-square", "Town square")]},
            )
            rc = exporter.run(
                [
                    "--source",
                    str(source),
                    "--vault-root",
                    str(vault),
                    "--mode",
                    "diff",
                ]
            )
            self.assertEqual(rc, 0)
            diff_path = (
                vault
                / ".greenhaven-agent-manual"
                / "generated"
                / "export-diff.md"
            )
            self.assertTrue(diff_path.exists())
            # Visible vault still empty.
            visible_files = list(world.rglob("*"))
            self.assertEqual(visible_files, [])

    def test_stage_refuses_writes_outside_staging_root(self) -> None:
        # Defense-in-depth: even if a hand-crafted ExportPlan carries a
        # traversal target, write_staging() must refuse the write. The
        # staging tree stays clean and the visible vault stays empty.
        plan = exporter.ExportPlan(
            record_id="evil",
            kind="person",
            slug="evil",
            display="Evil",
            target="../sneaky.md",
            content="should never land",
            status="create",
        )
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            staging_root = exporter.write_staging([plan], vault)
            self.assertTrue(staging_root.exists() or not staging_root.exists())
            # Nothing under the staging tree.
            self.assertEqual(list(staging_root.rglob("*.md")), [])
            # Nothing leaked into the parent.
            sneaky = vault.parent / "sneaky.md"
            self.assertFalse(sneaky.exists())
            sneaky_in_generated = (
                vault / ".greenhaven-agent-manual" / "generated" / "sneaky.md"
            )
            self.assertFalse(sneaky_in_generated.exists())

    def test_perform_write_refuses_targets_outside_visible_root(self) -> None:
        # Same defense-in-depth for write mode. A traversal target must
        # be skipped, even with --allow-write set, and no file may leak
        # outside <vault-root>/GreenHavenWorld.
        plan = exporter.ExportPlan(
            record_id="evil",
            kind="person",
            slug="evil",
            display="Evil",
            target="../sneaky.md",
            content="should never land",
            status="create",
        )
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            result = exporter.perform_write([plan], vault, {}, allow_write=True)
            self.assertEqual(result["written"], [])
            self.assertEqual(len(result["skipped"]), 1)
            self.assertFalse((vault.parent / "sneaky.md").exists())
            self.assertEqual(
                list((vault / "GreenHavenWorld").rglob("*.md")), []
            )

    def test_stage_writes_only_under_staging_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            world = vault / "GreenHavenWorld"
            world.mkdir()
            source = make_project(
                vault,
                {
                    "locations": [base_location("town-square", "Town square")],
                    "npcs": [base_npc("mikka", "Mikka", home_slug="town-square")],
                },
            )
            rc = exporter.run(
                [
                    "--source",
                    str(source),
                    "--vault-root",
                    str(vault),
                    "--mode",
                    "stage",
                ]
            )
            self.assertEqual(rc, 0)
            staging = (
                vault
                / ".greenhaven-agent-manual"
                / "generated"
                / "export-staging"
                / "GreenHavenWorld"
            )
            staged_files = sorted(p.as_posix() for p in staging.rglob("*.md"))
            self.assertEqual(len(staged_files), 2)
            # Visible vault untouched.
            self.assertEqual(list(world.rglob("*.md")), [])


class WriteModeTests(unittest.TestCase):
    def test_write_requires_allow_write_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            source = make_project(
                vault,
                {"locations": [base_location("town-square", "Town square")]},
            )
            with self.assertRaises(RuntimeError):
                exporter.run(
                    [
                        "--source",
                        str(source),
                        "--vault-root",
                        str(vault),
                        "--mode",
                        "write",
                    ]
                )
            # And no visible files were written.
            self.assertEqual(
                list((vault / "GreenHavenWorld").rglob("*.md")), []
            )

    def test_write_creates_then_preserves_writer_edits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            location_record = base_location("town-square", "Town square")
            location_record["payload"]["source_markdown"] = (
                "# @Town square\n\nExporter-controlled prose.\n"
            )
            source = make_project(vault, {"locations": [location_record]})
            args = [
                "--source",
                str(source),
                "--vault-root",
                str(vault),
                "--mode",
                "write",
                "--allow-write",
            ]
            # First run creates the file and records its hash.
            rc1 = exporter.run(args)
            self.assertEqual(rc1, 0)
            target = (
                vault
                / "GreenHavenWorld"
                / "Locations"
                / "@Town square"
                / "TownSquareMind.md"
            )
            self.assertTrue(target.exists())
            self.assertIn("Exporter-controlled prose.", target.read_text(encoding="utf-8"))

            # Writer edits the visible note. Second run must NOT overwrite.
            edited = "# @Town square\n\nWriter rewrote this completely.\n"
            target.write_text(edited, encoding="utf-8")
            location_record["payload"]["source_markdown"] = (
                "# @Town square\n\nExporter-rewrite v2.\n"
            )
            # Rewrite the source jsonl with the updated record.
            (source / "records" / "locations.jsonl").write_text(
                json.dumps(location_record, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            rc2 = exporter.run(args)
            self.assertEqual(rc2, 0)
            # The writer's edit must still be on disk — conflict protection
            # refused to overwrite.
            self.assertEqual(target.read_text(encoding="utf-8"), edited)

            # The diff must report a `conflict` for this file.
            diff_md = (
                vault
                / ".greenhaven-agent-manual"
                / "generated"
                / "export-diff.md"
            ).read_text(encoding="utf-8")
            self.assertIn("conflict", diff_md)
            self.assertIn("town-square", diff_md)

    def test_write_safely_updates_when_hash_matches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "GreenHavenWorld").mkdir()
            record = base_location("town-square", "Town square")
            record["payload"]["source_markdown"] = "# @Town square\n\nv1.\n"
            source = make_project(vault, {"locations": [record]})
            args = [
                "--source",
                str(source),
                "--vault-root",
                str(vault),
                "--mode",
                "write",
                "--allow-write",
            ]
            self.assertEqual(exporter.run(args), 0)
            target = (
                vault
                / "GreenHavenWorld"
                / "Locations"
                / "@Town square"
                / "TownSquareMind.md"
            )
            # Update the source markdown and rerun — the recorded hash still
            # matches what's on disk, so the exporter is allowed to update.
            record["payload"]["source_markdown"] = "# @Town square\n\nv2.\n"
            (source / "records" / "locations.jsonl").write_text(
                json.dumps(record, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            self.assertEqual(exporter.run(args), 0)
            self.assertIn("v2.", target.read_text(encoding="utf-8"))


class RoundtripStateTests(unittest.TestCase):
    """OWV-16: hidden roundtrip-state artifacts.

    Pins the diff/conflict guard contract: note-hashes JSONL records
    every plan with the spec-required fields, conflict / orphan /
    deleted-note reports surface explicitly, and the legacy
    ``export-hashes.json`` store stays the source of truth for write
    mode so existing exports are not treated as untracked writer
    edits.
    """

    def _vault(self) -> Path:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        vault = Path(tmp.name)
        (vault / "GreenHavenWorld").mkdir()
        return vault

    def test_diff_emits_roundtrip_state_artifacts(self) -> None:
        vault = self._vault()
        source = make_project(
            vault,
            {
                "locations": [base_location("town-square", "Town square")],
                "npcs": [base_npc("mikka", "Mikka", home_slug="town-square")],
            },
        )
        rc = exporter.run(
            [
                "--source", str(source),
                "--vault-root", str(vault),
                "--mode", "diff",
            ]
        )
        self.assertEqual(rc, 0)
        state = vault / ".greenhaven-agent-manual" / "generated" / "roundtrip-state"
        self.assertTrue((state / "note-hashes.jsonl").is_file())
        self.assertTrue((state / "conflicts.md").is_file())
        self.assertTrue((state / "orphaned-db-records.md").is_file())
        self.assertTrue((state / "deleted-note-candidates.md").is_file())
        # Diff mode never touches the visible vault.
        self.assertEqual(list((vault / "GreenHavenWorld").rglob("*.md")), [])

    def test_note_hashes_jsonl_records_contract_fields(self) -> None:
        vault = self._vault()
        record = base_location("town-square", "Town square")
        record["payload"]["source_markdown"] = "# @Town square\n\nv1.\n"
        source = make_project(vault, {"locations": [record]})
        rc = exporter.run(
            [
                "--source", str(source),
                "--vault-root", str(vault),
                "--mode", "diff",
            ]
        )
        self.assertEqual(rc, 0)
        rows = [
            json.loads(line)
            for line in (
                vault
                / ".greenhaven-agent-manual"
                / "generated"
                / "roundtrip-state"
                / "note-hashes.jsonl"
            )
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        for required in (
            "target",
            "record_id",
            "kind",
            "slug",
            "generated_hash",
            "source_project",
            "status",
            "exported_at",
        ):
            self.assertIn(required, row, msg=f"missing required field {required!r}")
        self.assertEqual(row["kind"], "location")
        self.assertEqual(row["slug"], "town-square")
        self.assertEqual(row["status"], "create")
        self.assertEqual(row["source_project"], "test-project")
        self.assertEqual(len(row["generated_hash"]), 64)  # sha256 hex digest

    def test_legacy_hash_store_still_drives_conflict_decisions(self) -> None:
        """Backward compat: an `export-hashes.json` written by an
        earlier exporter must keep its meaning so already-tracked
        notes are not flagged as untracked writer edits when the new
        roundtrip-state code rolls out."""

        vault = self._vault()
        record = base_location("town-square", "Town square")
        record["payload"]["source_markdown"] = "# @Town square\n\nv2.\n"
        source = make_project(vault, {"locations": [record]})
        # Simulate a previously-exported file whose hash matches the
        # legacy store. The new content would change it, but the
        # exporter must treat that as a clean "update", not a conflict.
        target_rel = (
            "GreenHavenWorld/Locations/@Town square/TownSquareMind.md"
        )
        previous_disk = "# @Town square\n\nprior body.\n"
        target_abs = vault / target_rel
        target_abs.parent.mkdir(parents=True, exist_ok=True)
        target_abs.write_text(previous_disk, encoding="utf-8")
        store_path = (
            vault
            / ".greenhaven-agent-manual"
            / "generated"
            / "export-hashes.json"
        )
        store_path.parent.mkdir(parents=True, exist_ok=True)
        store_path.write_text(
            json.dumps(
                {target_rel: exporter.sha256_text(previous_disk)},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        ctx = exporter.load_project(source)
        plans = exporter.plan_exports(ctx, vault, exporter.load_hash_store(vault))
        self.assertEqual(len(plans), 1)
        plan = plans[0]
        self.assertEqual(plan.status, "update")
        self.assertEqual(plan.note, "writer-untouched; safe to overwrite")

    def test_conflicts_report_surfaces_writer_edited_targets(self) -> None:
        vault = self._vault()
        record = base_location("town-square", "Town square")
        record["payload"]["source_markdown"] = "# @Town square\n\nv1.\n"
        source = make_project(vault, {"locations": [record]})
        # Writer authored a different body and the legacy hash store
        # does not know about it.
        target_rel = (
            "GreenHavenWorld/Locations/@Town square/TownSquareMind.md"
        )
        target_abs = vault / target_rel
        target_abs.parent.mkdir(parents=True, exist_ok=True)
        target_abs.write_text(
            "# @Town square\n\nwriter rewrote this.\n", encoding="utf-8"
        )
        rc = exporter.run(
            [
                "--source", str(source),
                "--vault-root", str(vault),
                "--mode", "diff",
            ]
        )
        self.assertEqual(rc, 0)
        conflicts = (
            vault
            / ".greenhaven-agent-manual"
            / "generated"
            / "roundtrip-state"
            / "conflicts.md"
        ).read_text(encoding="utf-8")
        self.assertIn(target_rel, conflicts)
        self.assertIn("writer-edited since last export", conflicts)
        self.assertNotIn("- none", conflicts)

    def test_orphaned_report_surfaces_unplaced_records(self) -> None:
        vault = self._vault()
        record = {
            "canonical_name": "Free-floating fact",
            "kind": "world_fact",
            "slug": "free-floating-fact",
            "record_id": "ghc:world_fact:free-floating-fact",
            "summary": "",
            "payload": {},
        }
        source = make_project(vault, {"world-facts": [record]})
        rc = exporter.run(
            [
                "--source", str(source),
                "--vault-root", str(vault),
                "--mode", "diff",
            ]
        )
        self.assertEqual(rc, 0)
        orphans = (
            vault
            / ".greenhaven-agent-manual"
            / "generated"
            / "roundtrip-state"
            / "orphaned-db-records.md"
        ).read_text(encoding="utf-8")
        self.assertIn("free-floating-fact", orphans)
        self.assertIn("world_fact", orphans)

    def test_deleted_note_candidates_are_reported_not_deleted(self) -> None:
        vault = self._vault()
        record = base_location("town-square", "Town square")
        source = make_project(vault, {"locations": [record]})
        # The legacy hash store remembers a path that is no longer in
        # the current Forge project (and is not on disk either).
        ghost_target = (
            "GreenHavenWorld/Locations/@Old place/OldPlaceMind.md"
        )
        store_path = (
            vault
            / ".greenhaven-agent-manual"
            / "generated"
            / "export-hashes.json"
        )
        store_path.parent.mkdir(parents=True, exist_ok=True)
        store_path.write_text(
            json.dumps({ghost_target: "deadbeef"}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        # Also seed a visible note that was previously tracked but is
        # gone from the project — to verify "still on disk" hint flips.
        # (We leave it absent to exercise the "already removed" branch.)
        rc = exporter.run(
            [
                "--source", str(source),
                "--vault-root", str(vault),
                "--mode", "diff",
            ]
        )
        self.assertEqual(rc, 0)
        deleted = (
            vault
            / ".greenhaven-agent-manual"
            / "generated"
            / "roundtrip-state"
            / "deleted-note-candidates.md"
        ).read_text(encoding="utf-8")
        self.assertIn(ghost_target, deleted)
        self.assertIn("already removed from disk", deleted)
        # Visible vault never touched.
        self.assertFalse((vault / ghost_target).exists())

    def test_stage_writes_roundtrip_state_without_touching_visible_vault(self) -> None:
        vault = self._vault()
        source = make_project(
            vault,
            {
                "locations": [base_location("town-square", "Town square")],
                "npcs": [base_npc("mikka", "Mikka", home_slug="town-square")],
            },
        )
        rc = exporter.run(
            [
                "--source", str(source),
                "--vault-root", str(vault),
                "--mode", "stage",
            ]
        )
        self.assertEqual(rc, 0)
        state = vault / ".greenhaven-agent-manual" / "generated" / "roundtrip-state"
        self.assertTrue((state / "note-hashes.jsonl").is_file())
        self.assertEqual(list((vault / "GreenHavenWorld").rglob("*.md")), [])

    def test_export_diff_references_roundtrip_state_companions(self) -> None:
        vault = self._vault()
        source = make_project(
            vault,
            {"locations": [base_location("town-square", "Town square")]},
        )
        rc = exporter.run(
            [
                "--source", str(source),
                "--vault-root", str(vault),
                "--mode", "diff",
            ]
        )
        self.assertEqual(rc, 0)
        diff_md = (
            vault
            / ".greenhaven-agent-manual"
            / "generated"
            / "export-diff.md"
        ).read_text(encoding="utf-8")
        self.assertIn("Roundtrip-state companions", diff_md)
        self.assertIn("roundtrip-state/note-hashes.jsonl", diff_md)
        self.assertIn("roundtrip-state/conflicts.md", diff_md)
        self.assertIn("roundtrip-state/orphaned-db-records.md", diff_md)
        self.assertIn("roundtrip-state/deleted-note-candidates.md", diff_md)


if __name__ == "__main__":
    unittest.main()
