import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { runBroker, runNarrator } from '../../ai/handoff.js';
import {
  cleanupTurnTestEnvironment,
  collectSse,
  queryRows,
  setupTestSession,
  setupTurnTestEnvironment,
  startTurn,
} from './framework.js';

const classifierState = vi.hoisted(() => ({
  intent: 'T4',
  mode: 'exploration',
}));

const handoffState = vi.hoisted(() => ({
  brokerText: 'The test broker resolves the action.',
  narratorText: 'The test narrator paints the scene.',
  brokerDelayMs: 0,
  brokerError: null as Error | null,
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
    runBroker: vi.fn(async () => {
      if (handoffState.brokerDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, handoffState.brokerDelayMs),
        );
      }
      if (handoffState.brokerError) throw handoffState.brokerError;
      return {
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
      };
    }),
    runNarrator: vi.fn(async (args) => {
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
  handoffState.brokerText = 'The test broker resolves the action.';
  handoffState.narratorText = 'The test narrator paints the scene.';
  handoffState.brokerDelayMs = 0;
  handoffState.brokerError = null;
  vi.clearAllMocks();
});

describe.sequential('turn pipeline golden paths', () => {
  test('free-text T4 turn persists player and broker narration messages', async () => {
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { done } = startTurn(ctx.session, {
        text: 'I inspect the room carefully.',
        playerId: ctx.playerId,
        language: 'en',
      });
      await done;
      await nextTick();

      const messages = await chatMessages(ctx.sessionId);
      expect(messages.map((row) => row.tone)).toEqual(['player', 'narrator']);
      expect(messages[0]?.text).toBe('I inspect the room carefully.');
      expect(messages[1]?.text).toBe(handoffState.brokerText);
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('free-text T4 turn emits start, player message, tier, and end events', async () => {
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { turnId, done } = startTurn(ctx.session, {
        text: 'I test the event stream.',
        playerId: ctx.playerId,
        language: 'en',
      });
      await done;
      await nextTick();

      expect(sse.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'turn.start',
            data: expect.objectContaining({ turnId }),
          }),
          expect.objectContaining({
            event: 'turn.tier',
            data: expect.objectContaining({ turnId, tier: 'T4' }),
          }),
          expect.objectContaining({
            event: 'message:created',
            data: expect.objectContaining({ turnId, tone: 'player' }),
          }),
          expect.objectContaining({
            event: 'turn.end',
            data: expect.objectContaining({ turnId }),
          }),
        ]),
      );
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('T1 narrator-only route bypasses broker and persists narrator fallback', async () => {
    classifierState.intent = 'T1';
    classifierState.mode = 'exploration';
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { done } = startTurn(ctx.session, {
        text: 'A quiet observational beat.',
        playerId: ctx.playerId,
        language: 'en',
      });
      await done;
      await nextTick();

      expect(runBroker).not.toHaveBeenCalled();
      expect(runNarrator).toHaveBeenCalledTimes(1);
      const messages = await chatMessages(ctx.sessionId);
      expect(messages.at(-1)?.text).toBe(handoffState.narratorText);
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('broker-required dialogue mode escalates non-T4 classifier result to T4', async () => {
    classifierState.intent = 'T1';
    classifierState.mode = 'dialogue';
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { turnId, done } = startTurn(ctx.session, {
        text: '@Mikka, hello.',
        playerId: ctx.playerId,
        language: 'en',
      });
      await done;
      await nextTick();

      expect(runBroker).toHaveBeenCalledTimes(1);
      expect(sse.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'turn.tier',
            data: expect.objectContaining({ turnId, tier: 'T4' }),
          }),
        ]),
      );
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('T1 narrator-only route emits T1 tier event', async () => {
    classifierState.intent = 'T1';
    classifierState.mode = 'exploration';
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { turnId, done } = startTurn(ctx.session, {
        text: 'Tier event for narrator only.',
        playerId: ctx.playerId,
      });
      await done;
      await nextTick();

      expect(sse.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'turn.tier',
            data: expect.objectContaining({ turnId, tier: 'T1' }),
          }),
        ]),
      );
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('active turn handle is cleared after post-turn boundary emits turn.end', async () => {
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { done } = startTurn(ctx.session, {
        text: 'Clear active turn after finish.',
        playerId: ctx.playerId,
      });
      await done;
      await nextTick();

      expect(ctx.session.activeTurn).toBeUndefined();
      expect(sse.events.some((event) => event.event === 'turn.end')).toBe(true);
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('broker failure resolves done and emits a turn error event', async () => {
    handoffState.brokerError = new Error('mock broker exploded');
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { done } = startTurn(ctx.session, {
        text: 'This turn should fail visibly.',
        playerId: ctx.playerId,
      });
      await expect(done).resolves.toBeUndefined();
      await nextTick();

      expect(sse.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'gui:event',
            data: expect.objectContaining({
              type: 'turn.error',
            }),
          }),
        ]),
      );
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('player message payload records source turn id and original text', async () => {
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { turnId, done } = startTurn(ctx.session, {
        text: 'Payload check.',
        playerId: ctx.playerId,
        actionId: 'continue_scene',
      });
      await done;

      const messages = await chatMessages(ctx.sessionId);
      expect(messages[0]?.payload).toEqual(
        expect.objectContaining({
          turn_id: turnId,
          source: 'user',
          actionId: 'continue_scene',
          original_text: 'Payload check.',
        }),
      );
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('turn telemetry records broker and narrator-bypass roles for T4', async () => {
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { turnId, done } = startTurn(ctx.session, {
        text: 'Telemetry check.',
        playerId: ctx.playerId,
      });
      await done;

      const telemetry = await queryRows<{ role: string }>(
        `SELECT role FROM turn_telemetry WHERE turn_id = $1 ORDER BY id`,
        [turnId],
      );
      expect(telemetry.map((row) => row.role)).toEqual(
        expect.arrayContaining(['broker']),
      );
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });

  test('session ownership keeps messages scoped to the active player', async () => {
    const ctx = await setupTestSession();
    const sse = collectSse(ctx.session);
    try {
      const { done } = startTurn(ctx.session, {
        text: 'Ownership check.',
        playerId: ctx.playerId,
      });
      await done;

      const foreignRows = await queryRows<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM chat_messages
          WHERE session_id = $1
            AND player_id IS DISTINCT FROM $2`,
        [ctx.sessionId, ctx.playerId],
      );
      expect(Number(foreignRows[0]?.count)).toBe(0);
    } finally {
      await sse.stop();
      await ctx.cleanup();
    }
  });
});

async function chatMessages(sessionId: string): Promise<
  Array<{
    tone: string;
    text: string;
    payload: Record<string, unknown> | null;
  }>
> {
  return queryRows(
    `SELECT tone, text, payload
       FROM chat_messages
      WHERE session_id = $1
      ORDER BY id`,
    [sessionId],
  );
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
