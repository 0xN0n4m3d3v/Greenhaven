/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-3 regression — `Session.lastTurnToolHistory`.
//
// Before USER-3, `runTurn` evaluated active quests with
// `session.activeTurn.toolHistory ?? []`.  At the top of `runTurn`
// the new turn's `activeTurn` exists but its `toolHistory` is empty
// (the broker hasn't run yet), so a `tool_called` quest objective
// could never advance from turn-N tool calls on turn N+1 — the
// history was lost when `postTurnPipeline` cleared `activeTurn`.
//
// USER-3 introduces `session.lastTurnToolHistory`, snapshotted by
// `postTurnPipeline` from the just-finished `activeTurn` before
// clearing it, and reads from that field on the next turn.  Reset
// clears the field so a reset session can't inherit stale history.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTestSession,
  setupTurnTestEnvironment,
  startTurn,
} from './framework.js';
import type {ToolHistoryEntry} from '../../sessionManager.js';

const classifierState = vi.hoisted(() => ({
  intent: 'T4',
  mode: 'exploration',
}));

const handoffState = vi.hoisted(() => ({
  brokerText: 'The test broker resolves the action.',
  narratorText: 'The test narrator paints the scene.',
}));

vi.mock('../../ai/classifier.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../ai/classifier.js')>();
  return {
    ...actual,
    classifyIntent: vi.fn(async () => classifierState.intent),
    classifyMode: vi.fn(async () => classifierState.mode),
    // X-3 — `resolveTurnRoute` now consumes the structured decision.
    classifyTurnRoute: vi.fn(async () => ({
      mode: classifierState.mode,
      profile: 'default' as const,
      dialogueAct: 'none' as const,
    })),
  };
});

vi.mock('../../ai/handoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/handoff.js')>();
  return {
    ...actual,
    runBroker: vi.fn(async () => ({
      narrateRequest: {
        tone: 'narrator',
        text: handoffState.brokerText,
        done: true,
      },
      responseMessages: [],
      contentBuffer: '',
      toolCallCount: 1,
      toolNamesCalled: ['narrate'],
      mutationLimitExceeded: false,
      inputTokens: 10,
      outputTokens: 5,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
    })),
    runNarrator: vi.fn(async (args: {onText?: (chunk: string) => void}) => {
      args.onText?.(handoffState.narratorText);
      return {
        contentBuffer: handoffState.narratorText,
        toolCallsSeen: 0,
        toolResultsSeen: 0,
        toolErrorsSeen: 0,
        jsonDumpDetected: false,
        inputTokens: 8,
        outputTokens: 6,
        cacheHitTokens: 0,
        cacheMissTokens: 8,
      };
    }),
  };
});

beforeAll(async () => {
  await setupTurnTestEnvironment();
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(() => {
  classifierState.intent = 'T4';
  classifierState.mode = 'exploration';
  vi.clearAllMocks();
});

async function nextTick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

async function insertProbeQuestWithToolCalledObjective(opts: {
  toolName: string;
}): Promise<number> {
  const profile = {
    stages: [
      {
        id: 'roll',
        advance_on: 'any',
        objectives: [
          {kind: 'tool_called', tool: opts.toolName, args_match: {}},
        ],
        next_stage: null,
      },
    ],
  };
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags,
        cartridge_id, dynamic_origin)
     VALUES ('quest', 'USER-3 Probe Quest', 'probe', $1::jsonb,
             ARRAY['user3-probe'], 'grinhaven-full', false)
     RETURNING id`,
    [JSON.stringify(profile)],
  );
  return rows[0]!.id;
}

async function activatePlayerQuest(
  playerId: number,
  questId: number,
  stageId: string,
): Promise<void> {
  await queryRows(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase,
        current_stage_id, started_at, accumulated_state)
     VALUES ($1, $2, 'active', 0, $3, now(), '{}'::jsonb)`,
    [playerId, questId, stageId],
  );
}

