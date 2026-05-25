/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-3 — `runMigrations()` bootstrap contract.
//
// Three mode branches exercised here:
//
//   1. Fresh DB (`schema_migrations` empty) → applies the baseline
//      once, records `baseline-0001-engine`, skips every prebaseline
//      manifest entry, returns `mode === 'fresh-baseline'`.
//   2. Re-run after baseline applied → returns
//      `mode === 'baseline-deltas'`, applies zero new rows, skips
//      every prebaseline manifest entry.
//   3. Legacy DB seeded with a historical migration name (no
//      baseline row) → returns `mode === 'legacy-chain'`, emits a
//      console warning, does NOT apply the baseline, continues
//      applying any unrecorded historical migrations.
//
// The suite drives a real PGlite via the same `closeDb()` / temp dir
// dance used by the production bootstrap. Each test uses a fresh
// data directory so the global db.ts singletons reset cleanly.

import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {closeDb, query} from '../../db.js';
import {
  BASELINE_PATH,
  BASELINE_VERSION,
  runMigrations,
  PREBASELINE_MANIFEST_PATH,
} from '../../migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_PREBASELINE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'migrations',
  'archive-prebaseline',
);

let dataDir: string | null = null;

async function loadManifest(): Promise<Set<string>> {
  const raw = await readFile(PREBASELINE_MANIFEST_PATH, 'utf8');
  const names = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!trimmed.endsWith('.sql')) continue;
    names.add(trimmed);
  }
  return names;
}

beforeEach(async () => {
  dataDir = await mkdtemp(
    path.join(os.tmpdir(), 'greenhaven-runmigrations-'),
  );
  process.env['PGLITE_DATA_DIR'] = dataDir;
  delete process.env['DATABASE_URL'];
  // config() requires a 32+ char AUTH_SECRET. The runner only touches
  // db.ts, but db.ts pulls config() during ensureBackend().
  process.env['AUTH_SECRET'] ??=
    'engine-baseline-runtests-secret-must-be-32-bytes-or-more';
  process.env['NODE_ENV'] ??= 'test';
  process.env['AUTH_DISABLED'] ??= '1';
});

afterEach(async () => {
  await closeDb();
  if (dataDir) {
    await rm(dataDir, {recursive: true, force: true});
    dataDir = null;
  }
  delete process.env['PGLITE_DATA_DIR'];
  vi.restoreAllMocks();
});

