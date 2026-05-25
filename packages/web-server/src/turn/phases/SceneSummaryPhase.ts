/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — scene summary fold-in (Spec 14).
//
// Older-than-5 chat turns collapse into a 3-5 bullet block we cache
// per (session, scene). Scripted and trivial narrator paths
// (`brokerContextScope === 'scripted'` or `tier === 'T1'`) do not
// need to pay this cost, so the phase short-circuits to `null` for
// those routes. Failures are non-fatal — the prior inline code
// logged + returned `null`, and that behavior is preserved.
//
// Output is written to `TurnContext.state` under
// `SCENE_SUMMARY_STATE_KEY` for `ContextBuildPhase` to read.

import {getOrBuildSceneSummary} from '../../ai/historyCompressor.js';
import {measure} from '../../telemetry/index.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';
import {readRouteResolutionFromState} from './RouteResolutionPhase.js';

export const SCENE_SUMMARY_STATE_KEY = 'sceneSummary' as const;

export function readSceneSummaryFromState(
  context: TurnContext,
): string | null {
  const raw = context.state[SCENE_SUMMARY_STATE_KEY];
  return (raw as string | null | undefined) ?? null;
}

export const sceneSummaryPhase: Phase = {
  name: 'scene_summary',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId, signal} = context;
    const {tier, contextScope, brokerContextScope, brokerToolProfile} =
      readRouteResolutionFromState(context);
    if (brokerContextScope === 'scripted' || tier === 'T1') {
      context.state[SCENE_SUMMARY_STATE_KEY] = null;
      return;
    }
    let sceneSummary: string | null = null;
    try {
      sceneSummary = await measure(
        {
          sessionId: session.id,
          playerId: input.playerId,
          turnId,
          kind: 'agent',
          phase: 'agent.scene_summary',
          metadata: {
            route_scope: contextScope,
            scope: brokerContextScope,
            broker_tool_profile: brokerToolProfile,
          },
        },
        () =>
          getOrBuildSceneSummary({
            providers: session.ensureProviders(),
            sessionId: session.id,
            playerId: input.playerId,
            signal,
          }),
      );
    } catch (err) {
      // CATCH-WARN-OK: scene summary is a best-effort prompt-context enrichment; broker proceeds with the previous summary, and the underlying summariser invocation already emits its own `agent:scene_painter` telemetry on failure.
      console.warn('[turnV2] scene summariser failed (non-fatal):', err);
    }
    context.state[SCENE_SUMMARY_STATE_KEY] = sceneSummary;
  },
};
