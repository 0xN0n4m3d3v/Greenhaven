/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — broker/narrator dispatch preparation.
//
// Mirrors the previous inline `runTurn` setup block byte-for-byte:
//
//   1. Resolve the registered tool catalog, the narrator tool set,
//      and the `narrate` definition. A missing `narrate` is a hard
//      failure (the dispatch branches all require it).
//   2. Load the narrator system prompt and, gated on the active
//      mode + broker tool profile, the broker system prompt.
//   3. Compute the broker tool subset for the active mode + profile.
//   4. Emit the `turn.tier` SSE event.
//   5. On a mode transition (compared against
//      `session.turnModeState.lastMode`):
//        * Update the session's explicit `turnModeState` to the new mode.
//        * Emit `mode:changed` over the GUI event bus.
//        * If entering `combat`, invoke `emitCombatInitiativeSet`
//          (non-fatal on failure).
//        * If leaving `combat`, call `clearCombatTheatre`.
//        * Emit `ambient:bed` via `selectAmbientBed` +
//          `emitAmbientChange` (non-fatal on failure).
//   6. If the active mode is `intimacy`, append cartridge-sourced
//      intimacy rules onto the broker system prompt (non-fatal on
//      failure).
//
// The phase reads the route from `readRouteResolutionFromState` and
// the `TurnPreparationResult` (only `playerLang` indirectly via the
// route). It writes a single typed `TurnDispatchPreparationResult`
// (`narratorSystemPrompt`, `narrateDef`, `brokerSystemPrompt`,
// `brokerTools`) under `TURN_DISPATCH_PREPARATION_STATE_KEY` so
// `runTurn` can hand the values to scripted/narrator/broker
// dispatch unchanged.
//
// This pass is extraction only — narrator/broker dispatch branches
// stay inline in `runTurn`. The SSE emits in this phase
// (`turn.tier`, `mode:changed`, `ambient:bed`) are lifecycle /
// streaming markers, not DB state changes, and are annotated with
// `SSE-OK: emit outside tx (reason: ...)` per
// `docs/backend/state-mutation-contract.md`.

import {emitAmbientChange, selectAmbientBed} from '../../ambientBus.js';
import {loadBrokerPromptForMode, loadNarratorPrompt} from '../../ai/prompts.js';
import {
  toolsForBrokerMode,
  toolsForRole,
} from '../../ai/toolsets.js';
import {
  clearCombatTheatre,
  emitCombatInitiativeSet,
} from '../../combatTheatre.js';
import {query} from '../../db.js';
import {emitGuiEvent} from '../../guiEventOutbox.js';
import {classifyModeSignal} from '../../modeSignals.js';
import {buildIntimacyRules} from '../../scriptedActions/intimacyActions.js';
import {
  getRegisteredTools,
  type ToolDefinition,
} from '../../tools/base.js';
import {
  getSessionModeState,
  playerHasAnyCompanion,
  setSessionMode,
} from '../dispatchPrep.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';
import {readRouteResolutionFromState} from './RouteResolutionPhase.js';

export interface TurnDispatchPreparationResult {
  narratorSystemPrompt: string;
  narrateDef: ToolDefinition;
  brokerSystemPrompt: string;
  brokerTools: Map<string, ToolDefinition>;
}

export const TURN_DISPATCH_PREPARATION_STATE_KEY =
  'turnDispatchPreparation' as const;

export function readTurnDispatchPreparationFromState(
  context: TurnContext,
): TurnDispatchPreparationResult {
  const raw = context.state[TURN_DISPATCH_PREPARATION_STATE_KEY];
  if (raw == null) {
    throw new Error(
      'turnDispatchPreparationPhase did not run before ' +
        'readTurnDispatchPreparationFromState',
    );
  }
  return raw as TurnDispatchPreparationResult;
}

