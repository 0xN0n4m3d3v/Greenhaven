/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — Spec 22 / USER-3 quest objective evaluator.
//
// Auto-advances any active quest whose stage objectives are now
// satisfied; auto-completes when there's no next stage.  Reads tool
// history from the PRIOR completed turn via
// `session.lastTurnToolHistory` — `session.activeTurn.toolHistory` is
// for THIS turn (still empty here because the broker hasn't run yet)
// and would never match a `tool_called` objective in time.
//
// The legacy `if (session.activeTurn)` guard is preserved: it is
// defensive, since `startTurnV2` always assigns `activeTurn` before
// `runTurn` runs, but the phase keeps the same behavior to make the
// extraction byte-for-byte equivalent.

import {evaluateActiveQuests} from '../../quest/questEngine.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const evaluateActiveQuestsPhase: Phase = {
  name: 'evaluate_active_quests',
  async run(context: TurnContext): Promise<void> {
    if (!context.session.activeTurn) return;
    // QE-4 — forward `context.turnId` (not
    // `session.activeTurn?.turnId`) so quest GUI events emitted by
    // `evaluateActiveQuests(...)` are correlatable with the active
    // turn the orchestrator opened for this phase.
    await evaluateActiveQuests(
      context.session.id,
      context.input.playerId,
      context.session.lastTurnToolHistory,
      context.turnId,
    );
  },
};
