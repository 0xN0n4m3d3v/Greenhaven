/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 — preflight + pre-turn phase list.
//
// Order matters and matches the previous inline call sequence in
// `turnRunnerV2.runTurn` byte-for-byte:
//
//   1. `prompt_guard`            — wraps player text if a Spec 36 §6
//                                  injection pattern matches.
//   2. `quest_choice`            — routes `quest-choice:<id>:<stage>`
//                                  actionIds onto `accumulated_state`.
//   3. `decrement_conditions`    — Spec 17 condition decay.
//   4. `decrement_surfaces`      — Spec 33 environmental surface decay.
//   5. `tick_world_clock`        — Spec 32 world-clock tick.
//   6. `evaluate_active_quests`  — Spec 22 / USER-3 quest evaluator,
//                                  reads `session.lastTurnToolHistory`.
//
// Steps 2 and 6 are paired by design: routing the choice BEFORE
// evaluation lets the same turn pick up `pending_choice` and advance
// the quest along the chosen branch.

import type {Phase} from '../Phase.js';
import {adventureIntentPhase} from './AdventureIntentPhase.js';
import {contextBuildPhase} from './ContextBuildPhase.js';
import {decrementConditionsPhase} from './DecrementConditionsPhase.js';
import {decrementSurfacesPhase} from './DecrementSurfacesPhase.js';
import {dialogueAutoEngagePhase} from './DialogueAutoEngagePhase.js';
import {evaluateActiveQuestsPhase} from './EvaluateActiveQuestsPhase.js';
import {languagePhase} from './LanguagePhase.js';
import {locationVisitPhase} from './LocationVisitPhase.js';
import {playerMessagePersistencePhase} from './PlayerMessagePersistencePhase.js';
import {playerPromptPhase} from './PlayerPromptPhase.js';
import {promptGuardPhase} from './PromptGuardPhase.js';
import {questChoicePhase} from './QuestChoicePhase.js';
import {routeResolutionPhase} from './RouteResolutionPhase.js';
import {sceneSummaryPhase} from './SceneSummaryPhase.js';
import {scriptedActionPhase} from './ScriptedActionPhase.js';
import {tickWorldClockPhase} from './TickWorldClockPhase.js';
import {turnDispatchPhase} from './TurnDispatchPhase.js';
import {turnDispatchPreparationPhase} from './TurnDispatchPreparationPhase.js';

export const preTurnPhases: ReadonlyArray<Phase> = [
  promptGuardPhase,
  questChoicePhase,
  decrementConditionsPhase,
  decrementSurfacesPhase,
  tickWorldClockPhase,
  evaluateActiveQuestsPhase,
];

// USER-4 slice 2 — runs after `preTurnPhases` and BEFORE scripted
// action resolution / route classification.  `dialogueAutoEngagePhase`
// sets the dialogue partner from any @-mention; `adventureIntentPhase`
// writes `naturalAdventure` and `ignoredAdventure` results onto
// `TurnContext.state` for `runTurn` to consume when building the
// broker tool profile and adventure briefing strings.
export const preRoutePhases: ReadonlyArray<Phase> = [
  dialogueAutoEngagePhase,
  adventureIntentPhase,
];

// USER-4 slice 3 — scripted action resolution + route classification.
// Order matters: `scriptedActionPhase` runs first because
// `routeResolutionPhase` reads `scripted?.contextInjection` to decide
// whether to classify intent/mode at all. The route phase also reads
// the adventure intent results written by `preRoutePhases`, so the
// runner must invoke `preRoutePhases` strictly before this list.
export const routeResolutionPhases: ReadonlyArray<Phase> = [
  scriptedActionPhase,
  routeResolutionPhase,
];

// USER-4 slice 4 — turn-context + broker user-prompt preparation.
// Order is strict because later phases read earlier phases' state:
//   sceneSummary   → ContextBuildPhase reads it.
//   language       → ContextBuildPhase + PlayerPromptPhase read it.
//   location_visit → side-effect only (first-entry GUI event); no
//                    downstream readers, but ordered before
//                    context_build to match the previous inline
//                    sequence (location may influence world state
//                    the turn context reads through buildTurnContext).
//   context_build  → PlayerPromptPhase reads the bundle.
//   player_prompt  → writes the consolidated TurnPreparationResult
//                    that `runTurn` reads back.
export const turnContextPreparationPhases: ReadonlyArray<Phase> = [
  sceneSummaryPhase,
  languagePhase,
  locationVisitPhase,
  contextBuildPhase,
  playerPromptPhase,
];

