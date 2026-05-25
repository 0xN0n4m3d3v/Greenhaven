/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — TurnLifecycle.
//
// Two narrow helpers that close USER-2 (deferred turn start) and
// USER-1 (safe post-turn pipeline invocation) without rewriting the
// full runner:
//
//   * `deferTurnStart(work)` — yields a single microtask before
//     invoking `work()`.  Used by `startTurnV2` so the function
//     returns its `TurnHandle` (turnId + `activeTurn.done`) before
//     `runWithTurnWatchdog` / `runWithContext` / `measure` /
//     `runTurn` can run.  Any caller subscribing to
//     `session.sse.runFor(...)` immediately after `startTurnV2`
//     returns therefore still sees the very first SSE event for the
//     turn (the SseBridge's preconnect buffer covers the gap, and
//     the deferred start guarantees the runner can't have raced
//     ahead before the buffer existed).
//
//   * `runPostTurnSafely(envelope, invoke)` — invokes
//     `runPostTurnPipeline` inside a try/catch that ALSO follows the
//     returned value: today the pipeline is `void`, but if it ever
//     starts returning a Promise (e.g. a wrapped lifecycle), the
//     rejection is still caught and forwarded as a structured
//     telemetry event instead of becoming an unhandled rejection.
//
// Both helpers are deliberately functions, not classes — the existing
// runner uses functions everywhere and there is no value in a class
// for a two-method contract.

import {telemetry} from '../telemetry/index.js';
import type {Phase} from './Phase.js';
import type {TurnContext} from './TurnContext.js';

/** Yields one microtask before invoking `work`.  The returned promise
 *  resolves/rejects with whatever `work` produces.  Sync throws inside
 *  `work` surface as a rejection on the returned promise (consistent
 *  with `Promise.resolve().then(work)`). */
export function deferTurnStart<T>(work: () => Promise<T> | T): Promise<T> {
  return Promise.resolve().then(work);
}

/** Runs `phases` sequentially against the shared `context`.  Stops on
 *  the first rejection or sync throw — the rejection propagates so the
 *  caller's existing turn-error path (telemetry, friendly bubble,
 *  finally block) handles it exactly like an inline failure.  No retry,
 *  no concurrency, no event bus: this is deliberately the smallest
 *  thing that lets `runTurn` swap inline calls for typed phases. */
export async function runPhases(
  context: TurnContext,
  phases: ReadonlyArray<Phase>,
): Promise<void> {
  for (const phase of phases) {
    await phase.run(context);
  }
}

export interface PostTurnUnhandledEnvelope {
  sessionId: string;
  playerId: number;
  turnId: string;
}

/** Calls `invoke()` and forwards any sync throw or async rejection
 *  through the ARCH-2 telemetry facade as
 *  `gameplay:post_turn_pipeline.unhandled`.  The wrapper itself never
 *  throws or rejects — losing turn cleanup because the post-turn
 *  pipeline crashed is exactly the failure mode USER-1 closes. */
export function runPostTurnSafely(
  envelope: PostTurnUnhandledEnvelope,
  invoke: () => void | Promise<void>,
): void {
  let result: void | Promise<void>;
  try {
    result = invoke();
  } catch (err) {
    emitPostTurnUnhandled(envelope, err);
    return;
  }
  if (
    result &&
    typeof (result as Promise<void>).then === 'function'
  ) {
    (result as Promise<void>).catch((err: unknown) => {
      emitPostTurnUnhandled(envelope, err);
    });
  }
}

function emitPostTurnUnhandled(
  envelope: PostTurnUnhandledEnvelope,
  err: unknown,
): void {
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(
    `[postTurnPipeline ${envelope.turnId}] unhandled:`,
    err,
  );
  telemetry.record({
    channel: 'gameplay',
    name: 'post_turn_pipeline.unhandled',
    sessionId: envelope.sessionId,
    playerId: envelope.playerId,
    turnId: envelope.turnId,
    error: err,
    data: {
      raw_message: rawMessage,
      stack,
    },
  });
}
