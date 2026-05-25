/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — scripted action resolution.
//
// Mirrors the previous inline `runTurn` call exactly:
//
//   const scripted = await maybeScriptAction(
//     session, playerId, actionId, turnId,
//   );
//
// The `ScriptResult | null` is written onto `TurnContext.state`
// under the stable `scripted` key so the immediately-following
// `RouteResolutionPhase` can read it for the
// `scriptedContextInjection` decision, and so `runTurn` can read it
// downstream when composing scene summary / context / broker prompt.
//
// `null` is a legitimate value — most turns are not scripted. The
// accessor below normalises both "phase never ran" and "phase ran
// and returned null" to `null` so consumers don't need to
// distinguish.

import {maybeScriptAction} from '../../scriptedActions.js';
import type {ScriptResult} from '../../scriptedActions/common.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const SCRIPTED_ACTION_STATE_KEY = 'scripted' as const;

export function readScriptedActionFromState(
  context: TurnContext,
): ScriptResult | null {
  const raw = context.state[SCRIPTED_ACTION_STATE_KEY];
  return (raw as ScriptResult | null | undefined) ?? null;
}

export const scriptedActionPhase: Phase = {
  name: 'scripted_action',
  async run(context: TurnContext): Promise<void> {
    const scripted = await maybeScriptAction(
      context.session,
      context.input.playerId,
      context.input.actionId,
      context.turnId,
    );
    context.state[SCRIPTED_ACTION_STATE_KEY] = scripted ?? null;
  },
};
