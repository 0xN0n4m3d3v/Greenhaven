from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

from compile_vault_to_forge import compile_vault
from vault_scan import default_vault_root, write_text


DEFAULT_DRAFT_SQL = "obsidian-world-preview.sql"
DEFAULT_MIGRATION_NAME = "obsidian_world_patch"


def export_vault_sql(
    vault_root: Path,
    repo_root: Path | None,
    out_sql: Path | None,
    write_migration: bool,
    dry_run: bool,
    migration_name: str,
    force_export: bool,
    current_cartridge: Path | None,
    dev_apply: bool,
    dev_data_dir: Path | None,
    dev_apply_out: Path | None,
    dev_allow_database_url: bool,
) -> dict[str, Any]:
    vault = vault_root.resolve()
    repo = resolve_repo_root(vault, repo_root)

    # OWV-15: thread the donor cartridge root into compile_vault so the
    # OWV-13 merge/alias reconciliation runs at export time too. None
    # falls back to the compiler's default (live `grinhaven-full-current`).
    compile_report = compile_vault(
        vault,
        current_cartridge_root=current_cartridge.resolve() if current_cartridge else None,
    )
    project = Path(compile_report["project"]).resolve()
    audit_dir = project / "audit"
    draft_sql = (out_sql or audit_dir / DEFAULT_DRAFT_SQL).resolve()

    validation = run_forge(repo, "validate", str(project))
    export_args = ["export-grinhaven-sql", str(project), str(draft_sql)]
    if force_export:
        export_args.append("--force")
    sql_export = run_forge(repo, *export_args)

    planned_migration = next_migration_path(repo, migration_name)
    migration_report: dict[str, Any] = {
        "enabled": write_migration,
        "dry_run": dry_run,
        "planned_path": str(planned_migration),
        "written": False,
    }
    if write_migration and not dry_run:
        sql = draft_sql.read_text(encoding="utf-8")
        migration_text = render_migration_sql(
            planned_migration.name,
            vault,
            project,
            draft_sql,
            sql,
        )
        write_text(planned_migration, migration_text)
        migration_report["written"] = True

    merge_summary = summarize_merge_records(audit_dir, compile_report)

    dev_apply_report: dict[str, Any] = {
        "enabled": dev_apply,
        "ok": None,
        "dev_data_dir": str(dev_data_dir.resolve()) if dev_data_dir else None,
        "out": str(dev_apply_out.resolve()) if dev_apply_out else None,
        "returncode": None,
        "stdout": None,
        "stderr": None,
        "report_path": None,
    }
    if dev_apply and not dry_run:
        dev_apply_report.update(
            run_dev_apply(
                repo=repo,
                source_sql=draft_sql,
                dev_data_dir=dev_data_dir,
                out_dir=dev_apply_out,
                allow_database_url=dev_allow_database_url,
            )
        )

    report = {
        "ok": True,
        "generated_at": now_iso(),
        "vault_root": str(vault),
        "repo_root": str(repo),
        "project": str(project),
        "draft_sql": str(draft_sql),
        "compile": compile_report,
        "validation": validation,
        "sql_export": sql_export,
        "migration": migration_report,
        "merge_records": merge_summary,
        "dev_apply": dev_apply_report,
    }
    write_report(audit_dir, report)
    return report


def summarize_merge_records(audit_dir: Path, compile_report: dict[str, Any]) -> dict[str, Any]:
    """OWV-15: thin pointer block surfacing OWV-13 audit artifacts.

    Returns the on-disk paths of the merge records JSONL + conflicts
    Markdown plus the compile-time status counts. The audit artifacts
    themselves are written by ``compile_vault_to_forge.py`` and are not
    rewritten here.
    """

    return {
        "audit_jsonl": str((audit_dir / "merge-records.jsonl").resolve()),
        "audit_md": str((audit_dir / "merge-conflicts.md").resolve()),
        "status_counts": dict(compile_report.get("merge_status_counts") or {}),
    }


