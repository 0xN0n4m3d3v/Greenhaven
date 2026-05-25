/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-1 — migration 0125 invariants.
//
// Pins the durable shape `CartridgeLibraryService` and the
// scoped-meta helpers depend on: table existence, column types,
// foreign-key cascade/set-null rules, status / source_kind
// CHECK constraints, and the default-cartridge + scoped-meta +
// hero_cartridge_states backfill that has to land on a fresh
// migration run.

import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {rm} from 'node:fs/promises';
import {
  cleanupMigrationTemplates,
  createPristineDataDir,
  withPristineDb,
} from './framework.js';

afterAll(async () => {
  await cleanupMigrationTemplates();
});

beforeAll(async () => {
  const dataDir = await createPristineDataDir();
  await rm(dataDir, {recursive: true, force: true});
}, 600_000);

describe.sequential('FEAT-CART-LIB-1 cartridge library (0125)', () => {
  test('cartridges table has the expected column shape + status check', async () => {
    await withPristineDb(async (db) => {
      const cols = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(`
        SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'cartridges'
         ORDER BY column_name
      `);
      const names = cols.rows.map((r) => r.column_name).sort();
      expect(names).toEqual(
        [
          'content_hash',
          'id',
          'installed_at',
          'manifest',
          'schema_version',
          'source_kind',
          'source_path',
          'status',
          'title',
          'updated_at',
          'validation_report',
          'version',
        ].sort(),
      );
      const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
      expect(byName['id']?.data_type).toBe('text');
      expect(byName['id']?.is_nullable).toBe('NO');
      expect(byName['content_hash']?.is_nullable).toBe('NO');
      expect(byName['manifest']?.data_type).toBe('jsonb');
      expect(byName['validation_report']?.data_type).toBe('jsonb');

      // status CHECK enforces the documented enum
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO cartridges (id, title, version, schema_version,
                                    source_kind, content_hash, status)
           VALUES ('bad', 'Bad', '0', '1', 'builtin', 'h', 'not_a_status')`,
        );
      } catch (err) {
        rejected =
          err instanceof Error && /(check|constraint)/i.test(err.message);
      }
      expect(rejected).toBe(true);
    });
  });

  test('cartridge_import_runs FK cascades from cartridges on delete', async () => {
    await withPristineDb(async (db) => {
      const fks = await db.query<{
        delete_rule: string;
        referenced_table: string;
      }>(`
        SELECT rc.delete_rule,
               ccu.table_name AS referenced_table
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = rc.unique_constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'cartridge_import_runs'
           AND kcu.column_name = 'cartridge_id'
      `);
      expect(fks.rows[0]?.referenced_table).toBe('cartridges');
      expect(fks.rows[0]?.delete_rule).toBe('CASCADE');
    });
  });

  test('cartridge_records primary key is (cartridge_id, record_id) + unique (cartridge_id, kind, slug)', async () => {
    await withPristineDb(async (db) => {
      const pk = await db.query<{column_name: string}>(`
        SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'cartridge_records'
         ORDER BY kcu.ordinal_position
      `);
      expect(pk.rows.map((r) => r.column_name)).toEqual([
        'cartridge_id',
        'record_id',
      ]);

      // The unique-constraint must reject duplicate (cartridge,
      // kind, slug) inserts.
      await db.query(
        `INSERT INTO cartridges (id, title, version, schema_version,
                                  source_kind, content_hash)
         VALUES ('demo', 'Demo', '0', '1', 'builtin', 'h')`,
      );
      await db.query(
        `INSERT INTO cartridge_records
           (cartridge_id, record_id, kind, slug, content_hash)
         VALUES ('demo', 'r1', 'location', 'plaza', 'h1')`,
      );
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO cartridge_records
             (cartridge_id, record_id, kind, slug, content_hash)
           VALUES ('demo', 'r2', 'location', 'plaza', 'h2')`,
        );
      } catch (err) {
        rejected =
          err instanceof Error &&
          /(unique|duplicate|constraint)/i.test(err.message);
      }
      expect(rejected).toBe(true);
    });
  });

  test('cartridge_meta_scoped primary key is (cartridge_id, key)', async () => {
    await withPristineDb(async (db) => {
      const pk = await db.query<{column_name: string}>(`
        SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'cartridge_meta_scoped'
         ORDER BY kcu.ordinal_position
      `);
      expect(pk.rows.map((r) => r.column_name)).toEqual([
        'cartridge_id',
        'key',
      ]);
    });
  });

  test('hero_cartridge_states FKs cascade on player + cascade on cartridge', async () => {
    await withPristineDb(async (db) => {
      const fks = await db.query<{
        column_name: string;
        delete_rule: string;
        referenced_table: string;
      }>(`
        SELECT kcu.column_name,
               rc.delete_rule,
               ccu.table_name AS referenced_table
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = rc.unique_constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'hero_cartridge_states'
           AND kcu.column_name IN ('player_id', 'cartridge_id')
         ORDER BY kcu.column_name
      `);
      const byCol = Object.fromEntries(fks.rows.map((r) => [r.column_name, r]));
      expect(byCol['player_id']?.referenced_table).toBe('entities');
      expect(byCol['player_id']?.delete_rule).toBe('CASCADE');
      expect(byCol['cartridge_id']?.referenced_table).toBe('cartridges');
      expect(byCol['cartridge_id']?.delete_rule).toBe('CASCADE');
    });
  });

  test('default cartridge is backfilled from legacy cartridge_meta', async () => {
    await withPristineDb(async (db) => {
      // Seed cartridge_meta with the migrations' values
      // (already there from 0018) and verify a cartridges row
      // exists for the active cartridge id.
      const id = await db.query<{value: string}>(
        `SELECT value#>>'{}' AS value
           FROM cartridge_meta WHERE key = 'cartridge_id'`,
      );
      const expected = id.rows[0]?.value;
      expect(expected).toBeTruthy();
      const r = await db.query<{id: string; source_kind: string}>(
        `SELECT id, source_kind FROM cartridges WHERE id = $1`,
        [expected],
      );
      expect(r.rows[0]?.id).toBe(expected);
      expect(r.rows[0]?.source_kind).toBe('builtin');
    });
  });

  test('cartridge_meta_scoped is backfilled for the default cartridge with every legacy key', async () => {
    await withPristineDb(async (db) => {
      const id = await db.query<{value: string}>(
        `SELECT value#>>'{}' AS value FROM cartridge_meta WHERE key = 'cartridge_id'`,
      );
      const cartridgeId = id.rows[0]?.value;
      expect(cartridgeId).toBeTruthy();
      const legacyKeys = await db.query<{key: string}>(
        `SELECT key FROM cartridge_meta ORDER BY key`,
      );
      const scopedKeys = await db.query<{key: string}>(
        `SELECT key FROM cartridge_meta_scoped
          WHERE cartridge_id = $1 ORDER BY key`,
        [cartridgeId],
      );
      expect(scopedKeys.rows.map((r) => r.key)).toEqual(
        legacyKeys.rows.map((r) => r.key),
      );
      expect(scopedKeys.rows.length).toBeGreaterThan(0);
    });
  });

  test('seeded players appear in hero_cartridge_states under the default cartridge', async () => {
    await withPristineDb(async (db) => {
      const id = await db.query<{value: string}>(
        `SELECT value#>>'{}' AS value FROM cartridge_meta WHERE key = 'cartridge_id'`,
      );
      const cartridgeId = id.rows[0]?.value;
      const playerCount = await db.query<{count: string}>(
        `SELECT COUNT(*)::text AS count FROM players`,
      );
      const stateCount = await db.query<{count: string}>(
        `SELECT COUNT(*)::text AS count
           FROM hero_cartridge_states
          WHERE cartridge_id = $1`,
        [cartridgeId],
      );
      // Default backfill: one row per existing player, cartridge_id
      // = active default. Equal counts prove no player was missed
      // and no extra rows were inserted.
      expect(stateCount.rows[0]?.count).toBe(playerCount.rows[0]?.count);
    });
  });

  test('default cartridge backfill is idempotent under repeated INSERT attempts (ON CONFLICT DO NOTHING)', async () => {
    // Production `runMigrations()` skips already-applied
    // migrations via `schema_migrations`. The migration body's
    // own idempotency (separate from that bookkeeping) is what
    // matters when the backfill DO block re-runs on a recovery
    // path. Exercise the inner statements directly.
    await withPristineDb(async (db) => {
      const id = await db.query<{value: string}>(
        `SELECT value#>>'{}' AS value FROM cartridge_meta WHERE key = 'cartridge_id'`,
      );
      const cartridgeId = id.rows[0]?.value as string;

      const beforeCart = await db.query<{count: string}>(
        `SELECT COUNT(*)::text AS count FROM cartridges`,
      );
      const beforeScoped = await db.query<{count: string}>(
        `SELECT COUNT(*)::text AS count FROM cartridge_meta_scoped`,
      );
      const beforeStates = await db.query<{count: string}>(
        `SELECT COUNT(*)::text AS count FROM hero_cartridge_states`,
      );

      // Replay the backfill inserts directly.
      await db.query(
        `INSERT INTO cartridges (id, title, version, schema_version,
                                  source_kind, content_hash)
         VALUES ($1, $1, '0', '1', 'builtin', 'legacy:' || $1)
         ON CONFLICT (id) DO NOTHING`,
        [cartridgeId],
      );
      await db.query(
        `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
         SELECT $1, cm.key, cm.value, cm.description
           FROM cartridge_meta cm
           WHERE NOT EXISTS (
             SELECT 1 FROM cartridge_meta_scoped s
              WHERE s.cartridge_id = $1 AND s.key = cm.key
           )`,
        [cartridgeId],
      );
      await db.query(
        `INSERT INTO hero_cartridge_states (
           player_id, cartridge_id, status,
           current_location_id, current_scene_id, snapshot,
           compatibility_report
         )
         SELECT p.entity_id, $1, 'available',
                p.current_location_id, p.current_scene_id,
                '{}'::jsonb, '{}'::jsonb
           FROM players p
           WHERE NOT EXISTS (
             SELECT 1 FROM hero_cartridge_states h
              WHERE h.player_id = p.entity_id
                AND h.cartridge_id = $1
           )`,
        [cartridgeId],
      );

      const afterCart = await db.query<{count: string}>(
        `SELECT COUNT(*)::text AS count FROM cartridges`,
      );
      const afterScoped = await db.query<{count: string}>(
        `SELECT COUNT(*)::text AS count FROM cartridge_meta_scoped`,
      );
      const afterStates = await db.query<{count: string}>(
        `SELECT COUNT(*)::text AS count FROM hero_cartridge_states`,
      );
      expect(afterCart.rows[0]?.count).toBe(beforeCart.rows[0]?.count);
      expect(afterScoped.rows[0]?.count).toBe(beforeScoped.rows[0]?.count);
      expect(afterStates.rows[0]?.count).toBe(beforeStates.rows[0]?.count);
    });
  });
});
