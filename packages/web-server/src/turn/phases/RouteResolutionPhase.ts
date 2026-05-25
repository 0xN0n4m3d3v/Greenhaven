/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — route classification + dialogue-focus reconciliation
// + broker tool profile / context scope computation.
//
// Mirrors the previous inline `runTurn` block:
//
//   const route = await resolveTurnRoute({..., scriptedContextInjection});
//   await reconcileDialogueFocusForTurn(..., {dialogueAct: route.dialogueAct});
//   const {tier, mode, contextScope, profileHint} = route;
//   const brokerToolProfile = naturalAdventure.accepted
//     ? 'adventure_accept'
//     : ignoredAdventure.ignored
//       ? 'adventure_ignore'
//       : brokerToolProfileForTurn(mode, profileHint);
//   const brokerContextScope = contextScopeForBrokerProfile(
//     contextScope, brokerToolProfile,
//   );
//   if (session.activeTurn) {
//     session.activeTurn.mode = mode;
//     session.activeTurn.brokerToolProfile = brokerToolProfile;
//   }
//
// All four computed values (`tier`, `mode`, `contextScope`,
// `brokerToolProfile`, `brokerContextScope`) land on
// `TurnContext.state` under a single `RouteResolutionResult` object
// keyed by `ROUTE_RESOLUTION_STATE_KEY`.  `runTurn` reads the result
// back through `readRouteResolutionFromState` — that accessor THROWS
// if the phase did not run, so a downstream reader cannot silently
// see undefined route data.
//
// The phase reads `naturalAdventure` and `ignoredAdventure` from
// state (populated by `AdventureIntentPhase`) and the scripted
// result from `SCRIPTED_ACTION_STATE_KEY`, so phase ordering matters:
// `preRoutePhases` (adventure intent) → `scriptedActionPhase` →
// `routeResolutionPhase`.

import {contextScopeForBrokerProfile} from '../../ai/profileScopes.js';
import {
  brokerToolProfileForTurn,
  type BrokerToolProfile,
} from '../../ai/toolsets.js';
import type {DialogueAct, Mode, Tier} from '../../ai/classifier.js';
import {resolveTurnRoute} from '../../turnRouting.js';
import type {TurnContextScope} from '../../turnContext/index.js';
import {reconcileDialogueFocusForTurn} from '../dialogueFocus.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';
import {
  readIgnoredAdventureFromState,
  readNaturalAdventureFromState,
} from './AdventureIntentPhase.js';
import {readScriptedActionFromState} from './ScriptedActionPhase.js';

export interface RouteResolutionResult {
  tier: Tier;
  mode: Mode;
  dialogueAct: DialogueAct;
  contextScope: TurnContextScope;
  brokerToolProfile: BrokerToolProfile;
  brokerContextScope: TurnContextScope;
}

export const ROUTE_RESOLUTION_STATE_KEY = 'routeResolution' as const;

export function readRouteResolutionFromState(
  context: TurnContext,
): RouteResolutionResult {
  const raw = context.state[ROUTE_RESOLUTION_STATE_KEY];
  if (raw == null) {
    throw new Error(
      'routeResolutionPhase did not run before readRouteResolutionFromState',
    );
  }
  return raw as RouteResolutionResult;
}

export const routeResolutionPhase: Phase = {
  name: 'route_resolution',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId, signal} = context;
    const providers = session.ensureProviders();
    const scripted = readScriptedActionFromState(context);
    const naturalAdventure = readNaturalAdventureFromState(context);
    const ignoredAdventure = readIgnoredAdventureFromState(context);

    const route = await resolveTurnRoute({
      providers,
      sessionId: session.id,
      playerId: input.playerId,
      turnId,
      text: input.text,
      actionId: input.actionId,
      signal,
      scriptedContextInjection: Boolean(scripted?.contextInjection),
    });
    await reconcileDialogueFocusForTurn(
      input.playerId,
      route.mode,
      route.dialogueAct,
      {actionId: input.actionId, session, turnId},
    );
    const {tier, mode, dialogueAct, contextScope, profileHint} = route;
    const brokerToolProfile: BrokerToolProfile = naturalAdventure.accepted
      ? 'adventure_accept'
      : ignoredAdventure.ignored
        ? 'adventure_ignore'
        : brokerToolProfileForTurn(mode, profileHint);
    const brokerContextScope = contextScopeForBrokerProfile(
      contextScope,
      brokerToolProfile,
    );
    if (session.activeTurn) {
      session.activeTurn.mode = mode;
      session.activeTurn.brokerToolProfile = brokerToolProfile;
    }
    const result: RouteResolutionResult = {
      tier,
      mode,
      dialogueAct,
      contextScope,
      brokerToolProfile,
      brokerContextScope,
    };
    context.state[ROUTE_RESOLUTION_STATE_KEY] = result;
  },
};

// ARCH-12 — the inline profile-to-scope promotion chain moved to
// `packages/web-server/src/ai/profileScopes.ts` so the mapping is a
// typed `Record<BrokerToolProfile, ...>` and adding a broker profile
// forces a compile-time addition to the map.