describe.sequential('runMigrations baseline-first bootstrap (FEAT-ENGINE-BASELINE-3)', () => {
  it('fresh DB applies the baseline once and skips every prebaseline migration', {timeout: 60_000}, async () => {
    const result = await runMigrations();
    expect(result.mode).toBe('fresh-baseline');
    // FEAT-HERO-CONTINUITY-3 (2026-05-17) — fresh-baseline applies
    // the baseline plus every post-baseline delta in numbered order.
    // The post-baseline list is currently:
    //   * 0128a_legacy_cartridge_runtime_repair.sql
    //   * 0129_hero_universe_instances.sql
    //   * 0130_hero_continuity_ledger.sql
    // Add new deltas to this expected order as they land.
    expect(result.applied).toEqual([
      BASELINE_VERSION,
      '0128a_legacy_cartridge_runtime_repair.sql',
      '0129_hero_universe_instances.sql',
      '0130_hero_continuity_ledger.sql',
    ]);

    const recorded = await query<{name: string}>(
      `SELECT name FROM schema_migrations ORDER BY name`,
    );
    const names = recorded.rows.map((r) => r.name);
    expect(names).toContain(BASELINE_VERSION);
    expect(names).toContain('0128a_legacy_cartridge_runtime_repair.sql');
    expect(names).toContain('0129_hero_universe_instances.sql');
    expect(names).toContain('0130_hero_continuity_ledger.sql');

    const manifest = await loadManifest();
    const historicalRecorded = names.filter((n) => manifest.has(n));
    expect(historicalRecorded, 'no prebaseline migration name should appear in fresh schema_migrations').toEqual([]);

    // Prebaseline files now live under archive-prebaseline/ and are
    // not visible to the top-level migration scan at all; they appear
    // in neither applied[] nor skipped[]. The contract that matters
    // is that none of them landed in schema_migrations, which is
    // already asserted above via `historicalRecorded` empty.
    for (const file of manifest) {
      expect(
        result.applied.includes(file),
        `prebaseline migration ${file} must NOT be applied on a fresh-baseline run`,
      ).toBe(false);
    }
  });

  it('the second run is a no-op (baseline-deltas mode, zero new applied)', {timeout: 60_000}, async () => {
    await runMigrations();
    const second = await runMigrations();
    expect(second.mode).toBe('baseline-deltas');
    expect(second.applied).toEqual([]);
  });

  it('no authored cartridge content lands after a fresh-baseline bootstrap', {timeout: 60_000}, async () => {
    await runMigrations();
    const counts = await query<{
      entities: number;
      players: number;
      cartridges: number;
      cartridge_meta_scoped: number;
      runtime_values: number;
      npc_memories: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM entities) AS entities,
         (SELECT COUNT(*)::int FROM players) AS players,
         (SELECT COUNT(*)::int FROM cartridges) AS cartridges,
         (SELECT COUNT(*)::int FROM cartridge_meta_scoped) AS cartridge_meta_scoped,
         (SELECT COUNT(*)::int FROM runtime_values) AS runtime_values,
         (SELECT COUNT(*)::int FROM npc_memories) AS npc_memories`,
    );
    const row = counts.rows[0];
    if (!row) throw new Error('count query returned no rows');
    expect(Number(row.entities)).toBe(0);
    expect(Number(row.players)).toBe(0);
    expect(Number(row.cartridges)).toBe(0);
    expect(Number(row.cartridge_meta_scoped)).toBe(0);
    expect(Number(row.runtime_values)).toBe(0);
    expect(Number(row.npc_memories)).toBe(0);
  });

  it('legacy DB with historical schema_migrations rows is detected and the baseline is skipped', {timeout: 120_000}, async () => {
    // Seed the bookkeeping table as if 0001-0128 had previously
    // applied. We do not need the schema to exist for this branch
    // (the runner only inspects schema_migrations rows to decide the
    // mode) but we do need the bookkeeping table; runMigrations()
    // creates it itself before reading.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First, bootstrap an empty DB so the schema_migrations table
    // exists. Then drop the baseline row and insert a fake
    // historical row to simulate the legacy shape.
    await runMigrations();
    await query(`DELETE FROM schema_migrations WHERE name = $1`, [
      BASELINE_VERSION,
    ]);
    await query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [
      '0001_cartridge.sql',
    ]);

    const result = await runMigrations();
    expect(result.mode).toBe('legacy-chain');
    expect(result.applied).not.toContain(BASELINE_VERSION);

    // The compatibility warning is emitted on every legacy-mode call.
    const calls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
    const matched = calls.some((line) =>
      line.includes('legacy schema_migrations rows detected without'),
    );
    expect(matched, 'expected a legacy-mode compatibility warning').toBe(true);

    // The seeded historical-only row stays in place; the baseline
    // row should remain absent.
    const recorded = await query<{name: string}>(
      `SELECT name FROM schema_migrations`,
    );
    const names = new Set(recorded.rows.map((r) => r.name));
    expect(names.has(BASELINE_VERSION)).toBe(false);
    expect(names.has('0001_cartridge.sql')).toBe(true);
  });

  it('the baseline file is present at the documented path', async () => {
    // Static smoke: the runtime relies on the generator artifact
    // landing at this path; a missing or zero-byte file would silently
    // break fresh boots.
    const sql = await readFile(BASELINE_PATH, 'utf8');
    expect(sql.length).toBeGreaterThan(10_000);
    expect(sql).toContain(`'${BASELINE_VERSION}'`);
  });

  it('manifest covers every prebaseline .sql file in the archive directory', async () => {
    const manifest = await loadManifest();
    const onDisk = (
      await (await import('node:fs/promises')).readdir(ARCHIVE_PREBASELINE_DIR)
    ).filter((f) => f.endsWith('.sql'));
    // Every prebaseline file in the manifest must still exist under
    // archive-prebaseline so the framework helper can replay the
    // historical chain in invariant tests.
    for (const name of manifest) {
      expect(
        onDisk.includes(name),
        `manifest references missing migration file ${name}`,
      ).toBe(true);
    }
    // And the inverse: every archive file should be named in the
    // manifest. New post-baseline deltas DO NOT belong under the
    // archive directory.
    for (const file of onDisk) {
      expect(
        manifest.has(file),
        `archive .sql ${file} is not in the prebaseline manifest`,
      ).toBe(true);
    }
  });
});
