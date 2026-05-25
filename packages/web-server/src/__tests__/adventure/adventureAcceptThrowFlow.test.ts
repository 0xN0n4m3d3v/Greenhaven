/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-5/USER-6 — drive the real `acceptPlayerAdventure` service
// entry through the blueprint raw-throw branch and prove the
// contract end-to-end:
//   - inner savepoint rolls back the partial blueprint write
//   - outer tx commits `markAdventureFailed('accept_application_failed', ...)`
//   - no `adventure:accepted` GUI / SSE event escapes
//   - the service returns `{ ok: false, status: 'failed', ... }` with
//     a useful reason/message derived from the thrown error
//
// A companion soft-`{ ok: false }` test pins the same contract for
// the existing `BlueprintApplicationFailedError` path so a future
// refactor cannot regress the soft branch into a behaviour-only-on-
// throw shape.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const queryState = vi.hoisted(() => ({
  calls: [] as Array<{sql: string; params: unknown[] | undefined}>,
  responses: [] as Array<
    | {rows: Array<Record<string, unknown>>; rowCount?: number}
    | Error
  >,
}));

const txState = vi.hoisted(() => ({
  inTx: false,
  commitHooks: [] as Array<() => void | Promise<void>>,
  rollbackHooks: [] as Array<() => void | Promise<void>>,
  withTransactionCalls: 0,
  rolledBack: 0,
}));

vi.mock('../../db.js', () => {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queryState.calls.push({sql, params});
    const next = queryState.responses.shift();
    if (next instanceof Error) throw next;
    return next ?? {rows: [], rowCount: 0};
  });
  return {
    query,
    withTransaction: vi.fn(
      async <T>(fn: (client: {query: typeof query}) => Promise<T>) => {
        txState.withTransactionCalls += 1;
        const wasInTx = txState.inTx;
        txState.inTx = true;
        const savedCommit = txState.commitHooks;
        const savedRollback = txState.rollbackHooks;
        txState.commitHooks = [];
        txState.rollbackHooks = [];
        try {
          const result = await fn({query});
          for (const hook of txState.commitHooks) await hook();
          return result;
        } catch (err) {
          txState.rolledBack += 1;
          for (const hook of txState.rollbackHooks) await hook();
          throw err;
        } finally {
          txState.commitHooks = savedCommit;
          txState.rollbackHooks = savedRollback;
          txState.inTx = wasInTx;
        }
      },
    ),
    onTransactionCommit: vi.fn((fn: () => void | Promise<void>) => {
      if (!txState.inTx) return false;
      txState.commitHooks.push(fn);
      return true;
    }),
    onTransactionRollback: vi.fn((fn: () => void | Promise<void>) => {
      if (!txState.inTx) return false;
      txState.rollbackHooks.push(fn);
      return true;
    }),
    isInTransaction: vi.fn(() => txState.inTx),
  };
});

const guiState = vi.hoisted(() => ({
  emitCalls: [] as Array<{type: string; payload: Record<string, unknown>}>,
  sseEmits: [] as string[],
}));

vi.mock('../../guiEventOutbox.js', async () => {
  const db = (await import('../../db.js')) as unknown as {
    onTransactionCommit: (fn: () => void | Promise<void>) => boolean;
  };
  return {
    emitGuiEventForSession: vi.fn(
      async (_sessionId: string, type: string, payload: Record<string, unknown>) => {
        guiState.emitCalls.push({type, payload});
        const deferred = db.onTransactionCommit(() => {
          guiState.sseEmits.push(type);
        });
        if (!deferred) guiState.sseEmits.push(type);
        return null;
      },
    ),
  };
});

const READY_ROW = {
  id: 42,
  sessionId: 'sess-1',
  playerId: 5,
  turnId: 'turn-1',
  status: 'ready' as const,
  source: 'oracle',
  adventureKind: 'side_quest',
  priority: 50,
  seed: 'seed',
  sequence: 1,
  tableId: 'table-1',
  blueprint: {title: 'Test Adventure', summary: 'A test', danger: 'safe'},
  rollResult: {},
  contextSnapshot: {},
  dedupeKey: 'dk',
  availableAfterTurnId: 'turn-1',
  createdAt: '2026-05-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
};

