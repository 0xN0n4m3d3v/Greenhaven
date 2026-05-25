/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// turnRunnerV2 - AI SDK + DeepSeek runner.
// Two-stage flow:
//   1. Scripted-action path: skip broker, narrator narrates the
//      pre-computed result block.
//   2. Free-text path: broker (V4 Flash) drives tools, hands off to
//      narrator (V4 Pro) when it calls narrate.

import { randomUUID } from 'node:crypto';
import type { Session } from './sessionManager.js';
import { markQueueTurnFailed } from './turnIngressQueue.js';
import { runPostTurnPipeline } from './postTurnPipeline.js';
import { runWithContext } from './tools/base.js';
import { measure, telemetry } from './telemetry/index.js';
import {
  deferTurnStart,
  runPhases,
  runPostTurnSafely,
} from './turn/TurnLifecycle.js';
import { createTurnContext } from './turn/TurnContext.js';
import { getTurnErrorCode } from './turn/errors.js';
import {
  playerMessagePersistencePhases,
  preRoutePhases,
  preTurnPhases,
  routeResolutionPhases,
  turnContextPreparationPhases,
  turnDispatchPhases,
  turnDispatchPreparationPhases,
} from './turn/phases/index.js';
import {
  runWithTurnWatchdog as runWithTurnWatchdogImpl,
  type WatchdogOptions,
} from './turn/watchdog.js';
import { friendlyTurnErrorMessage } from './turn/friendlyTurnError.js';
import { emitGuiEvent } from './guiEventOutbox.js';
import { config } from './config.js';

export { synthesiseNarrate } from './narrationSynthesis.js';
// Re-exported so `devtools/supportSmoke.ts` keeps importing the
// fail-open text from `turnRunnerV2.ts` after the helper itself
// moved into `src/turn/brokerEmptyText.ts`.
export { brokerEmptyFailOpenText } from './turn/brokerEmptyText.js';
// ARCH-1 — `friendlyTurnErrorMessage` lives in
// `turn/friendlyTurnError.ts`; re-exported so `devtools/supportSmoke`
// and any other downstream consumer keeps the
// `turnRunnerV2.ts` import path that existed before extraction.
export { friendlyTurnErrorMessage } from './turn/friendlyTurnError.js';

export interface TurnInput {
  text: string;
  /** Optional preallocated turn id from turn_ingress_queue. */
  turnId?: string;
  /** Optional turn_ingress_queue.id, used for diagnostics/ownership. */
  queueId?: number;
  /** Optional cartridge action id (if click came from a quick-action). */
  actionId?: string;
  /**
   * Player making the call. The whole turn (including any tools the
   * runtime dispatches transitively) runs inside an AsyncLocalStorage
   * carrying this player id, so tool executors can route per-player
   * overlay writes correctly.
   */
  playerId: number;
  /**
   * ISO-639 short code (e.g. 'en', 'ru'). When set, the turn runner
   * prepends a directive line to the user message instructing the
   * model to reply in this language regardless of the language the
   * player wrote in. When unset, the system prompt's auto-mirror rule
   * stands.
   */
  language?: string;
}

export interface TurnHandle {
  turnId: string;
  /** Resolves when the turn finishes (success or failure). Never rejects. */
  done: Promise<void>;
}

// ARCH-1 — watchdog implementation lives in `./turn/watchdog.ts`.
// Re-exported as `runWithTurnWatchdogForTest` so existing test and
// devtool imports keep working after the extraction.
export function runWithTurnWatchdogForTest<T>(
  opts: WatchdogOptions,
  run: () => Promise<T>,
): Promise<T> {
  return runWithTurnWatchdogImpl(opts, run);
}

const runWithTurnWatchdog = runWithTurnWatchdogImpl;