export const turnDispatchPreparationPhase: Phase = {
  name: 'turn_dispatch_preparation',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId} = context;
    const {tier, mode, brokerToolProfile} =
      readRouteResolutionFromState(context);

    const allTools = getRegisteredTools();
    const narratorTools = toolsForRole(allTools, 'narrator');
    const narrateDef = narratorTools.get('narrate');
    if (!narrateDef) throw new Error('narrate tool not registered');
    const narratorSystemPrompt = loadNarratorPrompt();

    // Prompt and tool scope follow the already chosen route. The
    // runner does not invent gameplay policy here; it only hands
    // each path its own contract. companions.md is loaded only when
    // at least one companion is active, so a player without a party
    // doesn't pay the token cost of party-lifecycle rules.
    const hasCompanion = await playerHasAnyCompanion(input.playerId);
    let brokerSystemPrompt = loadBrokerPromptForMode(mode, brokerToolProfile, {
      hasCompanion,
    });
    const brokerTools = toolsForBrokerMode(allTools, mode, brokerToolProfile);
    // SSE-OK: emit outside tx (reason: turn-lifecycle marker
    // — tells UI which provider tier is about to stream, not a
    // DB state-change).
    session.sse.emit('turn.tier', {turnId, tier});

    // Emit mode:changed only on transition (avoid noisy banner spam).
    const lastMode = getSessionModeState(session).lastMode;
    if (mode !== lastMode) {
      await applyModeTransition({
        session,
        playerId: input.playerId,
        turnId,
        text: input.text,
        actionId: input.actionId,
        mode,
        lastMode: lastMode ?? null,
      });
    }

    // Spec 35 section 2 — intimacy mode injects mandatory
    // mechanical-persistence rules into the broker system prompt.
    if (mode === 'intimacy') {
      brokerSystemPrompt = await maybeAppendIntimacyRules(
        input.playerId,
        brokerSystemPrompt,
      );
    }

    context.state[TURN_DISPATCH_PREPARATION_STATE_KEY] = {
      narratorSystemPrompt,
      narrateDef,
      brokerSystemPrompt,
      brokerTools,
    };
  },
};

interface ModeTransitionArgs {
  session: TurnContext['session'];
  playerId: number;
  turnId: string;
  text: string;
  actionId: string | undefined;
  mode: ReturnType<typeof readRouteResolutionFromState>['mode'];
  lastMode: ReturnType<typeof readRouteResolutionFromState>['mode'] | null;
}

async function applyModeTransition(args: ModeTransitionArgs): Promise<void> {
  const {session, playerId, turnId, text, actionId, mode, lastMode} = args;
  setSessionMode(session, mode);
  const modeSignal = classifyModeSignal({
    from: lastMode,
    to: mode,
    text,
    actionId,
  });
  await emitGuiEvent(
    {sessionId: session.id, playerId, turnId},
    'mode:changed',
    {
      mode,
      prev: lastMode,
      from_mode: lastMode,
      to_mode: mode,
      cue: modeSignal.cue,
      reason: modeSignal.reason,
      turnId,
    },
    {lane: 'pre_response', phase: 'pre_turn'},
  );
  if (mode === 'combat') {
    try {
      await emitCombatInitiativeSet({session, playerId, turnId});
    } catch (err) {
      // CATCH-WARN-OK: combat-initiative SSE is a visual seed-up; the broker turn proceeds with the persisted combat_state and `emitCombatInitiativeSet`'s internal SSE bridge already records its own emit failures via the SseBridge drop telemetry (S-4).
      console.warn(
        '[turnV2] combat:initiative_set emit failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  } else if (lastMode === 'combat') {
    clearCombatTheatre(session);
  }

  // Spec 36 section A.1 — emit ambient:bed slug on every mode
  // transition so the client useAmbientBed hook can cross-fade
  // Howler stems. We don't yet have sceneTags lookup at this
  // layer; combat/intimacy modes already win the selector
  // regardless.
  try {
    const slug = selectAmbientBed([], mode);
    emitAmbientChange(session.id, slug);
  } catch (err) {
    // CATCH-WARN-OK: ambient-bed SSE is a non-canonical audio crossfade hint; broker output is unaffected and the underlying `emitAmbientChange` records its own SseBridge drop telemetry on failure (S-4).
    console.warn('[turnV2] ambient:bed emit failed (non-fatal):', err);
  }
}

async function maybeAppendIntimacyRules(
  playerId: number,
  baseSystemPrompt: string,
): Promise<string> {
  // Cartridge-sourced rules from `scripted_intimacy_rules` drive
  // the injection. Without this, intimate prose writes but
  // trauma/strings/runtime-fields don't persist.
  try {
    const partnerRow = await query<{value: unknown}>(
      `SELECT rv.value FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = 'active_dialogue_partner_id'`,
      [playerId],
    );
    const partnerId = readPartnerId(partnerRow.rows[0]?.value);
    const rules = await buildIntimacyRules({playerId, partnerId});
    return rules ? baseSystemPrompt + '\n\n' + rules : baseSystemPrompt;
  } catch (err) {
    // CATCH-WARN-OK: intimacy-rules injection is a prompt enrichment; broker proceeds with the unenriched system prompt and `buildIntimacyRules` errors are recorded through the intimacy.coordinator telemetry channel on the way in.
    console.warn(
      '[turnV2] intimacy rules injection failed:',
      err instanceof Error ? err.message : err,
    );
    return baseSystemPrompt;
  }
}

function readPartnerId(value: unknown): number | null {
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