const queueState = vi.hoisted(() => ({
  getRowResult: null as null | Record<string, unknown>,
  claimResult: null as null | Record<string, unknown>,
  markFailedResult: null as null | Record<string, unknown>,
  markFailedCalls: [] as Array<{
    queueId: number;
    reason: string;
    details: Record<string, unknown>;
  }>,
  claimCalls: 0,
  getRowCalls: 0,
}));

vi.mock('../../domain/adventure/runtime/adventureQueue.js', () => ({
  getAdventureQueueRow: vi.fn(async () => {
    queueState.getRowCalls += 1;
    return queueState.getRowResult;
  }),
  claimReadyAdventureForAcceptance: vi.fn(async () => {
    queueState.claimCalls += 1;
    return queueState.claimResult;
  }),
  markAdventureFailed: vi.fn(
    async (queueId: number, reason: string, details: Record<string, unknown>) => {
      queueState.markFailedCalls.push({queueId, reason, details});
      return queueState.markFailedResult;
    },
  ),
  markAdventureCancelled: vi.fn(async () => null),
  listAdventureQueue: vi.fn(async () => []),
  buildAdventureHookPayload: vi.fn(async () => null),
}));

const arbiterState = vi.hoisted(() => ({
  throws: null as Error | null,
  softFailure: null as null | {
    ok: false;
    reason?: string;
    message?: string;
  },
  calls: 0,
}));

vi.mock('../../domain/adventure/runtime/adventureArbiter.js', () => ({
  applyReadyAdventureBlueprint: vi.fn(async () => {
    arbiterState.calls += 1;
    // Mirror production: the applier performs at least one DB write
    // before failing. The mocked `query()` records the call so we
    // can assert the savepoint actually wraps it.
    const db = await import('../../db.js');
    await db.query('INSERT INTO partial_blueprint_spawn', []);
    if (arbiterState.throws) throw arbiterState.throws;
    if (arbiterState.softFailure) return arbiterState.softFailure;
    return {ok: true as const, questResult: null, spawnResults: []};
  }),
}));

vi.mock('../../sessionManager.js', () => ({
  sessionManager: {get: vi.fn(() => null)},
}));

vi.mock('../../narrationSynthesis.js', () => ({
  synthesiseNarrate: vi.fn(async () => null),
}));

vi.mock('../../domain/adventure/runtime/adventureAcceptFollowup.js', () => ({
  buildAdventureAcceptFollowup: vi.fn(async () => null),
}));

vi.mock('../../dialogueParticipants.js', () => ({
  setDialogueParticipants: vi.fn(async () => ({
    state: {focused_partner_id: null, participant_ids: [], source: 'route'},
    participants: [],
  })),
}));

vi.mock('../../domain/memory/clusters/clusters.js', () => ({
  assignMemoryCluster: vi.fn(async () => null),
  // `MemoryService.ts` imports the full clusters surface.
  recomputeClusterSalience: vi.fn(),
}));

vi.mock('../../domain/memory/npc/sessionThread.js', () => ({
  attachMemoryToThread: vi.fn(async () => null),
  recordThreadEvidence: vi.fn(async () => null),
  // `MemoryService.ts` imports the full sessionThread surface.
  ambientThreadId: vi.fn(() => 'stub-thread'),
  ensureSessionMemoryThread: vi.fn(async () => null),
}));

vi.mock('../../telemetry/index.js', () => ({
  telemetry: {
    record: vi.fn(),
    flush: vi.fn(async () => {}),
    pendingCount: vi.fn(() => 0),
  },
  measure: vi.fn(async (_input: unknown, work: () => unknown) => work()),
}));

import {acceptPlayerAdventure} from '../../domain/adventure/AdventureService.js';

