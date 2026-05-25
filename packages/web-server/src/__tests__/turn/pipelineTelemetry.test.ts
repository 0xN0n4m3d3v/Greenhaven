/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-3 — structured telemetry in pipeline catch/retry blocks.
// These tests drive each newly-instrumented swallow path in
// `turnBrokerStage` and `postTurnPipeline` to assert telemetry
// events fire with the expected channel, name, IDs, error payload,
// and retry metadata.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

const brokerState = vi.hoisted(() => ({
  attempts: [] as Array<{userMessage: string; tools: string[]}>,
  outcomes: [] as Array<
    | {kind: 'throw'; err: Error}
    | {kind: 'return'; outcome: Record<string, unknown>}
  >,
}));

// S-13 — use the shared domain error so the broker stage's
// `instanceof` check (and the canonical `code` field) match
// production behavior.
import {
  BrokerEmptyOutputError,
  isBrokerEmptyOutputError as sharedIsBrokerEmptyOutputError,
} from '../../turn/errors.js';

function defaultBrokerOutcome(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contentBuffer: '',
    narrateRequest: null,
    toolNamesCalled: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    mutationLimitExceeded: false,
    ...overrides,
  };
}

vi.mock('../../ai/handoff.js', () => ({
  runBroker: vi.fn(async (input: {userMessage: string; tools: Map<string, unknown>}) => {
    brokerState.attempts.push({
      userMessage: input.userMessage,
      tools: [...input.tools.keys()],
    });
    const next = brokerState.outcomes.shift();
    if (!next) throw new Error('runBroker called with no scripted outcome');
    if (next.kind === 'throw') throw next.err;
    return next.outcome;
  }),
  runNarrator: vi.fn(async () => ({
    contentBuffer: '',
    toolHistory: [],
    toolNamesCalled: [],
  })),
  isBrokerEmptyOutputError: (err: unknown) =>
    sharedIsBrokerEmptyOutputError(err),
  brokerStageOverrideForTools: () => '',
  buildNarratorHandoffMessage: () => '',
  MAX_MUTATION_TOOLS: 5,
  MUTATION_LIMIT_WARNING: 'mutation limit warning %d',
  READ_ONLY_TOOL_NAMES: new Set<string>(),
}));

const narrationState = vi.hoisted(() => ({
  fallbackCalls: 0,
}));

vi.mock('../../narrationSynthesis.js', () => ({
  synthesiseNarrate: vi.fn(async () => {
    narrationState.fallbackCalls += 1;
    return {messageId: null};
  }),
  currentLocationAuthorId: vi.fn(async () => null),
}));

vi.mock('../../db.js', () => ({
  query: vi.fn(async () => ({rows: [], rowCount: 0})),
  // postTurnPipeline now wraps the NPC-agency enqueue + emit in
  // `withTransaction(...)`. The pass-through is enough here: we just
  // need the callback to run; the commit/rollback hook semantics are
  // covered by the dedicated transactionNesting + npcVoice
  // transactional tests.
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({query: vi.fn(async () => ({rows: [], rowCount: 0}))}),
  ),
  onTransactionCommit: vi.fn(() => false),
  onTransactionRollback: vi.fn(() => false),
  isInTransaction: vi.fn(() => false),
}));

vi.mock('../../turnNarrationStage.js', () => ({
  hasVisibleNarrateMessage: vi.fn(() => false),
}));

const queueState = vi.hoisted(() => ({
  startNextThrows: null as Error | null,
}));

const enqueueState = vi.hoisted(() => ({
  reused: false,
  throws: null as Error | null,
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../turnIngressQueue.js', () => ({
  startNextQueuedTurn: vi.fn(async () => {
    if (queueState.startNextThrows) throw queueState.startNextThrows;
    return null;
  }),
  queueRowToTurnInput: vi.fn((row: unknown) => row),
  enqueueTurn: vi.fn(async (opts: Record<string, unknown>) => {
    enqueueState.calls.push(opts);
    if (enqueueState.throws) throw enqueueState.throws;
    return {row: {turnId: 'synthetic-1'}, reused: enqueueState.reused};
  }),
}));

