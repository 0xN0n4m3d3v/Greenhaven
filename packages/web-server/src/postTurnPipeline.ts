/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {evaluateNpcAgency} from './agency/npcAgencyEvaluator.js';
import type {PostTurnHook, SpecialistContext} from './agents/base.js';
import {listPostTurnHooks} from './specialists/index.js';
import {withTransaction} from './db.js';
import {emitGuiEvent, getCurrentReleaseSeq} from './guiEventOutbox.js';
import {
  closePresentationBarrier,
  expirePresentationBarrier,
  openPresentationBarrier,
  reservePostTurnPresentationSlots,
  runPostTurnHookWithPresentation,
} from './presentationScheduler.js';
import type {Session} from './sessionManager.js';
import {
  enqueueTurn,
  queueRowToTurnInput,
  startNextQueuedTurn,
} from './turnIngressQueue.js';
import type {TurnHandle, TurnInput} from './turnRunnerV2.js';
import {runMemoryMaintenanceFailOpen} from './domain/memory/index.js';
import { telemetry } from './telemetry/index.js';

// Spec 39 - post-turn specialists. This module owns the async
// side-effect pipeline so the turn runner does not also own GUI
// barrier release and queued turn promotion.
//
// ARCH-5 post-turn slice — the previous hardcoded `postTurnPhase`
// array now lives in the SpecialistRegistry. Hooks are registered by
// side-effect import of `specialists/index.js` (in registration order:
// quest_watcher → memory_loop_watcher → catalogue_scout → npc_voice
// → dialogue_anchor → rolling_dialogue_summary →
// narrative_claim_sweeper → movement_warden → quest_pacer →
// adventure_oracle → adventure_materializer →
// companion_depart_engine). `listPostTurnHooks()` returns that
// ordered hook stack so the slot-counting + filtering logic below
// stays byte-for-byte identical.

export interface PostTurnPipelineInput {
  text: string;
  actionId?: string;
  language?: string;
  playerId: number;
}

export interface RunPostTurnPipelineOptions {
  session: Session;
  input: PostTurnPipelineInput;
  turnId: string;
  turnFailed: boolean;
  signal: AbortSignal;
  startTurn: (session: Session, input: TurnInput) => TurnHandle;
}

