/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — player text rendering + broker user-prompt
// composition.
//
// Mirrors the previous inline `runTurn` block exactly:
//
//   1. Compute `rawPlayerText` / `visiblePlayerText` /
//      `playerRenderMeta` / `brokerPlayerText`.  The protagonist
//      renderer is disabled by design today; the meta has been
//      shipped as `{enabled:false, changed:false, skipped_reason:
//      'disabled_by_design', ...}` since the inline implementation.
//   2. Emit `player:message_rendered` on the SSE bridge.
//   3. Compose the broker user text in cache-friendly order: static
//      → dynamic → language directive → scripted context → accepted
//      adventure briefing → ignored adventure briefing → player
//      text. Cache keys are leading-bytes-sensitive, so anything
//      dynamic in front kills caching.
//   4. Compute the `promptBudgetBreakdown` shipped in performance
//      telemetry.
//
// The result lands on `TurnContext.state` under
// `TURN_PREPARATION_STATE_KEY` as a single `TurnPreparationResult`
// object so `runTurn` can read every preparation output back in one
// destructure.

import type {
  NaturalAdventureAcceptanceResult,
  NaturalAdventureIgnoreResult,
} from '../../domain/adventure/index.js';
import type {ProtagonistRenderMeta} from '../../agents/protagonistActionRenderer.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';
import {
  readIgnoredAdventureFromState,
  readNaturalAdventureFromState,
} from './AdventureIntentPhase.js';
import {
  readEffectiveLangNameFromState,
  readPlayerLangFromState,
} from './LanguagePhase.js';
import {readScriptedActionFromState} from './ScriptedActionPhase.js';
import {readTurnContextBundleFromState} from './ContextBuildPhase.js';

export interface TurnPreparationResult {
  playerLang: string;
  rawPlayerText: string;
  visiblePlayerText: string;
  playerRenderMeta: ProtagonistRenderMeta;
  brokerPlayerText: string;
  userText: string;
  promptBudgetBreakdown: Record<string, number>;
}

export const TURN_PREPARATION_STATE_KEY = 'turnPreparation' as const;

export function readTurnPreparationFromState(
  context: TurnContext,
): TurnPreparationResult {
  const raw = context.state[TURN_PREPARATION_STATE_KEY];
  if (raw == null) {
    throw new Error(
      'playerPromptPhase did not run before readTurnPreparationFromState',
    );
  }
  return raw as TurnPreparationResult;
}

export const playerPromptPhase: Phase = {
  name: 'player_prompt',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId} = context;
    const ctx = readTurnContextBundleFromState(context);
    const playerLang = readPlayerLangFromState(context);
    const effectiveLangName = readEffectiveLangNameFromState(context);
    const scripted = readScriptedActionFromState(context);
    const naturalAdventure = readNaturalAdventureFromState(context);
    const ignoredAdventure = readIgnoredAdventureFromState(context);

    const rawPlayerText = input.text;
    const visiblePlayerText = rawPlayerText;
    const playerRenderMeta: ProtagonistRenderMeta = {
      enabled: false,
      changed: false,
      skipped_reason: 'disabled_by_design',
      confidence: null,
      model_id: 'disabled',
    };
    const brokerPlayerText = rawPlayerText;
    // SSE-OK: emit outside tx (reason: render-meta cue for the UI
    // when the protagonist-render shim is disabled; the player
    // chat row is written later inside the persistence phase
    // under withTransaction).
    session.sse.emit('player:message_rendered', {
      turnId,
      originalText: rawPlayerText,
      visibleText: visiblePlayerText,
      changed: playerRenderMeta.changed,
    });

    const languageDirective = effectiveLangName
      ? `[Language directive: respond in ${effectiveLangName} regardless of the language I write in.]`
      : null;
    const scriptedContextInjection = scripted?.contextInjection ?? null;
    const acceptedAdventureBriefing =
      formatAcceptedAdventureBriefing(naturalAdventure);
    const ignoredAdventureBriefing =
      formatIgnoredAdventureBriefing(ignoredAdventure);
    const userText = [
      ctx.static
        ? `<turn_context_static>\n${ctx.static}\n</turn_context_static>`
        : null,
      ctx.dynamic
        ? `<turn_context_dynamic>\n${ctx.dynamic}\n</turn_context_dynamic>`
        : null,
      languageDirective,
      scriptedContextInjection,
      acceptedAdventureBriefing,
      ignoredAdventureBriefing,
      brokerPlayerText,
    ]
      .filter((s): s is string => Boolean(s))
      .join('\n\n');
    const promptBudgetBreakdown: Record<string, number> = {
      turn_context_static_chars: ctx.static.length,
      turn_context_dynamic_chars: ctx.dynamic.length,
      ...turnContextSectionBudgetBreakdown(ctx),
      language_directive_chars: languageDirective?.length ?? 0,
      scripted_context_chars: scriptedContextInjection?.length ?? 0,
      accepted_adventure_briefing_chars:
        acceptedAdventureBriefing?.length ?? 0,
      ignored_adventure_briefing_chars:
        ignoredAdventureBriefing?.length ?? 0,
      player_text_chars: brokerPlayerText.length,
    };

    const result: TurnPreparationResult = {
      playerLang,
      rawPlayerText,
      visiblePlayerText,
      playerRenderMeta,
      brokerPlayerText,
      userText,
      promptBudgetBreakdown,
    };
    context.state[TURN_PREPARATION_STATE_KEY] = result;
  },
};

