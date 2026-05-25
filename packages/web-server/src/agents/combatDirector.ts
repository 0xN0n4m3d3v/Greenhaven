/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 40 §5.1 — Combat Director.
//
// Blocking pre-broker specialist. It prepares a grounded combat plan and
// injects a compact briefing that the broker must execute verbatim.

import {
  runSpecialist,
  type PreBrokerHook,
  type SpecialistDef,
} from './base.js';
import {formatBrokerBriefing} from './combatDirectorBriefing.js';
import {buildCombatDirectorInput} from './combatDirectorContext.js';
import {
  groundCombatBriefing,
  recordCombatSourceGrounding,
} from './combatDirectorGrounding.js';
import {combatDirectorPrompt} from './combatDirectorPrompt.js';
import {
  DirectorOutput,
  type DirectorBrief,
  type DirectorInput,
} from './combatDirectorTypes.js';

export {groundCombatBriefing} from './combatDirectorGrounding.js';

const def: SpecialistDef<DirectorInput, DirectorBrief> = {
  name: 'combat_director',
  mode: 'blocking',
  buildPrompt(input) {
    return {
      system: combatDirectorPrompt.buildSystem(input),
      user: combatDirectorPrompt.buildUser(input),
    };
  },
  outputSchema: DirectorOutput,
  timeoutMs: 7000,
  temperature: 0.2,
};

export const combatDirectorHook: PreBrokerHook = {
  name: 'combat_director',
  async run(ctx, turnInput) {
    if (turnInput.mode !== 'combat') return null;

    const directorInput = await buildCombatDirectorInput({
      playerId: ctx.playerId,
      sessionId: ctx.sessionId,
      text: turnInput.text,
      language: ctx.language,
    });
    if (!directorInput) return null;

    const brief = await runSpecialist(def, directorInput, ctx);
    if (!brief) return null;

    const groundedBrief = groundCombatBriefing(brief, directorInput);
    await recordCombatSourceGrounding(ctx, brief, groundedBrief);
    return formatBrokerBriefing(groundedBrief);
  },
};
