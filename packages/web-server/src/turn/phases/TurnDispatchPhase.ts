/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — scripted/narrator/broker dispatch.
//
// Mirrors the previous inline `runTurn` dispatch block byte-for-byte:
//
//   * `scripted?.contextInjection` → `runScriptedNarratorStage`.
//   * tier `T1`/`T2`/`T3` → `runNarratorOnlyStage` (with tier).
//   * otherwise (`T4`) → `runBrokerStage` with mode, player
//     language, broker profile, prompt budget breakdown, recovery
//     directive, fail-open text, and the static preBroker hook
//     stack.
//
// The phase reads existing typed state from
// `readScriptedActionFromState`, `readRouteResolutionFromState`,
// `readTurnPreparationFromState`, and
// `readTurnDispatchPreparationFromState`. It does NOT recompute
// scene summary, route, or prompt setup. Provider resolution happens
// in `runTurn` (before any phases) so the early-fail path for a
// missing API key is preserved; the phase calls
// `session.ensureProviders()` again, which returns the same cached
// instance.
//
// The pre-broker hook stack now lives in the ARCH-5
// `SpecialistRegistry` (`packages/web-server/src/specialists/`). This
// phase imports `specialists/index.js` for the registration side
// effect and reads the ordered hook list through `listPreBrokerHooks()`
// instead of declaring a local hardcoded array. Order of broker
// briefings (combat → intimacy → reward) is preserved by registration
// order in `specialists/index.ts`.

import type {Mode} from '../../ai/classifier.js';
import type {Tier} from '../../ai/classifier.js';
import {listPreBrokerHooks} from '../../specialists/index.js';
import type {BrokerToolProfile} from '../../ai/toolsets.js';
import {
  brokerEmptyFailOpenText,
  brokerEmptyRecoveryDirective,
} from '../brokerEmptyText.js';
import {runBrokerStage} from '../../turnBrokerStage.js';
import {
  runNarratorOnlyStage,
  runScriptedNarratorStage,
} from '../../turnNarrationStage.js';
import {reconcileDialogueFocusForTurn} from '../dialogueFocus.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';
import {readRouteResolutionFromState} from './RouteResolutionPhase.js';
import {readScriptedActionFromState} from './ScriptedActionPhase.js';
import {readTurnDispatchPreparationFromState} from './TurnDispatchPreparationPhase.js';
import {readTurnPreparationFromState} from './PlayerPromptPhase.js';

export type TurnDispatchPath =
  | 'scripted_narrator'
  | 'narrator_only'
  | 'broker';

export interface TurnDispatchResult {
  path: TurnDispatchPath;
  tier: Tier;
  mode: Mode;
  brokerToolProfile: BrokerToolProfile;
}

export const TURN_DISPATCH_STATE_KEY = 'turnDispatch' as const;

export function readTurnDispatchFromState(
  context: TurnContext,
): TurnDispatchResult {
  const raw = context.state[TURN_DISPATCH_STATE_KEY];
  if (raw == null) {
    throw new Error(
      'turnDispatchPhase did not run before readTurnDispatchFromState',
    );
  }
  return raw as TurnDispatchResult;
}

