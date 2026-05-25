/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-15 — Guarded dev-apply path for Obsidian-vault SQL.
//
// Reads a validated Obsidian preview / production migration SQL file
// and applies it through `execMulti()` against a LOCAL PGlite data
// directory. Refuses to run when:
//   - `DATABASE_URL` is set (managed Postgres target), unless the
//     caller passes `--allow-database-url` for an explicit test fixture.
//   - `--dev-data-dir` is missing or points at the in-repo
//     `packages/web-server/pgdata/` (no implicit overwrite of the live
//     local dev DB).
//   - the SQL contains any destructive statement (DROP / TRUNCATE) or
//     any INSERT / UPDATE / DELETE against player-state, session,
//     telemetry, or migration tables.
//
// On success writes `<out>/dev-apply-report.{json,md}` with the SQL
// path, target data dir, entity / bridge counts after apply, and
// timestamps. The helper never writes to managed Postgres and never
// reads from the donor cartridge — merge/alias reconciliation is a
// compile-time concern handled by `compile_vault_to_forge.py` and
// surfaced into this report by the calling Python harness.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { clearConfigEnv, setConfigEnv } from '../config.js';

interface Args {
  sourceSql: string;
  devDataDir: string;
  out: string;
  allowDatabaseUrl: boolean;
}

