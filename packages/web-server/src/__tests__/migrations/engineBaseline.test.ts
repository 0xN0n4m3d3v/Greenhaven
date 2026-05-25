/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-2 — baseline application + emptiness contract.
//
// Applies `packages/web-server/baseline/0001_engine_baseline.sql`
// directly to a fresh PGlite instance with the vector extension
// enabled, then asserts:
//   1. The full engine schema lands (key tables across the
//      cartridge / runtime / playthrough / FEAT-CART-LIB layers).
//   2. Authored Greenhaven world content is absent (entities,
//      players, cartridges, cartridge_meta cartridge-scoped keys,
//      i18n_translations for cartridge entity keys, etc.).
//   3. Engine-owned seeds expected by the runtime are present
//      (mechanical-vocab i18n, persona archetypes, density_caps,
//      world_clock cadence).
//   4. The bookkeeping row recording the baseline version is
//      present.
//
// The test deliberately does NOT call `withPristineDb()` — that
// helper still exercises the archived historical migration chain for
// invariant coverage. The baseline artifact lives or dies on its own.

import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite/vector';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'baseline',
  '0001_engine_baseline.sql',
);
const BASELINE_VERSION = 'baseline-0001-engine';

// Tables that must exist after the baseline applies. This list is the
// post-0128 engine surface — any new engine table added in a future
// migration should be appended here so the baseline never silently
// loses a contract.
const EXPECTED_TABLES = [
  // 0001 cartridge core
  'entities',
  'runtime_fields',
  'runtime_values',
  'inventory_entries',
  'transitions',
  // 0002 litrpg
  'players',
  'player_stats',
  'player_skills',
  'chat_messages',
  'sessions',
  'runtime_player_overlay',
  // engine taxonomies
  'persona_archetypes',
  // i18n
  'i18n_keys',
  'i18n_translations',
  // quest + inventory
  'player_quests',
  'items',
  'player_proficient_skills',
  // 0018 cartridge meta + 0125 cartridge library
  'cartridge_meta',
  'cartridges',
  'cartridge_import_runs',
  'cartridge_records',
  'cartridge_meta_scoped',
  'hero_cartridge_states',
  // 0126/0127 import jobs (apply state lives on cartridge_import_preview_jobs)
  'cartridge_install_cache',
  'cartridge_import_preview_jobs',
  // gui events / queues
  'gui_events',
  'turn_ingress_queue',
  'adventure_queue',
  // telemetry / performance
  'turn_telemetry',
  'performance_events',
  'telemetry_events',
  // 0085 / 0086 memory + living world
  'npc_memories',
  'memory_clusters',
  'memory_threads',
  'player_location_visits',
  'actor_statuses',
  'location_intro_bubbles',
  // SEC-6 session tokens
  'session_tokens',
  // FEAT-INV-1 / FEAT-NOTICE-1 / FEAT-STATE-1
  'player_journal_entries',
  // bookkeeping
  'schema_migrations',
];

// Cartridge-content tables that must contain zero rows after a
// baseline-only bootstrap.
const EMPTY_TABLES = [
  'entities',
  'players',
  'cartridges',
  'cartridge_records',
  'cartridge_meta_scoped',
  'hero_cartridge_states',
  'cartridge_install_cache',
  'cartridge_import_runs',
  'cartridge_import_preview_jobs',
  'runtime_values',
  'inventory_entries',
  // `items` is engine-seeded with 6 stock D&D items (oil_flask,
  // healing_potion, torch, shortsword, water_skin, rope_50ft) by
  // 0038 — those are engine vocab, not cartridge content.
  'transitions',
  'chat_messages',
  'sessions',
  'npc_memories',
  'memory_clusters',
  'memory_threads',
  'player_location_visits',
  'actor_statuses',
  'location_intro_bubbles',
  'player_quests',
  'player_journal_entries',
];

interface PGliteRow {
  [key: string]: unknown;
}

async function applyBaseline(): Promise<{db: PGlite; dataDir: string}> {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), 'greenhaven-engine-baseline-'),
  );
  const db = await PGlite.create(dataDir, {extensions: {vector}});
  await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const sql = await readFile(BASELINE_PATH, 'utf8');
  await db.exec(`BEGIN; ${sql}; COMMIT;`);
  return {db, dataDir};
}

