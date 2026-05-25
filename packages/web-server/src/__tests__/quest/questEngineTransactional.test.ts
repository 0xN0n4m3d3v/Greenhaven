/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-2 — `quest/questEngine.ts` must run each
// `player_quests` mutation, its side-effect helper
// (`applyFailureConsequence` / `applyQuestRewards`), and its
// `quest:changed` or `quest:choice_required` GUI event inside a
// single `withTransaction(...)`. The deferred SSE auto-routes
// through `onTransactionCommit(...)` so a rollback drops the GUI
// event before the UI can see it.

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
  emitCalls: [] as Array<{
    type: string;
    payload: Record<string, unknown>;
    opts: Record<string, unknown> | undefined;
  }>,
  sseEmits: [] as string[],
  throwOnce: null as Error | null,
}));

vi.mock('../../guiEventOutbox.js', async () => {
  const db = (await import('../../db.js')) as unknown as {
    onTransactionCommit: (fn: () => void | Promise<void>) => boolean;
  };
  return {
    emitGuiEventForSession: vi.fn(
      async (
        _sessionId: string,
        type: string,
        payload: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => {
        guiState.emitCalls.push({type, payload, opts});
        if (guiState.throwOnce) {
          const err = guiState.throwOnce;
          guiState.throwOnce = null;
          throw err;
        }
        const deferred = db.onTransactionCommit(() => {
          guiState.sseEmits.push(type);
        });
        if (!deferred) guiState.sseEmits.push(type);
        return null;
      },
    ),
  };
});

const rewardsState = vi.hoisted(() => ({
  calls: [] as Array<{playerId: number; questId: number}>,
  throws: null as Error | null,
}));

vi.mock('../../tools/quest.js', () => ({
  applyQuestRewards: vi.fn(async (playerId: number, questId: number) => {
    rewardsState.calls.push({playerId, questId});
    if (rewardsState.throws) throw rewardsState.throws;
    return {xp: 50};
  }),
}));

const objectiveState = vi.hoisted(() => ({
  result: {satisfied: false, detail: ''} as {satisfied: boolean; detail?: string},
  perCall: [] as Array<{satisfied: boolean; detail?: string}>,
}));

vi.mock('../../quest/objectiveEvaluators.js', () => ({
  evaluateObjective: vi.fn(async () => {
    if (objectiveState.perCall.length > 0) {
      return objectiveState.perCall.shift()!;
    }
    return objectiveState.result;
  }),
}));

const transitionState = vi.hoisted(() => ({
  legal: true,
}));

vi.mock('../../quest/questTransitionArbiter.js', () => ({
  isLegalQuestStageTransition: vi.fn(() => transitionState.legal),
}));

import {evaluateActiveQuests} from '../../quest/questEngine.js';

function seedReadsForOneQuest(opts: {
  questId?: number;
  currentStageId?: string;
  profile: Record<string, unknown>;
  accumulatedState?: Record<string, unknown>;
  displayName?: string;
  playerId?: number;
}) {
  const questId = opts.questId ?? 100;
  const playerId = opts.playerId ?? 5;
  // QE-1 — single joined SELECT returns active_quests + entity
  // profile + accumulated_state in one round trip. Subsequent
  // per-quest profile / accumulated-state reads are gone.
  queryState.responses.push({
    rows: [
      {
        player_id: playerId,
        quest_entity_id: questId,
        current_stage_id: opts.currentStageId ?? 'stage-1',
        accumulated_state: opts.accumulatedState ?? {},
        profile: opts.profile,
        display_name: opts.displayName ?? 'Quest of Tests',
      },
    ],
    rowCount: 1,
  });
}

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
  guiState.throwOnce = null;
  rewardsState.calls = [];
  rewardsState.throws = null;
  objectiveState.result = {satisfied: false, detail: ''};
  objectiveState.perCall = [];
  transitionState.legal = true;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('questEngine QE-2 — failure path', () => {
  it('runs UPDATE + applyFailureConsequence + quest:changed inside one tx', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [{id: 'stage-1', objectives: [{kind: 'always'}]}],
        failure_conditions: [{kind: 'unreachable'}],
      },
    });
    // 5. evaluateObjective (failure_conditions[0]) → satisfied
    objectiveState.perCall.push({satisfied: true});
    // Inside the tx: UPDATE player_quests; no failure_consequence
    // block, so applyFailureConsequence is a no-op (no extra
    // queries). Then emitGuiEventForSession is called.
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1');

    expect(txState.withTransactionCalls).toBe(1);
    expect(txState.rolledBack).toBe(0);
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]!.type).toBe('quest:changed');
    expect(guiState.emitCalls[0]!.payload).toMatchObject({
      status: 'failed',
    });
    expect(guiState.emitCalls[0]!.opts).toMatchObject({turnId: 'turn-evt-1'});
    expect(guiState.sseEmits).toEqual(['quest:changed']);
  });

  it('rolls back when emitGuiEventForSession throws — no SSE escapes', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [{id: 'stage-1', objectives: [{kind: 'always'}]}],
        failure_conditions: [{kind: 'unreachable'}],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    queryState.responses.push({rows: [], rowCount: 1});
    guiState.throwOnce = new Error('gui emit boom');

    await expect(
      evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1'),
    ).rejects.toThrow(
      /gui emit boom/,
    );

    expect(txState.withTransactionCalls).toBe(1);
    expect(txState.rolledBack).toBe(1);
    // emitGuiEventForSession was attempted exactly once, but the
    // deferred SSE never fired because the tx rolled back.
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.sseEmits).toEqual([]);
  });
});

