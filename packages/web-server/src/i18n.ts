/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// i18n resolver for cartridge text fields.
//
// Storage convention (migration 0017):
//   entities.i18n             :: { fieldName: { lang: value } }
//   entity_instructions.i18n  :: same
//
// Resolution chain (per call site):
//   1. record.i18n[fieldName][lang]    — exact match
//   2. record.i18n[fieldName]['en']    — English fallback
//   3. fallback (caller-provided base value, e.g. record.display_name)
//
// Keeping the chain caller-explicit means we never silently localize
// the wrong thing — the call site decides what the base text is.

export interface Localizable {
  i18n?: Record<string, Record<string, unknown>> | null;
}

export function loc<T>(
  record: Localizable | null | undefined,
  lang: string,
  fieldName: string,
  fallback: T,
): T {
  if (!record || !record.i18n) return fallback;
  const variants = record.i18n[fieldName];
  if (!variants || typeof variants !== 'object') return fallback;
  if (variants[lang] !== undefined) return variants[lang] as T;
  if (variants['en'] !== undefined) return variants['en'] as T;
  return fallback;
}

export function i18nPathSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
}

export function profileI18nKey(...segments: string[]): string {
  return ['profile', ...segments.map(i18nPathSegment)].join('.');
}

export function questStageI18nKey(
  stageId: string,
  fieldName: 'name' | 'description',
): string {
  return profileI18nKey('stages', stageId, fieldName);
}

export function locQuestStageField<T>(
  record: Localizable | null | undefined,
  lang: string,
  stage: Record<string, unknown>,
  fieldName: 'name' | 'description',
  fallback: T,
): T {
  const stageId = stage['id'];
  if (typeof stageId !== 'string' || stageId.trim().length === 0) {
    return fallback;
  }
  return loc(record, lang, questStageI18nKey(stageId, fieldName), fallback);
}

export function locNestedProfileText<T>(
  record: Localizable | null | undefined,
  lang: string,
  segments: string[],
  fallback: T,
): T {
  return loc(record, lang, profileI18nKey(...segments), fallback);
}

/**
 * Pick the effective language for a turn:
 *   1. turnLang — the per-turn `language` arg from POST /turn (UI dropdown)
 *   2. playerLang — players.preferred_language (persistent)
 *   3. 'en' — engine default
 */
export function resolveLanguage(opts: {
  turnLang?: string | null;
  playerLang?: string | null;
}): string {
  if (opts.turnLang && opts.turnLang.length >= 2) return opts.turnLang;
  if (opts.playerLang && opts.playerLang.length >= 2) return opts.playerLang;
  return 'en';
}