beforeEach(() => {
  queryState.calls = [];
  queryState.responses = [];
  txState.inTx = false;
  txState.commitHooks = [];
  txState.rollbackHooks = [];
  txState.withTransactionCalls = 0;
  txState.rolledBack = 0;
  guiState.emitCalls = [];
  guiState.sseEmits = [];
  queueState.getRowResult = READY_ROW;
  queueState.claimResult = {...READY_ROW, status: 'materializing'};
  queueState.markFailedResult = {...READY_ROW, status: 'failed'};
  queueState.markFailedCalls = [];
  queueState.claimCalls = 0;
  queueState.getRowCalls = 0;
  arbiterState.throws = null;
  arbiterState.softFailure = null;
  arbiterState.calls = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('acceptPlayerAdventure — raw blueprint throw (USER-5/USER-6)', () => {
  it('catches a thrown applyReadyAdventureBlueprint, rolls back the savepoint, records accept_application_failed, and emits no adventure:accepted', async () => {
    arbiterState.throws = new Error('tool dispatch crashed');

    const result = await acceptPlayerAdventure({
      playerId: 5,
      queueId: 42,
    });

    expect(arbiterState.calls).toBe(1);
    // Outer accept tx + inner blueprint savepoint both ran.
    expect(txState.withTransactionCalls).toBeGreaterThanOrEqual(2);
    // The inner savepoint rolled back; the outer tx committed.
    expect(txState.rolledBack).toBe(1);
    // markAdventureFailed was called inside the outer tx with the
    // canonical reason and the thrown error's message.
    expect(queueState.markFailedCalls).toHaveLength(1);
    expect(queueState.markFailedCalls[0]).toMatchObject({
      queueId: 42,
      reason: 'accept_application_failed',
    });
    expect(
      String(queueState.markFailedCalls[0]!.details['message']),
    ).toContain('tool dispatch crashed');
    expect(queueState.markFailedCalls[0]!.details['reason']).toBe(
      'tool_application_failed',
    );
    // No adventure:accepted GUI/SSE event escaped.
    expect(
      guiState.emitCalls.filter(c => c.type === 'adventure:accepted'),
    ).toEqual([]);
    expect(guiState.sseEmits).toEqual([]);
    // Service returns a failed result with the canonical shape.
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'tool_application_failed',
    });
    expect(String((result as {message?: string}).message ?? '')).toContain(
      'tool dispatch crashed',
    );
  });

  it('still routes soft {ok:false} blueprint failures through the same markFailed path with no accepted emit', async () => {
    arbiterState.softFailure = {
      ok: false,
      reason: 'tool_application_failed',
      message: 'create_quest failed: missing giver',
    };

    const result = await acceptPlayerAdventure({
      playerId: 5,
      queueId: 42,
    });

    expect(arbiterState.calls).toBe(1);
    expect(txState.rolledBack).toBe(1);
    expect(queueState.markFailedCalls).toHaveLength(1);
    expect(queueState.markFailedCalls[0]).toMatchObject({
      queueId: 42,
      reason: 'accept_application_failed',
      details: {
        reason: 'tool_application_failed',
        message: 'create_quest failed: missing giver',
      },
    });
    expect(
      guiState.emitCalls.filter(c => c.type === 'adventure:accepted'),
    ).toEqual([]);
    expect(guiState.sseEmits).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'tool_application_failed',
      message: 'create_quest failed: missing giver',
    });
  });

  it('happy path: blueprint succeeds → adventure:accepted SSE fires exactly once', async () => {
    // No soft failure, no throw — applier returns { ok: true }.
    const result = await acceptPlayerAdventure({
      playerId: 5,
      queueId: 42,
    });

    expect(arbiterState.calls).toBe(1);
    expect(queueState.markFailedCalls).toEqual([]);
    const acceptedEmits = guiState.emitCalls.filter(
      c => c.type === 'adventure:accepted',
    );
    expect(acceptedEmits).toHaveLength(1);
    expect(acceptedEmits[0]!.payload).toMatchObject({
      queueId: 42,
      playerId: 5,
      adventureKind: 'side_quest',
      status: 'accepted',
    });
    expect(guiState.sseEmits).toEqual(['adventure:accepted']);
    expect(result).toMatchObject({ok: true, status: 'accepted'});
  });
});