export function startTurnV2(session: Session, input: TurnInput): TurnHandle {
  if (session.activeTurn) {
    throw new Error(
      `another turn already running (turnId=${session.activeTurn.turnId})`,
    );
  }
  const turnId = input.turnId ?? `turn-${randomUUID().slice(0, 8)}`;
  const abortController = new AbortController();
  const activeTurn: NonNullable<Session['activeTurn']> = {
    turnId,
    queueId: input.queueId,
    abortController,
    startedAt: Date.now(),
    language: input.language,
  };
  session.activeTurn = activeTurn;
  let turnFailed = false;
  telemetry.record({
    channel: 'gameplay',
    name: 'turn.start',
    sessionId: session.id,
    playerId: input.playerId,
    turnId,
    data: {
      queue_id: input.queueId ?? null,
      action_id: input.actionId ?? null,
      language: input.language ?? null,
      text: input.text,
    },
  });

  // ARCH-1 / USER-2 — defer the heavy turn work by one microtask so
  // `startTurnV2` finishes returning its `TurnHandle` (and assigns
  // `activeTurn.done`) before `runWithTurnWatchdog`, `runWithContext`,
  // `measure`, or `runTurn` execute.  A caller that subscribes to
  // `session.sse.runFor(...)` immediately after `startTurnV2` returns
  // therefore can't miss SSE events emitted by the runner — the
  // runner literally hasn't started yet at that point.
  const done = deferTurnStart(() =>
    runWithTurnWatchdog(
      {
        session,
        input,
        turnId,
        activeTurn,
        abortController,
        timeoutMs: config().turnWatchdogMs,
      },
      () =>
        Promise.resolve(
          runWithContext(
            {
              sessionId: session.id,
              playerId: input.playerId,
              turnId,
              signal: abortController.signal,
              // Spec 139 v2 — entity-creation discipline.
              // continue / scripted / chip-click → not player_prose.
              turnInputKind: input.actionId
                ? input.actionId === 'continue_scene'
                  ? 'continue'
                  : 'player_action'
                : 'player_prose',
            },
            () =>
              measure(
                {
                  sessionId: session.id,
                  playerId: input.playerId,
                  turnId,
                  kind: 'turn',
                  phase: 'turn.run',
                  metadata: { action_id: input.actionId ?? null },
                },
                () => runTurn(session, input, turnId, abortController.signal),
              ),
          ),
        ),
    ),
  )
    .catch(async (err) => {
      turnFailed = true;
      let rawMessage: string;
      if (err instanceof Error) rawMessage = err.message;
      else if (
        typeof err === 'object' &&
        err !== null &&
        typeof (err as { message?: unknown }).message === 'string'
      )
        rawMessage = (err as { message: string }).message;
      else rawMessage = String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(`[turnV2 ${turnId}] failed:`, err);
      telemetry.record({
        channel: 'gameplay',
        name: 'turn.failed',
        sessionId: session.id,
        playerId: input.playerId,
        turnId,
        error: err,
        data: {
          error_code: getTurnErrorCode(err),
          raw_message: rawMessage,
          stack,
        },
      });

      // Translate noisy underlying-IO errors into a player-friendly
      // hint. `terminated` is undici's message when the upstream LLM
      // provider closes the TLS stream (ECONNRESET / UND_ERR_SOCKET).
      // The original is still logged + carried in `cause` for ops
      // visibility; the visible bubble shows the friendly version.
      const message = friendlyTurnErrorMessage(
        err,
        rawMessage,
        activeTurn.language ?? input.language,
      );
      await markQueueTurnFailed(input.queueId, rawMessage);
      if (!activeTurn.resetRequestedAt) {
        await emitGuiEvent(
          { sessionId: session.id, playerId: input.playerId, turnId },
          'turn.error',
          { message, stack, cause: rawMessage },
          { lane: 'status', phase: 'support' },
        );
      }
    })
    .finally(() => {
      const resetCancelled =
        activeTurn.resetRequestedAt != null ||
        session.resetTurnIds.has(turnId) ||
        session.activeTurn !== activeTurn;
      if (resetCancelled) {
        telemetry.record({
          channel: 'gameplay',
          name: 'turn.cancelled',
          sessionId: session.id,
          playerId: input.playerId,
          turnId,
          data: {
            reason:
              activeTurn.resetRequestedAt != null
                ? 'reset_requested'
                : session.resetTurnIds.has(turnId)
                  ? 'reset_turn_id'
                  : 'active_turn_replaced',
          },
        });
        if (session.activeTurn === activeTurn) {
          session.activeTurn = undefined;
        }
        session.resetTurnIds.delete(turnId);
        // SSE-OK: emit outside tx (reason: turn-lifecycle marker
        // for session-reset cancellation; the reset writes commit
        // separately via resetSessionState).
        session.sse.emit('cancelled', {
          turnId,
          reason: 'session_reset',
        });
        return;
      }
      telemetry.record({
        channel: 'gameplay',
        name: 'turn.finished',
        sessionId: session.id,
        playerId: input.playerId,
        turnId,
        data: {
          failed: turnFailed,
          duration_ms: Date.now() - activeTurn.startedAt,
          mode: activeTurn.mode ?? null,
          broker_tool_profile: activeTurn.brokerToolProfile ?? null,
          tool_count: activeTurn.toolHistory?.length ?? 0,
          final_message_id: activeTurn.finalMessageId ?? null,
        },
      });
      // ARCH-1 / USER-1 — wrap the post-turn pipeline so a sync throw
      // (or a future Promise rejection if the pipeline signature ever
      // changes) becomes a structured telemetry event instead of an
      // unhandled error that swallows turn cleanup silently.
      runPostTurnSafely(
        { sessionId: session.id, playerId: input.playerId, turnId },
        () =>
          runPostTurnPipeline({
            session,
            input,
            turnId,
            turnFailed,
            signal: abortController.signal,
            startTurn: startTurnV2,
          }),
      );
      return;
    });

  activeTurn.done = done;
  return { turnId, done };
}