describe('engine baseline (FEAT-ENGINE-BASELINE-2)', () => {
  let db: PGlite | null = null;
  let dataDir: string | null = null;

  beforeEach(async () => {
    const applied = await applyBaseline();
    db = applied.db;
    dataDir = applied.dataDir;
  });

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
    if (dataDir) {
      await rm(dataDir, {recursive: true, force: true});
      dataDir = null;
    }
  });

  it('applies cleanly and records its bookkeeping row', async () => {
    if (!db) throw new Error('no db');
    const versions = await db.query<{name: string}>(
      `SELECT name FROM schema_migrations WHERE name = $1`,
      [BASELINE_VERSION],
    );
    expect(versions.rows.map((r) => r.name)).toEqual([BASELINE_VERSION]);
  });

  it('creates every expected engine table', async () => {
    if (!db) throw new Error('no db');
    const present = await db.query<{table_name: string}>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = new Set(present.rows.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !names.has(t));
    expect(missing, `missing engine tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('contains no authored cartridge content', async () => {
    if (!db) throw new Error('no db');
    for (const table of EMPTY_TABLES) {
      const result = await db.query<{c: number}>(
        `SELECT COUNT(*)::int AS c FROM ${quoteIdent(table)}`,
      );
      const count = Number(result.rows[0]?.c ?? 0);
      expect(count, `${table} should be empty on the baseline`).toBe(0);
    }
  });

  it('does not pre-install a grinhaven-full cartridge', async () => {
    if (!db) throw new Error('no db');
    const direct = await db.query<{c: number}>(
      `SELECT COUNT(*)::int AS c FROM cartridges
        WHERE id IN ('grinhaven-full', 'quickgrin-lane', 'robot-empty')`,
    );
    expect(Number(direct.rows[0]?.c ?? 0)).toBe(0);

    const scoped = await db.query<{c: number}>(
      `SELECT COUNT(*)::int AS c FROM cartridge_meta_scoped`,
    );
    expect(Number(scoped.rows[0]?.c ?? 0)).toBe(0);
  });

  it('does not seed the quickgrin cartridge_meta keys', async () => {
    if (!db) throw new Error('no db');
    const result = await db.query<{key: string}>(
      `SELECT key FROM cartridge_meta
        WHERE key IN (
          'cartridge_id',
          'cartridge_version',
          'starting_location_id',
          'starting_scene_id',
          'default_class_id',
          'currency_item_id',
          'starting_currency_count',
          'reset_inventory_seeds',
          'reset_runtime_overrides',
          'atmosphere_presets'
        )`,
    );
    expect(result.rows.map((r) => r.key)).toEqual([]);
  });

  it('keeps engine-owned cartridge_meta knobs (density_caps + world_clock)', async () => {
    if (!db) throw new Error('no db');
    const result = await db.query<{key: string}>(
      `SELECT key FROM cartridge_meta
        WHERE key IN ('density_caps', 'world_clock')
        ORDER BY key`,
    );
    const keys = result.rows.map((r) => r.key);
    expect(keys).toContain('density_caps');
    expect(keys).toContain('world_clock');
  });

  it('seeds the engine persona archetypes (engine bubble taxonomy)', async () => {
    if (!db) throw new Error('no db');
    const result = await db.query<{slug: string}>(
      `SELECT slug FROM persona_archetypes ORDER BY slug`,
    );
    const slugs = result.rows.map((r) => r.slug);
    expect(slugs).toContain('narrator_parchment');
    expect(slugs).toContain('npc_rounded_tail');
    expect(slugs).toContain('player_echo');
    expect(slugs).toContain('system_pill');
  });

  it('seeds engine mechanical vocab i18n (condition + mode labels)', async () => {
    if (!db) throw new Error('no db');
    const conditions = await db.query<{key: string}>(
      `SELECT key FROM i18n_keys WHERE category = 'condition' ORDER BY key`,
    );
    expect(conditions.rows.length).toBeGreaterThan(0);
    expect(conditions.rows.map((r) => r.key)).toContain('condition.bleeding');

    const englishLabels = await db.query<{value: string}>(
      `SELECT value FROM i18n_translations
        WHERE key = 'condition.bleeding' AND lang = 'en'`,
    );
    expect(englishLabels.rows[0]?.value).toBe('Bleeding');
  });

  it('does NOT seed cartridge-entity i18n (no entity i18n keys land on baseline)', async () => {
    if (!db) throw new Error('no db');
    // Cartridge entity i18n (0023, 0024, 0065-0072) writes into the
    // entities.i18n column, not i18n_keys. entities is empty on a
    // baseline-only bootstrap, so there is nothing to assert there.
    // What WOULD leak through is entries_in_entities — verify zero.
    const entities = await db.query<{c: number}>(
      `SELECT COUNT(*)::int AS c FROM entities`,
    );
    expect(Number(entities.rows[0]?.c ?? 0)).toBe(0);
  });

  it('runtime_fields holds only engine cross-cutting registrations', async () => {
    if (!db) throw new Error('no db');
    // 0026 (conditions), 0027 (strings), 0028 (trauma), 0033, 0034
    // all register cross-cutting field rows via `SELECT FROM entities
    // WHERE kind=...` patterns. On an empty entities table they
    // produce zero rows naturally. The baseline must not contain any
    // owner_entity_id-bound runtime_fields rows.
    const result = await db.query<{c: number}>(
      `SELECT COUNT(*)::int AS c FROM runtime_fields`,
    );
    expect(Number(result.rows[0]?.c ?? 0)).toBe(0);
  });

  it('engine functions are installed (rebuild_local_density, safe_jsonb_array)', async () => {
    if (!db) throw new Error('no db');
    const fns = await db.query<{proname: string}>(
      `SELECT proname FROM pg_proc
        WHERE proname IN (
          'rebuild_local_density',
          'safe_jsonb_array'
        )
        ORDER BY proname`,
    );
    const names = fns.rows.map((r) => r.proname);
    expect(names).toContain('rebuild_local_density');
    expect(names).toContain('safe_jsonb_array');
  });
});

function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`unsafe identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

// Unused type guard kept for future row-shape assertions.
void ({} as PGliteRow);
