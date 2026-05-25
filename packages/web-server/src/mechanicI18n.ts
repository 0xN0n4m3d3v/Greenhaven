/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 36 §1 — mechanical-vocabulary i18n.
//
// Distinct from src/i18n.ts (cartridge field resolver). This module
// covers UI/mechanic labels: condition slugs, surface types, trauma
// tags, string bands, item slugs, mode names, skills, stats, combat
// states. Backed by migration 0040 i18n_keys + i18n_translations.
//
// One-shot load + in-memory cache; cartridge author edits via SQL
// require a server restart (documented gotcha, spec 36 §i18n cache
// invalidation).

import {query} from './db.js';

type LangMap = Map<string, string>; // lang → value
const cache = new Map<string, LangMap>(); // key → LangMap
let loaded = false;

export async function loadMechanicI18n(): Promise<void> {
  const r = await query<{key: string; lang: string; value: string}>(
    `SELECT key, lang, value FROM i18n_translations`,
  );
  cache.clear();
  for (const row of r.rows) {
    let langMap = cache.get(row.key);
    if (!langMap) {
      langMap = new Map();
      cache.set(row.key, langMap);
    }
    langMap.set(row.lang, row.value);
  }
  loaded = true;
}

export function tMech(key: string, lang = 'en'): string {
  if (!loaded) return key;
  const langMap = cache.get(key);
  if (!langMap) return key;
  return langMap.get(lang) ?? langMap.get('en') ?? key;
}

export function isMechI18nLoaded(): boolean {
  return loaded;
}
