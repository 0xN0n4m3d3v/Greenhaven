/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 — broker empty-output recovery text.
//
// Moved out of `turnRunnerV2.ts` so the `TurnDispatchPhase` can
// import the recovery directive and fail-open text without creating a
// `phase → runner → phase` cycle. `brokerEmptyFailOpenText` is also
// re-exported from `turnRunnerV2.ts` so existing devtool callers
// (notably `devtools/supportSmoke.ts`) keep their import path.
//
// S-7 / S-8 — every per-language string lives in
// `packages/web-server/locales/<lang>/turn-errors.json` and is loaded
// synchronously with a per-(language, key) cache so the
// `TurnDispatchPhase` and `invokeBroker` retry path don't have to
// introduce async I/O. Adding a language means dropping in a JSON
// file rather than editing this module.

import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  languageBase,
  languageDirectiveName,
} from './language.js';

type TurnErrorKey =
  | 'broker_empty_fail_open'
  | 'broker_empty_intimacy_recovery';

export function brokerEmptyRecoveryDirective(
  language: string | undefined,
): string {
  const lang = languageDirectiveName(language) ?? 'the selected language';
  return [
    '[Broker recovery directive: the previous broker attempt returned empty output.]',
    'You must not return empty output.',
    'If the player is accepting travel, following someone, or attempting to move toward a known reachable location, call `move_player` with `intent_source="user_command"` before `narrate`.',
    'If the player is accepting or taking a quest item shown in ACTIVE QUESTS, call `inventory_transfer` from the authoritative holder to `to_player_id` before `narrate`.',
    'If the player is taking a scene item and offering or selling it, call `batch_mutate_world` with the required `inventory_transfer` child before `narrate`; if payment is not proven, the player keeps the item and the NPC gives a counteroffer or refusal.',
    'If no tool applies, call `narrate` with an in-world blocker or clarification.',
    `Visible prose must be in ${lang}.`,
  ].join(' ');
}

// Both `src/turn/brokerEmptyText.ts` (via tsx) and
// `dist/turn/brokerEmptyText.js` (compiled) sit two directories under
// the package root, so the same relative path resolves the locales/
// catalog in either layout.
const LOCALES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'locales',
);

const TURN_ERROR_CACHE = new Map<string, string>();
const englishFallback = new Map<TurnErrorKey, string>();

function cacheKey(lang: string, key: TurnErrorKey): string {
  return `${lang}::${key}`;
}

function loadTurnErrorString(
  lang: string,
  key: TurnErrorKey,
): string | undefined {
  const slot = cacheKey(lang, key);
  const cached = TURN_ERROR_CACHE.get(slot);
  if (cached !== undefined) return cached || undefined;
  let raw: string;
  try {
    raw = readFileSync(resolve(LOCALES_ROOT, lang, 'turn-errors.json'), 'utf8');
  } catch {
    TURN_ERROR_CACHE.set(slot, '');
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    TURN_ERROR_CACHE.set(slot, '');
    return undefined;
  }
  const value =
    parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== 'string' || value.length === 0) {
    TURN_ERROR_CACHE.set(slot, '');
    return undefined;
  }
  TURN_ERROR_CACHE.set(slot, value);
  return value;
}

function englishOrThrow(key: TurnErrorKey): string {
  const cached = englishFallback.get(key);
  if (cached !== undefined) return cached;
  const value = loadTurnErrorString('en', key);
  if (!value) {
    throw new Error(
      `brokerEmptyText: missing en/turn-errors.json[${key}] under ${LOCALES_ROOT}`,
    );
  }
  englishFallback.set(key, value);
  return value;
}

export function brokerEmptyFailOpenText(language: string | undefined): string {
  return (
    loadTurnErrorString(languageBase(language), 'broker_empty_fail_open') ??
    englishOrThrow('broker_empty_fail_open')
  );
}

// S-8 — intimacy mode / `intimacy_social` profile recovery prose.
// Returns the catalog string for the player's language, falling back
// to English the same way as `brokerEmptyFailOpenText`. The caller is
// responsible for deciding whether to emit it (mode / profile gate)
// and for adding the structural delimiter so the retry prompt remains
// readable. Non-intimacy turns must not invoke this helper — see
// `intimacyRecoverySuffix` in `BrokerInvocation.ts` for the gate.
export function brokerEmptyIntimacyRecoveryText(
  language: string | undefined,
): string {
  return (
    loadTurnErrorString(
      languageBase(language),
      'broker_empty_intimacy_recovery',
    ) ?? englishOrThrow('broker_empty_intimacy_recovery')
  );
}
