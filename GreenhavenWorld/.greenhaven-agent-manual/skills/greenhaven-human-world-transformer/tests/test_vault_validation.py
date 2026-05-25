"""Focused unittests for ``vault_validation.py`` (OWV-4).

These tests pin the validator's behaviour against the silent fallback
sites OWV-4 closes: unresolved prose mentions, missing materialiser
targets, scenes without an owner/prose-linked NPC, locations with no
real exit context, missing/unmapped visual assets, and pre-write
duplicate-entity blocks. The validator is exercised directly so each
case stays cheap and deterministic; one integration test confirms the
Forge compiler still wraps the duplicate path in
``DuplicateEntityError`` for the OWV-12 contract.
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
import vault_validation as vv  # noqa: E402


def _entity(
    *,
    display: str,
    kind: str,
    path: str,
    text: str = "",
    owner: str | None = None,
    parent: str | None = None,
    relation: str | None = None,
) -> vault_scan.Entity:
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
        text=text or f"# @{display}\n",
        parts=parts,
    )


def _note(entity: vault_scan.Entity) -> vs.NoteSections:
    return vs.note_sections(entity)


def _manifest(start_slug: str | None, start_mention: str | None = None) -> vs.ManifestInfo:
    return vs.ManifestInfo(
        start_wikilink=None,
        start_mention=start_mention,
        start_slug=start_slug,
        source_path="WORLD_MANIFEST.md",
    )


class StartLocationTests(unittest.TestCase):
    def test_unresolved_start_location_is_fatal(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location],
            notes=[_note(location)],
            manifest=_manifest(None),
        )
        codes = [f.code for f in report.errors]
        self.assertIn("start_location.unresolved", codes)
        self.assertTrue(report.has_errors)

    def test_invalid_start_target_is_fatal(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location],
            notes=[_note(location)],
            manifest=_manifest("ghost-town", start_mention="@Ghost town"),
        )
        codes = [f.code for f in report.errors]
        self.assertIn("start_location.invalid_target", codes)


class UnresolvedMentionTests(unittest.TestCase):
    def test_unresolved_prose_mention_surfaces_as_warning(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
            text="# @Town square\n\n@Sable Vey watches from a corner.\n",
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location],
            notes=[_note(location)],
            manifest=_manifest("town-square", start_mention="@Town square"),
            unresolved=[
                {
                    "mention": "@Sable Vey",
                    "source": location.path,
                }
            ],
        )
        warning_codes = [f.code for f in report.warnings]
        self.assertIn("mention.unresolved", warning_codes)
        finding = next(f for f in report.warnings if f.code == "mention.unresolved")
        self.assertEqual(finding.mention, "@Sable Vey")
        self.assertEqual(finding.source_path, location.path)

    def test_duplicate_unresolved_rows_collapse(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
            text="@Ghost @Ghost @Ghost",
        )
        unresolved = [
            {"mention": "@Ghost", "source": location.path},
            {"mention": "@Ghost", "source": location.path},
            {"mention": "@Ghost", "source": location.path},
        ]
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location],
            notes=[_note(location)],
            manifest=_manifest("town-square"),
            unresolved=unresolved,
        )
        unresolved_findings = [
            f for f in report.findings if f.code == "mention.unresolved"
        ]
        self.assertEqual(len(unresolved_findings), 1)


class MaterializesTests(unittest.TestCase):
    def test_missing_materializes_target_is_create_candidate(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
        )
        npc_text = textwrap.dedent(
            """
            # @Mikka

            ## Materializes

            - Entity: @Hidden cache
              Type: clue
              Scope: scene
              Effect: appears during stage 2.
            """
        ).strip()
        npc = _entity(
            display="Mikka",
            kind="person",
            path=(
                "GreenHavenWorld/Locations/@Town square/npc/@Mikka/MikkaMind.md"
            ),
            text=npc_text,
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location, npc],
            notes=[_note(location), _note(npc)],
            manifest=_manifest("town-square"),
        )
        questions = [f for f in report.questions if f.code == "materializes.create_candidate"]
        self.assertEqual(len(questions), 1)
        finding = questions[0]
        self.assertEqual(finding.target_mention, "@Hidden cache")
        self.assertEqual(finding.mention, "@Mikka")

    def test_existing_materializes_target_is_not_create_candidate(self) -> None:
        cache = _entity(
            display="Hidden cache",
            kind="item",
            path=(
                "GreenHavenWorld/Locations/@Town square/items/"
                "@Hidden cache/HiddenCacheMind.md"
            ),
        )
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
        )
        npc_text = textwrap.dedent(
            """
            # @Mikka

            ## Materializes

            - Entity: @Hidden cache
              Type: clue
              Scope: scene
              Effect: surfaces.
            """
        ).strip()
        npc = _entity(
            display="Mikka",
            kind="person",
            path=(
                "GreenHavenWorld/Locations/@Town square/npc/@Mikka/MikkaMind.md"
            ),
            text=npc_text,
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location, npc, cache],
            notes=[_note(location), _note(npc), _note(cache)],
            manifest=_manifest("town-square"),
        )
        questions = [f for f in report.questions if f.code == "materializes.create_candidate"]
        self.assertEqual(questions, [])


class SceneTests(unittest.TestCase):
    def test_scene_without_owner_or_prose_person_is_valid_location_scene(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
        )
        scene = _entity(
            display="Empty square at noon",
            kind="scene",
            path=(
                "GreenHavenWorld/Locations/@Town square/scenes/"
                "Empty square at noon.md"
            ),
            text="# Empty square at noon\n\nNobody is here yet.\n",
            parent="Town square",
            relation="location_scene",
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location, scene],
            notes=[_note(location), _note(scene)],
            manifest=_manifest("town-square"),
        )
        codes = [f.code for f in report.warnings]
        self.assertNotIn("scene.fallback_participant", codes)

    def test_scene_owner_unresolved_is_fatal(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
        )
        # The scene path references @Ghost via the npc folder segment,
        # but no @Ghost NPC is authored.
        scene = _entity(
            display="Ghost first scene",
            kind="scene",
            path=(
                "GreenHavenWorld/Locations/@Town square/npc/@Ghost/scenes/"
                "Ghost first scene.md"
            ),
            text="# Ghost first scene\n",
            owner="Ghost",
            parent="Ghost",
            relation="npc_scene",
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location, scene],
            notes=[_note(location), _note(scene)],
            manifest=_manifest("town-square"),
        )
        codes = [f.code for f in report.errors]
        self.assertIn("scene.owner_unresolved", codes)


class LocationTopologyTests(unittest.TestCase):
    def test_isolated_location_warns_about_self_exits(self) -> None:
        # A lone location with no parent, no child, and no prose links —
        # the compiler would emit `exits: [self.slug]` as a placeholder.
        location = _entity(
            display="Lonely shrine",
            kind="location",
            path=(
                "GreenHavenWorld/Locations/@Lonely shrine/LonelyShrineMind.md"
            ),
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location],
            notes=[_note(location)],
            manifest=_manifest("lonely-shrine"),
        )
        codes = [f.code for f in report.warnings]
        self.assertIn("location.no_exits", codes)

    def test_location_with_child_does_not_warn(self) -> None:
        outer = _entity(
            display="City of Greenhaven",
            kind="location",
            path=(
                "GreenHavenWorld/Locations/@City of Greenhaven/"
                "CityOfGreenhavenMind.md"
            ),
        )
        inner = _entity(
            display="Town square",
            kind="location",
            path=(
                "GreenHavenWorld/Locations/@City of Greenhaven/"
                "@Town square/TownSquareMind.md"
            ),
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[outer, inner],
            notes=[_note(outer), _note(inner)],
            manifest=_manifest("town-square"),
        )
        codes = [f.code for f in report.warnings]
        self.assertNotIn("location.no_exits", codes)


class QuestTests(unittest.TestCase):
    def test_quest_with_item_parent_emits_giver_fallback(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
        )
        item = _entity(
            display="Barrels in the square",
            kind="item",
            path=(
                "GreenHavenWorld/Locations/@Town square/items/"
                "@Barrels in the square/BarrelsMind.md"
            ),
        )
        quest = _entity(
            display="Way to Thief's market",
            kind="quest",
            path=(
                "GreenHavenWorld/Locations/@Town square/items/"
                "@Barrels in the square/quests/Way to Thief's market.md"
            ),
            parent="Barrels in the square",
            relation="quest_source",
            text="# Way to Thief's market\n\nMove the barrels.\n",
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location, item, quest],
            notes=[_note(location), _note(item), _note(quest)],
            manifest=_manifest("town-square"),
        )
        codes = [f.code for f in report.warnings]
        self.assertIn("quest.giver_fallback", codes)


class VisualAssetTests(unittest.TestCase):
    def test_missing_visual_row_warns(self) -> None:
        location = _entity(
            display="Town square",
            kind="location",
            path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
        )
        report = vv.validate_vault(
            vault=Path("."),
            entities=[location],
            notes=[_note(location)],
            manifest=_manifest("town-square"),
            visual_rows=[
                {
                    "mention": "@Town square",
                    "kind": "location",
                    "role": "scene",
                    "source": location.path,
                    "target": "GreenHavenWorld/images/town-square.png",
                    "exists": False,
                }
            ],
        )
        codes = [f.code for f in report.warnings]
        self.assertIn("visual_asset.missing", codes)

    def test_unmapped_visual_warns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp).resolve()
            stray = vault / "GreenHavenWorld" / "images" / "stray.png"
            stray.parent.mkdir(parents=True, exist_ok=True)
            stray.write_bytes(b"")
            location = _entity(
                display="Town square",
                kind="location",
                path="GreenHavenWorld/Locations/@Town square/TownSquareMind.md",
            )
            report = vv.validate_vault(
                vault=vault,
                entities=[location],
                notes=[_note(location)],
                manifest=_manifest("town-square"),
                unmapped_visuals=[stray],
            )
        codes = [f.code for f in report.warnings]
        self.assertIn("visual_asset.unmapped", codes)


class DuplicateTests(unittest.TestCase):
    def test_validate_emits_duplicate_slug_finding(self) -> None:
        a = _entity(display="Mikka-1", kind="person", path="x/AMind.md")
        b = _entity(display="Mikka 1", kind="person", path="y/BMind.md")
        report = vv.validate_vault(
            vault=Path("."),
            entities=[a, b],
            notes=[_note(a), _note(b)],
            manifest=_manifest(None),
        )
        codes = [f.code for f in report.errors]
        self.assertIn("duplicate.slug", codes)
        self.assertTrue(report.has_errors)

    def test_compiler_raises_validation_error_on_missing_start_location(self) -> None:
        """OWV-4: non-duplicate fatal validation findings short-circuit
        the Forge compile path with a :class:`ValidationError` before
        any project bytes are written."""

        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            world = vault / "GreenHavenWorld" / "Locations" / "@Town square"
            world.mkdir(parents=True)
            (world / "TownSquareMind.md").write_text(
                "# @Town square\n", encoding="utf-8"
            )
            # WORLD_MANIFEST.md exists but declares no start location.
            (vault / "WORLD_MANIFEST.md").write_text(
                "# Manifest\n\n## Начало игры\n\nTBD.\n",
                encoding="utf-8",
            )
            output_dir = vault / "out"
            with self.assertRaises(vv.ValidationError) as ctx:
                compiler.compile_vault(vault, output_dir)
            self.assertFalse(
                isinstance(ctx.exception, compiler.DuplicateEntityError),
                msg="missing start_location should raise the base ValidationError",
            )
            # The Forge project directory must not exist after a fatal
            # validation failure.
            self.assertFalse(output_dir.exists())


if __name__ == "__main__":
    unittest.main()
