/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — effective player language resolution.
//
// Per-turn override (UI dropdown) beats persistent
// `players.preferred_language`. When the turn carries an explicit
// `input.language`, persist it; either way, stamp the resolved
// language onto the active-turn handle so post-turn / error paths
// can render the right localized text.
//
// Writes `playerLang: string` and `effectiveLangName: string |
// undefined` to `TurnContext.state` for `ContextBuildPhase` and
// `PlayerPromptPhase` to read.

import {
  languageDirectiveName,
  persistPreferredLanguage,
  resolveEffectiveLang,
} from '../language.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const LANGUAGE_STATE_KEY = {
  playerLang: 'playerLang' as const,
  effectiveLangName: 'effectiveLangName' as const,
};

export function readPlayerLangFromState(context: TurnContext): string {
  const raw = context.state[LANGUAGE_STATE_KEY.playerLang];
  if (typeof raw !== 'string') {
    throw new Error('languagePhase did not run before readPlayerLangFromState');
  }
  return raw;
}

export function readEffectiveLangNameFromState(
  context: TurnContext,
): string | undefined {
  const raw = context.state[LANGUAGE_STATE_KEY.effectiveLangName];
  return typeof raw === 'string' ? raw : undefined;
}

export const languagePhase: Phase = {
  name: 'language',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId} = context;
    const playerLang = await resolveEffectiveLang(
      input.playerId,
      input.language,
    );
    const effectiveLangName = languageDirectiveName(playerLang);
    if (input.language) {
      await persistPreferredLanguage(input.playerId, playerLang);
    }
    if (session.activeTurn?.turnId === turnId) {
      session.activeTurn.language = playerLang;
    }
    context.state[LANGUAGE_STATE_KEY.playerLang] = playerLang;
    context.state[LANGUAGE_STATE_KEY.effectiveLangName] = effectiveLangName;
  },
};