describe.sequential('USER-3: Session.lastTurnToolHistory', () => {
  test('is initialised to an empty array on a fresh session', async () => {
    const ctx = await setupTestSession();
    try {
      expect(ctx.session.lastTurnToolHistory).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  test('postTurnPipeline snapshots the completed turn tool history and clears activeTurn', async () => {
    const ctx = await setupTestSession();
    try {
      const handle = startTurn(ctx.session, {
        text: 'turn that records history',
        playerId: ctx.playerId,
        language: 'en',
      });
      // `startTurnV2` synchronously assigns `session.activeTurn`
      // before returning. Inject a deterministic tool entry now so
      // the snapshot path has something to capture (the mocked
      // broker never calls tools on its own).
      expect(ctx.session.activeTurn).toBeDefined();
      const probe: ToolHistoryEntry = {
        name: 'dice_check',
        args: {dc: 12, attribute: 'wits'},
        ok: true,
        source: 'direct',
      };
      ctx.session.activeTurn!.toolHistory = [probe];

      await handle.done;
      await nextTick();

      expect(ctx.session.activeTurn).toBeUndefined();
      // The runner's broker/narrator pipeline may append its own
      // entries (e.g. a synthesised `narrate` for the broker fast
      // path). The contract is "the prior turn's tool history is on
      // session.lastTurnToolHistory" — the dice_check probe must be
      // present.
      const snapshotted = ctx.session.lastTurnToolHistory;
      expect(snapshotted.length).toBeGreaterThan(0);
      expect(
        snapshotted.find((entry) => entry.name === 'dice_check'),
      ).toMatchObject({
        name: 'dice_check',
        args: {dc: 12, attribute: 'wits'},
        ok: true,
        source: 'direct',
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test('a tool_called quest objective advances when satisfied by the PREVIOUS turn', async () => {
    const ctx = await setupTestSession();
    try {
      const questId = await insertProbeQuestWithToolCalledObjective({
        toolName: 'dice_check',
      });
      await activatePlayerQuest(ctx.playerId, questId, 'roll');

      // Pre-populate the prior-turn snapshot the way `postTurnPipeline`
      // would have done at the end of a real previous turn.  No
      // mid-turn injection trickery; this is exactly the field
      // `runTurn` is now expected to consume.
      ctx.session.lastTurnToolHistory = [
        {name: 'dice_check', args: {dc: 12}, ok: true, source: 'direct'},
      ];

      const handle = startTurn(ctx.session, {
        text: 'progress my quest after the roll',
        playerId: ctx.playerId,
        language: 'en',
      });
      await handle.done;
      await nextTick();

      const finalRows = await queryRows<{status: string}>(
        `SELECT status FROM player_quests
          WHERE player_id = $1 AND quest_entity_id = $2`,
        [ctx.playerId, questId],
      );
      // next_stage is null, so a satisfied objective auto-completes
      // the quest.
      expect(finalRows[0]?.status).toBe('completed');
    } finally {
      await ctx.cleanup();
    }
  });

  test('is cleared by resetSessionState', async () => {
    const ctx = await setupTestSession();
    try {
      ctx.session.lastTurnToolHistory = [
        {name: 'dice_check', args: {}, ok: true, source: 'direct'},
        {name: 'add_memory', args: {}, ok: true, source: 'ai_sdk'},
      ];
      const {resetSessionState} = await import('../../resetSession.js');
      await resetSessionState(ctx.session, ctx.playerId, {turnWaitMs: 200});
      expect(ctx.session.lastTurnToolHistory).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe.sequential('S-10: Session.turnModeState', () => {
  test('is initialised to an empty object on a fresh session', async () => {
    const ctx = await setupTestSession();
    try {
      expect(ctx.session.turnModeState).toEqual({});
    } finally {
      await ctx.cleanup();
    }
  });

  test('getSessionModeState/setSessionMode read and write the explicit session field', async () => {
    const ctx = await setupTestSession();
    try {
      const {getSessionModeState, setSessionMode} = await import(
        '../../turn/dispatchPrep.js'
      );
      expect(getSessionModeState(ctx.session)).toEqual({});
      setSessionMode(ctx.session, 'combat');
      expect(ctx.session.turnModeState).toEqual({lastMode: 'combat'});
      expect(getSessionModeState(ctx.session)).toEqual({lastMode: 'combat'});
    } finally {
      await ctx.cleanup();
    }
  });

  test('is cleared by resetSessionState so the next turn re-fires mode:changed', async () => {
    const ctx = await setupTestSession();
    try {
      const {setSessionMode} = await import('../../turn/dispatchPrep.js');
      setSessionMode(ctx.session, 'intimacy');
      expect(ctx.session.turnModeState).toEqual({lastMode: 'intimacy'});
      const {resetSessionState} = await import('../../resetSession.js');
      await resetSessionState(ctx.session, ctx.playerId, {turnWaitMs: 200});
      expect(ctx.session.turnModeState).toEqual({});
    } finally {
      await ctx.cleanup();
    }
  });
});
