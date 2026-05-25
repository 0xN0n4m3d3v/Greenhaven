/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-15 — focused tests for the `obsidian:dev-apply` helper.
//
// The helper exposes two pure functions we can drive without spinning
// up the whole web-server:
//
// * `preflightObsidianSql(sql)` returns a list of violations for any
//   destructive op against player-state, sessions, telemetry, or
//   migration tables. Forge-shaped vault migrations have no
//   violations.
// * `runDevApply(args)` resolves the safety guards (DATABASE_URL,
//   repo-local pgdata) and, on success, applies the SQL into a
//   *temporary* PGlite data dir via `execMulti()`.
//
// Tests pin both the preflight and the happy-path apply against a
// freshly seeded temp pgdata directory so the in-repo
// `packages/web-server/pgdata/` is never touched.

// config() requires AUTH_SECRET. The unit suite doesn't load .env; set
// it here before the helper imports `../db.js` (which calls config()
// on first execMulti / query call).
process.env.AUTH_SECRET ??=
  'obsidian-dev-apply-test-auth-secret-32-bytes-min';

import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {preflightObsidianSql, runDevApply} from '../../scripts/obsidian-dev-apply.js';

const PATCH = '0122_obsidian_world_patch_v2.sql';
const MIGRATION_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'migrations',
  'archive-prebaseline',
  PATCH,
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, {recursive: true, force: true});
    } catch {
      // The temp dir may already be gone; nothing to clean up.
    }
  }
});

describe('preflightObsidianSql', () => {
  it('accepts a clean Forge-shaped vault migration', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(preflightObsidianSql(sql)).toEqual([]);
  });

  it('rejects DROP TABLE statements', () => {
    const violations = preflightObsidianSql('DROP TABLE entities;');
    expect(violations.map(v => v.kind)).toContain('destructive_op');
    expect(violations.map(v => v.detail)).toContain('forbidden statement: DROP TABLE');
  });

  it('rejects TRUNCATE statements anywhere in the file', () => {
    const violations = preflightObsidianSql(`-- header\nTRUNCATE players RESTART IDENTITY;`);
    expect(violations.map(v => v.kind)).toContain('destructive_op');
  });

  it('rejects DELETE / UPDATE / INSERT against player + session tables', () => {
    const cases = [
      'DELETE FROM players;',
      'DELETE FROM player_inventory WHERE 1=1;',
      'UPDATE sessions SET state = \'{}\';',
      'UPDATE session_tokens SET jti = NULL;',
      'INSERT INTO npc_memories (id) VALUES (1);',
      'INSERT INTO schema_migrations (name) VALUES (\'rogue\');',
      'INSERT INTO telemetry_events (id) VALUES (1);',
      'INSERT INTO player_journal_entries (id) VALUES (1);',
      'INSERT INTO player_progression (id) VALUES (1);',
      'INSERT INTO player_titles (id) VALUES (1);',
      'INSERT INTO turn_ingress_queue (id) VALUES (1);',
    ];
    for (const sql of cases) {
      const violations = preflightObsidianSql(sql);
      expect(violations.length, `expected ${sql} to be rejected`).toBeGreaterThan(0);
    }
  });
});

describe('runDevApply safety guards', () => {
  it('refuses to run when DATABASE_URL is set without --allow-database-url', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://example.invalid/managed';
    try {
      const result = await runDevApply({
        sourceSql: MIGRATION_PATH,
        devDataDir: makeTempDir(),
        out: makeTempDir(),
        allowDatabaseUrl: false,
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.report.reason).toBe('managed_database_url');
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it('refuses to run against the in-repo packages/web-server/pgdata', async () => {
    const repoLocal = path.resolve('packages', 'web-server', 'pgdata');
    const result = await runDevApply({
      sourceSql: MIGRATION_PATH,
      devDataDir: repoLocal,
      out: makeTempDir(),
      allowDatabaseUrl: false,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.report.reason).toBe('repo_local_pgdata');
  });

  it('refuses to run when the source SQL file is missing', async () => {
    const result = await runDevApply({
      sourceSql: path.join(makeTempDir(), 'does-not-exist.sql'),
      devDataDir: makeTempDir(),
      out: makeTempDir(),
      allowDatabaseUrl: false,
    });
    expect(result.ok).toBe(false);
    expect(result.report.reason).toBe('missing_source_sql');
  });

  it('rejects an SQL file with a destructive statement before touching the DB', async () => {
    const sqlPath = path.join(makeTempDir(), 'evil.sql');
    writeFileSync(sqlPath, 'DROP TABLE entities;', 'utf8');
    const devDataDir = makeTempDir();
    const out = makeTempDir();
    const result = await runDevApply({
      sourceSql: sqlPath,
      devDataDir,
      out,
      allowDatabaseUrl: false,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.report.reason).toBe('destructive_preflight');
    expect(Array.isArray(result.report.violations)).toBe(true);
  });
});

describe('runDevApply happy path', () => {
  // OWV-15 hardening: a fresh temp PGlite dir runs through the full
  // migration chain (currently ~120 files) before the source SQL is
  // applied. Allow generous time on Windows / cold caches.
  const TIMEOUT_MS = 600_000;

  beforeEach(() => {
    // The web-server `db.ts` reads DATABASE_URL on first call. We
    // need to ensure it is unset for this branch — but other tests in
    // the same suite may have set it. Snapshot + restore.
    process.env.GREENHAVEN_PRIOR_DATABASE_URL = process.env.DATABASE_URL ?? '';
    delete process.env.DATABASE_URL;
  });

  it(
    'initializes a fresh temp PGlite via runMigrations and applies the real 0122 source SQL',
    async () => {
      const devDataDir = makeTempDir();
      const outDir = makeTempDir();

      // No schema bootstrap: a *fresh* temp data dir starts empty,
      // the helper has to run runMigrations() against it before the
      // generated SQL can land.
      const result = await runDevApply({
        sourceSql: MIGRATION_PATH,
        devDataDir,
        out: outDir,
        allowDatabaseUrl: false,
      });

      expect(result.ok, `dev-apply failed: ${JSON.stringify(result.report)}`).toBe(true);
      expect(result.exitCode).toBe(0);
      // FEAT-ENGINE-BASELINE-3 — runMigrations() now bootstraps from
      // the clean baseline; 0122 is no longer applied by the migration
      // runner. It is applied directly by `runDevApply` after the
      // baseline lands. Verify the baseline ran and the patch
      // contract still produced the OWV-14 cartridge shape below.
      expect(result.report.migrationsAppliedCount).toBeGreaterThan(0);
      expect(Array.isArray(result.report.migrationsApplied)).toBe(true);
      expect(result.report.migrationsApplied).toContain(
        'baseline-0001-engine',
      );
      expect(result.report.migrationsApplied).not.toContain(PATCH);
      // Cartridge contract:
      expect(result.report.entitiesAfter).toBe(34);
      expect(result.report.bridgesAfter).toBe(5);
      expect(result.report.startingLocationId).toBe(904983);
      expect(existsSync(devDataDir)).toBe(true);
    },
    TIMEOUT_MS,
  );
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'owv15-dev-apply-'));
  tempDirs.push(dir);
  return dir;
}
