"""OWV-15 focused tests for the export_vault_sql harness.

The export script wires together vault compile, Forge validation, SQL
export, and (newly) a guarded `dev-apply` path that runs the SQL into
a local PGlite data dir via the `obsidian:dev-apply` web-server helper.
These tests cover the Python side only:

* `--current-cartridge` is passed through to `compile_vault(...)`,
* merge-alias reconciliation surfaces in the generated report,
* a customized donor `@Mikka` resolves cleanly (no duplicate / no
  conflict) when the donor's slug and source_path both match the
  generated record,
* the dev-apply branch refuses to run without `--dev-data-dir` /
  `--dev-apply-out` and returns the refusal in the report rather than
  silently no-op'ing.

The TS-side preflight + DB apply behavior is covered by a separate
vitest in `packages/web-server/src/__tests__/scripts/` so we don't
have to spin up PGlite from Python.
"""

from __future__ import annotations

import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import export_vault_sql as exporter  # noqa: E402
import compile_vault_to_forge as compiler  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip("\n"), encoding="utf-8")


def _build_vault(tmp: Path) -> Path:
    """Seed a minimal vault that the compiler can lift end-to-end."""

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
    _write(
        world / "Economy" / "items" / "@Copper coin" / "CopperCoinMind.md",
        "# @Copper coin\n\nCanonical copper coin.\n",
    )
    _write(
        world / "Economy" / "Currency.md",
        "# Currency of Greenhaven\n\nValuta blueprint.\n",
    )
    _write(
        world / "Locations" / "@City of Greenhaven" / "@Town square" / "npc" / "@Mikka" / "MikkaMind.md",
        "# @Mikka\n\n## Identity\n\n@Mikka is the info-broker on @Town square.\n",
    )
    _write(
        world
        / "Locations"
        / "@City of Greenhaven"
        / "@Town square"
        / "scenes"
        / "@Morning crowd.md",
        """
        # @Morning crowd

        ## Триггер

        - Локация: @Town square

        ## Поведение

        Morning opens.
        """,
    )
    return vault


def _customized_donor_with_mikka(donor_root: Path, mikka_source_path: str) -> None:
    """Write a donor cartridge whose Mikka entry already matches the
    generated record by slug + source_path. OWV-13 reconciliation
    classifies this as `exact_slug_match` and must not raise.
    """

    records_dir = donor_root / "records"
    records_dir.mkdir(parents=True, exist_ok=True)
    donor_row = {
        "kind": "person",
        "slug": "mikka",
        "payload": {
            "source_path": mikka_source_path,
            "customized_field": "writer note kept on disk",
        },
    }
    (records_dir / "npcs.jsonl").write_text(
        json.dumps(donor_row, sort_keys=True) + "\n", encoding="utf-8",
    )


class CurrentCartridgePassthroughTests(unittest.TestCase):
    """Confirm `--current-cartridge` reaches `compile_vault(...)`."""

    def test_compile_vault_receives_explicit_donor_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            vault = _build_vault(tmp_path)
            donor = tmp_path / "donor"
            mikka_path = (
                "GreenHavenWorld/Locations/@City of Greenhaven/"
                "@Town square/npc/@Mikka/MikkaMind.md"
            )
            _customized_donor_with_mikka(donor, mikka_path)

            captured: dict[str, object] = {}
            real_compile = exporter.compile_vault

            def spy_compile(vault_arg, **kwargs):
                captured["vault"] = vault_arg
                captured["current_cartridge_root"] = kwargs.get("current_cartridge_root")
                return real_compile(vault_arg, **kwargs)

            with (
                mock.patch.object(exporter, "compile_vault", side_effect=spy_compile),
                mock.patch.object(exporter, "run_forge", side_effect=lambda *_a, **_kw: {"ok": True}),
            ):
                report = exporter.export_vault_sql(
                    vault_root=vault,
                    repo_root=None,
                    out_sql=None,
                    write_migration=False,
                    dry_run=True,
                    migration_name="obsidian_world_patch_test",
                    force_export=False,
                    current_cartridge=donor,
                    dev_apply=False,
                    dev_data_dir=None,
                    dev_apply_out=None,
                    dev_allow_database_url=False,
                )
            self.assertEqual(captured.get("current_cartridge_root"), donor.resolve())
            self.assertIn("merge_records", report)
            self.assertIn("audit_jsonl", report["merge_records"])
            self.assertIn("status_counts", report["merge_records"])

    def test_compile_vault_falls_back_to_default_when_unspecified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = _build_vault(Path(tmp))
            captured: dict[str, object] = {}

            def spy_compile(vault_arg, **kwargs):
                captured["current_cartridge_root"] = kwargs.get("current_cartridge_root")
                return exporter.compile_vault.__wrapped__(vault_arg, **kwargs) if hasattr(
                    exporter.compile_vault, "__wrapped__"
                ) else compiler.compile_vault(vault_arg, **kwargs)

            with (
                mock.patch.object(exporter, "compile_vault", side_effect=spy_compile),
                mock.patch.object(exporter, "run_forge", side_effect=lambda *_a, **_kw: {"ok": True}),
            ):
                exporter.export_vault_sql(
                    vault_root=vault,
                    repo_root=None,
                    out_sql=None,
                    write_migration=False,
                    dry_run=True,
                    migration_name="obsidian_world_patch_test",
                    force_export=False,
                    current_cartridge=None,
                    dev_apply=False,
                    dev_data_dir=None,
                    dev_apply_out=None,
                    dev_allow_database_url=False,
                )
            self.assertIsNone(captured.get("current_cartridge_root"))


