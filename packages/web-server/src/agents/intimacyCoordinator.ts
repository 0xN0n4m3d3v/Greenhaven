/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 41 - Intimacy Coordinator.
//
// Blocking pre-broker specialist. Fires when classifyMode returns
// 'intimacy'. The hook now only wires state loading, specialist execution,
// grounding, and broker briefing formatting; the domain submodules own those
// concerns directly.

import {
  runSpecialist,
  type PreBrokerHook,
  type SpecialistDef,
} from './base.js';
import {
  formatBrokerBriefing,
  groundCoordinatorBriefing,
} from './intimacyCoordinatorBriefing.js';
import {intimacyCoordinatorPrompt} from './intimacyCoordinatorPrompt.js';
import {normalizeCoordinatorBrief} from './intimacyCoordinatorPolicy.js';
import {loadCoordinatorInput} from './intimacyCoordinatorState.js';
import {
  CoordinatorOutput,
  type CoordinatorBrief,
  type CoordinatorInput,
  type CoordinatorModelBrief,
} from './intimacyCoordinatorTypes.js';

export type {CoordinatorBrief, CoordinatorInput, CoordinatorModelBrief};
export {formatBrokerBriefing, groundCoordinatorBriefing};

const def: SpecialistDef<CoordinatorInput, CoordinatorModelBrief> = {
  name: 'intimacy_coordinator',
  mode: 'blocking',
  buildPrompt(input) {
    return {
      system: intimacyCoordinatorPrompt.buildSystem(input),
      user: intimacyCoordinatorPrompt.buildUser(input),
    };
  },
  outputSchema: CoordinatorOutput,
  timeoutMs: 7000,
  // Beat-phase detection benefits from slight stochasticity, but memory
  // composition wants steady voice. 0.3 is the same default as base.ts;
  // explicit here for clarity.
  temperature: 0.3,
};

export const intimacyCoordinatorHook: PreBrokerHook = {
  name: 'intimacy_coordinator',
  async run(ctx, turnInput) {
    if (turnInput.mode !== 'intimacy') return null;

    const input = await loadCoordinatorInput({
      playerId: ctx.playerId,
      sessionId: ctx.sessionId,
      playerProse: turnInput.text,
      language: ctx.language ?? null,
    });
    if (!input) return null;

    const brief = await runSpecialist(def, input, ctx);
    if (!brief) return null;

    return formatBrokerBriefing(
      groundCoordinatorBriefing(normalizeCoordinatorBrief(brief, input)),
    );
  },
};
