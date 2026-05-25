/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — turn context build (Spec 14 + dialogue history
// limit).
//
// Reads route state, the scene-summary written by
// `SceneSummaryPhase`, and the resolved language written by
// `LanguagePhase`. Calls `buildTurnContext` under a wrapped
// `measure(...)` block with the same metadata the runner used inline.
// Stores the resulting `TurnContextBundle` on `TurnContext.state` for
// `PlayerPromptPhase` to consume.

import {measure} from '../../telemetry/index.js';
import type {BrokerToolProfile} from '../../ai/toolsets.js';
import {buildTurnContext} from '../../turnContext/index.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';
import {readPlayerLangFromState} from './LanguagePhase.js';
import {readRouteResolutionFromState} from './RouteResolutionPhase.js';
import {readSceneSummaryFromState} from './SceneSummaryPhase.js';

export type TurnContextBundle = Awaited<ReturnType<typeof buildTurnContext>>;

export const TURN_CONTEXT_STATE_KEY = 'turnContextBundle' as const;

export function readTurnContextBundleFromState(
  context: TurnContext,
): TurnContextBundle {
  const raw = context.state[TURN_CONTEXT_STATE_KEY];
  if (raw == null) {
    throw new Error(
      'contextBuildPhase did not run before readTurnContextBundleFromState',
    );
  }
  return raw as TurnContextBundle;
}

export const contextBuildPhase: Phase = {
  name: 'context_build',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId} = context;
    const {contextScope, brokerContextScope, brokerToolProfile} =
      readRouteResolutionFromState(context);
    const sceneSummary = readSceneSummaryFromState(context);
    const playerLang = readPlayerLangFromState(context);
    const ctx = await measure(
      {
        sessionId: session.id,
        playerId: input.playerId,
        turnId,
        kind: 'turn',
        phase: 'turn.build_context',
        metadata: {
          route_scope: contextScope,
          scope: brokerContextScope,
          broker_tool_profile: brokerToolProfile,
        },
      },
      () =>
        buildTurnContext(session.id, input.playerId, {
          sceneSummary,
          dialogueHistoryLimit:
            dialogueHistoryLimitForBrokerProfile(brokerToolProfile),
          lang: playerLang,
          scope: brokerContextScope,
          excludeTurnId: turnId,
          turnId,
        }),
    );
    context.state[TURN_CONTEXT_STATE_KEY] = ctx;
  },
};

/** Same body the runner used to define inline. The broker tool
 *  profile picks how much dialogue history to fold into the context.
 *  Movement/trade profiles keep history minimal; commerce/quest/state
 *  profiles let the broker see one or two more turns; free text keeps
 *  the default of 5. */
function dialogueHistoryLimitForBrokerProfile(
  profile: BrokerToolProfile,
): number {
  if (profile === 'movement_social') return 1;
  if (profile === 'scene_trade') return 1;
  if (profile === 'quest_detail') return 2;
  if (profile === 'quest_seed') return 1;
  if (profile === 'commerce_bargain') return 2;
  if (profile === 'state_recap') return 2;
  if (profile === 'adventure_accept') return 2;
  if (profile === 'adventure_ignore') return 2;
  if (profile === 'intimacy_social') return 2;
  return 5;
}