describe('questEngine QE-2 — terminal-completion path (objectives empty)', () => {
  it('runs UPDATE + applyQuestRewards + quest:changed inside one tx', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [{id: 'stage-1', objectives: [], next_stage: null}],
      },
    });
    // 5. Inside the tx: UPDATE player_quests
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1');

    expect(txState.withTransactionCalls).toBe(1);
    expect(txState.rolledBack).toBe(0);
    expect(rewardsState.calls).toEqual([{playerId: 5, questId: 100}]);
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]!.type).toBe('quest:changed');
    expect(guiState.emitCalls[0]!.payload).toMatchObject({
      status: 'completed',
    });
    expect(guiState.emitCalls[0]!.opts).toMatchObject({turnId: 'turn-evt-1'});
    expect(guiState.sseEmits).toEqual(['quest:changed']);
  });

  it('rolls back when applyQuestRewards throws — no SSE escapes', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [{id: 'stage-1', objectives: [], next_stage: null}],
      },
    });
    queryState.responses.push({rows: [], rowCount: 1});
    rewardsState.throws = new Error('rewards boom');

    await expect(
      evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1'),
    ).rejects.toThrow(
      /rewards boom/,
    );

    expect(txState.withTransactionCalls).toBe(1);
    expect(txState.rolledBack).toBe(1);
    expect(guiState.emitCalls).toHaveLength(0);
    expect(guiState.sseEmits).toEqual([]);
  });
});

describe('questEngine QE-2 — pending-choice advancement', () => {
  it('UPDATE + quest:changed(advanced) inside one tx when accumulated_state.pending_choice picks a valid branch', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'always'}],
            next_stage: {
              kind: 'choice',
              options: [{label: 'Open the door', target_stage_id: 'stage-door'}],
            },
          },
        ],
      },
      accumulatedState: {pending_choice: 'stage-door'},
    });
    // failure_conditions empty → no objective call yet
    // objectives loop: 1 objective × satisfied
    objectiveState.perCall.push({satisfied: true});
    // Inside the tx: UPDATE player_quests
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1');

    expect(txState.withTransactionCalls).toBe(1);
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]!.type).toBe('quest:changed');
    expect(guiState.emitCalls[0]!.payload).toMatchObject({
      status: 'advanced',
      stage: 'stage-door',
    });
    expect(guiState.emitCalls[0]!.opts).toMatchObject({turnId: 'turn-evt-1'});
    expect(guiState.sseEmits).toEqual(['quest:changed']);
  });
});

