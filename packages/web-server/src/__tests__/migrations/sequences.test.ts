/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// GE-2 — PGlite compatibility for `nextval(...)` inside conditional
// SQL forms used by `packages/web-server/src/guiEventOutbox.ts`:
//
//   * `CASE WHEN <bool> THEN nextval('seq') ELSE NULL END`
//     (used in `emitGuiEventForSession` INSERT + the
//     `release_seq = CASE WHEN $14 THEN ... ELSE NULL END` branch).
//   * `COALESCE(<prior>, <fallback>, nextval('seq'))` and
//     `COALESCE(release_seq, nextval('seq'))` (used in the
//     UPSERT / `releaseGuiEvent` / `bindReleasedTurnGuiEventsToMessage`
//     branches).
//
// The Postgres docs say `nextval` is volatile and evaluated only when
// the surrounding expression actually selects the branch, but
// PGlite's WASM build has historically diverged on subtle volatile
// semantics. If PGlite eagerly consumes a sequence value from a
// non-taken branch, GUI release ordering would gap (a pending/
// unreleased row would burn `release_seq` values that no actual
// emit ever sees).
//
// The fixspec's draft assertion `last_value = 1` is too weak for a
// fresh sequence: the first emission would still leave
// `last_value = 1`. The tests below call `nextval('test_seq')` after
// each conditional probe and assert it returns the next expected
// value, which catches eager consumption directly.

import {describe, expect, test} from 'vitest';
import {type TestDb, withPristineDb} from './framework.js';

async function makeSeq(db: TestDb): Promise<void> {
  await db.query(`DROP SEQUENCE IF EXISTS test_seq`);
  await db.query(`CREATE SEQUENCE test_seq START 1`);
}

async function callNextval(db: TestDb): Promise<number> {
  const r = await db.query<{nextval: number | string}>(
    `SELECT nextval('test_seq') AS nextval`,
  );
  return Number(r.rows[0]!.nextval);
}

