/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — `0121_character_state_progression.sql` migration
// invariants. Pins the durable shape the `CharacterStateService`
// snapshot and the future progression tools depend on: column
// types and nullability, the `(player_id, title_key)` dedupe
// index on titles, the FK chains to `players(entity_id)` and
// `progression_tracks(track_key)`, and the wallet check
// constraints that prevent negative spendable points.

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

describe.sequential('FEAT-STATE-1 character_state_progression (0121)', () => {
  test('player_titles column shape + dedupe index', async () => {
    await withPristineDb(async (db) => {
      const cols = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(`
        SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'player_titles'
         ORDER BY column_name
      `);
      const byName = Object.fromEntries(cols.rows.map((row) => [row.column_name, row]));
      expect(Object.keys(byName).sort()).toEqual([
        'awarded_at',
        'description',
        'display_name',
        'id',
        'is_equipped',
        'metadata',
        'player_id',
        'source',
        'title_key',
      ]);
      expect(byName['id']!.data_type).toBe('bigint');
      expect(byName['id']!.is_nullable).toBe('NO');
      expect(byName['player_id']!.is_nullable).toBe('NO');
      expect(byName['title_key']!.is_nullable).toBe('NO');
      expect(byName['display_name']!.is_nullable).toBe('NO');
      expect(byName['is_equipped']!.data_type).toBe('boolean');
      expect(byName['metadata']!.data_type).toBe('jsonb');

      const idx = await db.query<{indexname: string; indexdef: string}>(`
        SELECT indexname, indexdef
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'player_titles'
      `);
      const names = idx.rows.map((row) => row.indexname);
      expect(names).toContain('idx_player_titles_dedupe');
      expect(names).toContain('idx_player_titles_player_awarded');
      const dedupe = idx.rows.find(
        (row) => row.indexname === 'idx_player_titles_dedupe',
      );
      expect(dedupe?.indexdef).toMatch(/UNIQUE/);
      expect(dedupe?.indexdef).toMatch(/player_id/);
      expect(dedupe?.indexdef).toMatch(/title_key/);
    });
  });

  test('player_titles dedupes (player_id, title_key) and cascades on player delete', async () => {
    await withPristineDb(async (db) => {
      const ent = await db.query<{id: number}>(`
        INSERT INTO entities (kind, display_name, profile, tags)
        VALUES ('player', 'FEAT-STATE-1 titles', '{}'::jsonb, ARRAY['player'])
        RETURNING id
      `);
      const playerId = Number(ent.rows[0]?.id);
      await db.query(
        `INSERT INTO players
           (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
         VALUES ($1, gen_random_uuid(), 'hash', 'AB2N')`,
        [playerId],
      );

      await db.query(
        `INSERT INTO player_titles (player_id, title_key, display_name)
         VALUES ($1, 'bell-ringer', 'Bell Ringer')`,
        [playerId],
      );
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO player_titles (player_id, title_key, display_name)
           VALUES ($1, 'bell-ringer', 'Duplicate Bell Ringer')`,
          [playerId],
        );
      } catch (err) {
        rejected = err instanceof Error && /duplicate|unique/i.test(err.message);
      }
      expect(rejected).toBe(true);

      // Different key — allowed.
      await db.query(
        `INSERT INTO player_titles (player_id, title_key, display_name)
         VALUES ($1, 'wanderer', 'Wanderer')`,
        [playerId],
      );
      const counted = await db.query<{count: number}>(
        `SELECT COUNT(*)::int AS count FROM player_titles WHERE player_id = $1`,
        [playerId],
      );
      expect(Number(counted.rows[0]?.count)).toBe(2);

      // Cascade on player delete (which cascades from the
      // underlying entity row).
      await db.query(`DELETE FROM entities WHERE id = $1`, [playerId]);
      const afterDelete = await db.query<{count: number}>(
        `SELECT COUNT(*)::int AS count FROM player_titles WHERE player_id = $1`,
        [playerId],
      );
      expect(Number(afterDelete.rows[0]?.count)).toBe(0);
    });
  });

  test('progression_tracks catalog + per-player join shape', async () => {
    await withPristineDb(async (db) => {
      const catalogCols = await db.query<{column_name: string; is_nullable: string}>(`
        SELECT column_name, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'progression_tracks'
         ORDER BY column_name
      `);
      const byName = Object.fromEntries(
        catalogCols.rows.map((row) => [row.column_name, row]),
      );
      expect(Object.keys(byName).sort()).toEqual([
        'description',
        'display_name',
        'max_level',
        'sort_order',
        'track_key',
        'xp_curve',
      ]);
      expect(byName['track_key']!.is_nullable).toBe('NO');
      expect(byName['display_name']!.is_nullable).toBe('NO');

      // Seed a catalog row + a per-player ladder.
      const ent = await db.query<{id: number}>(`
        INSERT INTO entities (kind, display_name, profile, tags)
        VALUES ('player', 'FEAT-STATE-1 tracks', '{}'::jsonb, ARRAY['player'])
        RETURNING id
      `);
      const playerId = Number(ent.rows[0]?.id);
      await db.query(
        `INSERT INTO players
           (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
         VALUES ($1, gen_random_uuid(), 'hash', 'AB2N')`,
        [playerId],
      );
      await db.query(
        `INSERT INTO progression_tracks
           (track_key, display_name, description, xp_curve, max_level, sort_order)
         VALUES ('survival', 'Survival', 'Wilderness ladder.',
                 '{"kind":"linear","step":100}'::jsonb, 10, 1)`,
      );
      await db.query(
        `INSERT INTO player_progression_tracks
           (player_id, track_key, xp, level)
         VALUES ($1, 'survival', 350, 3)`,
        [playerId],
      );

      // Primary key prevents the same (player, track) twice.
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO player_progression_tracks
             (player_id, track_key, xp, level)
           VALUES ($1, 'survival', 1, 1)`,
          [playerId],
        );
      } catch (err) {
        rejected = err instanceof Error;
      }
      expect(rejected).toBe(true);

      // FK on track_key: unknown key rejected.
      let trackRejected = false;
      try {
        await db.query(
          `INSERT INTO player_progression_tracks
             (player_id, track_key, xp, level)
           VALUES ($1, 'does-not-exist', 0, 1)`,
          [playerId],
        );
      } catch (err) {
        trackRejected = err instanceof Error;
      }
      expect(trackRejected).toBe(true);

      // CHECK constraints — xp and level must be >= 0 / 1.
      let xpRejected = false;
      try {
        await db.query(
          `INSERT INTO progression_tracks
             (track_key, display_name, max_level)
           VALUES ('zero-cap', 'Zero', 0)`,
        );
      } catch (err) {
        xpRejected = err instanceof Error && /check/i.test(err.message);
      }
      expect(xpRejected).toBe(true);
    });
  });

  test('player_progression_wallets has one row per player with non-negative defaults', async () => {
    await withPristineDb(async (db) => {
      const cols = await db.query<{column_name: string; column_default: string | null}>(`
        SELECT column_name, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'player_progression_wallets'
         ORDER BY column_name
      `);
      const byName = Object.fromEntries(
        cols.rows.map((row) => [row.column_name, row]),
      );
      expect(Object.keys(byName).sort()).toEqual([
        'player_id',
        'skill_points',
        'stat_points',
        'title_slots',
        'updated_at',
      ]);
      expect(byName['stat_points']!.column_default ?? '').toMatch(/0/);
      expect(byName['skill_points']!.column_default ?? '').toMatch(/0/);
      expect(byName['title_slots']!.column_default ?? '').toMatch(/1/);

      const pk = await db.query<{column_name: string}>(`
        SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'player_progression_wallets'
      `);
      expect(pk.rows.map((row) => row.column_name)).toEqual(['player_id']);

      // Insert + roundtrip + check constraint.
      const ent = await db.query<{id: number}>(`
        INSERT INTO entities (kind, display_name, profile, tags)
        VALUES ('player', 'FEAT-STATE-1 wallet', '{}'::jsonb, ARRAY['player'])
        RETURNING id
      `);
      const playerId = Number(ent.rows[0]?.id);
      await db.query(
        `INSERT INTO players
           (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
         VALUES ($1, gen_random_uuid(), 'hash', 'AB2N')`,
        [playerId],
      );
      await db.query(
        `INSERT INTO player_progression_wallets (player_id) VALUES ($1)`,
        [playerId],
      );
      const row = await db.query<{
        stat_points: number;
        skill_points: number;
        title_slots: number;
      }>(
        `SELECT stat_points, skill_points, title_slots
           FROM player_progression_wallets WHERE player_id = $1`,
        [playerId],
      );
      expect(Number(row.rows[0]?.stat_points)).toBe(0);
      expect(Number(row.rows[0]?.skill_points)).toBe(0);
      expect(Number(row.rows[0]?.title_slots)).toBe(1);

      // Negative spend rejected by CHECK.
      let rejected = false;
      try {
        await db.query(
          `UPDATE player_progression_wallets
              SET stat_points = -1
            WHERE player_id = $1`,
          [playerId],
        );
      } catch (err) {
        rejected = err instanceof Error && /check/i.test(err.message);
      }
      expect(rejected).toBe(true);
    });
  });

  test('FK chains cascade on player delete', async () => {
    await withPristineDb(async (db) => {
      const ent = await db.query<{id: number}>(`
        INSERT INTO entities (kind, display_name, profile, tags)
        VALUES ('player', 'FEAT-STATE-1 cascade', '{}'::jsonb, ARRAY['player'])
        RETURNING id
      `);
      const playerId = Number(ent.rows[0]?.id);
      await db.query(
        `INSERT INTO players
           (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
         VALUES ($1, gen_random_uuid(), 'hash', 'AB2N')`,
        [playerId],
      );
      await db.query(
        `INSERT INTO progression_tracks (track_key, display_name)
         VALUES ('combat', 'Combat')`,
      );
      await db.query(
        `INSERT INTO player_progression_tracks (player_id, track_key, xp, level)
         VALUES ($1, 'combat', 10, 1)`,
        [playerId],
      );
      await db.query(
        `INSERT INTO player_progression_wallets (player_id, stat_points)
         VALUES ($1, 2)`,
        [playerId],
      );
      await db.query(
        `INSERT INTO player_titles (player_id, title_key, display_name)
         VALUES ($1, 'cascade', 'Cascade')`,
        [playerId],
      );

      await db.query(`DELETE FROM entities WHERE id = $1`, [playerId]);

      const titles = await db.query<{count: number}>(
        `SELECT COUNT(*)::int AS count FROM player_titles WHERE player_id = $1`,
        [playerId],
      );
      const tracks = await db.query<{count: number}>(
        `SELECT COUNT(*)::int AS count
           FROM player_progression_tracks WHERE player_id = $1`,
        [playerId],
      );
      const wallets = await db.query<{count: number}>(
        `SELECT COUNT(*)::int AS count
           FROM player_progression_wallets WHERE player_id = $1`,
        [playerId],
      );
      expect(Number(titles.rows[0]?.count)).toBe(0);
      expect(Number(tracks.rows[0]?.count)).toBe(0);
      expect(Number(wallets.rows[0]?.count)).toBe(0);
    });
  });
});
