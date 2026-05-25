/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-8 regression tests — concurrent POST /api/session/:id/turn must
// never exceed MAX_QUEUED_PER_SESSION active rows for one session and
// must never produce duplicate (session_id, queue_index) pairs. The
// idempotency contract for `clientRequestId` must also survive racing
// retries: same clientRequestId across N parallel callers yields one
// durable row and N - 1 `reused: true` results.
//
// ARCH-14 — `recoverAbandonedRunningTurns` covers four option shapes
// (no filters / sessionId only / activeTurnId only / both), status
// filtering (only running+starting are flipped to failed), and reason
// persistence (default vs caller-supplied error string).

import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTestSession,
  setupTurnTestEnvironment,
} from './framework.js';
import type {TestSession} from './framework.js';

let enqueueTurn: typeof import('../../turnIngressQueue.js').enqueueTurn;
let recoverAbandonedRunningTurns: typeof import('../../turnIngressQueue.js').recoverAbandonedRunningTurns;
let MAX_QUEUED_PER_SESSION: number;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({enqueueTurn, recoverAbandonedRunningTurns, MAX_QUEUED_PER_SESSION} =
    await import('../../turnIngressQueue.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

async function clearQueue(sessionId: string): Promise<void> {
  await queryRows(`DELETE FROM turn_ingress_queue WHERE session_id = $1`, [
    sessionId,
  ]);
}

describe('enqueueTurn — DEEP-8 concurrency', () => {
  let test: TestSession;

  beforeAll(async () => {
    test = await setupTestSession();
  });

  afterAll(async () => {
    await test.cleanup();
  });

  it('caps concurrent enqueues at MAX_QUEUED_PER_SESSION with unique queue_index', async () => {
    await clearQueue(test.sessionId);

    const attempts = 10;
    const results = await Promise.allSettled(
      Array.from({length: attempts}, (_, i) =>
        enqueueTurn({
          sessionId: test.sessionId,
          playerId: test.playerId,
          text: `concurrent-${i}`,
        }),
      ),
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled.length).toBe(MAX_QUEUED_PER_SESSION);
    expect(rejected.length).toBe(attempts - MAX_QUEUED_PER_SESSION);
    for (const r of rejected) {
      const err = (r as PromiseRejectedResult).reason;
      expect(err instanceof Error ? err.message : String(err)).toBe(
        'queue_full',
      );
    }

    const rows = await queryRows<{queue_index: number | string}>(
      `SELECT queue_index FROM turn_ingress_queue
        WHERE session_id = $1
          AND status IN ('queued', 'starting', 'running')
        ORDER BY queue_index ASC`,
      [test.sessionId],
    );
    expect(rows).toHaveLength(MAX_QUEUED_PER_SESSION);
    const indexes = rows.map(r => Number(r.queue_index));
    expect(new Set(indexes).size).toBe(MAX_QUEUED_PER_SESSION);
  });

  it('idempotent under concurrent retries with the same clientRequestId', async () => {
    await clearQueue(test.sessionId);

    const clientRequestId = `idem-${Date.now()}`;
    const attempts = 5;
    const results = await Promise.all(
      Array.from({length: attempts}, () =>
        enqueueTurn({
          sessionId: test.sessionId,
          playerId: test.playerId,
          text: 'idempotent-call',
          clientRequestId,
        }),
      ),
    );

    const turnIds = new Set(results.map(r => r.row.turnId));
    expect(turnIds.size).toBe(1);
    const reusedCount = results.filter(r => r.reused).length;
    expect(reusedCount).toBe(attempts - 1);

    const rows = await queryRows<{count: number | string}>(
      `SELECT COUNT(*)::int AS count
         FROM turn_ingress_queue
        WHERE session_id = $1
          AND client_request_id = $2`,
      [test.sessionId, clientRequestId],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('rejects with queue_full once the cap is reached sequentially', async () => {
    await clearQueue(test.sessionId);

    for (let i = 0; i < MAX_QUEUED_PER_SESSION; i++) {
      await enqueueTurn({
        sessionId: test.sessionId,
        playerId: test.playerId,
        text: `seq-${i}`,
      });
    }
    await expect(
      enqueueTurn({
        sessionId: test.sessionId,
        playerId: test.playerId,
        text: 'overflow',
      }),
    ).rejects.toThrow(/queue_full/);
  });
});

describe('recoverAbandonedRunningTurns — ARCH-14 static SQL branches', () => {
  const DEFAULT_REASON =
    'turn abandoned: server restarted or in-memory active turn was lost';
  let sessA: TestSession;
  let sessB: TestSession;

  type SeedStatus =
    | 'queued'
    | 'starting'
    | 'running'
    | 'done'
    | 'cancelled'
    | 'failed';

  interface SeedRow {
    session: TestSession;
    status: SeedStatus;
    turnId: string;
  }

  let queueIndexCounter = 1;

  async function seed(
    session: TestSession,
    status: SeedStatus,
    label: string,
  ): Promise<SeedRow> {
    const turnId = `arch14-${label}-${randomUUID().slice(0, 8)}`;
    await queryRows(
      `INSERT INTO turn_ingress_queue
         (session_id, player_id, turn_id, status, text, queue_index)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        session.sessionId,
        session.playerId,
        turnId,
        status,
        `seed-${label}`,
        queueIndexCounter++,
      ],
    );
    return {session, status, turnId};
  }

  async function readRow(turnId: string): Promise<{
    status: SeedStatus;
    error: string | null;
    finished_at: string | null;
  }> {
    const rows = await queryRows<{
      status: SeedStatus;
      error: string | null;
      finished_at: string | null;
    }>(
      `SELECT status, error, finished_at::text AS finished_at
         FROM turn_ingress_queue
        WHERE turn_id = $1`,
      [turnId],
    );
    expect(rows.length).toBe(1);
    return rows[0]!;
  }

  async function wipeBothSessions(): Promise<void> {
    await queryRows(
      `DELETE FROM turn_ingress_queue WHERE session_id IN ($1, $2)`,
      [sessA.sessionId, sessB.sessionId],
    );
  }

  beforeAll(async () => {
    sessA = await setupTestSession();
    sessB = await setupTestSession();
  });

  afterAll(async () => {
    await sessA.cleanup();
    await sessB.cleanup();
  });

  it('no filters: flips every running/starting row across all sessions', async () => {
    await wipeBothSessions();
    const aRun = await seed(sessA, 'running', 'a-run');
    const aStart = await seed(sessA, 'starting', 'a-start');
    const bRun = await seed(sessB, 'running', 'b-run');
    // Inactive rows are spectators — must stay untouched.
    const aQueued = await seed(sessA, 'queued', 'a-queued');
    const aDone = await seed(sessA, 'done', 'a-done');
    const aCancelled = await seed(sessA, 'cancelled', 'a-cancelled');
    const aFailed = await seed(sessA, 'failed', 'a-failed');

    const n = await recoverAbandonedRunningTurns();

    expect(n).toBe(3);
    for (const id of [aRun.turnId, aStart.turnId, bRun.turnId]) {
      const r = await readRow(id);
      expect(r.status).toBe('failed');
      expect(r.error).toBe(DEFAULT_REASON);
      expect(r.finished_at).not.toBeNull();
    }
    expect((await readRow(aQueued.turnId)).status).toBe('queued');
    expect((await readRow(aDone.turnId)).status).toBe('done');
    expect((await readRow(aCancelled.turnId)).status).toBe('cancelled');
    expect((await readRow(aFailed.turnId)).status).toBe('failed');
  });

  it('sessionId only: scopes recovery to that session', async () => {
    await wipeBothSessions();
    const aRun = await seed(sessA, 'running', 'a-run');
    const aStart = await seed(sessA, 'starting', 'a-start');
    const bRun = await seed(sessB, 'running', 'b-run');
    const bStart = await seed(sessB, 'starting', 'b-start');
    const aQueued = await seed(sessA, 'queued', 'a-queued');

    const n = await recoverAbandonedRunningTurns({sessionId: sessA.sessionId});

    expect(n).toBe(2);
    expect((await readRow(aRun.turnId)).status).toBe('failed');
    expect((await readRow(aStart.turnId)).status).toBe('failed');
    expect((await readRow(bRun.turnId)).status).toBe('running');
    expect((await readRow(bStart.turnId)).status).toBe('starting');
    expect((await readRow(aQueued.turnId)).status).toBe('queued');
  });

  it('activeTurnId only: spares that turn across all sessions', async () => {
    await wipeBothSessions();
    const keep = await seed(sessA, 'running', 'a-keep');
    const aOther = await seed(sessA, 'starting', 'a-other');
    const bRun = await seed(sessB, 'running', 'b-run');

    const n = await recoverAbandonedRunningTurns({activeTurnId: keep.turnId});

    expect(n).toBe(2);
    expect((await readRow(keep.turnId)).status).toBe('running');
    expect((await readRow(aOther.turnId)).status).toBe('failed');
    expect((await readRow(bRun.turnId)).status).toBe('failed');
  });

  it('sessionId + activeTurnId: scoped recovery, spares active turn', async () => {
    await wipeBothSessions();
    const keep = await seed(sessA, 'running', 'a-keep');
    const aOther = await seed(sessA, 'running', 'a-other');
    const aStart = await seed(sessA, 'starting', 'a-start');
    const bRun = await seed(sessB, 'running', 'b-run');
    const aQueued = await seed(sessA, 'queued', 'a-queued');

    const n = await recoverAbandonedRunningTurns({
      sessionId: sessA.sessionId,
      activeTurnId: keep.turnId,
    });

    expect(n).toBe(2);
    expect((await readRow(keep.turnId)).status).toBe('running');
    expect((await readRow(aOther.turnId)).status).toBe('failed');
    expect((await readRow(aStart.turnId)).status).toBe('failed');
    expect((await readRow(bRun.turnId)).status).toBe('running');
    expect((await readRow(aQueued.turnId)).status).toBe('queued');
  });

  it('persists a caller-supplied reason verbatim', async () => {
    await wipeBothSessions();
    const target = await seed(sessA, 'running', 'a-custom');
    const custom = 'shutdown signal: rolling redeploy';

    const n = await recoverAbandonedRunningTurns({
      sessionId: sessA.sessionId,
      reason: custom,
    });

    expect(n).toBe(1);
    const r = await readRow(target.turnId);
    expect(r.status).toBe('failed');
    expect(r.error).toBe(custom);
  });

  it('falls back to the default reason when none is supplied', async () => {
    await wipeBothSessions();
    const target = await seed(sessB, 'starting', 'b-default');

    const n = await recoverAbandonedRunningTurns({sessionId: sessB.sessionId});

    expect(n).toBe(1);
    const r = await readRow(target.turnId);
    expect(r.status).toBe('failed');
    expect(r.error).toBe(DEFAULT_REASON);
  });

  it('leaves queued/done/cancelled/failed rows untouched in every shape', async () => {
    await wipeBothSessions();
    const spectators: SeedRow[] = [
      await seed(sessA, 'queued', 'spec-q'),
      await seed(sessA, 'done', 'spec-d'),
      await seed(sessA, 'cancelled', 'spec-c'),
      await seed(sessA, 'failed', 'spec-f'),
      await seed(sessB, 'queued', 'spec-q-b'),
      await seed(sessB, 'done', 'spec-d-b'),
    ];

    const n = await recoverAbandonedRunningTurns();
    expect(n).toBe(0);
    for (const s of spectators) {
      expect((await readRow(s.turnId)).status).toBe(s.status);
    }
  });
});