def run_dev_apply(
    *,
    repo: Path,
    source_sql: Path,
    dev_data_dir: Path | None,
    out_dir: Path | None,
    allow_database_url: bool,
) -> dict[str, Any]:
    """OWV-15: invoke the web-server `obsidian:dev-apply` TS helper.

    Refuses to run when the caller did not provide ``--dev-data-dir`` or
    ``--dev-apply-out`` so the dev-apply path never silently overwrites
    the in-repo dev DB. The helper itself does the destructive-statement
    preflight + ``DATABASE_URL`` refusal.
    """

    if dev_data_dir is None:
        return {
            "ok": False,
            "returncode": None,
            "stdout": None,
            "stderr": "--dev-data-dir is required when --dev-apply is set.",
            "report_path": None,
        }
    if out_dir is None:
        return {
            "ok": False,
            "returncode": None,
            "stdout": None,
            "stderr": "--dev-apply-out is required when --dev-apply is set.",
            "report_path": None,
        }
    dev_data_abs = dev_data_dir.resolve()
    out_abs = out_dir.resolve()
    out_abs.mkdir(parents=True, exist_ok=True)

    cmd = [
        npm_bin(),
        "--prefix",
        "packages/web-server",
        "run",
        "obsidian:dev-apply",
        "--",
        "--source-sql",
        str(source_sql),
        "--dev-data-dir",
        str(dev_data_abs),
        "--out",
        str(out_abs),
    ]
    if allow_database_url:
        cmd.append("--allow-database-url")
    proc = subprocess.run(
        cmd,
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )
    report_path = out_abs / "dev-apply-report.json"
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
        "report_path": str(report_path) if report_path.exists() else None,
    }


def resolve_repo_root(vault: Path, explicit: Path | None) -> Path:
    if explicit is not None:
        repo = explicit.resolve()
        assert_repo_root(repo)
        return repo

    candidates: list[Path] = []
    candidates.extend([vault, *vault.parents])
    cwd = Path.cwd().resolve()
    candidates.extend([cwd, *cwd.parents])

    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if is_repo_root(candidate):
            return candidate
    raise FileNotFoundError(
        "Cannot locate Greenhaven repo root. Pass --repo-root C:\\Greenhaven."
    )


def is_repo_root(path: Path) -> bool:
    return (
        (path / "packages" / "cartridge-forge" / "package.json").is_file()
        and (path / "packages" / "web-server" / "migrations").is_dir()
    )


def assert_repo_root(path: Path) -> None:
    if not is_repo_root(path):
        raise FileNotFoundError(
            f"{path} is not a Greenhaven repo root with cartridge-forge and migrations."
        )


def run_forge(repo: Path, *args: str) -> dict[str, Any]:
    cmd = [
        npm_bin(),
        "--prefix",
        "packages/cartridge-forge",
        "run",
        "forge",
        "--",
        *args,
    ]
    proc = subprocess.run(
        cmd,
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )
    parsed = parse_json_object(proc.stdout)
    result = {
        "ok": proc.returncode == 0,
        "command": " ".join(cmd),
        "returncode": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
        "json": parsed,
    }
    if proc.returncode != 0:
        raise RuntimeError(
            f"Forge command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    return result


def npm_bin() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def parse_json_object(text: str) -> Any | None:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def next_migration_path(repo: Path, migration_name: str) -> Path:
    safe_name = safe_migration_name(migration_name)
    migrations = repo / "packages" / "web-server" / "migrations"
    max_prefix = 0
    for path in migrations.glob("*.sql"):
        match = re.match(r"^(\d+)_", path.name)
        if match:
            max_prefix = max(max_prefix, int(match.group(1)))
    prefix = f"{max_prefix + 1:04d}"
    target = migrations / f"{prefix}_{safe_name}.sql"
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite migration: {target}")
    return target


def safe_migration_name(value: str) -> str:
    name = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower())
    name = re.sub(r"_+", "_", name).strip("_")
    if not name:
        raise ValueError("migration name is empty after sanitization")
    return name


def render_migration_sql(
    migration_file: str,
    vault: Path,
    project: Path,
    draft_sql: Path,
    sql: str,
) -> str:
    header = [
        f"-- {migration_file}",
        "-- Generated from the Greenhaven Obsidian vault.",
        f"-- Source vault: {vault}",
        f"-- Cartridge Forge project: {project}",
        f"-- Draft SQL: {draft_sql}",
        f"-- Generated at: {now_iso()}",
        "-- Forward-only rule: after applying, do not edit this file;",
        "-- create a later compensating migration instead.",
        "",
    ]
    return "\n".join(header) + sql.rstrip() + "\n"