function turnContextSectionBudgetBreakdown(ctx: {
  stats?: {
    static?: Array<{name: string; chars: number}>;
    dynamic?: Array<{name: string; chars: number}>;
  };
}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of ['static', 'dynamic'] as const) {
    const rows = ctx.stats?.[part] ?? [];
    rows.forEach((row, index) => {
      const key = row.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
      out[
        `turn_context_${part}_section_${index + 1}_${key || 'section'}_chars`
      ] = row.chars;
    });
  }
  return out;
}

function formatAcceptedAdventureBriefing(
  result: NaturalAdventureAcceptanceResult,
): string | null {
  if (!result.accepted) return null;
  const payload = {
    queueId: result.queueId ?? null,
    status: result.status ?? 'accepted',
    score: result.score ?? null,
    questResult: compactForPrompt(result.questResult),
    spawnResults: compactForPrompt(result.spawnResults ?? []),
  };
  return [
    '<accepted_adventure>',
    'The player accepted a ready adventure hook this turn. The server has already materialized that hook before broker execution. Treat the accepted quest/spawns as canon; do not create a duplicate quest, duplicate enemy, or duplicate hook for the same accepted adventure. Continue with only the missing next action, such as movement, a visible roll, or narration.',
    JSON.stringify(payload),
    '</accepted_adventure>',
  ].join('\n');
}

function formatIgnoredAdventureBriefing(
  result: NaturalAdventureIgnoreResult,
): string | null {
  if (!result.ignored) return null;
  const payload = {
    queueId: result.queueId ?? null,
    status: result.status ?? 'cancelled',
    score: result.score ?? null,
    reason: result.reason ?? 'ignored',
    hook: compactForPrompt(result.hook ?? null),
    consequence: compactForPrompt(result.consequence ?? null),
  };
  return [
    '<ignored_adventure>',
    'The player declined a ready adventure hook this turn. The server has already cancelled that hook before broker execution and recorded a baseline consequence. Treat the declined hook as unavailable canon; do not create its quest, spawn its promised entities, or route the player into it anyway. A visible response is mandatory this turn: if hook.speakerEntityId or consequence.speakerEntityId is present, narrate the reply from that NPC; otherwise narrate the local/world reaction. Add extra memory, relationship, or status consequences when the refusal matters beyond the baseline record.',
    JSON.stringify(payload),
    '</ignored_adventure>',
  ].join('\n');
}

function compactForPrompt(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length <= 1600) return value ?? null;
  return `${text.slice(0, 1597)}...`;
}