export function runPostTurnPipeline(opts: RunPostTurnPipelineOptions): void {
  const {session, input, turnId, turnFailed, signal, startTurn} = opts;
  const activeTurn = session.activeTurn;

  const turnSnapshot = {
    text: input.text,
    actionId: input.actionId,
    toolHistory: activeTurn?.toolHistory ?? [],
    narrative: activeTurn?.narrativeBuffer ?? '',
    mode: activeTurn?.mode,
    language: activeTurn?.language ?? input.language,
  };
  const suppressPostTurn = activeTurn?.suppressPostTurn === true;

  const postTurnHooks = turnFailed || suppressPostTurn
    ? []
    : listPostTurnHooks().filter(
        hook =>
          hook.presentation &&
          !shouldSkipPostTurnHookForSnapshot(hook, turnSnapshot),
      );
  const chatVisibleSlotCount = postTurnHooks.filter(
    hook => hook.presentation.barrierMode === 'chat_visible',
  ).length;
  // S-14 — the barrier now opens with a 5-minute dead-service
  // fallback only; the slot-resolution path drives the canonical
  // close. Per-hook `deadlineMs` still governs the per-slot
  // watchdog inside `runPostTurnHookWithPresentation`, which is
  // unchanged. Snapshot the current `gui_events.release_seq` for
  // diagnostics so an operator can correlate which post-turn
  // activity was outstanding when the barrier opened.
  const barrier = chatVisibleSlotCount > 0
    ? openPresentationBarrier(session, {
        turnId,
        pendingVisibleSlots: chatVisibleSlotCount,
      })
    : null;
  if (barrier) {
    void getCurrentReleaseSeq(session.id)
      .then(seq => {
        if (session.presentationBarrier?.id === barrier.id) {
          session.presentationBarrier.openedReleaseSeq = seq;
        }
      })
      .catch(err => {
        // CATCH-WARN-OK: openedReleaseSeq is a debug instrumentation snapshot only; barrier lifecycle continues without it, and re-emitting through telemetry duplicates the post-turn pipeline trace.
        console.warn(
          '[presentationBarrier] openedReleaseSeq snapshot failed:',
          err instanceof Error ? err.message : err,
        );
      });
  }
  const expiryTimer = barrier
    ? setTimeout(() => {
        expirePresentationBarrier(
          session,
          barrier.id,
          'fallback_deadline_exceeded',
        );
        console.warn(
          `[presentationBarrier ${barrier.id}] expired after ${Date.now() - barrier.openedAt}ms (5-minute dead-service fallback)`,
        );
        // VOID-FF-OK: dead-service fallback path; expirePresentationBarrier above already recorded the failure through the standard barrier-expiry pipeline.
        void startNextQueued(session, startTurn);
      }, Math.max(1, barrier.fallbackDeadlineAt - Date.now()))
    : null;

  // SSE-OK: emit outside tx (reason: turn-lifecycle marker; flips
  // the UI from "running" to "post-turn", not a DB state-change).
  session.sse.emit('turn.end', {
    turnId,
    messageId: activeTurn?.finalMessageId ?? null,
    durationMs: Date.now() - (activeTurn?.startedAt ?? Date.now()),
  });
  // USER-3 — snapshot the just-completed turn's tool history onto the
  // session BEFORE clearing `activeTurn`, so the next turn's
  // `evaluateActiveQuests` call (which runs at the top of `runTurn`)
  // can see the prior broker's `tool_called` activity. A shallow array
  // copy is enough; ToolHistoryEntry is treated as immutable by every
  // existing reader. A failed turn still snapshots — quest evaluation
  // already handles an empty/no-match history.
  session.lastTurnToolHistory = activeTurn?.toolHistory
    ? [...activeTurn.toolHistory]
    : [];
  session.activeTurn = undefined;

  if (turnFailed) {
    void startNextQueued(session, startTurn).catch(err => {
      console.warn(
        '[postTurnPipeline] queue promotion after failed turn skipped:',
        err instanceof Error ? err.message : err,
      );
      telemetry.record({
        channel: 'gameplay',
        name: 'post_turn.start_next_queued_failed',
        sessionId: session.id,
        playerId: input.playerId,
        turnId,
        error: err,
        data: {
          stage: 'post_turn_pipeline',
          raw_message: err instanceof Error ? err.message : String(err),
        },
      });
    });
    return;
  }

  runMemoryMaintenanceFailOpen();

  const specCtx: SpecialistContext = {
    sessionId: session.id,
    playerId: input.playerId,
    turnId,
    language: turnSnapshot.language,
    signal,
  };
  if (!barrier) {
    // VOID-FF-OK: queue promoter; `startNextQueued`'s own internal catch chain feeds `markQueueTurnFailed` so a reject does not silently disappear.
    void startNextQueued(session, startTurn);
    return;
  }

  const postTurnOrchestrator = reservePostTurnPresentationSlots(
    {
      sessionId: session.id,
      playerId: input.playerId,
      turnId,
    },
    postTurnHooks.map(hook => ({
      name: hook.name,
      presentation: hook.presentation,
    })),
  ).then(slots => {
    const runs = slots.map((slot, index) => {
      const hook = postTurnHooks[index]!;
      const run = runPostTurnHookWithPresentation(slot, async ({presentation}) => {
        await hook.run({...specCtx, presentation}, turnSnapshot);
      });
      run.catch(err => {
        console.warn(
          `[postTurnPhase ${hook.name}] failed:`,
          err instanceof Error ? err.message : err,
        );
        telemetry.record({
          channel: 'gameplay',
          name: 'error.post_turn_hook',
          sessionId: session.id,
          playerId: input.playerId,
          turnId,
          error: err,
          data: {
            stage: 'post_turn_hook',
            hook_name: hook.name,
            raw_message: err instanceof Error ? err.message : String(err),
          },
        });
      });
      return {hook, slot, run};
    });
    const blockingRuns = runs
      .filter(run => run.slot.meta.barrierMode === 'chat_visible')
      .map(run => run.run);
    return Promise.allSettled(blockingRuns);
  });

  postTurnOrchestrator
    .then(async () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      closePresentationBarrier(session, barrier.id);
      await startNextQueued(session, startTurn);
    })
    .catch(async err => {
      if (expiryTimer) clearTimeout(expiryTimer);
      expirePresentationBarrier(
        session,
        barrier.id,
        err instanceof Error ? err.message : String(err),
      );
      await startNextQueued(session, startTurn);
    });

  void evaluateNpcAgency(session, input.playerId)
    .then(async intent => {
      if (!intent) return;
      // USER-5/USER-6 — the `npc:initiative` GUI event and the
      // synthetic turn it represents share one transaction so a failed
      // `enqueueTurn` rolls back the `gui_events` row and the deferred
      // SSE never escapes. `enqueueTurn` itself uses
      // `withTransaction(...)` internally; with ARCH-16 nesting that
      // becomes a SAVEPOINT against this outer tx. Order: enqueue
      // first; if `enqueueTurn` returns `reused: true` (the same
      // synthetic agency turn was already queued for this
      // post-turn) we skip the GUI emit so the UI never sees a
      // duplicate `npc:initiative` notification. SSE auto-defers via
      // `SseBridge.emit`'s `onTransactionCommit` path. `dedupeKey`
      // makes the `gui_events` row itself idempotent in case the
      // emit path is retried.
      const synthetic = `[${intent.npcName} takes initiative - ${intent.reason}]`;
      const clientRequestId = `npc-agency:${turnId}:${intent.npcId}`;
      try {
        await withTransaction(async () => {
          const result = await enqueueTurn({
            sessionId: session.id,
            playerId: input.playerId,
            text: synthetic,
            actionId: 'agency',
            language: input.language,
            clientRequestId,
            visibleAfterTurnId: turnId,
          });
          if (result.reused) return;
          await emitGuiEvent(
            {sessionId: session.id, playerId: input.playerId, turnId},
            'npc:initiative',
            {
              npc_id: intent.npcId,
              npc_name: intent.npcName,
              reason: intent.reason,
              urgency: intent.urgency,
            },
            {
              lane: 'post_response',
              phase: 'post_turn',
              dedupeKey: clientRequestId,
            },
          );
        });
      } catch (err) {
        console.warn(
          '[agency] synthetic turn enqueue skipped:',
          err instanceof Error ? err.message : err,
        );
        telemetry.record({
          channel: 'gameplay',
          name: 'error.npc_initiative_enqueue',
          sessionId: session.id,
          playerId: input.playerId,
          turnId,
          error: err,
          data: {
            stage: 'npc_agency',
            raw_message: err instanceof Error ? err.message : String(err),
          },
        });
      }
      await startNextQueued(session, startTurn);
    })
    .catch(err => {
      console.warn(
        '[agency] evaluator failed:',
        err instanceof Error ? err.message : err,
      );
      telemetry.record({
        channel: 'gameplay',
        name: 'error.npc_agency_evaluator',
        sessionId: session.id,
        playerId: input.playerId,
        turnId,
        error: err,
        data: {
          stage: 'npc_agency_evaluator',
          raw_message: err instanceof Error ? err.message : String(err),
        },
      });
    });
}

function shouldSkipPostTurnHookForSnapshot(
  hook: PostTurnHook,
  turnSnapshot: {
    text: string;
    toolHistory: NonNullable<Session['activeTurn']>['toolHistory'];
    narrative: string;
    mode?: string;
    language?: string;
  },
): boolean {
  void hook;
  void turnSnapshot;
  return false;
}

function startNextQueued(
  session: Session,
  startTurn: (session: Session, input: TurnInput) => TurnHandle,
): Promise<{row: unknown; handle: TurnHandle} | null> {
  return startNextQueuedTurn(session, row =>
    startTurn(session, queueRowToTurnInput(row)),
  );
}