function parseArguments(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    options: {
      'source-sql': { type: 'string' },
      'dev-data-dir': { type: 'string' },
      'out': { type: 'string' },
      'allow-database-url': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const sourceSql = typeof values['source-sql'] === 'string' ? values['source-sql'] : '';
  const devDataDir = typeof values['dev-data-dir'] === 'string' ? values['dev-data-dir'] : '';
  const out = typeof values['out'] === 'string' ? values['out'] : '';
  if (!sourceSql) throw new Error('--source-sql <path> is required');
  if (!devDataDir) {
    throw new Error(
      '--dev-data-dir <local-pgdata-dir> is required: obsidian:dev-apply refuses an implicit fallback to %APPDATA% / in-repo pgdata.',
    );
  }
  if (!out) throw new Error('--out <report-dir> is required');
  return {
    sourceSql,
    devDataDir,
    out,
    allowDatabaseUrl: values['allow-database-url'] === true,
  };
}

interface PreflightViolation {
  kind: 'destructive_op' | 'destructive_delete' | 'managed_dml';
  detail: string;
}

const PROTECTED_TABLES = [
  'players',
  'sessions',
  'session_tokens',
  'turn_ingress_queue',
  'player_inventory',
  'player_journal_entries',
  'player_progression',
  'player_titles',
  'npc_memories',
  'schema_migrations',
  'telemetry_events',
];

const DESTRUCTIVE_PATTERNS: Array<{ label: string; rx: RegExp }> = [
  { label: 'DROP TABLE', rx: /\bDROP\s+TABLE\b/i },
  { label: 'DROP SCHEMA', rx: /\bDROP\s+SCHEMA\b/i },
  { label: 'DROP DATABASE', rx: /\bDROP\s+DATABASE\b/i },
  { label: 'TRUNCATE', rx: /\bTRUNCATE\b/i },
];

export function preflightObsidianSql(sql: string): PreflightViolation[] {
  const violations: PreflightViolation[] = [];
  for (const { label, rx } of DESTRUCTIVE_PATTERNS) {
    if (rx.test(sql)) {
      violations.push({
        kind: 'destructive_op',
        detail: `forbidden statement: ${label}`,
      });
    }
  }
  for (const table of PROTECTED_TABLES) {
    if (new RegExp(`\\bDELETE\\s+FROM\\s+${table}\\b`, 'i').test(sql)) {
      violations.push({
        kind: 'destructive_delete',
        detail: `forbidden DELETE FROM ${table}`,
      });
    }
    if (new RegExp(`\\bUPDATE\\s+${table}\\b`, 'i').test(sql)) {
      violations.push({
        kind: 'managed_dml',
        detail: `forbidden UPDATE ${table}`,
      });
    }
    if (new RegExp(`\\bINSERT\\s+INTO\\s+${table}\\b`, 'i').test(sql)) {
      violations.push({
        kind: 'managed_dml',
        detail: `forbidden INSERT INTO ${table}`,
      });
    }
  }
  return violations;
}

function looksLikeRepoLocalPgdata(absDir: string): boolean {
  const repoLocal = path.resolve('packages', 'web-server', 'pgdata');
  return absDir === repoLocal || absDir.startsWith(repoLocal + path.sep);
}

interface RunResult {
  ok: boolean;
  exitCode: number;
  report: Record<string, unknown>;
}

export async function runDevApply(args: Args): Promise<RunResult> {
  if (process.env.DATABASE_URL && !args.allowDatabaseUrl) {
    return {
      ok: false,
      exitCode: 2,
      report: {
        ok: false,
        reason: 'managed_database_url',
        message:
          'DATABASE_URL is set; obsidian:dev-apply refuses to write to managed Postgres. Unset the env var or pass --allow-database-url for an explicit local test URL.',
      },
    };
  }

  const sqlPath = path.resolve(args.sourceSql);
  if (!existsSync(sqlPath)) {
    return {
      ok: false,
      exitCode: 1,
      report: {
        ok: false,
        reason: 'missing_source_sql',
        sourceSql: sqlPath,
      },
    };
  }

  const absDevDataDir = path.resolve(args.devDataDir);
  if (looksLikeRepoLocalPgdata(absDevDataDir)) {
    return {
      ok: false,
      exitCode: 2,
      report: {
        ok: false,
        reason: 'repo_local_pgdata',
        message:
          `--dev-data-dir ${absDevDataDir} points at the in-repo packages/web-server/pgdata. Use a fresh staging directory instead.`,
        devDataDir: absDevDataDir,
      },
    };
  }
  mkdirSync(absDevDataDir, { recursive: true });

  const sql = readFileSync(sqlPath, 'utf8');
  const violations = preflightObsidianSql(sql);
  if (violations.length > 0) {
    return {
      ok: false,
      exitCode: 3,
      report: {
        ok: false,
        reason: 'destructive_preflight',
        sourceSql: sqlPath,
        devDataDir: absDevDataDir,
        violations,
      },
    };
  }

  clearConfigEnv('DATABASE_URL');
  setConfigEnv('PGLITE_DATA_DIR', absDevDataDir);

  // OWV-15 hardening: dev-apply targets a *fresh* PGlite data dir on
  // every call. The generated Obsidian SQL is a forward-only patch
  // (INSERT INTO entities ... ON CONFLICT (id) DO UPDATE), so the
  // target schema has to exist before we touch it. Run the normal
  // migration runner first; it's idempotent against an already-
  // initialized dev DB and brings a fresh dir up to the latest
  // schema without any test-only bootstrap.
  const { execMulti, query } = await import('../db.js');
  const { runMigrations } = await import('../migrate.js');

  const startedAt = new Date().toISOString();
  let migrationsApplied: string[] = [];
  let migrationsSkipped = 0;
  let migrationError: string | null = null;
  try {
    const result = await runMigrations();
    migrationsApplied = result.applied;
    migrationsSkipped = result.skipped.length;
  } catch (err) {
    migrationError = err instanceof Error ? err.message : String(err);
  }
  if (migrationError) {
    return {
      ok: false,
      exitCode: 4,
      report: {
        ok: false,
        reason: 'migration_runner_failed',
        sourceSql: sqlPath,
        devDataDir: absDevDataDir,
        startedAt,
        finishedAt: new Date().toISOString(),
        migrationsApplied,
        migrationsSkipped,
        migrationError,
      },
    };
  }

  let applyError: string | null = null;
  let entitiesAfter = 0;
  let bridgesAfter = 0;
  let startingLocationId: number | null = null;
  try {
    await execMulti(`BEGIN; ${sql}; COMMIT;`);
    await query(
      `INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [path.basename(sqlPath)],
    );
    // OWV-15 hardening: the full migration chain loads ~1.3k baseline
    // grinhaven-full entities. Count only the Obsidian-derived subset
    // (profile.source_category = 'forge-roundtrip') so the assertion
    // surfaces *this apply's* contribution, not the donor cartridge.
    const e = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM entities
        WHERE cartridge_id = 'grinhaven-full'
          AND profile->>'source_category' = 'forge-roundtrip'`,
    );
    entitiesAfter = Number(e.rows[0]?.count ?? 0);
    const m = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM cartridge_meta
        WHERE key IN (
          'forge_currency_bridge',
          'forge_merchant_contracts',
          'forge_materializer_bridge',
          'forge_scene_instructions',
          'forge_visual_assets'
        )`,
    );
    bridgesAfter = Number(m.rows[0]?.count ?? 0);
    const s = await query<{ value: unknown }>(
      `SELECT value FROM cartridge_meta WHERE key = 'starting_location_id'`,
    );
    const raw = s.rows[0]?.value;
    if (typeof raw === 'number') startingLocationId = raw;
    else if (typeof raw === 'string') {
      const parsed = Number(raw);
      startingLocationId = Number.isFinite(parsed) ? parsed : null;
    }
  } catch (err) {
    applyError = err instanceof Error ? err.message : String(err);
  }

  const ok = applyError === null;
  return {
    ok,
    exitCode: ok ? 0 : 4,
    report: {
      ok,
      sourceSql: sqlPath,
      devDataDir: absDevDataDir,
      startedAt,
      finishedAt: new Date().toISOString(),
      migrationsApplied,
      migrationsAppliedCount: migrationsApplied.length,
      migrationsSkipped,
      entitiesAfter,
      bridgesAfter,
      startingLocationId,
      applyError,
    },
  };
}

function renderMarkdown(report: Record<string, unknown>): string {
  const ok = report.ok === true;
  const reason = typeof report.reason === 'string' ? report.reason : undefined;
  const lines: string[] = [
    '# Obsidian Dev-Apply Report',
    '',
    `- status: ${ok ? 'OK' : 'REJECTED'}`,
  ];
  if (reason) lines.push(`- reason: ${reason}`);
  if (typeof report.sourceSql === 'string') lines.push(`- sourceSql: ${report.sourceSql}`);
  if (typeof report.devDataDir === 'string') lines.push(`- devDataDir: ${report.devDataDir}`);
  if (typeof report.migrationsAppliedCount === 'number') {
    lines.push(
      `- migrations applied: ${report.migrationsAppliedCount}`
        + (typeof report.migrationsSkipped === 'number'
          ? ` (skipped: ${report.migrationsSkipped})`
          : ''),
    );
  }
  if (typeof report.entitiesAfter === 'number') {
    lines.push(`- entitiesAfter (grinhaven-full): ${report.entitiesAfter}`);
  }
  if (typeof report.bridgesAfter === 'number') {
    lines.push(`- bridgesAfter (forge_*): ${report.bridgesAfter}`);
  }
  if (
    typeof report.startingLocationId === 'number'
    || report.startingLocationId === null
  ) {
    lines.push(`- startingLocationId: ${report.startingLocationId}`);
  }
  if (typeof report.startedAt === 'string') lines.push(`- startedAt: ${report.startedAt}`);
  if (typeof report.finishedAt === 'string') lines.push(`- finishedAt: ${report.finishedAt}`);
  if (Array.isArray(report.violations)) {
    lines.push('', '## Violations', '');
    for (const v of report.violations) {
      if (typeof v === 'object' && v && 'detail' in v) {
        lines.push(`- ${String((v as Record<string, unknown>).kind)}: ${String((v as Record<string, unknown>).detail)}`);
      }
    }
  }
  if (typeof report.applyError === 'string' && report.applyError) {
    lines.push('', '## Apply error', '', '```', report.applyError, '```');
  }
  if (typeof report.message === 'string') {
    lines.push('', '## Message', '', report.message);
  }
  return lines.join('\n') + '\n';
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (err) {
    console.error(`[obsidian:dev-apply] ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  const result = await runDevApply(args);
  try {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(
      path.join(args.out, 'dev-apply-report.json'),
      JSON.stringify(result.report, null, 2) + '\n',
      'utf8',
    );
    writeFileSync(
      path.join(args.out, 'dev-apply-report.md'),
      renderMarkdown(result.report),
      'utf8',
    );
  } catch (err) {
    console.error(`[obsidian:dev-apply] failed to write report: ${err instanceof Error ? err.message : err}`);
    return Math.max(result.exitCode, 5);
  }
  if (!result.ok) {
    console.error(`[obsidian:dev-apply] rejected (exit ${result.exitCode}). See ${path.join(args.out, 'dev-apply-report.md')}.`);
    return result.exitCode;
  }
  console.log(
    `[obsidian:dev-apply] applied ${path.basename(args.sourceSql)} → ${args.devDataDir} (entities=${result.report.entitiesAfter}, bridges=${result.report.bridgesAfter}).`,
  );
  return 0;
}

function isDirectInvocation(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const normalized = argv1.replace(/\\/g, '/');
  // tsx + node may rewrite the extension. Match by basename so the
  // check is stable across .ts (tsx) and .js (compiled) runs.
  return /obsidian-dev-apply\.(?:ts|js|mjs)$/.test(normalized);
}

if (isDirectInvocation()) {
  main().then(
    code => process.exit(code),
    err => {
      console.error(`[obsidian:dev-apply] unexpected failure: ${err}`);
      process.exit(1);
    },
  );
}