async function runTurn(
  session: Session,
  input: TurnInput,
  turnId: string,
  signal: AbortSignal,
): Promise<void> {
  // USER-4 (ARCH-1) — resolve providers eagerly so a missing API
  // key aborts the turn BEFORE any phase side effects (player
  // message persistence, SSE emits) fire. The dispatch phase calls
  // `session.ensureProviders()` again later; the result is cached.
  session.ensureProviders();

  // USER-4 (ARCH-1) — run the deterministic preflight/pre-turn phases.
  // Each Phase wraps a single previously-inline call (prompt-injection
  // guard, Spec 25 quest-choice routing, Spec 17 condition decay,
  // Spec 33 surface decay, Spec 32 world-clock tick, Spec 22 / USER-3
  // quest evaluator).  See `src/turn/phases/index.ts` for the ordered
  // list.  `createTurnContext` shallow-copies `input`, so the prompt
  // guard's `text` rewrite stays inside the turn; we reassign the
  // local `input` to point at the (possibly rewritten) per-turn copy
  // so the rest of this function picks up the neutralised text
  // transparently.
  const phaseContext = createTurnContext({
    session,
    input,
    turnId,
    signal,
  });
  await runPhases(phaseContext, preTurnPhases);
  input = phaseContext.input;

  // USER-4 slice 2 (ARCH-1) — dialogue auto-engage + natural
  // adventure intent run through the second phase list.  The
  // adventure phase writes `naturalAdventure` and `ignoredAdventure`
  // onto `phaseContext.state` for the route resolution phase + the
  // player prompt phase to consume; no other consumer in `runTurn`.
  await runPhases(phaseContext, preRoutePhases);

  // USER-4 slice 3 (ARCH-1) — scripted action resolution + route
  // classification (with dialogue focus reconciliation and broker
  // tool profile / context scope computation) now live in
  // `routeResolutionPhases`. Results are written to phase state and
  // consumed by later phases (preparation, dispatch).
  await runPhases(phaseContext, routeResolutionPhases);

  // USER-4 slice 4 (ARCH-1) — turn-context + broker user-prompt
  // preparation runs through `turnContextPreparationPhases`:
  //
  //   scene_summary → language → location_visit → context_build
  //                                              → player_prompt
  //
  // Each phase reads upstream state and writes its own output back
  // to `TurnContext.state`. The consolidated `TurnPreparationResult`
  // (playerLang / userText / promptBudgetBreakdown / render meta /
  // text variants) is consumed by the persistence + dispatch phases
  // below.
  await runPhases(phaseContext, turnContextPreparationPhases);

  // USER-4 slice 5 (ARCH-1) / USER-5 / USER-6 — `turn.start` SSE
  // emit + player chat message persistence + `message:created` SSE
  // emit + auto-snapshot moved into `playerMessagePersistencePhases`.
  // The phase reads `rawPlayerText` / `visiblePlayerText` /
  // `playerRenderMeta` from `TurnPreparationResult`. The DB writes
  // run inside `withTransaction(...)` and the `message:created`
  // SSE + `turn.player_message.persisted` telemetry fire via
  // `onTransactionCommit(...)` so a rollback can't leak an
  // uncommitted message_id over SSE — see
  // `docs/backend/state-mutation-contract.md`.
  await runPhases(phaseContext, playerMessagePersistencePhases);

  // USER-4 slice 6 (ARCH-1) — broker/narrator dispatch preparation
  // runs through `turnDispatchPreparationPhases`. The phase owns
  // tool/prompt resolution, `turn.tier` SSE, `mode:changed` GUI
  // event + combat/ambient side effects, and intimacy-rules
  // injection.
  await runPhases(phaseContext, turnDispatchPreparationPhases);

  // USER-4 slice 7 (ARCH-1) — scripted/narrator/broker dispatch is
  // a single ordered phase list now. The phase reads all of its
  // inputs from `TurnContext.state`, picks the right stage, and
  // records the chosen `path` under `TURN_DISPATCH_STATE_KEY`.
  // Provider resolution stays at the top of `runTurn` so the
  // early-fail path for a missing API key still aborts before any
  // phase side effects fire.
  await runPhases(phaseContext, turnDispatchPhases);
}
