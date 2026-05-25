/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// AQ-1 — `maybeEnqueueAdventureOpportunity` is atomic across its
// read → decide → INSERT → emit chain. Ten concurrent calls for the
// same (sessionId, playerId, turnId) must produce exactly one
// durable `adventure_queue` row, exactly one `adventure_oracle_rolls`
// row, exactly one `reused:false` result, and the other callers
// return `reused:true`. Reused rows never write a duplicate
// `adventure_oracle_rolls` row and never publish a duplicate
// `adventure:oracle_rolled` GUI event.

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTestSession,
  setupTurnTestEnvironment,
} from '../turn/framework.js';
import type {TestSession} from '../turn/framework.js';
import type {AdventureTurnSnapshot} from '../../domain/adventure/runtime/adventureQueue.js';

let maybeEnqueueAdventureOpportunity: typeof import('../../domain/adventure/runtime/adventureQueue.js').maybeEnqueueAdventureOpportunity;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({maybeEnqueueAdventureOpportunity} = await import(
    '../../domain/adventure/runtime/adventureQueue.js'
  ));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

async function clearAdventureRows(sessionId: string): Promise<void> {
  // adventure_oracle_rolls.adventure_queue_id is a FK; drop rolls
  // first so the queue DELETE doesn't fight an FK constraint.
  await queryRows(
    `DELETE FROM adventure_oracle_rolls WHERE session_id = $1`,
    [sessionId],
  );
  await queryRows(`DELETE FROM adventure_queue WHERE session_id = $1`, [
    sessionId,
  ]);
  await queryRows(
    `DELETE FROM adventure_queue_counters WHERE session_id = $1`,
    [sessionId],
  );
  await queryRows(
    `DELETE FROM gui_events
      WHERE session_id = $1
        AND event_type = 'adventure:oracle_rolled'`,
    [sessionId],
  );
}

const TURN_SNAPSHOT: AdventureTurnSnapshot = {
  text: 'idle exploration',
  toolHistory: [],
  narrative: 'idle',
  mode: 'exploration',
  language: 'en',
};

describe('maybeEnqueueAdventureOpportunity — AQ-1 concurrency', () => {
  let test: TestSession;

  beforeAll(async () => {
    test = await setupTestSession();
  });

  afterAll(async () => {
    await test.cleanup();
  });

  it('10 parallel calls for one (sessionId, playerId, turnId) produce exactly one queue row, one oracle-roll row, one reused:false', async () => {
    await clearAdventureRows(test.sessionId);

    const turnId = `aq1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const attempts = 10;
    const results = await Promise.all(
      Array.from({length: attempts}, () =>
        maybeEnqueueAdventureOpportunity(
          {
            sessionId: test.sessionId,
            playerId: test.playerId,
            turnId,
            source: 'manual_debug',
            visible: false,
          },
          TURN_SNAPSHOT,
        ),
      ),
    );

    const queueRows = await queryRows<{count: number | string}>(
      `SELECT COUNT(*)::int AS count
         FROM adventure_queue
        WHERE session_id = $1 AND player_id = $2`,
      [test.sessionId, test.playerId],
    );
    expect(Number(queueRows[0]?.count ?? 0)).toBe(1);

    const rollRows = await queryRows<{count: number | string}>(
      `SELECT COUNT(*)::int AS count
         FROM adventure_oracle_rolls
        WHERE session_id = $1 AND player_id = $2`,
      [test.sessionId, test.playerId],
    );
    expect(Number(rollRows[0]?.count ?? 0)).toBe(1);

    const queued = results.filter((r) => r.queued);
    expect(queued).toHaveLength(attempts);
    const reusedFalse = queued.filter((r) => !r.reused);
    const reusedTrue = queued.filter((r) => r.reused);
    expect(reusedFalse).toHaveLength(1);
    expect(reusedTrue).toHaveLength(attempts - 1);

    // All callers receive the same durable row id.
    const ids = new Set(queued.map((r) => r.row?.id));
    expect(ids.size).toBe(1);
    expect(ids.has(undefined)).toBe(false);
  });

  it('10 parallel visible oracle calls publish exactly one adventure:oracle_rolled GUI event', async () => {
    await clearAdventureRows(test.sessionId);

    const turnId = `aq1-visible-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const attempts = 10;
    const results = await Promise.all(
      Array.from({length: attempts}, () =>
        maybeEnqueueAdventureOpportunity(
          {
            sessionId: test.sessionId,
            playerId: test.playerId,
            turnId,
            source: 'manual_debug',
            visible: true,
          },
          TURN_SNAPSHOT,
        ),
      ),
    );

    const queueCount = await queryRows<{count: number | string}>(
      `SELECT COUNT(*)::int AS count
         FROM adventure_queue
        WHERE session_id = $1 AND player_id = $2`,
      [test.sessionId, test.playerId],
    );
    expect(Number(queueCount[0]?.count ?? 0)).toBe(1);

    const rollCount = await queryRows<{count: number | string}>(
      `SELECT COUNT(*)::int AS count
         FROM adventure_oracle_rolls
        WHERE session_id = $1 AND player_id = $2`,
      [test.sessionId, test.playerId],
    );
    expect(Number(rollCount[0]?.count ?? 0)).toBe(1);

    const guiCount = await queryRows<{count: number | string}>(
      `SELECT COUNT(*)::int AS count
         FROM gui_events
        WHERE session_id = $1
          AND event_type = 'adventure:oracle_rolled'`,
      [test.sessionId],
    );
    expect(Number(guiCount[0]?.count ?? 0)).toBe(1);

    const queued = results.filter((r) => r.queued);
    expect(queued).toHaveLength(attempts);
    expect(queued.filter((r) => !r.reused)).toHaveLength(1);
    expect(queued.filter((r) => r.reused)).toHaveLength(attempts - 1);
  });
});