export const turnDispatchPhase: Phase = {
  name: 'turn_dispatch',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId, signal} = context;
    const scripted = readScriptedActionFromState(context);
    const route = readRouteResolutionFromState(context);
    const prep = readTurnPreparationFromState(context);
    const dispatchPrep = readTurnDispatchPreparationFromState(context);
    const providers = session.ensureProviders();
    const stageArgs: StageArgs = {
      session,
      playerId: input.playerId,
      turnId,
      signal,
      providers,
      route,
      prep,
      dispatchPrep,
      rawPlayerText: input.text,
    };

    // T0 — scripted, narrator only.
    if (scripted?.contextInjection) {
      await dispatchScripted(stageArgs);
      await releaseDialogueAfterFarewell(stageArgs);
      writeDispatchResult(context, 'scripted_narrator', route);
      return;
    }

    // T1 / T2 / T3 — narrator-only path. Bypasses the broker because
    // the classifier judged this is ambient narrative (no mutations
    // expected). Saves a whole broker round-trip + tool-loop. Spec 44
    // — T2 ambient turns route to Scene Painter (deepseek-chat +
    // location-voice addendum) instead of Magnum; failures fall back
    // to Magnum so the player never sees a broken turn.
    if (route.tier === 'T1' || route.tier === 'T2' || route.tier === 'T3') {
      await dispatchNarratorOnly(stageArgs, route.tier);
      await releaseDialogueAfterFarewell(stageArgs);
      writeDispatchResult(context, 'narrator_only', route);
      return;
    }

    // T4 — free-text path: broker stage owns tool loop, retry,
    // handoff, and synth fallback.
    await dispatchBroker(stageArgs);
    await releaseDialogueAfterFarewell(stageArgs);
    writeDispatchResult(context, 'broker', route);
  },
};

interface StageArgs {
  session: TurnContext['session'];
  playerId: number;
  turnId: string;
  signal: AbortSignal;
  providers: ReturnType<TurnContext['session']['ensureProviders']>;
  route: ReturnType<typeof readRouteResolutionFromState>;
  prep: ReturnType<typeof readTurnPreparationFromState>;
  dispatchPrep: ReturnType<typeof readTurnDispatchPreparationFromState>;
  rawPlayerText: string;
}

async function dispatchScripted(args: StageArgs): Promise<void> {
  await runScriptedNarratorStage({
    session: args.session,
    playerId: args.playerId,
    turnId: args.turnId,
    userText: args.prep.userText,
    providers: args.providers,
    narratorSystemPrompt: args.dispatchPrep.narratorSystemPrompt,
    narrateDef: args.dispatchPrep.narrateDef,
    signal: args.signal,
  });
}

async function dispatchNarratorOnly(
  args: StageArgs,
  tier: 'T1' | 'T2' | 'T3',
): Promise<void> {
  await runNarratorOnlyStage({
    session: args.session,
    playerId: args.playerId,
    turnId: args.turnId,
    userText: args.prep.userText,
    providers: args.providers,
    narratorSystemPrompt: args.dispatchPrep.narratorSystemPrompt,
    narrateDef: args.dispatchPrep.narrateDef,
    signal: args.signal,
    tier,
  });
}

async function dispatchBroker(args: StageArgs): Promise<void> {
  const {playerLang, userText, promptBudgetBreakdown} = args.prep;
  await runBrokerStage({
    session: args.session,
    playerId: args.playerId,
    turnId: args.turnId,
    rawPlayerText: args.rawPlayerText,
    userText,
    mode: args.route.mode,
    playerLang,
    providers: args.providers,
    brokerSystemPrompt: args.dispatchPrep.brokerSystemPrompt,
    brokerTools: args.dispatchPrep.brokerTools,
    brokerToolProfile: args.route.brokerToolProfile,
    narratorSystemPrompt: args.dispatchPrep.narratorSystemPrompt,
    narrateDef: args.dispatchPrep.narrateDef,
    signal: args.signal,
    preBrokerHooks: listPreBrokerHooks(),
    recoveryDirective: brokerEmptyRecoveryDirective(playerLang),
    failOpenText: brokerEmptyFailOpenText(playerLang),
    promptBudgetBreakdown,
  });
}

async function releaseDialogueAfterFarewell(args: StageArgs): Promise<void> {
  if (args.route.dialogueAct !== 'farewell') return;
  await reconcileDialogueFocusForTurn(
    args.playerId,
    args.route.mode,
    args.route.dialogueAct,
    {
      session: args.session,
      turnId: args.turnId,
    },
  );
}

function writeDispatchResult(
  context: TurnContext,
  path: TurnDispatchPath,
  route: ReturnType<typeof readRouteResolutionFromState>,
): void {
  context.state[TURN_DISPATCH_STATE_KEY] = {
    path,
    tier: route.tier,
    mode: route.mode,
    brokerToolProfile: route.brokerToolProfile,
  };
}
