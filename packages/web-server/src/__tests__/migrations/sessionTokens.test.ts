/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-6 — `session_tokens` migration invariants.
//
// Pins the shape of migration 0118 against the runtime schema
// `requireAuth` / `authenticatedPlayerId` / `clearAuthCookie`
// now depend on: a `jti` UUID primary key, a `player_id` foreign
// key with `ON DELETE CASCADE`, a non-null `issued_at` defaulted
// to `now()`, a nullable `revoked_at`, and the partial index
// that backs the active-only revocation lookup.

import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {
  cleanupMigrationTemplates,
  createPristineDataDir,
  withPristineDb,
} from './framework.js';
import {rm} from 'node:fs/promises';

afterAll(async () => {
  await cleanupMigrationTemplates();
});

// PGlite cold-starts the migration template on Windows in ~3 min;
// pay that cost once in `beforeAll` so per-test budgets are honest.
// `createPristineDataDir` blows the cache only on the first call.
beforeAll(async () => {
  const dataDir = await createPristineDataDir();
  await rm(dataDir, {recursive: true, force: true});
}, 600_000);

describe.sequential('SEC-6 session_tokens migration', () => {
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
           AND table_name = 'session_tokens'
         ORDER BY column_name
      `);
      const byName = Object.fromEntries(cols.rows.map((row) => [row.column_name, row]));
      expect(Object.keys(byName).sort()).toEqual([
        'issued_at',
        'jti',
        'player_id',
        'revoked_at',
      ]);
      expect(byName['jti']!.data_type).toBe('uuid');
      expect(byName['jti']!.is_nullable).toBe('NO');
      expect(byName['player_id']!.data_type).toBe('bigint');
      expect(byName['player_id']!.is_nullable).toBe('NO');
      expect(byName['issued_at']!.data_type).toBe(
        'timestamp with time zone',
      );
      expect(byName['issued_at']!.is_nullable).toBe('NO');
      expect(byName['issued_at']!.column_default ?? '').toContain('now()');
      expect(byName['revoked_at']!.data_type).toBe(
        'timestamp with time zone',
      );
      expect(byName['revoked_at']!.is_nullable).toBe('YES');
    });
  });

  test('jti is the primary key', async () => {
    await withPristineDb(async (db) => {
      const pk = await db.query<{column_name: string}>(`
        SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = 'public'
           AND tc.table_name = 'session_tokens'
           AND tc.constraint_type = 'PRIMARY KEY'
      `);
      expect(pk.rows.map((row) => row.column_name)).toEqual(['jti']);
    });
  });

  test('player_id references players(entity_id) ON DELETE CASCADE', async () => {
    await withPristineDb(async (db) => {
      const fk = await db.query<{
        column_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
        delete_rule: string;
      }>(`
        SELECT kcu.column_name,
               ccu.table_name  AS foreign_table_name,
               ccu.column_name AS foreign_column_name,
               rc.delete_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
           AND tc.table_schema = rc.constraint_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.table_schema = tc.table_schema
         WHERE tc.table_schema = 'public'
           AND tc.table_name = 'session_tokens'
           AND tc.constraint_type = 'FOREIGN KEY'
      `);
      expect(fk.rows).toEqual([
        {
          column_name: 'player_id',
          foreign_table_name: 'players',
          foreign_column_name: 'entity_id',
          delete_rule: 'CASCADE',
        },
      ]);
    });
  });

  test('the active-only partial index exists for revocation lookups', async () => {
    await withPristineDb(async (db) => {
      const indexes = await db.query<{indexname: string; indexdef: string}>(`
        SELECT indexname, indexdef
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'session_tokens'
         ORDER BY indexname
      `);
      const names = indexes.rows.map((row) => row.indexname);
      expect(names).toContain('idx_session_tokens_active');
      const active = indexes.rows.find(
        (row) => row.indexname === 'idx_session_tokens_active',
      );
      expect(active?.indexdef ?? '').toContain('revoked_at IS NULL');
    });
  });

  test('inserts + revocation behave end-to-end (CRUD smoke)', async () => {
    await withPristineDb(async (db) => {
      // Seed a player so the FK on session_tokens.player_id resolves.
      // ARCH-19 Phase 4 (migration 0124): the row-level CHECK exempts
      // `kind = 'player'`. Seed with that kind (the original `'person'`
      // was a misnomer for the SEC-6 fixture).
      const player = await db.query<{entity_id: number}>(`
        INSERT INTO entities (kind, display_name)
          VALUES ('player', 'sec6-test-player')
          RETURNING id AS entity_id
      `);
      const entityId = player.rows[0]!.entity_id;
      // `players.public_id` is `UUID NOT NULL UNIQUE` per the
      // initial litrpg migration; supply a deterministic value so
      // the smoke insert satisfies the constraint without coupling
      // to UI bootstrap logic.
      await db.query(
        `INSERT INTO players (entity_id, public_id)
         VALUES ($1, '00000000-0000-4000-8000-000000000010'::uuid)`,
        [entityId],
      );

      const jti = '11111111-1111-4111-8111-111111111111';
      await db.query(
        `INSERT INTO session_tokens (jti, player_id) VALUES ($1, $2)`,
        [jti, entityId],
      );

      // Active row visible before revoke.
      const before = await db.query<{ok: number}>(
        `SELECT 1 AS ok
           FROM session_tokens
          WHERE jti = $1 AND player_id = $2 AND revoked_at IS NULL`,
        [jti, entityId],
      );
      expect(before.rows.length).toBe(1);

      // Revoke and confirm the partial-index path no longer matches.
      await db.query(
        `UPDATE session_tokens SET revoked_at = now() WHERE jti = $1`,
        [jti],
      );
      const after = await db.query<{ok: number}>(
        `SELECT 1 AS ok
           FROM session_tokens
          WHERE jti = $1 AND player_id = $2 AND revoked_at IS NULL`,
        [jti, entityId],
      );
      expect(after.rows.length).toBe(0);
    });
  });
});