describe('maybeEnqueueAdventureOpportunity — AQ-2 sequence counter', () => {
  let test: TestSession;

  beforeAll(async () => {
    test = await setupTestSession();
  });

  afterAll(async () => {
    await test.cleanup();
  });

  it('10 parallel calls with distinct turn ids allocate unique sequences 1..10 via the per-player counter', async () => {
    await clearAdventureRows(test.sessionId);

    const attempts = 10;
    const baseTag = `aq2-distinct-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const results = await Promise.all(
      Array.from({length: attempts}, (_, i) =>
        maybeEnqueueAdventureOpportunity(
          {
            sessionId: test.sessionId,
            playerId: test.playerId,
            turnId: `${baseTag}-${i}`,
            source: 'manual_debug',
            visible: false,
          },
          TURN_SNAPSHOT,
        ),
      ),
    );

    const rows = await queryRows<{sequence: number | string}>(
      `SELECT sequence
         FROM adventure_queue
        WHERE session_id = $1 AND player_id = $2
        ORDER BY sequence ASC`,
      [test.sessionId, test.playerId],
    );
    expect(rows).toHaveLength(attempts);
    const sequences = rows.map((r) => Number(r.sequence));
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(sequences).size).toBe(attempts);

    // Every call was a fresh insert (different turnId → different
    // dedupeKey → no reuse).
    expect(results.every((r) => r.queued && !r.reused)).toBe(true);

    const counters = await queryRows<{last_sequence: number | string}>(
      `SELECT last_sequence
         FROM adventure_queue_counters
        WHERE session_id = $1 AND player_id = $2`,
      [test.sessionId, test.playerId],
    );
    expect(counters).toHaveLength(1);
    expect(Number(counters[0]!.last_sequence)).toBe(attempts);
  });

  it('explicit opts.sequence advances the counter, and the next automatic call returns counter+1', async () => {
    await clearAdventureRows(test.sessionId);

    const explicit = await maybeEnqueueAdventureOpportunity(
      {
        sessionId: test.sessionId,
        playerId: test.playerId,
        turnId: `aq2-explicit-${Date.now()}`,
        source: 'manual_debug',
        sequence: 25,
        visible: false,
      },
      TURN_SNAPSHOT,
    );
    expect(explicit.queued).toBe(true);
    expect(explicit.reused).toBe(false);
    expect(explicit.row?.sequence).toBe(25);

    const counterAfterExplicit = await queryRows<{
      last_sequence: number | string;
    }>(
      `SELECT last_sequence
         FROM adventure_queue_counters
        WHERE session_id = $1 AND player_id = $2`,
      [test.sessionId, test.playerId],
    );
    expect(Number(counterAfterExplicit[0]?.last_sequence ?? 0)).toBe(25);

    const automatic = await maybeEnqueueAdventureOpportunity(
      {
        sessionId: test.sessionId,
        playerId: test.playerId,
        turnId: `aq2-auto-${Date.now()}`,
        source: 'manual_debug',
        visible: false,
      },
      TURN_SNAPSHOT,
    );
    expect(automatic.queued).toBe(true);
    expect(automatic.reused).toBe(false);
    expect(automatic.row?.sequence).toBe(26);

    const counterAfterAuto = await queryRows<{last_sequence: number | string}>(
      `SELECT last_sequence
         FROM adventure_queue_counters
        WHERE session_id = $1 AND player_id = $2`,
      [test.sessionId, test.playerId],
    );
    expect(Number(counterAfterAuto[0]?.last_sequence ?? 0)).toBe(26);
  });
});
