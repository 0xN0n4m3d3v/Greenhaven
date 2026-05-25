/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';

export interface LoadingQuote {
  id: number;
  text_key: string;
  attribution: string | null;
  scene_tags: string[];
  weight: number;
}

export interface LocalizedLoadingQuote extends LoadingQuote {
  text: string;
  language: string;
}

export class QuoteService {
  static async quotes(tags: string[]): Promise<LoadingQuote[]> {
    const normalizedTags = new Set(normalizeTags(tags));
    const r = await query<LoadingQuote>(
      `SELECT id, text_key, attribution, scene_tags, weight FROM loading_quotes`,
    );
    return r.rows
      .map(row => ({
        ...row,
        scene_tags: normalizeTags(row.scene_tags),
      }))
      .filter(
        quote =>
          quote.scene_tags.length === 0 ||
          quote.scene_tags.some(tag => normalizedTags.has(tag)),
      );
  }

  static async localizedQuotes(
    tags: string[],
    language?: string | null,
  ): Promise<LocalizedLoadingQuote[]> {
    const normalizedLanguage = normalizeLanguage(language);
    const normalizedTags = new Set(normalizeTags(tags));
    const r = await query<LocalizedLoadingQuote>(
      `SELECT q.id, q.text_key, q.attribution, q.scene_tags, q.weight,
              COALESCE(localized.value, fallback.value, q.text_key) AS text,
              CASE
                WHEN localized.value IS NOT NULL THEN $1::text
                WHEN fallback.value IS NOT NULL THEN 'en'
                ELSE $1::text
              END AS language
         FROM loading_quotes q
         LEFT JOIN i18n_translations localized
           ON localized.key = q.text_key AND localized.lang = $1
         LEFT JOIN i18n_translations fallback
           ON fallback.key = q.text_key AND fallback.lang = 'en'`,
      [normalizedLanguage],
    );
    return r.rows
      .map(row => ({
        ...row,
        scene_tags: normalizeTags(row.scene_tags),
      }))
      .filter(
        quote =>
          quote.scene_tags.length === 0 ||
          quote.scene_tags.some(tag => normalizedTags.has(tag)),
      );
  }

  static async inspirationalQuote(
    language?: string | null,
    tags: string[] = [],
  ): Promise<LocalizedLoadingQuote | null> {
    return weightedPick(await this.localizedQuotes(tags, language));
  }
}

export function parseQuoteTags(tagsParam: string | undefined | null): string[] {
  return normalizeTags((tagsParam ?? '').split(','));
}

function normalizeTags(tags: readonly unknown[]): string[] {
  return tags
    .map(tag => (typeof tag === 'string' ? tag.trim().toLowerCase() : ''))
    .filter(tag => tag.length > 0);
}

function normalizeLanguage(language?: string | null): string {
  // `String.split` always returns at least one element, even for empty
  // input, so the first segment is non-null. The cast keeps the
  // language-tag stripper honest under `noUncheckedIndexedAccess`.
  const base = (language ?? 'en').trim().toLowerCase().split(/[-_]/)[0]!;
  return base.length > 0 ? base.slice(0, 8) : 'en';
}

function weightedPick<T extends {weight: number}>(pool: T[]): T | null {
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, item) => sum + Math.max(1, item.weight), 0);
  let roll = Math.random() * total;
  for (const item of pool) {
    roll -= Math.max(1, item.weight);
    if (roll <= 0) return item;
  }
  return pool[pool.length - 1] ?? null;
}
