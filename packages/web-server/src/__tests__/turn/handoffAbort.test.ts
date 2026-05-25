/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-13 — `throwIfAborted` inside `ai/handoff.ts` must route generic
// abort reasons through the shared `TurnCancelledError`, but preserve
// richer domain errors (watchdog timeout, session reset, explicit
// cancel) verbatim so the catch handler in `turnRunnerV2.ts` can read
// `getTurnErrorCode(err)` for telemetry.

import {describe, expect, it} from 'vitest';

import {runBroker, type BrokerOutcome} from '../../ai/handoff.js';
import type {ToolDefinition} from '../../tools/base.js';
import type {RunnerProviders} from '../../ai/providers.js';
import {
  SessionResetDuringTurnError,
  TurnCancelledError,
  TurnWatchdogTimeoutError,
} from '../../turn/errors.js';

const noopProviders: RunnerProviders = {
  broker: undefined as never,
  narrator: undefined as never,
  brokerModelId: 'fake-broker',
  brokerThinking: false,
  narratorModelId: 'fake-narrator',
  narratorThinking: false,
} as unknown as RunnerProviders;

async function expectAbort(
  signal: AbortSignal,
): Promise<unknown> {
  try {
    await runBroker({
      providers: noopProviders,
      systemPrompt: 'sys',
      userMessage: 'hi',
      tools: new Map<string, ToolDefinition>(),
      signal,
    }) satisfies BrokerOutcome;
    throw new Error('runBroker should have rejected on a pre-aborted signal');
  } catch (err) {
    return err;
  }
}

describe('handoff.throwIfAborted (S-13)', () => {
  it('throws TurnCancelledError when the signal is aborted with no reason', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await expectAbort(ac.signal);
    expect(err).toBeInstanceOf(TurnCancelledError);
    expect((err as TurnCancelledError).code).toBe('TURN_CANCELLED');
  });

  it('throws TurnCancelledError carrying the string reason as message', async () => {
    const ac = new AbortController();
    ac.abort('user click');
    const err = await expectAbort(ac.signal);
    expect(err).toBeInstanceOf(TurnCancelledError);
    expect((err as TurnCancelledError).code).toBe('TURN_CANCELLED');
    expect((err as TurnCancelledError).message).toBe('user click');
  });

  it('passes a TurnWatchdogTimeoutError reason through unchanged', async () => {
    const reason = new TurnWatchdogTimeoutError(120_000);
    const ac = new AbortController();
    ac.abort(reason);
    const err = await expectAbort(ac.signal);
    expect(err).toBe(reason);
    expect((err as TurnWatchdogTimeoutError).code).toBe('TURN_WATCHDOG_TIMEOUT');
  });

  it('passes a SessionResetDuringTurnError reason through unchanged', async () => {
    const reason = new SessionResetDuringTurnError();
    const ac = new AbortController();
    ac.abort(reason);
    const err = await expectAbort(ac.signal);
    expect(err).toBe(reason);
    expect((err as SessionResetDuringTurnError).code).toBe(
      'SESSION_RESET_DURING_TURN',
    );
  });

  it('passes a TurnCancelledError reason through unchanged', async () => {
    const reason = new TurnCancelledError('explicit user cancel');
    const ac = new AbortController();
    ac.abort(reason);
    const err = await expectAbort(ac.signal);
    expect(err).toBe(reason);
    expect((err as TurnCancelledError).message).toBe('explicit user cancel');
  });
});
