/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — turn watchdog. Pulled out of `turnRunnerV2.ts` so the
// runner stays a thin turn-handle / orchestration file. The
// watchdog races the turn body against a configurable timeout: if
// the timer fires first, it aborts the turn's `AbortController`
// with a `TurnWatchdogTimeoutError`, records the
// `performance/turn.watchdog` event, fires the lifecycle
// `turn.timeout` SSE marker, and rejects the returned promise.
// Behavior matches the pre-extraction implementation byte-for-byte;
// `turnRunnerV2.ts` re-exports `runWithTurnWatchdogForTest` so
// existing test and devtool imports keep working.

import type {Session} from '../sessionManager.js';
import {telemetry} from '../telemetry/index.js';
import {TurnWatchdogTimeoutError} from './errors.js';

export interface WatchdogTurnInput {
  playerId: number;
}

export interface WatchdogOptions {
  session: Session;
  input: WatchdogTurnInput;
  turnId: string;
  activeTurn: NonNullable<Session['activeTurn']>;
  abortController: AbortController;
  timeoutMs: number;
}

export function runWithTurnWatchdog<T>(
  opts: WatchdogOptions,
  run: () => Promise<T>,
): Promise<T> {
  if (opts.timeoutMs <= 0) return run();

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const signal = opts.abortController.signal;

  return new Promise<T>((resolve, reject) => {
    const abortHandler = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener('abort', abortHandler);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    signal.addEventListener('abort', abortHandler, {once: true});
    timer = setTimeout(() => {
      timer = null;
      if (opts.session.activeTurn !== opts.activeTurn) return;
      if (signal.aborted) return;
      const err = new TurnWatchdogTimeoutError(opts.timeoutMs);
      opts.activeTurn.timeoutRequestedAt = Date.now();
      opts.activeTurn.timeoutReason = err.message;
      console.warn(
        `[turnV2 ${opts.turnId}] watchdog timeout after ${opts.timeoutMs}ms`,
      );
      telemetry.record({
        channel: 'performance',
        name: 'turn.watchdog',
        sessionId: opts.session.id,
        playerId: opts.input.playerId,
        turnId: opts.turnId,
        traceId: opts.turnId,
        kind: 'turn',
        phase: 'turn.watchdog',
        status: 'timeout',
        durationMs: opts.timeoutMs,
        metadata: {
          timeout_ms: opts.timeoutMs,
          error_code: err.code,
        },
        error: err.message,
      });
      // SSE-OK: emit outside tx (reason: turn-lifecycle marker
      // for watchdog timeout; not a DB state-change — the queue
      // row is failed elsewhere).
      opts.session.sse.emit('turn.timeout', {
        turnId: opts.turnId,
        timeoutMs: opts.timeoutMs,
        message: err.message,
      });
      opts.abortController.abort(err);
      finish(() => reject(err));
    }, opts.timeoutMs);

    void run().then(
      value => finish(() => resolve(value)),
      err => finish(() => reject(err)),
    );
  });
}
