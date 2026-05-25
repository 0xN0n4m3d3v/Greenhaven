/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 — turn-scoped language helpers.
//
// Moved out of `turnRunnerV2.ts` so the `LanguagePhase` (and the
// `brokerEmptyRecoveryDirective` recovery helper still inside the
// runner) can import them without creating a `phase → runner →
// phase` cycle.  The contract matches the previous inline helpers
// byte-for-byte; only the location of the code changed.

import {query} from '../db.js';
import {resolveLanguage} from '../i18n.js';
import {
  SUPPORTED_LANGUAGE_NAMES,
  type SupportedLanguageCode,
} from '../languages.js';

/** Per-turn override (UI dropdown) beats persistent
 *  `players.preferred_language`. Either feeds the i18n resolver in
 *  `turnContext` for cartridge text and the language directive line
 *  prepended to the broker user prompt. */
export async function resolveEffectiveLang(
  playerId: number,
  turnLang?: string,
): Promise<string> {
  let playerLang: string | null = null;
  try {
    const r = await query<{preferred_language: string | null}>(
      `SELECT preferred_language FROM players WHERE entity_id = $1`,
      [playerId],
    );
    playerLang = r.rows[0]?.preferred_language ?? null;
  } catch {
    /* preferred_language column may not exist on older DBs - fall through */
  }
  return resolveLanguage({turnLang, playerLang});
}

export async function persistPreferredLanguage(
  playerId: number,
  language: string,
): Promise<void> {
  if (!language || language.length < 2) return;
  try {
    await query(
      `UPDATE players
          SET preferred_language = $2
        WHERE entity_id = $1
          AND COALESCE(preferred_language, '') <> $2`,
      [playerId, language],
    );
  } catch {
    /* preferred_language column may not exist on older DBs. */
  }
}

/** Human-readable language name for the language-directive line in
 *  the broker user prompt and the recovery-directive composer. Falls
 *  back to `ISO language code "<code>"` when the base code is
 *  unknown. Returns `undefined` for an empty input so the caller can
 *  skip emitting the directive entirely. */
export function languageDirectiveName(
  language: string | undefined,
): string | undefined {
  if (!language) return undefined;
  const code = language.trim().toLowerCase();
  if (!code) return undefined;
  const base = code.split(/[-_]/)[0]!;
  return (
    SUPPORTED_LANGUAGE_NAMES[base as SupportedLanguageCode] ??
    `ISO language code "${code}"`
  );
}

/** Strip region tags and fall back to `'en'` so language-keyed
 *  Records can be indexed safely.  Used by both the broker
 *  empty-output text table and the friendly turn-error text table. */
export function languageBase(language: string | undefined): string {
  return (language ?? 'en').trim().toLowerCase().split(/[-_]/)[0] || 'en';
}
