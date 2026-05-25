/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  classifyIntent,
  classifyTurnRoute,
  type DialogueAct,
  type Mode,
  type ProfileHint,
  type Tier,
} from './ai/classifier.js';
import type {RunnerProviders} from './ai/providers.js';
import {query} from './db.js';
import {measure} from './telemetry/index.js';
import type {TurnContextScope} from './turnContext/index.js';

export interface ResolveTurnRouteInput {
  providers: RunnerProviders;
  sessionId: string;
  playerId: number;
  turnId: string;
  text: string;
  actionId?: string;
  signal: AbortSignal;
  scriptedContextInjection: boolean;
}

export interface TurnRouteDecision {
  tier: Tier;
  mode: Mode;
  contextScope: TurnContextScope;
  /** Focused broker tool profile hint emitted by the classifier — drives
   *  `brokerToolProfileForTurn` without any per-language text inspection. */
  profileHint: ProfileHint;
  /** Whether the player's text is a dialogue farewell, a transactional
   *  action, or neither — drives `reconcileDialogueFocusForTurn` so the
   *  focus release no longer reads raw text. */
  dialogueAct: DialogueAct;
}

export async function resolveTurnRoute(
  input: ResolveTurnRouteInput,
): Promise<TurnRouteDecision> {
  let tier: Tier = input.scriptedContextInjection ? 'T0' : 'T4';
  let mode: Mode = 'exploration';
  let profileHint: ProfileHint = 'default';
  let dialogueAct: DialogueAct = 'none';

  if (!input.scriptedContextInjection) {
    const lastNpcLine = await loadLastNpcLineForClassifier(input.sessionId);
    const [tierResult, routeResult] = await Promise.allSettled([
      measure(
        {
          sessionId: input.sessionId,
          playerId: input.playerId,
          turnId: input.turnId,
          kind: 'llm',
          phase: 'llm.classify_intent',
          metadata: {model_id: input.providers.brokerModelId},
        },
        () =>
          classifyIntent({
            providers: input.providers,
            userText: input.text,
            signal: input.signal,
          }),
      ),
      measure(
        {
          sessionId: input.sessionId,
          playerId: input.playerId,
          turnId: input.turnId,
          kind: 'llm',
          phase: 'llm.classify_mode',
          metadata: {model_id: input.providers.brokerModelId},
        },
        () =>
          classifyTurnRoute({
            providers: input.providers,
            userText: input.text,
            signal: input.signal,
            lastNpcLine,
          }),
      ),
    ]);

    if (tierResult.status === 'fulfilled') {
      tier = tierResult.value;
    } else {
      console.warn(
        '[turnRouting] intent classifier failed, defaulting to T4:',
        tierResult.reason,
      );
      tier = 'T4';
    }

    if (routeResult.status === 'fulfilled') {
      mode = routeResult.value.mode;
      profileHint = routeResult.value.profile;
      dialogueAct = routeResult.value.dialogueAct;
    } else {
      console.warn(
        '[turnRouting] mode classifier failed, defaulting to exploration:',
        routeResult.reason,
      );
    }

    // Language-neutral overrides only. @-mention is a UI-explicit signal
    // (the player tapped or typed an entity reference), not a language
    // heuristic. The previous combat/intimacy/travel/rest keyword regex
    // overrides were en+ru only and silently broke routing for every
    // other player language — they have been removed; `classifyTurnRoute`
    // is multilingual and already runs above. The low-signal-text fallback
    // (e.g. "ok", "...") stays because it is a character-count heuristic,
    // not language-specific.
    const explicitLocationAction = isEntityActionId(input.actionId, [
      'location',
      'scene',
      'travel',
    ]);
    const explicitNpcAction = isEntityActionId(input.actionId, ['npc']);
    if (explicitLocationAction && mode !== 'travel') {
      console.log(`[turnRouting] location action override ${mode} -> travel`);
      mode = 'travel';
    } else if (
      (explicitNpcAction || DIRECT_NPC_ADDRESS_RE.test(input.text)) &&
      mode !== 'dialogue'
    ) {
      console.log(
        `[turnRouting] dialogue action override ${mode} -> dialogue`,
      );
      mode = 'dialogue';
    }

    mode = await normaliseLowSignalMode(mode, input.text, input.playerId);
    if (tier !== 'T4' && modeRequiresBroker(mode)) {
      console.log(
        `[turnRouting] mode=${mode} requires broker tools; escalating tier ${tier} -> T4`,
      );
      tier = 'T4';
    }
  }

  console.log(
    `[turnV2 ${input.turnId}] routing tier=${tier} mode=${mode} profile=${profileHint} act=${dialogueAct} action=${input.actionId ?? 'free_text'}`,
  );

  return {
    tier,
    mode,
    contextScope: contextScopeForTurn(tier, mode),
    profileHint,
    dialogueAct,
  };
}