// USER-4 slice 5 / USER-5 / USER-6 — `turn.start` SSE emit + player
// chat-message persistence + `message:created` SSE emit + auto-
// snapshot of the player's utterance into the active dialogue
// partner's memory bank. Runs immediately after
// `turnContextPreparationPhases` and reads `rawPlayerText` /
// `visiblePlayerText` / `playerRenderMeta` from
// `TurnPreparationResult`. The DB writes run inside
// `withTransaction(...)` and the state-changing SSE +
// `turn.player_message.persisted` telemetry fire via
// `onTransactionCommit(...)`, so a rollback cannot leak an
// uncommitted message_id over SSE — see
// `docs/backend/state-mutation-contract.md`.
export const playerMessagePersistencePhases: ReadonlyArray<Phase> = [
  playerMessagePersistencePhase,
];

// USER-4 slice 6 — broker/narrator dispatch preparation. Runs
// immediately after `playerMessagePersistencePhases` and BEFORE the
// scripted/narrator/broker dispatch branches still inline in
// `runTurn`. The SSE emits in this phase (`turn.tier`,
// `mode:changed`, `ambient:bed`) are turn-lifecycle / streaming
// markers, not DB state changes, and are annotated with explicit
// `SSE-OK: emit outside tx (reason: ...)` per
// `docs/backend/state-mutation-contract.md`.
export const turnDispatchPreparationPhases: ReadonlyArray<Phase> = [
  turnDispatchPreparationPhase,
];

// USER-4 slice 7 — scripted/narrator/broker dispatch. Runs LAST in
// the phase list. The phase reads everything it needs from prior
// phase state (route, scripted action, preparation, dispatch prep)
// and invokes exactly one stage. Provider resolution stays in
// `runTurn` so the early-fail path for a missing API key continues
// to abort the turn before persistence / SSE side effects fire.
export const turnDispatchPhases: ReadonlyArray<Phase> = [turnDispatchPhase];

export {
  adventureIntentPhase,
  contextBuildPhase,
  decrementConditionsPhase,
  decrementSurfacesPhase,
  dialogueAutoEngagePhase,
  evaluateActiveQuestsPhase,
  languagePhase,
  locationVisitPhase,
  playerMessagePersistencePhase,
  playerPromptPhase,
  promptGuardPhase,
  questChoicePhase,
  routeResolutionPhase,
  sceneSummaryPhase,
  scriptedActionPhase,
  tickWorldClockPhase,
  turnDispatchPhase,
  turnDispatchPreparationPhase,
};
export {
  ADVENTURE_INTENT_STATE_KEY,
  readIgnoredAdventureFromState,
  readNaturalAdventureFromState,
} from './AdventureIntentPhase.js';
export {
  SCRIPTED_ACTION_STATE_KEY,
  readScriptedActionFromState,
} from './ScriptedActionPhase.js';
export {
  ROUTE_RESOLUTION_STATE_KEY,
  readRouteResolutionFromState,
  type RouteResolutionResult,
} from './RouteResolutionPhase.js';
export {
  SCENE_SUMMARY_STATE_KEY,
  readSceneSummaryFromState,
} from './SceneSummaryPhase.js';
export {
  LANGUAGE_STATE_KEY,
  readEffectiveLangNameFromState,
  readPlayerLangFromState,
} from './LanguagePhase.js';
export {
  TURN_CONTEXT_STATE_KEY,
  readTurnContextBundleFromState,
  type TurnContextBundle,
} from './ContextBuildPhase.js';
export {
  TURN_PREPARATION_STATE_KEY,
  readTurnPreparationFromState,
  type TurnPreparationResult,
} from './PlayerPromptPhase.js';
export {
  PLAYER_MESSAGE_PERSISTENCE_STATE_KEY,
  readPlayerMessagePersistenceFromState,
  type PlayerMessagePersistenceResult,
} from './PlayerMessagePersistencePhase.js';
export {
  TURN_DISPATCH_PREPARATION_STATE_KEY,
  readTurnDispatchPreparationFromState,
  type TurnDispatchPreparationResult,
} from './TurnDispatchPreparationPhase.js';
export {
  TURN_DISPATCH_STATE_KEY,
  readTurnDispatchFromState,
  type TurnDispatchPath,
  type TurnDispatchResult,
} from './TurnDispatchPhase.js';