const agencyState = vi.hoisted(() => ({
  intent: null as null | {
    npcId: number;
    npcName: string;
    reason: string;
    urgency: string;
  },
}));

vi.mock('../../agency/npcAgencyEvaluator.js', () => ({
  evaluateNpcAgency: vi.fn(async () => agencyState.intent),
}));

const presentationState = vi.hoisted(() => ({
  openBarrier: true,
}));

vi.mock('../../presentationScheduler.js', () => ({
  closePresentationBarrier: vi.fn(),
  expirePresentationBarrier: vi.fn(),
  openPresentationBarrier: vi.fn(
    (
      _session: unknown,
      opts: {turnId: string; pendingVisibleSlots: number},
    ) => {
      if (!presentationState.openBarrier) return null;
      return {
        id: 'barrier-stub',
        turnId: opts.turnId,
        openedAt: Date.now(),
        fallbackDeadlineAt: Date.now() + 300_000,
        pendingVisibleSlots: opts.pendingVisibleSlots,
        openedReleaseSeq: 0,
      };
    },
  ),
  currentPresentationBarrier: vi.fn(() => null),
  reservePostTurnPresentationSlots: vi.fn(async () => []),
  runPostTurnHookWithPresentation: vi.fn(),
}));

const guiState = vi.hoisted(() => ({
  emitCalls: [] as Array<{
    type: string;
    payload: Record<string, unknown>;
    opts: Record<string, unknown> | undefined;
  }>,
  emitThrows: null as Error | null,
}));