export function contextScopeForTurn(tier: Tier, mode: Mode): TurnContextScope {
  if (tier === 'T0') return 'scripted';
  if (tier !== 'T4') return 'narration';
  return mode;
}

export function modeRequiresBroker(mode: Mode): boolean {
  return (
    mode === 'combat' ||
    mode === 'intimacy' ||
    mode === 'dialogue' ||
    mode === 'travel'
  );
}

async function normaliseLowSignalMode(
  mode: Mode,
  text: string,
  playerId: number,
): Promise<Mode> {
  if (mode !== 'combat' || !isLowSignalPlayerText(text)) return mode;
  const fallback = (await hasActiveDialoguePartner(playerId))
    ? 'dialogue'
    : 'exploration';
  console.log(
    `[turnRouting] low-signal combat classification downgraded to ${fallback}`,
  );
  return fallback;
}

// Low-signal-text fallback: the player typed only a few characters (e.g.
// "ok", "...", a single emoji). The classifier sometimes drifts to combat
// on this kind of input. Pure character-count heuristic; no per-language
// keyword list.
function isLowSignalPlayerText(text: string): boolean {
  if (text.includes('@')) return false;
  const lettersOrNumbers = [...text.trim()].filter(ch => /[\p{L}\p{N}]/u.test(ch));
  if (lettersOrNumbers.length === 0) return true;
  if (lettersOrNumbers.length > 4) return false;
  return new Set(lettersOrNumbers.map(ch => ch.toLocaleLowerCase())).size <= 2;
}

// @-mention detection is language-neutral: the UI emits this tag verbatim
// when the player taps an entity bubble or types `@Name`. Used to route
// to dialogue mode regardless of the surrounding prose's language.
const DIRECT_NPC_ADDRESS_RE = /@\S/u;

function isEntityActionId(
  actionId: string | undefined,
  prefixes: readonly string[],
): boolean {
  if (!actionId) return false;
  return prefixes.some((prefix) => actionId.startsWith(`${prefix}:`));
}

/**
 * Pull the most recent NPC narrate text for the session to feed into
 * classifyMode as context. Lets the classifier resolve short or
 * referential replies ("yes", "веди меня", "ok let's do it") into the
 * mode of the offer the NPC just made. Returns null when there is no
 * recent NPC bubble.
 */
async function loadLastNpcLineForClassifier(
  sessionId: string,
): Promise<string | null> {
  try {
    const res = await query<{text: string}>(
      `SELECT text
         FROM chat_messages
        WHERE session_id = $1
          AND tone IN ('npc', 'narrator')
        ORDER BY turn_index DESC, id DESC
        LIMIT 1`,
      [sessionId],
    );
    const text = res.rows[0]?.text?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

async function hasActiveDialoguePartner(playerId: number): Promise<boolean> {
  try {
    const res = await query<{dialogue_partner_id: number | null}>(
      'select dialogue_partner_id from players where entity_id = $1',
      [playerId],
    );
    return res.rows[0]?.dialogue_partner_id != null;
  } catch {
    return false;
  }
}
