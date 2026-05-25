/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {onTransactionCommit, withTransaction} from './db.js';
import {clearDialogueParticipants} from './dialogueParticipants.js';
import {expirePresentationBarrier} from './presentationScheduler.js';
import type {Session} from './sessionManager.js';
import {SessionResetDuringTurnError} from './turn/errors.js';
import {
  deleteTelemetryArtifactFiles,
  listTelemetryArtifactFilesForSession,
} from './telemetryArtifacts.js';

export interface ResetSessionResult {
  deleted: Record<string, number>;
  cancelledTurnId: string | null;
  activeTurnTimedOut: boolean;
}

export async function resetSessionState(
  session: Session,
  playerId: number,
  opts: {turnWaitMs?: number} = {},
): Promise<ResetSessionResult> {
  const active = session.activeTurn;
  let activeTurnTimedOut = false;
  if (active) {
    active.resetRequestedAt = Date.now();
    session.resetTurnIds.add(active.turnId);
    // S-13 — abort with the shared domain error so the catch
    // handler in `turnRunnerV2.ts` can route `turn.failed`
    // telemetry by `error_code: SESSION_RESET_DURING_TURN`.
    active.abortController.abort(new SessionResetDuringTurnError());
    let settled = false;
    await Promise.race([
      (active.done ?? Promise.resolve()).then(() => {
        settled = true;
      }),
      delay(opts.turnWaitMs ?? 1500),
    ]);
    activeTurnTimedOut = !settled;
    if (session.activeTurn === active) {
      session.activeTurn = undefined;
    }
    if (settled) {
      session.resetTurnIds.delete(active.turnId);
    }
  }

  if (session.presentationBarrier) {
    expirePresentationBarrier(
      session,
      session.presentationBarrier.id,
      'session_reset',
    );
  }

  // USER-3 — the next turn after a reset must not inherit the
  // previous timeline's broker tool history.  postTurnPipeline only
  // populates `lastTurnToolHistory` on a clean turn.end; reset/cancel
  // aborts and never runs the pipeline, so a partial cancelled-turn
  // history could otherwise leak into the next quest evaluation.
  session.lastTurnToolHistory = [];
  // S-10 — also wipe the dispatched-mode memory so the first turn
  // after a reset treats the previous mode as absent and re-fires
  // `mode:changed` with `prev = null` (matching the freshly-created
  // Session semantics from before the reset).
  session.turnModeState = {};

  const deleted: Record<string, number> = {};
  const artifactRows = await listTelemetryArtifactFilesForSession(session.id);
  await withTransaction(async tx => {
    await clearDialogueParticipants(playerId, {
      source: 'session_reset',
    });
    const del = async (
      name: string,
      sql: string,
      params: unknown[] = [session.id],
    ) => {
      const result = await tx.query(sql, params);
      deleted[name] = result.rowCount ?? 0;
    };
    await del(
      'adventure_oracle_rolls',
      `DELETE FROM adventure_oracle_rolls WHERE session_id = $1`,
    );
    await del(
      'adventure_queue',
      `DELETE FROM adventure_queue WHERE session_id = $1`,
    );
    await del(
      'turn_ingress_queue',
      `DELETE FROM turn_ingress_queue WHERE session_id = $1`,
    );
    await del('gui_events', `DELETE FROM gui_events WHERE session_id = $1`);
    await del(
      'chat_messages',
      `DELETE FROM chat_messages WHERE session_id = $1`,
    );
    await del(
      'tool_invocations',
      `DELETE FROM tool_invocations WHERE session_id = $1`,
    );
    await del(
      'turn_telemetry',
      `DELETE FROM turn_telemetry WHERE session_id = $1`,
    );
    await del(
      'performance_events',
      `DELETE FROM performance_events WHERE session_id = $1`,
    );
    await del(
      'telemetry_eval_scores',
      `DELETE FROM telemetry_eval_scores WHERE session_id = $1`,
    );
    await del(
      'telemetry_artifacts',
      `DELETE FROM telemetry_artifacts WHERE session_id = $1`,
    );
    await del(
      'telemetry_metrics',
      `DELETE FROM telemetry_metrics WHERE session_id = $1`,
    );
    await del(
      'telemetry_events',
      `DELETE FROM telemetry_events WHERE session_id = $1`,
    );
    await del(
      'telemetry_spans',
      `DELETE FROM telemetry_spans WHERE session_id = $1`,
    );
    await del(
      'telemetry_sessions',
      `DELETE FROM telemetry_sessions WHERE session_id = $1`,
    );
    onTransactionCommit(async () => {
      const artifactFiles = await deleteTelemetryArtifactFiles(artifactRows);
      deleted.telemetry_artifact_files = artifactFiles.deleted;
    });
  });

  return {
    deleted,
    cancelledTurnId: active?.turnId ?? null,
    activeTurnTimedOut,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}
