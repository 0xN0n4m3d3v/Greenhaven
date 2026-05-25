/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-4 — migration 0128 invariants.
//
// Pins the four new columns added to `hero_cartridge_states`
// (playthrough_id, reset_generation, hero_snapshot, world_snapshot)
// and the index on playthrough_id.

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

describe.sequential('FEAT-CART-LIB-4 cartridge playthrough launch (0128)', () => {
  test('hero_cartridge_states gained playthrough launch columns', async () => {
    await withPristineDb(async (db) => {
      const cols = await db.query<{
        column_name: string;
        is_nullable: string;
        data_type: string;
      }>(`
        SELECT column_name, is_nullable, data_type
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'hero_cartridge_states'
         ORDER BY column_name
      `);
      const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
      const playthroughId = byName.get('playthrough_id');
      expect(playthroughId).toBeTruthy();
      // After backfill the column is NOT NULL.
      expect(playthroughId?.is_nullable).toBe('NO');
      expect(playthroughId?.data_type).toBe('uuid');
      const resetGen = byName.get('reset_generation');
      expect(resetGen).toBeTruthy();
      expect(resetGen?.is_nullable).toBe('NO');
      expect(resetGen?.data_type).toBe('integer');
      const heroSnap = byName.get('hero_snapshot');
      expect(heroSnap).toBeTruthy();
      expect(heroSnap?.is_nullable).toBe('NO');
      expect(heroSnap?.data_type).toBe('jsonb');
      const worldSnap = byName.get('world_snapshot');
      expect(worldSnap).toBeTruthy();
      expect(worldSnap?.is_nullable).toBe('NO');
      expect(worldSnap?.data_type).toBe('jsonb');
    });
  });

  test('playthrough_id index exists for telemetry lookups', async () => {
    await withPristineDb(async (db) => {
      const idx = await db.query<{indexname: string}>(`
        SELECT indexname
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'hero_cartridge_states'
           AND indexname = 'idx_hero_cartridge_states_playthrough_id'
      `);
      expect(idx.rows.length).toBe(1);
    });
  });

  test('reset_generation default is 0 + snapshots default to empty object', async () => {
    await withPristineDb(async (db) => {
      // Make sure we have a cartridge + player + state row we own.
      await db.query(
        `INSERT INTO cartridges (id, title, version, schema_version,
                                  source_kind, content_hash)
         VALUES ('cart-pt-mig-test', 'PT Mig', '0.1', '1',
                 'forge_project', 'sha256:mig')
         ON CONFLICT (id) DO NOTHING`,
      );
      const ent = await db.query<{id: number}>(
        `INSERT INTO entities (kind, display_name, cartridge_id)
         VALUES ('player', 'PT Mig Hero', 'cart-pt-mig-test')
         RETURNING id`,
      );
      const pid = Number(ent.rows[0]?.id);
      await db.query(
        `INSERT INTO players (entity_id, public_id)
         VALUES ($1, gen_random_uuid())
         ON CONFLICT (entity_id) DO NOTHING`,
        [pid],
      );
      await db.query(
        `INSERT INTO hero_cartridge_states (
           player_id, cartridge_id, status
         )
         VALUES ($1, 'cart-pt-mig-test', 'available')`,
        [pid],
      );
      const row = await db.query<{
        reset_generation: number;
        hero_snapshot: Record<string, unknown>;
        world_snapshot: Record<string, unknown>;
        playthrough_id: string | null;
      }>(
        `SELECT reset_generation,
                hero_snapshot,
                world_snapshot,
                playthrough_id::text AS playthrough_id
           FROM hero_cartridge_states
          WHERE player_id = $1 AND cartridge_id = 'cart-pt-mig-test'`,
        [pid],
      );
      const r = row.rows[0];
      expect(Number(r?.reset_generation)).toBe(0);
      expect(r?.hero_snapshot).toEqual({});
      expect(r?.world_snapshot).toEqual({});
      expect(typeof r?.playthrough_id).toBe('string');
      expect(r?.playthrough_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });
});