vi.mock('../../guiEventOutbox.js', () => ({
  emitGuiEvent: vi.fn(
    async (
      _ctx: unknown,
      type: string,
      payload: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => {
      guiState.emitCalls.push({type, payload, opts});
      if (guiState.emitThrows) throw guiState.emitThrows;
      return undefined;
    },
  ),
  getCurrentReleaseSeq: vi.fn(async () => 0),
}));

vi.mock('../../domain/memory/maintenance/maintenance.js', () => ({
  runMemoryMaintenanceFailOpen: vi.fn(),
  // `MemoryService.ts` imports the full maintenance surface; the
  // remaining names are unused by pipelineTelemetry.test.ts but must
  // be defined so the module load doesn't crash on missing exports.
  runMemoryMaintenance: vi.fn(),
  maybeRunMemoryMaintenance: vi.fn(),
}));

import {runBrokerStage} from '../../turnBrokerStage.js';
import {runPostTurnPipeline} from '../../postTurnPipeline.js';

interface FakeSession {
  id: string;
  activeTurn: Record<string, unknown> | undefined;
  sse: {emit: (event: string, payload?: unknown) => void};
  resetTurnIds: Set<string>;
  lastTurnToolHistory: unknown[];
}

function makeSession(): FakeSession {
  return {
    id: 'sess-1',
    activeTurn: {
      turnId: 'turn-1',
      toolHistory: [],
      narrativeBuffer: '',
      mode: 'exploration',
      language: 'en',
      startedAt: Date.now(),
      finalMessageId: null,
      streamSeq: 0,
    },
    sse: {emit: vi.fn()},
    resetTurnIds: new Set<string>(),
    lastTurnToolHistory: [],
  };
}

interface BrokerInputBuilderOverrides {
  preBrokerHooks?: ReadonlyArray<{name: string; run: () => Promise<string | null>}>;
  rawPlayerText?: string;
}

function makeBrokerInput(
  session: FakeSession,
  overrides: BrokerInputBuilderOverrides = {},
): Record<string, unknown> {
  return {
    session,
    playerId: 42,
    turnId: 'turn-1',
    rawPlayerText: overrides.rawPlayerText ?? 'walk forward',
    userText: 'walk forward',
    mode: 'exploration',
    playerLang: 'en',
    providers: {
      brokerModelId: 'broker-model',
      brokerThinking: false,
      narratorModelId: 'narrator-model',
      narratorThinking: false,
    },
    brokerSystemPrompt: 'system',
    brokerTools: new Map<string, unknown>(),
    brokerToolProfile: 'free_text',
    narratorSystemPrompt: 'narrator',
    narrateDef: {paramsSchema: {parse: () => ({})}},
    signal: new AbortController().signal,
    preBrokerHooks: overrides.preBrokerHooks ?? [],
    recoveryDirective: 'recover',
    failOpenText: 'fail open text',
    promptBudgetBreakdown: undefined,
  };
}

beforeEach(() => {
  telemetryState.events.length = 0;
  brokerState.attempts.length = 0;
  brokerState.outcomes.length = 0;
  queueState.startNextThrows = null;
  narrationState.fallbackCalls = 0;
  enqueueState.reused = false;
  enqueueState.throws = null;
  enqueueState.calls.length = 0;
  agencyState.intent = null;
  guiState.emitCalls.length = 0;
  guiState.emitThrows = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function eventsByName(name: string): Array<Record<string, unknown>> {
  return telemetryState.events.filter(e => e.name === name);
}

describe('S-3 — postTurnPipeline catch instrumentation', () => {
  it('emits post_turn.start_next_queued_failed when queue promotion fails after a failed turn', async () => {
    const session = makeSession();
    queueState.startNextThrows = new Error('promote-boom');
    runPostTurnPipeline({
      session: session as unknown as never,
      input: {text: 'hi', playerId: 42, language: 'en'},
      turnId: 'turn-1',
      turnFailed: true,
      signal: new AbortController().signal,
      startTurn: vi.fn() as never,
    });
    // Drain microtasks so the unhandled .catch handler fires.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    const events = eventsByName('post_turn.start_next_queued_failed');
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.channel).toBe('gameplay');
    expect(event.sessionId).toBe('sess-1');
    expect(event.playerId).toBe(42);
    expect(event.turnId).toBe('turn-1');
    expect((event.error as Error).message).toBe('promote-boom');
    expect(event.data).toEqual(
      expect.objectContaining({
        stage: 'post_turn_pipeline',
        raw_message: 'promote-boom',
      }),
    );
  });
});

describe('S-3 — turnBrokerStage catch instrumentation', () => {
  it('emits broker.pre_broker_hook_failed when a preBroker hook throws', async () => {
    const session = makeSession();
    brokerState.outcomes.push({
      kind: 'return',
      outcome: defaultBrokerOutcome({contentBuffer: 'ok'}),
    });
    const failingHook = {
      name: 'reward-calibrator',
      run: vi.fn(async () => {
        throw new Error('hook-boom');
      }),
    };
    await runBrokerStage(
      makeBrokerInput(session, {
        preBrokerHooks: [failingHook as unknown as never],
      }) as never,
    );

    const events = eventsByName('broker.pre_broker_hook_failed');
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.channel).toBe('gameplay');
    expect(event.turnId).toBe('turn-1');
    expect((event.error as Error).message).toBe('hook-boom');
    expect(event.data).toEqual(
      expect.objectContaining({
        stage: 'pre_broker_hook',
        hook_name: 'reward-calibrator',
        mode: 'exploration',
        broker_tool_profile: 'free_text',
        raw_message: 'hook-boom',
      }),
    );
  });

  it('emits broker.empty_output_retry when the first broker call returns empty', async () => {
    const session = makeSession();
    brokerState.outcomes.push({
      kind: 'throw',
      err: new BrokerEmptyOutputError('empty-1'),
    });
    brokerState.outcomes.push({
      kind: 'return',
      outcome: defaultBrokerOutcome({contentBuffer: 'recovered prose'}),
    });
    await runBrokerStage(makeBrokerInput(session) as never);

    const retry = eventsByName('broker.empty_output_retry');
    expect(retry).toHaveLength(1);
    expect(retry[0]!.data).toEqual(
      expect.objectContaining({
        stage: 'broker_empty_output_retry',
        attempt: 1,
        mode: 'exploration',
        broker_tool_profile: 'free_text',
        retry_directive: 'recovery_directive',
        error_code: 'BROKER_EMPTY_OUTPUT',
        raw_message: 'empty-1',
      }),
    );
    expect((retry[0]!.error as Error).message).toBe('empty-1');
    expect(eventsByName('broker.empty_output_fail_open')).toHaveLength(0);
  });

  it('emits broker.empty_output_fail_open after the retry also returns empty', async () => {
    const session = makeSession();
    brokerState.outcomes.push({
      kind: 'throw',
      err: new BrokerEmptyOutputError('empty-1'),
    });
    brokerState.outcomes.push({
      kind: 'throw',
      err: new BrokerEmptyOutputError('empty-2'),
    });
    await runBrokerStage(makeBrokerInput(session) as never);

    expect(eventsByName('broker.empty_output_retry')).toHaveLength(1);
    const failOpen = eventsByName('broker.empty_output_fail_open');
    expect(failOpen).toHaveLength(1);
    expect(failOpen[0]!.data).toEqual(
      expect.objectContaining({
        stage: 'broker_empty_output_fail_open',
        attempt: 2,
        mode: 'exploration',
        broker_tool_profile: 'free_text',
        fallback: 'fail_open_narration',
        error_code: 'BROKER_EMPTY_OUTPUT',
        raw_message: 'empty-2',
      }),
    );
    expect((failOpen[0]!.error as Error).message).toBe('empty-2');
    expect(narrationState.fallbackCalls).toBe(1);
  });

  it('emits broker.mutation_limit_retry + broker.mutation_limit_retry_empty when retry has no narrate', async () => {
    const session = makeSession();
    brokerState.outcomes.push({
      kind: 'return',
      outcome: defaultBrokerOutcome({
        mutationLimitExceeded: true,
        contentBuffer: '',
        narrateRequest: null,
      }),
    });
    brokerState.outcomes.push({
      kind: 'return',
      outcome: defaultBrokerOutcome({
        contentBuffer: '',
        narrateRequest: null,
      }),
    });
    await runBrokerStage(makeBrokerInput(session) as never);

    const retry = eventsByName('broker.mutation_limit_retry');
    expect(retry).toHaveLength(1);
    expect(retry[0]!.data).toEqual(
      expect.objectContaining({
        stage: 'broker_mutation_limit_retry',
        attempt: 2,
        mutation_limit: 5,
        retry_directive: 'mutation_limit_warning',
        error_code: 'BROKER_MUTATION_LIMIT',
      }),
    );
    const empty = eventsByName('broker.mutation_limit_retry_empty');
    expect(empty).toHaveLength(1);
    expect(empty[0]!.data).toEqual(
      expect.objectContaining({
        stage: 'broker_mutation_limit_retry',
        fallback: 'synth_fallback',
        error_code: 'BROKER_MUTATION_LIMIT',
      }),
    );
    expect(eventsByName('broker.mutation_limit_retry_failed')).toHaveLength(0);
  });

  it('emits broker.mutation_limit_retry_failed when the retry runBroker call throws', async () => {
    const session = makeSession();
    brokerState.outcomes.push({
      kind: 'return',
      outcome: defaultBrokerOutcome({
        mutationLimitExceeded: true,
        contentBuffer: '',
        narrateRequest: null,
      }),
    });
    brokerState.outcomes.push({
      kind: 'throw',
      err: new Error('retry-boom'),
    });
    await runBrokerStage(makeBrokerInput(session) as never);

    expect(eventsByName('broker.mutation_limit_retry')).toHaveLength(1);
    const failed = eventsByName('broker.mutation_limit_retry_failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]!.error as Error).message).toBe('retry-boom');
    expect(failed[0]!.data).toEqual(
      expect.objectContaining({
        stage: 'broker_mutation_limit_retry',
        fallback: 'synth_fallback',
        error_code: 'BROKER_MUTATION_LIMIT',
        raw_message: 'retry-boom',
      }),
    );
    // The retry path threw, retrySucceeded stays false, so the
    // synth-fallback empty event also fires after the catch.
    expect(eventsByName('broker.mutation_limit_retry_empty')).toHaveLength(1);
  });
});

describe('USER-5/USER-6 — postTurnPipeline NPC-agency idempotency', () => {
  function runAgencyPipeline() {
    const session = makeSession();
    runPostTurnPipeline({
      session: session as unknown as never,
      input: {text: 'hi', playerId: 42, language: 'en'},
      turnId: 'turn-1',
      turnFailed: false,
      signal: new AbortController().signal,
      startTurn: vi.fn() as never,
    });
    return session;
  }

  async function drainAgencyMicrotasks() {
    // The agency block runs as a floating .then() on
    // evaluateNpcAgency. A few microtask drains let the
    // await withTransaction + emit chain settle before assertions.
    for (let i = 0; i < 6; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  it('skips npc:initiative when enqueueTurn reports the synthetic turn was reused', async () => {
    agencyState.intent = {
      npcId: 99,
      npcName: 'Ardent',
      reason: 'unfinished business',
      urgency: 'soon',
    };
    enqueueState.reused = true;
    runAgencyPipeline();
    await drainAgencyMicrotasks();

    expect(enqueueState.calls).toHaveLength(1);
    expect(enqueueState.calls[0]).toMatchObject({
      clientRequestId: 'npc-agency:turn-1:99',
      actionId: 'agency',
      visibleAfterTurnId: 'turn-1',
    });
    expect(guiState.emitCalls.filter(c => c.type === 'npc:initiative')).toHaveLength(0);
    expect(eventsByName('error.npc_initiative_enqueue')).toHaveLength(0);
  });

  it('emits npc:initiative with a dedupe key when enqueueTurn returns a fresh row', async () => {
    agencyState.intent = {
      npcId: 99,
      npcName: 'Ardent',
      reason: 'unfinished business',
      urgency: 'soon',
    };
    enqueueState.reused = false;
    runAgencyPipeline();
    await drainAgencyMicrotasks();

    const npcEmits = guiState.emitCalls.filter(c => c.type === 'npc:initiative');
    expect(npcEmits).toHaveLength(1);
    expect(npcEmits[0]!.payload).toMatchObject({
      npc_id: 99,
      npc_name: 'Ardent',
      reason: 'unfinished business',
      urgency: 'soon',
    });
    expect(npcEmits[0]!.opts).toMatchObject({
      lane: 'post_response',
      phase: 'post_turn',
      dedupeKey: 'npc-agency:turn-1:99',
    });
    expect(eventsByName('error.npc_initiative_enqueue')).toHaveLength(0);
  });

  it('records error.npc_initiative_enqueue and skips npc:initiative when enqueueTurn throws', async () => {
    agencyState.intent = {
      npcId: 99,
      npcName: 'Ardent',
      reason: 'unfinished business',
      urgency: 'soon',
    };
    enqueueState.throws = new Error('enqueue boom');
    runAgencyPipeline();
    await drainAgencyMicrotasks();

    const errs = eventsByName('error.npc_initiative_enqueue');
    expect(errs).toHaveLength(1);
    expect((errs[0]!.error as Error).message).toBe('enqueue boom');
    expect(errs[0]!.data).toEqual(
      expect.objectContaining({
        stage: 'npc_agency',
        raw_message: 'enqueue boom',
      }),
    );
    expect(guiState.emitCalls.filter(c => c.type === 'npc:initiative')).toHaveLength(0);
  });

  it('records error.npc_initiative_enqueue when the npc:initiative emit fails after a fresh enqueue', async () => {
    agencyState.intent = {
      npcId: 99,
      npcName: 'Ardent',
      reason: 'unfinished business',
      urgency: 'soon',
    };
    enqueueState.reused = false;
    guiState.emitThrows = new Error('emit boom');
    runAgencyPipeline();
    await drainAgencyMicrotasks();

    const errs = eventsByName('error.npc_initiative_enqueue');
    expect(errs).toHaveLength(1);
    expect((errs[0]!.error as Error).message).toBe('emit boom');
    // The emit was attempted exactly once inside the tx; the catch
    // records the same domain telemetry as enqueue failures so the
    // op-log keeps one consistent signal for the agency path.
    expect(guiState.emitCalls.filter(c => c.type === 'npc:initiative')).toHaveLength(1);
  });
});
