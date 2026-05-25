/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-13 — cancel + reset must abort the in-flight turn with the
// shared domain error so the catch handler in `turnRunnerV2.ts` can
// route `turn.failed` telemetry by `error_code`.

import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  setupTestSession,
  setupTurnTestEnvironment,
} from '../turn/framework.js';
import type {TestSession} from '../turn/framework.js';
import {
  SessionResetDuringTurnError,
  TurnCancelledError,
} from '../../turn/errors.js';

let SessionLifecycleService: typeof import('../../services/SessionLifecycleService.js').SessionLifecycleService;
let resetSessionState: typeof import('../../resetSession.js').resetSessionState;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({SessionLifecycleService} = await import(
    '../../services/SessionLifecycleService.js'
  ));
  ({resetSessionState} = await import('../../resetSession.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

let ctx: TestSession;

beforeEach(async () => {
  ctx = await setupTestSession();
});

function attachActiveTurn(turnId: string): {abortController: AbortController} {
  const ac = new AbortController();
  ctx.session.activeTurn = {
    turnId,
    abortController: ac,
    startedAt: Date.now(),
    done: Promise.resolve(),
  };
  return {abortController: ac};
}

describe('S-13: cancel + reset abort reasons', () => {
  test('SessionLifecycleService.cancelTurn aborts with TurnCancelledError', async () => {
    try {
      const {abortController} = attachActiveTurn('turn-cancel-1');
      const outcome = await SessionLifecycleService.cancelTurn(ctx.session, {});
      expect(outcome.ok).toBe(true);
      expect(outcome.hadActive).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      const reason = abortController.signal.reason;
      expect(reason).toBeInstanceOf(TurnCancelledError);
      expect((reason as TurnCancelledError).code).toBe('TURN_CANCELLED');
    } finally {
      await ctx.cleanup();
    }
  });

  test('resetSessionState aborts the active turn with SessionResetDuringTurnError', async () => {
    try {
      const {abortController} = attachActiveTurn('turn-reset-1');
      await resetSessionState(ctx.session, ctx.playerId, {turnWaitMs: 100});
      expect(abortController.signal.aborted).toBe(true);
      const reason = abortController.signal.reason;
      expect(reason).toBeInstanceOf(SessionResetDuringTurnError);
      expect((reason as SessionResetDuringTurnError).code).toBe(
        'SESSION_RESET_DURING_TURN',
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test('cancelTurn is a no-op without an active turn', async () => {
    try {
      ctx.session.activeTurn = undefined;
      const outcome = await SessionLifecycleService.cancelTurn(ctx.session, {});
      expect(outcome.ok).toBe(true);
      expect(outcome.hadActive).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });
});
