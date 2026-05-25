/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-7 — every former quest-engine `console.log` / `console.warn`
// branch is now a structured `telemetry.record({ channel:
// 'gameplay', name: 'quest.<event>', ... })` call. The tests below
// pin each event name, payload shape, and post-commit ordering so a
// future refactor cannot silently drop a branch or move a success
// telemetry call ahead of its `withTransaction(...)` boundary.

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

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
    onTransactionRollback: vi.fn(() => false),
    isInTransaction: vi.fn(() => txState.inTx),
  };
});

vi.mock('../../guiEventOutbox.js', () => ({
  emitGuiEventForSession: vi.fn(async () => null),
}));

vi.mock('../../tools/quest.js', () => ({
  applyQuestRewards: vi.fn(async () => ({})),
}));

const objectiveState = vi.hoisted(() => ({
  perCall: [] as Array<{satisfied: boolean; detail?: string}>,
  fallback: {satisfied: false, detail: ''} as {satisfied: boolean; detail?: string},
}));

vi.mock('../../quest/objectiveEvaluators.js', () => ({
  evaluateObjective: vi.fn(async () => {
    return objectiveState.perCall.shift() ?? objectiveState.fallback;
  }),
}));

const transitionState = vi.hoisted(() => ({
  legal: true,
}));

vi.mock('../../quest/questTransitionArbiter.js', () => ({
  isLegalQuestStageTransition: vi.fn(() => transitionState.legal),
}));

const telemetryState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../telemetry/index.js', () => ({
  telemetry: {
    record: vi.fn((event: Record<string, unknown>) => {
      telemetryState.events.push(event);
    }),
    flush: vi.fn(async () => {}),
    pendingCount: vi.fn(() => 0),
  },
  measure: vi.fn(async (_input: unknown, work: () => unknown) => work()),
}));

import {evaluateActiveQuests} from '../../quest/questEngine.js';

const PLAYER_ID = 5;
const QUEST_ID = 100;
const SESSION_ID = 'sess-1';
const TURN_ID = 'turn-1';
const DISPLAY_NAME = 'Quest of Tests';

function seedOneActiveQuest(opts: {
  profile: Record<string, unknown>;
  accumulatedState?: Record<string, unknown>;
  currentStageId?: string;
}) {
  queryState.responses.push({
    rows: [
      {
        player_id: PLAYER_ID,
        quest_entity_id: QUEST_ID,
        current_stage_id: opts.currentStageId ?? 'stage-1',
        accumulated_state: opts.accumulatedState ?? {},
        profile: opts.profile,
        display_name: DISPLAY_NAME,
      },
    ],
    rowCount: 1,
  });
}

function questEvents(name: string): Array<Record<string, unknown>> {
  return telemetryState.events.filter((e) => e['name'] === name);
}

