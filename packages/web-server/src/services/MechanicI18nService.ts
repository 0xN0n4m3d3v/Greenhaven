/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';

export interface MechanicI18nPayload {
  lang: string;
  map: Record<string, string>;
}

export class MechanicI18nService {
  static async map(rawLang?: string | null): Promise<MechanicI18nPayload> {
    const lang = normalizeMechanicLang(rawLang);
    const r = await query<{key: string; value: string}>(
      `SELECT t.key, t.value
         FROM i18n_translations t
        WHERE t.lang = $1
        UNION ALL
        SELECT t.key, t.value FROM i18n_translations t
         WHERE t.lang = 'en'
           AND NOT EXISTS (
             SELECT 1 FROM i18n_translations t2
              WHERE t2.key = t.key AND t2.lang = $1
           )`,
      [lang],
    );
    const map: Record<string, string> = {};
    for (const row of r.rows) map[row.key] = row.value;
    return {lang, map};
  }
}

function normalizeMechanicLang(rawLang?: string | null): string {
  // `String.split` always returns at least one element, even for empty
  // input, so the first segment is non-null. The cast keeps the
  // language-tag stripper honest under `noUncheckedIndexedAccess`.
  const base = (rawLang ?? 'en').trim().toLowerCase().split(/[-_]/)[0]!;
  return base.length > 0 ? base.slice(0, 8) : 'en';
}
