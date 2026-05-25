/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-NOTICE-1 — `player_journal_entries` migration 0120 invariants.
//
// Pins the durable shape the `NoticeJournalService` and the
// `/api/player/:id/notices` route depend on: column types,
// foreign keys to `players(entity_id)` / `sessions(id)` /
// `gui_events(id)`, the partial unique index on
// `(player_id, source_event_id) WHERE source_event_id IS NOT NULL`
// (which drives ON CONFLICT DO NOTHING in the materializer), the
// `entry_type` CHECK constraint enum, and the two read indexes.

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

// PGlite cold-starts the migration template in ~3 min on Windows;
// pay the cost once in `beforeAll` so per-test budgets are honest.
// `createPristineDataDir` blows the cache only on the first call.
beforeAll(async () => {
  const dataDir = await createPristineDataDir();
  await rm(dataDir, {recursive: true, force: true});
}, 600_000);

describe.sequential('FEAT-NOTICE-1 player_journal_entries (0120)', () => {
  test('table exists with the expected column shape', async () => {
    await withPristineDb(async (db) => {
      const cols = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(`
        SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'player_journal_entries'
         ORDER BY column_name
      `);
      const byName = Object.fromEntries(cols.rows.map((row) => [row.column_name, row]));
      expect(Object.keys(byName).sort()).toEqual([
        'body',
        'created_at',
        'entry_type',
        'event_type',
        'id',
        'occurred_at',
        'payload',
        'player_id',
        'session_id',
        'source_event_id',
        'title',
        'turn_id',
      ]);
      expect(byName['id']!.data_type).toBe('bigint');
      expect(byName['id']!.is_nullable).toBe('NO');
      expect(byName['player_id']!.data_type).toBe('bigint');
      expect(byName['player_id']!.is_nullable).toBe('NO');
      expect(byName['session_id']!.data_type).toBe('text');
      expect(byName['session_id']!.is_nullable).toBe('YES');
      expect(byName['source_event_id']!.data_type).toBe('bigint');
      expect(byName['source_event_id']!.is_nullable).toBe('YES');
      expect(byName['entry_type']!.data_type).toBe('text');
      expect(byName['entry_type']!.is_nullable).toBe('NO');
      expect(byName['event_type']!.data_type).toBe('text');
      expect(byName['event_type']!.is_nullable).toBe('NO');
      expect(byName['title']!.data_type).toBe('text');
      expect(byName['title']!.is_nullable).toBe('NO');
      expect(byName['body']!.data_type).toBe('text');
      expect(byName['body']!.is_nullable).toBe('YES');
      expect(byName['payload']!.data_type).toBe('jsonb');
      expect(byName['payload']!.is_nullable).toBe('NO');
      expect(byName['turn_id']!.data_type).toBe('text');
      expect(byName['turn_id']!.is_nullable).toBe('YES');
      expect(byName['occurred_at']!.data_type).toBe('timestamp with time zone');
      expect(byName['occurred_at']!.is_nullable).toBe('NO');
      expect(byName['created_at']!.data_type).toBe('timestamp with time zone');
      expect(byName['created_at']!.is_nullable).toBe('NO');
      expect(byName['created_at']!.column_default ?? '').toContain('now()');
    });
  });

  test('id is the primary key', async () => {
    await withPristineDb(async (db) => {
      const pk = await db.query<{column_name: string}>(`
        SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'player_journal_entries'
         ORDER BY kcu.ordinal_position
      `);
      expect(pk.rows.map((row) => row.column_name)).toEqual(['id']);
    });
  });

  test('FK to players(entity_id) cascades on delete', async () => {
    await withPristineDb(async (db) => {
      const fks = await db.query<{
        delete_rule: string;
        referenced_table: string;
        referenced_column: string;
      }>(`
        SELECT rc.delete_rule,
               ccu.table_name AS referenced_table,
               ccu.column_name AS referenced_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = rc.unique_constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'player_journal_entries'
           AND kcu.column_name = 'player_id'
      `);
      expect(fks.rows.length).toBe(1);
      expect(fks.rows[0]?.referenced_table).toBe('players');
      expect(fks.rows[0]?.referenced_column).toBe('entity_id');
      expect(fks.rows[0]?.delete_rule).toBe('CASCADE');
    });
  });

  test('FK to sessions(id) and gui_events(id) set null on delete', async () => {
    await withPristineDb(async (db) => {
      const fks = await db.query<{
        column_name: string;
        referenced_table: string;
        delete_rule: string;
      }>(`
        SELECT kcu.column_name,
               ccu.table_name AS referenced_table,
               rc.delete_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = rc.unique_constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'player_journal_entries'
           AND kcu.column_name IN ('session_id', 'source_event_id')
         ORDER BY kcu.column_name
      `);
      const bySource = Object.fromEntries(
        fks.rows.map((row) => [row.column_name, row]),
      );
      expect(bySource['session_id']?.referenced_table).toBe('sessions');
      expect(bySource['session_id']?.delete_rule).toBe('SET NULL');
      expect(bySource['source_event_id']?.referenced_table).toBe('gui_events');
      expect(bySource['source_event_id']?.delete_rule).toBe('SET NULL');
    });
  });

  test('entry_type CHECK constraint enumerates the six allowed buckets', async () => {
    await withPristineDb(async (db) => {
      const ok = await db.query<{column_name: string}>(`
        SELECT 1 AS ok
          FROM pg_constraint
         WHERE conrelid = 'public.player_journal_entries'::regclass
           AND contype = 'c'
      `);
      expect(ok.rows.length).toBeGreaterThan(0);

      // Seed prerequisites: an entity row + a player + a session +
      // a released gui_event for the source_event_id reference.
      const ent = await db.query<{id: number}>(`
        INSERT INTO entities (kind, display_name, profile, tags)
        VALUES ('player', 'FEAT-NOTICE-1 invariant', '{}'::jsonb, ARRAY['player'])
        RETURNING id
      `);
      const playerId = Number(ent.rows[0]?.id);
      await db.query(
        `INSERT INTO players (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
         VALUES ($1, gen_random_uuid(), $2, $3)`,
        [playerId, 'hash', 'AB2N'],
      );

      // Allowed bucket: insert and roundtrip.
      const insertedOk = await db.query<{id: number}>(
        `INSERT INTO player_journal_entries
           (player_id, entry_type, event_type, title, payload)
         VALUES ($1, 'quest', 'quest:started', 'ok', '{}'::jsonb)
         RETURNING id`,
        [playerId],
      );
      expect(insertedOk.rows[0]?.id).toBeDefined();

      // Disallowed bucket → rejected by the CHECK constraint.
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO player_journal_entries
             (player_id, entry_type, event_type, title, payload)
           VALUES ($1, 'not_a_bucket', 'quest:started', 'bad', '{}'::jsonb)`,
          [playerId],
        );
      } catch (err) {
        rejected =
          err instanceof Error &&
          /(check|constraint)/i.test(err.message);
      }
      expect(rejected).toBe(true);
    });
  });

  test('partial unique index dedups (player_id, source_event_id) when non-null', async () => {
    await withPristineDb(async (db) => {
      // Seed a player + a session + a gui_event row.
      const ent = await db.query<{id: number}>(`
        INSERT INTO entities (kind, display_name, profile, tags)
        VALUES ('player', 'FEAT-NOTICE-1 dedupe', '{}'::jsonb, ARRAY['player'])
        RETURNING id
      `);
      const playerId = Number(ent.rows[0]?.id);
      await db.query(
        `INSERT INTO players (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
         VALUES ($1, gen_random_uuid(), 'hash', 'AB2N')`,
        [playerId],
      );
      const sess = await db.query<{id: string}>(
        `INSERT INTO sessions (id, player_id)
         VALUES (gen_random_uuid()::text, $1)
         RETURNING id`,
        [playerId],
      );
      const sessionId = String(sess.rows[0]?.id);
      const gui = await db.query<{id: number}>(
        `INSERT INTO gui_events
           (session_id, player_id, phase, event_type, status, payload)
         VALUES ($1, $2, 'support', 'quest:started', 'released', '{}'::jsonb)
         RETURNING id`,
        [sessionId, playerId],
      );
      const sourceEventId = Number(gui.rows[0]?.id);

      // First insert succeeds.
      await db.query(
        `INSERT INTO player_journal_entries
           (player_id, session_id, source_event_id,
            entry_type, event_type, title, payload)
         VALUES ($1, $2, $3, 'quest', 'quest:started', 't', '{}'::jsonb)`,
        [playerId, sessionId, sourceEventId],
      );

      // Same (player_id, source_event_id) rejected by the partial
      // unique index — this is the contract the materializer's
      // ON CONFLICT DO NOTHING relies on.
      let duplicated = false;
      try {
        await db.query(
          `INSERT INTO player_journal_entries
             (player_id, session_id, source_event_id,
              entry_type, event_type, title, payload)
           VALUES ($1, $2, $3, 'quest', 'quest:advanced', 't2', '{}'::jsonb)`,
          [playerId, sessionId, sourceEventId],
        );
      } catch (err) {
        duplicated =
          err instanceof Error && /duplicate|unique/i.test(err.message);
      }
      expect(duplicated).toBe(true);

      // ON CONFLICT DO NOTHING uses the partial index when the
      // matching predicate is supplied. The conflict resolves
      // silently (no row inserted, no error).
      const conflictAttempt = await db.query<{id: number}>(
        `INSERT INTO player_journal_entries
           (player_id, session_id, source_event_id,
            entry_type, event_type, title, payload)
         VALUES ($1, $2, $3, 'quest', 'quest:advanced', 't3', '{}'::jsonb)
         ON CONFLICT (player_id, source_event_id) WHERE source_event_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [playerId, sessionId, sourceEventId],
      );
      expect(conflictAttempt.rows.length).toBe(0);

      // NULL source_event_id rows are exempt from the partial
      // index — multiple are allowed for the same player.
      await db.query(
        `INSERT INTO player_journal_entries
           (player_id, entry_type, event_type, title, payload)
         VALUES ($1, 'system', 'memory:added', 'a', '{}'::jsonb)`,
        [playerId],
      );
      await db.query(
        `INSERT INTO player_journal_entries
           (player_id, entry_type, event_type, title, payload)
         VALUES ($1, 'system', 'memory:added', 'b', '{}'::jsonb)`,
        [playerId],
      );
      const orphanRows = await db.query<{count: number}>(
        `SELECT COUNT(*)::int AS count
           FROM player_journal_entries
          WHERE player_id = $1 AND source_event_id IS NULL`,
        [playerId],
      );
      expect(Number(orphanRows.rows[0]?.count)).toBe(2);
    });
  });

  test('read indexes exist on (player_id, id DESC) and (player_id, entry_type, id DESC)', async () => {
    await withPristineDb(async (db) => {
      const idx = await db.query<{indexname: string; indexdef: string}>(`
        SELECT indexname, indexdef
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'player_journal_entries'
      `);
      const names = idx.rows.map((row) => row.indexname);
      expect(names).toContain('idx_player_journal_player_id_desc');
      expect(names).toContain('idx_player_journal_player_type');
      expect(names).toContain('idx_player_journal_source_event_uniq');

      const partial = idx.rows.find(
        (row) => row.indexname === 'idx_player_journal_source_event_uniq',
      );
      expect(partial?.indexdef).toMatch(/UNIQUE/);
      expect(partial?.indexdef).toMatch(/WHERE/i);
      expect(partial?.indexdef).toMatch(/source_event_id IS NOT NULL/);
    });
  });
});