describe('PGlite nextval-in-CASE compatibility (GE-2)', () => {
  test('CASE WHEN false THEN nextval(...) ELSE NULL END does NOT consume the sequence', async () => {
    await withPristineDb(async (db) => {
      await makeSeq(db);
      // The CASE evaluates to NULL because the WHEN clause is false.
      const r = await db.query<{value: number | null}>(
        `SELECT CASE WHEN false THEN nextval('test_seq') ELSE NULL END AS value`,
      );
      expect(r.rows[0]!.value).toBeNull();
      // If PGlite is Postgres-compatible, the very next nextval call
      // returns 1 (the start value). Eager evaluation would return 2.
      const first = await callNextval(db);
      expect(first).toBe(1);
    });
  });

  test('COALESCE(NULL, nextval(...)) inside a non-taken CASE branch does NOT consume the sequence', async () => {
    await withPristineDb(async (db) => {
      await makeSeq(db);
      // Mirrors the outbox UPSERT shape:
      //   release_seq = CASE
      //     WHEN EXCLUDED.status = 'released'
      //       THEN COALESCE(gui_events.release_seq, EXCLUDED.release_seq, nextval('gui_events_release_seq'))
      //     ELSE gui_events.release_seq
      //   END
      // When the WHEN is false (i.e. row is not being promoted to
      // released), the COALESCE + nextval must not fire.
      const r = await db.query<{value: number | null}>(
        `SELECT CASE
                  WHEN false
                    THEN COALESCE(NULL, NULL, nextval('test_seq'))
                  ELSE NULL
                END AS value`,
      );
      expect(r.rows[0]!.value).toBeNull();
      const first = await callNextval(db);
      expect(first).toBe(1);
    });
  });

  test('COALESCE(prior, nextval(...)) skips nextval when prior is non-null (GE-2 release path shape)', async () => {
    await withPristineDb(async (db) => {
      await makeSeq(db);
      // Mirrors `releaseGuiEvent` and
      // `bindReleasedTurnGuiEventsToMessage`:
      //   release_seq = COALESCE(release_seq, nextval('gui_events_release_seq'))
      // When release_seq is already set, nextval must not fire.
      const r = await db.query<{value: number}>(
        `SELECT COALESCE(42::bigint, nextval('test_seq')) AS value`,
      );
      expect(Number(r.rows[0]!.value)).toBe(42);
      const first = await callNextval(db);
      expect(first).toBe(1);
    });
  });

  test('CASE WHEN true THEN nextval(...) ELSE NULL END consumes exactly one sequence value', async () => {
    await withPristineDb(async (db) => {
      await makeSeq(db);
      const r = await db.query<{value: number}>(
        `SELECT CASE WHEN true THEN nextval('test_seq') ELSE NULL END AS value`,
      );
      expect(Number(r.rows[0]!.value)).toBe(1);
      // The next call should return 2, not 3 (no double evaluation).
      const next = await callNextval(db);
      expect(next).toBe(2);
    });
  });

  test('mixed-row INSERT with conditional nextval does not consume sequence values for non-released rows', async () => {
    await withPristineDb(async (db) => {
      await makeSeq(db);
      // Reproduce the outbox INSERT shape on a synthetic table:
      // unreleased rows store release_seq = NULL via the CASE
      // branch, released rows store nextval('test_seq').
      await db.query(`
        CREATE TABLE gui_test (
          id SERIAL PRIMARY KEY,
          status TEXT NOT NULL,
          release_seq BIGINT
        )
      `);
      // Three unreleased rows (status = 'pending').
      for (let i = 0; i < 3; i++) {
        await db.query(
          `INSERT INTO gui_test (status, release_seq)
           VALUES ('pending',
                   CASE WHEN $1::boolean THEN nextval('test_seq') ELSE NULL END)`,
          [false],
        );
      }
      // One released row (status = 'released').
      await db.query(
        `INSERT INTO gui_test (status, release_seq)
         VALUES ('released',
                 CASE WHEN $1::boolean THEN nextval('test_seq') ELSE NULL END)`,
        [true],
      );

      // The released row must have received release_seq = 1 because
      // none of the three pending inserts should have consumed the
      // sequence.
      const released = await db.query<{release_seq: number}>(
        `SELECT release_seq FROM gui_test WHERE status = 'released'`,
      );
      expect(Number(released.rows[0]!.release_seq)).toBe(1);

      // The next manual nextval returns 2.
      const next = await callNextval(db);
      expect(next).toBe(2);
    });
  });
});