describe('questEngine QE-2 — awaiting-choice path', () => {
  it('UPDATE + quest:choice_required inside one tx when no pending pick is recorded', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'always'}],
            next_stage: {
              kind: 'choice',
              options: [{label: 'Open the door', target_stage_id: 'stage-door'}],
            },
          },
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1');

    expect(txState.withTransactionCalls).toBe(1);
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]!.type).toBe('quest:choice_required');
    expect(guiState.emitCalls[0]!.opts).toMatchObject({turnId: 'turn-evt-1'});
    expect(guiState.sseEmits).toEqual(['quest:choice_required']);
  });

  it('surfaces a choice stage even when the authored stage has no objectives', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [],
            next_stage: {
              kind: 'choice',
              options: [
                {label: 'Take the harbour route', target_stage_id: 'harbour_route'},
                {label: 'Take the street route', target_stage_id: 'street_route'},
              ],
            },
          },
          {id: 'harbour_route', objectives: []},
          {id: 'street_route', objectives: []},
        ],
      },
    });
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1');

    expect(txState.withTransactionCalls).toBe(1);
    expect(rewardsState.calls).toEqual([]);
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]!.type).toBe('quest:choice_required');
    expect(guiState.emitCalls[0]!.payload.options).toEqual([
      {label: 'Take the harbour route', target_stage_id: 'harbour_route'},
      {label: 'Take the street route', target_stage_id: 'street_route'},
    ]);
  });
});

describe('questEngine QE-2 — normal stage advancement', () => {
  it('UPDATE + quest:changed(advanced) inside one tx', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}], next_stage: 'stage-2'},
          {id: 'stage-2', objectives: [], next_stage: null},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1');

    expect(txState.withTransactionCalls).toBe(1);
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]!.type).toBe('quest:changed');
    expect(guiState.emitCalls[0]!.payload).toMatchObject({
      status: 'advanced',
      stage: 'stage-2',
    });
    expect(guiState.emitCalls[0]!.opts).toMatchObject({turnId: 'turn-evt-1'});
    expect(guiState.sseEmits).toEqual(['quest:changed']);
  });
});

describe('questEngine QE-6 — advance_on alias semantics', () => {
  it('advance_on: "any" advances on a single satisfied objective (OR semantics)', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'a'}, {kind: 'b'}, {kind: 'c'}],
            advance_on: 'any',
            next_stage: 'stage-2',
          },
          {id: 'stage-2', objectives: [], next_stage: null},
        ],
      },
    });
    // Three objectives: only the second is satisfied. With AND
    // semantics nothing would advance; with OR ('any') the stage
    // advances to `stage-2`.
    objectiveState.perCall.push(
      {satisfied: false},
      {satisfied: true},
      {satisfied: false},
    );
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-any-1');

    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]!.payload).toMatchObject({
      status: 'advanced',
      stage: 'stage-2',
    });
  });

  it('advance_on: "all" requires every objective satisfied (AND semantics, no advance on partial)', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'a'}, {kind: 'b'}],
            advance_on: 'all',
            next_stage: 'stage-2',
          },
          {id: 'stage-2', objectives: [], next_stage: null},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true}, {satisfied: false});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-all-1');

    expect(guiState.emitCalls).toHaveLength(0);
  });

  it('skips the quest when advance_on is an unknown legacy value (no advance, no crash)', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'a'}],
            advance_on: 'manual_or_watcher',
            next_stage: 'stage-2',
          },
          {id: 'stage-2', objectives: [], next_stage: null},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-bad-1');

    expect(guiState.emitCalls).toHaveLength(0);
    expect(txState.withTransactionCalls).toBe(0);
  });
});

describe('questEngine QE-2 — bottom auto-completion (next_stage absent)', () => {
  it('UPDATE + applyQuestRewards + quest:changed(completed) inside one tx', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}]},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1');

    expect(txState.withTransactionCalls).toBe(1);
    expect(rewardsState.calls).toEqual([{playerId: 5, questId: 100}]);
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]!.payload).toMatchObject({
      status: 'completed',
    });
    expect(guiState.emitCalls[0]!.opts).toMatchObject({turnId: 'turn-evt-1'});
    expect(guiState.sseEmits).toEqual(['quest:changed']);
  });

  it('rolls back when applyQuestRewards throws on the bottom path — no SSE escapes', async () => {
    seedReadsForOneQuest({
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}]},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    queryState.responses.push({rows: [], rowCount: 1});
    rewardsState.throws = new Error('rewards boom');

    await expect(
      evaluateActiveQuests('sess-1', 5, [], 'turn-evt-1'),
    ).rejects.toThrow(
      /rewards boom/,
    );

    expect(txState.withTransactionCalls).toBe(1);
    expect(txState.rolledBack).toBe(1);
    expect(guiState.emitCalls).toHaveLength(0);
    expect(guiState.sseEmits).toEqual([]);
  });
});