class MikkaReconciliationTests(unittest.TestCase):
    """A customized donor `@Mikka` must not duplicate or block."""

    def test_customized_mikka_resolves_as_exact_slug_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            vault = _build_vault(tmp_path)
            donor = tmp_path / "donor"
            mikka_path = (
                "GreenHavenWorld/Locations/@City of Greenhaven/"
                "@Town square/npc/@Mikka/MikkaMind.md"
            )
            _customized_donor_with_mikka(donor, mikka_path)

            with mock.patch.object(
                exporter, "run_forge", side_effect=lambda *_a, **_kw: {"ok": True}
            ):
                report = exporter.export_vault_sql(
                    vault_root=vault,
                    repo_root=None,
                    out_sql=None,
                    write_migration=False,
                    dry_run=True,
                    migration_name="obsidian_world_patch_test",
                    force_export=False,
                    current_cartridge=donor,
                    dev_apply=False,
                    dev_data_dir=None,
                    dev_apply_out=None,
                    dev_allow_database_url=False,
                )
            audit_jsonl = Path(report["merge_records"]["audit_jsonl"])
            self.assertTrue(audit_jsonl.is_file())
            rows = [
                json.loads(line)
                for line in audit_jsonl.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            mikka_rows = [
                row for row in rows if row["kind"] == "person" and row["slug"] == "mikka"
            ]
            self.assertEqual(len(mikka_rows), 1, "Mikka must not duplicate in the audit")
            self.assertEqual(mikka_rows[0]["status"], compiler.MERGE_STATUS_EXACT_SLUG)
            self.assertEqual(mikka_rows[0]["current_cartridge_slug"], "mikka")
            counts = report["merge_records"]["status_counts"]
            self.assertEqual(counts.get(compiler.MERGE_STATUS_AMBIGUOUS, 0), 0)
            self.assertGreaterEqual(counts.get(compiler.MERGE_STATUS_EXACT_SLUG, 0), 1)

    def test_ambiguous_donor_blocks_export(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            vault = _build_vault(tmp_path)
            donor = tmp_path / "donor"
            records_dir = donor / "records"
            records_dir.mkdir(parents=True, exist_ok=True)
            # Two donor rows clash: slug `mikka` points one place, and
            # `mikka-old` points at the same authored path the
            # generated `mikka` will export. OWV-13 must raise.
            (records_dir / "npcs.jsonl").write_text(
                "".join(
                    json.dumps(row, sort_keys=True) + "\n"
                    for row in [
                        {
                            "kind": "person",
                            "slug": "mikka",
                            "payload": {"source_path": "GreenHavenWorld/legacy/elsewhere.md"},
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
                    ]
                ),
                encoding="utf-8",
            )

            with mock.patch.object(
                exporter, "run_forge", side_effect=lambda *_a, **_kw: {"ok": True}
            ):
                with self.assertRaises(compiler.MergeIdentityConflictError):
                    exporter.export_vault_sql(
                        vault_root=vault,
                        repo_root=None,
                        out_sql=None,
                        write_migration=False,
                        dry_run=True,
                        migration_name="obsidian_world_patch_test",
                        force_export=False,
                        current_cartridge=donor,
                        dev_apply=False,
                        dev_data_dir=None,
                        dev_apply_out=None,
                        dev_allow_database_url=False,
                    )


class DevApplyArgumentTests(unittest.TestCase):
    """`--dev-apply` must demand the safety flags up front."""

    def test_dev_apply_without_data_dir_returns_refusal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            vault = _build_vault(tmp_path)
            with (
                mock.patch.object(
                    exporter, "run_forge", side_effect=lambda *_a, **_kw: {"ok": True}
                ),
                mock.patch.object(exporter, "subprocess") as fake_subprocess,
            ):
                fake_subprocess.run = mock.MagicMock()
                report = exporter.export_vault_sql(
                    vault_root=vault,
                    repo_root=None,
                    out_sql=None,
                    write_migration=False,
                    dry_run=False,
                    migration_name="obsidian_world_patch_test",
                    force_export=False,
                    current_cartridge=None,
                    dev_apply=True,
                    dev_data_dir=None,
                    dev_apply_out=None,
                    dev_allow_database_url=False,
                )
            dev_apply = report["dev_apply"]
            self.assertTrue(dev_apply["enabled"])
            self.assertFalse(dev_apply["ok"])
            self.assertIn("--dev-data-dir", str(dev_apply["stderr"]))
            fake_subprocess.run.assert_not_called()

    def test_dev_apply_dry_run_skips_subprocess(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            vault = _build_vault(tmp_path)
            dev_dir = tmp_path / "dev-data-dir"
            dev_out = tmp_path / "dev-apply-out"
            with (
                mock.patch.object(
                    exporter, "run_forge", side_effect=lambda *_a, **_kw: {"ok": True}
                ),
                mock.patch.object(exporter, "subprocess") as fake_subprocess,
            ):
                fake_subprocess.run = mock.MagicMock()
                report = exporter.export_vault_sql(
                    vault_root=vault,
                    repo_root=None,
                    out_sql=None,
                    write_migration=False,
                    dry_run=True,
                    migration_name="obsidian_world_patch_test",
                    force_export=False,
                    current_cartridge=None,
                    dev_apply=True,
                    dev_data_dir=dev_dir,
                    dev_apply_out=dev_out,
                    dev_allow_database_url=False,
                )
            self.assertTrue(report["dev_apply"]["enabled"])
            self.assertIsNone(report["dev_apply"]["ok"])
            fake_subprocess.run.assert_not_called()

    def test_dev_apply_invokes_ts_helper_with_safety_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            vault = _build_vault(tmp_path)
            dev_dir = tmp_path / "dev-data-dir"
            dev_out = tmp_path / "dev-apply-out"
            dev_out.mkdir(parents=True, exist_ok=True)
            (dev_out / "dev-apply-report.json").write_text("{}", encoding="utf-8")

            def fake_run(cmd, cwd, text, capture_output, check):  # noqa: ARG001
                return mock.MagicMock(returncode=0, stdout="applied\n", stderr="")

            with (
                mock.patch.object(
                    exporter, "run_forge", side_effect=lambda *_a, **_kw: {"ok": True}
                ),
                mock.patch.object(exporter, "subprocess") as fake_subprocess,
            ):
                fake_subprocess.run = mock.MagicMock(side_effect=fake_run)
                report = exporter.export_vault_sql(
                    vault_root=vault,
                    repo_root=None,
                    out_sql=None,
                    write_migration=False,
                    dry_run=False,
                    migration_name="obsidian_world_patch_test",
                    force_export=False,
                    current_cartridge=None,
                    dev_apply=True,
                    dev_data_dir=dev_dir,
                    dev_apply_out=dev_out,
                    dev_allow_database_url=True,
                )
            fake_subprocess.run.assert_called_once()
            invoked_cmd = fake_subprocess.run.call_args.args[0]
            joined = " ".join(invoked_cmd)
            self.assertIn("obsidian:dev-apply", joined)
            self.assertIn("--dev-data-dir", joined)
            self.assertIn(str(dev_dir.resolve()), joined)
            self.assertIn("--out", joined)
            self.assertIn(str(dev_out.resolve()), joined)
            self.assertIn("--allow-database-url", joined)
            self.assertTrue(report["dev_apply"]["ok"])


if __name__ == "__main__":
    unittest.main()