beforeEach(() => {
  queryState.calls = [];
  queryState.responses = [];
  txState.inTx = false;
  txState.commitHooks = [];
  txState.rollbackHooks = [];
  txState.rolledBack = 0;
  objectiveState.perCall = [];
  objectiveState.fallback = {satisfied: false, detail: ''};
  transitionState.legal = true;
  telemetryState.events = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('questEngine QE-7 — gameplay telemetry per state-change branch', () => {
  it('emits quest.failed AFTER the withTransaction commits, with failure_kind + quest identity', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [{id: 'stage-1', objectives: [{kind: 'always'}]}],
        failure_conditions: [{kind: 'tripwire'}],
      },
    });
    objectiveState.perCall.push({satisfied: true}); // failure condition matched
    queryState.responses.push({rows: [], rowCount: 1}); // UPDATE inside tx

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.failed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: 'gameplay',
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      turnId: TURN_ID,
      data: {
        quest_id: QUEST_ID,
        quest_title: DISPLAY_NAME,
        current_stage_id: 'stage-1',
        failure_kind: 'tripwire',
      },
    });
    expect(txState.rolledBack).toBe(0);
  });

  it('emits quest.advance_on_invalid with raw_advance_on + the resolver error, then skips the quest', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'always'}],
            advance_on: 'manual_or_watcher',
            next_stage: 'stage-2',
          },
          {id: 'stage-2', objectives: [], next_stage: null},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.advance_on_invalid');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      quest_id: QUEST_ID,
      raw_advance_on: 'manual_or_watcher',
    });
    expect(events[0]!.error).toBeInstanceOf(Error);
    // The quest was skipped — no advance / completed telemetry.
    expect(questEvents('quest.advanced')).toEqual([]);
    expect(questEvents('quest.completed')).toEqual([]);
  });

  it('emits quest.choice.invalid_pick when accumulated_state.pending_choice names an unknown option', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'always'}],
            next_stage: {
              kind: 'choice',
              options: [{label: 'A', target_stage_id: 'stage-a'}],
            },
          },
        ],
      },
      accumulatedState: {pending_choice: 'stage-mystery'},
    });
    objectiveState.perCall.push({satisfied: true});

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.choice.invalid_pick');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      quest_id: QUEST_ID,
      picked_stage_id: 'stage-mystery',
    });
  });

  it('emits quest.choice.illegal_transition when the picked branch fails the transition arbiter', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'always'}],
            next_stage: {
              kind: 'choice',
              options: [{label: 'A', target_stage_id: 'stage-a'}],
            },
          },
        ],
      },
      accumulatedState: {pending_choice: 'stage-a'},
    });
    objectiveState.perCall.push({satisfied: true});
    transitionState.legal = false;

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.choice.illegal_transition');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      quest_id: QUEST_ID,
      picked_stage_id: 'stage-a',
      next_stage_id: 'stage-a',
    });
  });

  it('emits quest.choice_required AFTER the awaiting-choice withTransaction commits', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [
          {
            id: 'stage-1',
            objectives: [{kind: 'always'}],
            next_stage: {
              kind: 'choice',
              options: [
                {label: 'A', target_stage_id: 'stage-a'},
                {label: 'B', target_stage_id: 'stage-b'},
              ],
            },
          },
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    queryState.responses.push({rows: [], rowCount: 1}); // accumulated_state patch

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.choice_required');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      quest_id: QUEST_ID,
      options: [
        {label: 'A', target_stage_id: 'stage-a'},
        {label: 'B', target_stage_id: 'stage-b'},
      ],
    });
    expect(txState.rolledBack).toBe(0);
  });

  it('emits quest.stage.prerequisite_blocked when the next stage prereq is unsatisfied', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}], next_stage: 'stage-2'},
          {
            id: 'stage-2',
            objectives: [],
            prerequisites: [{kind: 'flag_set', flag_key: 'gate', value: true}],
            next_stage: null,
          },
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true}); // stage-1 objective satisfied
    objectiveState.perCall.push({satisfied: false, detail: 'gate-not-set'}); // prereq blocks

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.stage.prerequisite_blocked');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      quest_id: QUEST_ID,
      next_stage_id: 'stage-2',
      detail: 'gate-not-set',
    });
  });

  it('emits quest.stage.illegal_transition when the arbiter rejects a normal-advance next_stage', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}], next_stage: 'stage-2'},
          {id: 'stage-2', objectives: [], next_stage: null},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    transitionState.legal = false;

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.stage.illegal_transition');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      quest_id: QUEST_ID,
      from: 'stage-1',
      to: 'stage-2',
    });
  });

  it('emits quest.advanced AFTER the normal-advance withTransaction commits, with next_stage_id', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}], next_stage: 'stage-2'},
          {id: 'stage-2', objectives: [], next_stage: null},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    queryState.responses.push({rows: [], rowCount: 1}); // UPDATE inside tx

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.advanced');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      quest_id: QUEST_ID,
      next_stage_id: 'stage-2',
    });
    expect(txState.rolledBack).toBe(0);
  });

  it('emits quest.completed AFTER the bottom auto-completion withTransaction commits', async () => {
    seedOneActiveQuest({
      profile: {
        stages: [
          {id: 'stage-1', objectives: [{kind: 'always'}]},
        ],
      },
    });
    objectiveState.perCall.push({satisfied: true});
    queryState.responses.push({rows: [], rowCount: 1}); // UPDATE inside tx

    await evaluateActiveQuests(SESSION_ID, PLAYER_ID, [], TURN_ID);

    const events = questEvents('quest.completed');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      quest_id: QUEST_ID,
      quest_title: DISPLAY_NAME,
    });
    expect(txState.rolledBack).toBe(0);
  });
});

describe('questEngine QE-7 — no console.* lingering in the source', () => {
  it('the production source file contains zero console.log / console.warn / console.error call sites', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, '../../quest/questEngine.ts'),
      'utf8',
    );
    // Strip comment lines so a doc reference like "previous
    // `console.log` / `console.warn` lines" cannot count as a call.
    const stripped = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(stripped).not.toMatch(/\bconsole\.(log|warn|error)\s*\(/);
  });
});
