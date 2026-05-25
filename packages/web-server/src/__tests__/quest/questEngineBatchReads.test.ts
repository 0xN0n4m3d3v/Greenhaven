/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-1 — `evaluateActiveQuests(...)` must complete a per-turn pass
// with a single joined read for active quests, regardless of how many
// quests are active. Before QE-1 every quest cost 2–3 extra reads
// (entity profile + accumulated_state + timer profile), so a player
// with N active quests hit ~3N+1 round trips per turn. After QE-1
// the joined read carries the profile + accumulated_state inline and
// `tickQuestTimers(...)` mutates the in-memory copy.

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

vi.mock('../../guiEventOutbox.js', () => ({
  emitGuiEventForSession: vi.fn(async () => null),
}));

vi.mock('../../tools/quest.js', () => ({
  applyQuestRewards: vi.fn(async () => ({})),
}));

// Each evaluateObjective call returns `not satisfied`, so the main
// loop runs the failure check + objective evaluation and otherwise
// no-ops. No advance, no completion, no failure — just the read
// pass plus per-quest objective evaluation. The point of this test
// is the read pattern, not the gameplay behavior.
vi.mock('../../quest/objectiveEvaluators.js', () => ({
  evaluateObjective: vi.fn(async () => ({satisfied: false, detail: ''})),
}));

vi.mock('../../quest/questTransitionArbiter.js', () => ({
  isLegalQuestStageTransition: vi.fn(() => true),
}));

import {evaluateActiveQuests} from '../../quest/questEngine.js';

const ACTIVE_QUEST_COUNT = 20;

beforeEach(() => {
  queryState.calls = [];
  queryState.responses = [];
  txState.inTx = false;
  txState.commitHooks = [];
  txState.rollbackHooks = [];
  txState.withTransactionCalls = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('evaluateActiveQuests QE-1 batched reads', () => {
  it('does one joined SELECT for active quests + profile + accumulated_state regardless of quest count', async () => {
    // Seed the joined SELECT with 20 active quests. Each carries its
    // own profile, accumulated_state, and display_name inline.
    const rows = Array.from({length: ACTIVE_QUEST_COUNT}, (_, i) => ({
      player_id: 5,
      quest_entity_id: 200 + i,
      current_stage_id: 'stage-1',
      accumulated_state: {},
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}], next_stage: null},
        ],
      },
      display_name: `Quest ${i}`,
    }));
    queryState.responses.push({rows, rowCount: rows.length});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-batch-1');

    // The only SELECT that ran is the joined active-quest read.
    // Per-quest entity / accumulated_state SELECTs are gone.
    const selectCalls = queryState.calls.filter((c) => /^\s*SELECT/i.test(c.sql));
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]!.sql).toMatch(
      /SELECT pq\.player_id, pq\.quest_entity_id, pq\.current_stage_id/,
    );
    expect(selectCalls[0]!.sql).toMatch(
      /pq\.accumulated_state, e\.profile, e\.display_name/,
    );
    expect(selectCalls[0]!.sql).toMatch(/JOIN entities e ON e\.id = pq\.quest_entity_id/);
  });

  it('does not re-read per-quest entity profile or accumulated_state', async () => {
    const rows = Array.from({length: ACTIVE_QUEST_COUNT}, (_, i) => ({
      player_id: 5,
      quest_entity_id: 200 + i,
      current_stage_id: 'stage-1',
      accumulated_state: {},
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}], next_stage: null},
        ],
      },
      display_name: `Quest ${i}`,
    }));
    queryState.responses.push({rows, rowCount: rows.length});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-batch-2');

    const legacyEntityRead = queryState.calls.some((c) =>
      /SELECT profile, display_name FROM entities WHERE id = \$1/.test(c.sql),
    );
    expect(legacyEntityRead).toBe(false);
    const legacyAccStateRead = queryState.calls.some((c) =>
      /SELECT accumulated_state FROM player_quests/.test(c.sql),
    );
    expect(legacyAccStateRead).toBe(false);
    const legacyTickRead = queryState.calls.some((c) =>
      /SELECT pq\.accumulated_state, e\.profile/.test(c.sql),
    );
    expect(legacyTickRead).toBe(false);
  });

  it('applies tick patches in-memory so the same pass sees timeout_failure', async () => {
    // A timer-armed quest with turns_remaining=1 and on_timeout.fail.
    // The single joined SELECT seeds the state; tickQuestTimers
    // patches the row to {turns_remaining: 0, timeout_failure: true}
    // and Object.assigns those keys onto the in-memory copy. The
    // main loop then reads accState['timeout_failure'] and takes the
    // failure branch — without another SELECT.
    queryState.responses.push({
      rows: [
        {
          player_id: 5,
          quest_entity_id: 300,
          current_stage_id: 'stage-1',
          accumulated_state: {turns_remaining: 1},
          profile: {
            stages: [
              {
                id: 'stage-1',
                objectives: [{kind: 'always'}],
                on_timeout: {action: 'fail'},
              },
            ],
          },
          display_name: 'Timed Quest',
        },
      ],
      rowCount: 1,
    });
    // tickQuestTimers' UPDATE through patchAccumulatedState.
    queryState.responses.push({rows: [], rowCount: 1});
    // Failure-path UPDATE inside withTransaction.
    queryState.responses.push({rows: [], rowCount: 1});

    await evaluateActiveQuests('sess-1', 5, [], 'turn-batch-3');

    const selectCalls = queryState.calls.filter((c) => /^\s*SELECT/i.test(c.sql));
    expect(selectCalls).toHaveLength(1);
    // Two transactions ran: the tick patch and the failure write.
    expect(txState.withTransactionCalls).toBe(2);
  });
});
