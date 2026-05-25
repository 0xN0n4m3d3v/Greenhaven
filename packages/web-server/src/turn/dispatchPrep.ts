/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 / S-10 — dispatch-preparation helpers.
//
// Moved out of `turnRunnerV2.ts` so the
// `TurnDispatchPreparationPhase` can import them without creating a
// `phase → runner → phase` cycle. S-10 (closed 2026-05-15) replaced
// the module-scoped `WeakMap<Session, ...>` mode memory with an
// explicit `Session.turnModeState` field so reset paths can clear it
// and tests can assert session-level state directly. Semantics are
// identical:
//
//   * First turn observes `lastMode === undefined`, fires
//     `mode:changed` with `prev = null`.
//   * Same-mode turns skip the transition path.
//   * `resetSessionState` resets `turnModeState` so the next turn
//     after a reset treats the previous mode as absent.
//
//   * `playerHasAnyCompanion` is a cheap single-row read used to
//     decide whether `loadBrokerPromptForMode` includes the
//     companion-lifecycle prompt fragment. Returns `false` on any
//     SQL error so a missing column on older DBs never aborts the
//     turn.

import type {Mode} from '../ai/classifier.js';
import {query} from '../db.js';
import type {Session} from '../sessionManager.js';

export function getSessionModeState(session: Session): {lastMode?: Mode} {
  return session.turnModeState;
}

export function setSessionMode(session: Session, mode: Mode): void {
  session.turnModeState = {lastMode: mode};
}

export function clearSessionMode(session: Session): void {
  session.turnModeState = {};
}

export async function playerHasAnyCompanion(
  playerId: number,
): Promise<boolean> {
  try {
    const r = await query<{n: number}>(
      // M-6: safe_jsonb_array guarantees jsonb_array_length sees an
      // array, so a non-array `companions` (legacy / authoring slip)
      // cannot raise instead of returning zero.
      `SELECT jsonb_array_length(safe_jsonb_array(metadata->'companions')) AS n
         FROM players
        WHERE entity_id = $1`,
      [playerId],
    );
    return Number(r.rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}