def write_report(audit_dir: Path, report: dict[str, Any]) -> None:
    write_text(
        audit_dir / "vault-sql-export-report.json",
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
    )
    migration = report["migration"]
    merge = report.get("merge_records") or {}
    dev_apply = report.get("dev_apply") or {}
    lines = [
        "# Vault SQL Export Report",
        "",
        f"Generated: {report['generated_at']}",
        f"Vault: `{report['vault_root']}`",
        f"Forge project: `{report['project']}`",
        f"Draft SQL: `{report['draft_sql']}`",
        "",
        "## Compile",
        "",
        f"- records: {report['compile']['records']}",
        f"- unresolved: {report['compile']['unresolved']}",
        f"- duplicates: {report['compile']['duplicates']}",
        f"- start location: {report['compile']['start_location']}",
        "",
        "## Validation",
        "",
        f"- forge validate: {'ok' if report['validation']['ok'] else 'failed'}",
        f"- forge SQL export: {'ok' if report['sql_export']['ok'] else 'failed'}",
        "",
        "## Merge Identity Reconciliation (OWV-13)",
        "",
        f"- audit JSONL: `{merge.get('audit_jsonl', 'unset')}`",
        f"- audit Markdown: `{merge.get('audit_md', 'unset')}`",
        "- status counts:",
    ]
    counts = merge.get("status_counts") or {}
    if counts:
        for status, count in sorted(counts.items()):
            lines.append(f"  - {status}: {count}")
    else:
        lines.append("  - (none)")
    lines.extend(
        [
            "",
            "## Migration",
            "",
            f"- enabled: {migration['enabled']}",
            f"- dry-run: {migration['dry_run']}",
            f"- planned path: `{migration['planned_path']}`",
            f"- written: {migration['written']}",
            "",
            "## Dev Apply (OWV-15)",
            "",
            f"- enabled: {dev_apply.get('enabled', False)}",
            f"- ok: {dev_apply.get('ok')}",
            f"- dev data dir: `{dev_apply.get('dev_data_dir') or 'unset'}`",
            f"- report: `{dev_apply.get('report_path') or 'unset'}`",
            "",
        ]
    )
    write_text(audit_dir / "vault-sql-export-report.md", "\n".join(lines))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compile GreenhavenWorld into Cartridge Forge, validate it, export "
            "SQL, and optionally write a forward-only web-server migration."
        )
    )
    parser.add_argument(
        "--vault-root",
        default=str(default_vault_root(__file__)),
        help="Path to the GreenhavenWorld vault root.",
    )
    parser.add_argument(
        "--repo-root",
        default=None,
        help="Path to the Greenhaven repo root. Auto-detected by default.",
    )
    parser.add_argument(
        "--out-sql",
        default=None,
        help="Draft SQL path. Defaults to generated cartridge audit output.",
    )
    parser.add_argument(
        "--write-migration",
        action="store_true",
        help="Write the next packages/web-server/migrations/*.sql file.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compile, validate, and export draft SQL, but do not write a migration.",
    )
    parser.add_argument(
        "--migration-name",
        default=DEFAULT_MIGRATION_NAME,
        help="Migration suffix, without the numeric prefix.",
    )
    parser.add_argument(
        "--force-export",
        action="store_true",
        help="Pass --force to Forge SQL export for explicit invalid-project debug work.",
    )
    parser.add_argument(
        "--current-cartridge",
        default=None,
        help=(
            "Donor cartridge root used for OWV-13 merge/alias reconciliation. "
            "Defaults to the live `grinhaven-full-current` cartridge in the "
            "monorepo. Tests pin custom fixtures here."
        ),
    )
    parser.add_argument(
        "--dev-apply",
        action="store_true",
        help=(
            "OWV-15: apply the exported SQL into a local PGlite dev "
            "data directory after validation. Requires --dev-data-dir + "
            "--dev-apply-out. Refused when DATABASE_URL is set unless "
            "--dev-allow-database-url is also set (test fixtures only)."
        ),
    )
    parser.add_argument(
        "--dev-data-dir",
        default=None,
        help="PGlite data directory for --dev-apply. Required when --dev-apply is set.",
    )
    parser.add_argument(
        "--dev-apply-out",
        default=None,
        help=(
            "Output directory for the dev-apply JSON + Markdown report. "
            "Required when --dev-apply is set."
        ),
    )
    parser.add_argument(
        "--dev-allow-database-url",
        action="store_true",
        help=(
            "Bypass the DATABASE_URL safety guard for explicit test fixtures. "
            "Never enable in production."
        ),
    )
    args = parser.parse_args(argv)

    try:
        report = export_vault_sql(
            vault_root=Path(args.vault_root),
            repo_root=Path(args.repo_root) if args.repo_root else None,
            out_sql=Path(args.out_sql) if args.out_sql else None,
            write_migration=args.write_migration,
            dry_run=args.dry_run,
            migration_name=args.migration_name,
            force_export=args.force_export,
            current_cartridge=Path(args.current_cartridge) if args.current_cartridge else None,
            dev_apply=args.dev_apply,
            dev_data_dir=Path(args.dev_data_dir) if args.dev_data_dir else None,
            dev_apply_out=Path(args.dev_apply_out) if args.dev_apply_out else None,
            dev_allow_database_url=args.dev_allow_database_url,
        )
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
