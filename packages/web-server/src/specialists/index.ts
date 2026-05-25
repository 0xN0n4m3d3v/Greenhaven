/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-5 — specialist registration (side-effect import).
//
// Importing this module registers every pre-broker, post-turn,
// debug-smoke, and pre-tool validator specialist into the singleton
// in `./registry.js`. Runtime consumers (`turn/phases/TurnDispatchPhase.ts`,
// `postTurnPipeline.ts`, `tools/index.ts`, `DebugService`) import this
// file for its side effect, then call the phase-specific listing helper
// (`listPreBrokerHooks()` / `listPostTurnHooks()` /
// `listDebugSmokeSpecialists()` / `listPreToolValidatorSpecialists()`)
// to obtain the ordered descriptors.
//
// Pre-broker order (broker briefings applied to broker user message):
//   1. combat_director       (spec 40)
//   2. intimacy_coordinator  (spec 41)
//   3. reward_calibrator     (spec 47)
//
// Post-turn order (post-turn pipeline runs after `turn.end`):
//   1. quest_watcher              (spec 39)
//   2. memory_loop_watcher        (spec 137)
//   3. catalogue_scout            (spec 42)
//   4. npc_voice                  (spec 43)
//   5. dialogue_anchor            (spec 45)
//   6. rolling_dialogue_summary   (memory tier C — per-NPC rolling thread summary)
//   7. narrative_claim_sweeper    (autonomic drift correction — see state-canonization.md)
//   8. movement_warden            (spec 46)
//   9. quest_pacer                (spec 49)
//  10. adventure_oracle           (spec 89)
//  11. adventure_materializer     (spec 90)
//  12. companion_depart_engine    (spec 53)
//
// Each pre-broker hook is still individually responsible for its
// `mode !== '<flavor>'` early-return; each post-turn hook still owns
// its own fail-open behavior + `shouldSkipPostTurnHookForSnapshot`
// is still applied by `postTurnPipeline`. The registry only records
// the narrative `appliesTo` tag for observability.

import {combatDirectorHook} from '../agents/combatDirector.js';
import {intimacyCoordinatorHook} from '../agents/intimacyCoordinator.js';
import {rewardCalibratorHook} from '../agents/rewardCalibrator.js';
import {adventureOracleHook} from '../domain/adventure/index.js';
import {adventureMaterializerHook} from '../domain/adventure/materializer/index.js';
import {catalogueScoutHook} from '../agents/catalogueScout.js';
import {companionDepartEngineHook} from '../agents/companionDepartEngine.js';
import {dialogueAnchorHook} from '../agents/dialogueAnchor.js';
import {memoryLoopWatcherHook} from '../domain/memory/index.js';
import {movementWardenHook} from '../agents/movementWarden.js';
import {narrativeClaimSweeperHook} from '../agents/narrativeClaimSweeper.js';
import {npcVoiceHook} from '../agents/npcVoice.js';
import {questPacerHook} from '../agents/questPacer.js';
import {questWatcherHook} from '../agents/questWatcher.js';
import {rollingDialogueSummaryHook} from '../agents/rollingDialogueSummary.js';
import {registerSpecialist} from './registry.js';
// Side-effect import — `./debugSmoke.ts` registers the 11 entries
// for `/api/debug/verify-specialists` into the singleton registry.
import './debugSmoke.js';
// Side-effect import — each pre-tool validator agent module calls
// `registerPreToolValidatorSpecialist` at load time. Order here is
// the order `listPreToolValidatorSpecialists()` returns them, which
// is also the order `tools/index.ts` uses to wire validators into
// the dispatch layer:
//   1. cartridge_steward.create_entity, cartridge_steward.create_quest
//   2. movement_warden.narrate
//   3. environment_state.narrate, environment_state.apply_runtime_field_patch
//   4. voice_warden.narrate
//   5. finalization_guards.<MUTATION_TOOLS> (insertion order preserved)
import '../agents/cartridgeSteward.js';
import '../agents/movementWardenPreTool.js';
import '../agents/environmentStatePreTool.js';
import '../agents/voiceWardenPreTool.js';
import '../agents/finalizationGuards.js';

registerSpecialist({
  spec: 'combat_director',
  phase: 'preBroker',
  appliesTo: 'combat',
  hook: combatDirectorHook,
});

registerSpecialist({
  spec: 'intimacy_coordinator',
  phase: 'preBroker',
  appliesTo: 'intimacy',
  hook: intimacyCoordinatorHook,
});

registerSpecialist({
  spec: 'reward_calibrator',
  phase: 'preBroker',
  appliesTo: 'any',
  hook: rewardCalibratorHook,
});

// Post-turn registrations — order must match the previous
// `postTurnPhase` array in `postTurnPipeline.ts`.
registerSpecialist({
  spec: 'quest_watcher',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: questWatcherHook,
});

registerSpecialist({
  spec: 'memory_loop_watcher',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: memoryLoopWatcherHook,
});

registerSpecialist({
  spec: 'catalogue_scout',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: catalogueScoutHook,
});

registerSpecialist({
  spec: 'npc_voice',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: npcVoiceHook,
});

registerSpecialist({
  spec: 'dialogue_anchor',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: dialogueAnchorHook,
});

registerSpecialist({
  spec: 'rolling_dialogue_summary',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: rollingDialogueSummaryHook,
});

registerSpecialist({
  spec: 'narrative_claim_sweeper',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: narrativeClaimSweeperHook,
});

registerSpecialist({
  spec: 'movement_warden',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: movementWardenHook,
});

registerSpecialist({
  spec: 'quest_pacer',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: questPacerHook,
});

registerSpecialist({
  spec: 'adventure_oracle',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: adventureOracleHook,
});

registerSpecialist({
  spec: 'adventure_materializer',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: adventureMaterializerHook,
});

registerSpecialist({
  spec: 'companion_depart_engine',
  phase: 'postTurn',
  appliesTo: 'always',
  hook: companionDepartEngineHook,
});

export {
  listDebugSmokeSpecialists,
  listPostTurnHooks,
  listPostTurnSpecialists,
  listPreBrokerHooks,
  listPreBrokerSpecialists,
  listPreToolValidatorSpecialists,
  registerDebugSmokeSpecialist,
  registerPreToolValidatorSpecialist,
  registerSpecialist,
  resetSpecialistRegistry,
} from './registry.js';
export type {
  DebugSmokeSpecialistDescriptor,
  DebugSmokeVerifyCheck,
  PostTurnAppliesTo,
  PostTurnSpecialistDescriptor,
  PreBrokerAppliesTo,
  PreBrokerSpecialistDescriptor,
  PreToolValidatorDescriptor,
  SpecialistDescriptor,
  SpecialistPhase,
} from './registry.js';