describe('gui_events_release_seq compatibility (GE-2)', () => {
  // Migrations may have already advanced `gui_events_release_seq` past
  // its start value (e.g. a fixture insert during template build).
  // Anchor the assertions on a baseline reading instead of the raw
  // start value, so we measure the *delta* the conditional insert
  // contributes — that is what catches eager consumption directly.

  async function readBaseline(db: {
    query<T>(sql: string, params?: unknown[]): Promise<{rows: T[]}>;
  }): Promise<number> {
    const r = await db.query<{nextval: number | string}>(
      `SELECT nextval('gui_events_release_seq') AS nextval`,
    );
    return Number(r.rows[0]!.nextval);
  }

  async function seedPlayerSession(
    db: {
      query<T>(sql: string, params?: unknown[]): Promise<{rows: T[]}>;
    },
    label: string,
  ): Promise<{playerId: number; sessionId: string}> {
    const playerRow = await db.query<{id: number}>(
      `INSERT INTO entities (kind, display_name, summary, profile, tags)
       VALUES ('player', $1::text, '', '{}'::jsonb, ARRAY['ge2'])
       RETURNING id`,
      [`GE-2 seq player ${label}`],
    );
    const playerId = Number(playerRow.rows[0]!.id);
    await db.query(
      `INSERT INTO players (entity_id, public_id)
       VALUES ($1, gen_random_uuid())`,
      [playerId],
    );
    const sessionId = `ge2-${label}-${Date.now()}`;
    await db.query(
      `INSERT INTO sessions (id, player_id) VALUES ($1, $2)`,
      [sessionId, playerId],
    );
    return {playerId, sessionId};
  }

  test('a pending gui_events row does NOT consume gui_events_release_seq', async () => {
    await withPristineDb(async (db) => {
      const {playerId, sessionId} = await seedPlayerSession(db, 'pending');
      const baseline = await readBaseline(db);
      // Mirror the outbox INSERT shape: status = 'pending', so the
      // `CASE WHEN $::boolean THEN nextval(...) ELSE NULL END`
      // clause must NOT consume the release sequence.
      await db.query(
        `INSERT INTO gui_events
           (session_id, player_id, lane, phase, event_type,
            status, display_policy, payload, ready_at, released_at,
            release_seq)
         VALUES ($1, $2, 'post_response', 'mutation', 'memory:added',
                 'pending', '{}'::jsonb, '{}'::jsonb,
                 NULL, NULL,
                 CASE WHEN $3::boolean
                        THEN nextval('gui_events_release_seq')
                      ELSE NULL END)`,
        [sessionId, playerId, false],
      );
      // The next nextval must return exactly baseline + 1 — proving
      // the pending insert did not burn a sequence value. Eager
      // consumption would push it to baseline + 2.
      const after = await db.query<{nextval: number | string}>(
        `SELECT nextval('gui_events_release_seq') AS nextval`,
      );
      expect(Number(after.rows[0]!.nextval)).toBe(baseline + 1);
    });
  });

  test('a released gui_events row receives release_seq = baseline + 1', async () => {
    await withPristineDb(async (db) => {
      const {playerId, sessionId} = await seedPlayerSession(db, 'released');
      const baseline = await readBaseline(db);
      const inserted = await db.query<{release_seq: number | string}>(
        `INSERT INTO gui_events
           (session_id, player_id, lane, phase, event_type,
            status, display_policy, payload, ready_at, released_at,
            release_seq)
         VALUES ($1, $2, 'post_response', 'mutation', 'xp:awarded',
                 'released', '{}'::jsonb, '{}'::jsonb,
                 now(), now(),
                 CASE WHEN $3::boolean
                        THEN nextval('gui_events_release_seq')
                      ELSE NULL END)
         RETURNING release_seq`,
        [sessionId, playerId, true],
      );
      expect(Number(inserted.rows[0]!.release_seq)).toBe(baseline + 1);
    });
  });

  test('mixed pending + released inserts consume the sequence exactly once', async () => {
    await withPristineDb(async (db) => {
      const {playerId, sessionId} = await seedPlayerSession(db, 'mixed');
      const baseline = await readBaseline(db);
      // Three pending rows must not consume sequence values.
      for (let i = 0; i < 3; i++) {
        await db.query(
          `INSERT INTO gui_events
             (session_id, player_id, lane, phase, event_type,
              status, display_policy, payload, ready_at, released_at,
              release_seq)
           VALUES ($1, $2, 'post_response', 'mutation', 'memory:added',
                   'pending', '{}'::jsonb, '{}'::jsonb,
                   NULL, NULL,
                   CASE WHEN $3::boolean
                          THEN nextval('gui_events_release_seq')
                        ELSE NULL END)`,
          [sessionId, playerId, false],
        );
      }
      // The released row must receive release_seq = baseline + 1.
      const released = await db.query<{release_seq: number | string}>(
        `INSERT INTO gui_events
           (session_id, player_id, lane, phase, event_type,
            status, display_policy, payload, ready_at, released_at,
            release_seq)
         VALUES ($1, $2, 'post_response', 'mutation', 'xp:awarded',
                 'released', '{}'::jsonb, '{}'::jsonb,
                 now(), now(),
                 CASE WHEN $3::boolean
                        THEN nextval('gui_events_release_seq')
                      ELSE NULL END)
         RETURNING release_seq`,
        [sessionId, playerId, true],
      );
      expect(Number(released.rows[0]!.release_seq)).toBe(baseline + 1);
      // The next manual nextval returns baseline + 2 — confirming
      // only ONE sequence value was consumed across all four
      // inserts.
      const after = await db.query<{nextval: number | string}>(
        `SELECT nextval('gui_events_release_seq') AS nextval`,
      );
      expect(Number(after.rows[0]!.nextval)).toBe(baseline + 2);
    });
  });
});
