/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';
import {SUPPORTED_LANGUAGE_CODES} from '../languages.js';

export const CARTRIDGE_I18N_AUTHORING_SCHEMA =
  'greenhaven.cartridge_i18n_authoring.v1';

export type CartridgeI18nSource = 'entity' | 'mechanic' | 'origin_template';

export interface CartridgeI18nEntry {
  entryId: string;
  source: CartridgeI18nSource;
  field: string;
  base: string;
  translations: Record<string, string>;
  missingLanguages: string[];
  entityId?: number;
  entityName?: string;
  kind?: string;
  path?: string;
  mechanicKey?: string;
  category?: string;
  originTemplateId?: string;
}

export interface CartridgeI18nAuthoringPack {
  schema: typeof CARTRIDGE_I18N_AUTHORING_SCHEMA;
  exportedAt: string;
  languages: string[];
  summary: {
    entries: number;
    missingValues: number;
    bySource: Record<string, number>;
  };
  entries: CartridgeI18nEntry[];
}

export interface CartridgeI18nExportOptions {
  missingOnly?: boolean;
}

export interface CartridgeI18nDiffIssue {
  code:
    | 'entry_added'
    | 'entry_removed'
    | 'translation_changed'
    | 'translation_missing_in_incoming'
    | 'translation_missing_in_current';
  entryId: string;
  language?: string;
  current?: string;
  incoming?: string;
}

export interface CartridgeI18nDiffResult {
  ok: boolean;
  summary: {
    currentEntries: number;
    incomingEntries: number;
    addedEntries: number;
    removedEntries: number;
    changedTranslations: number;
    missingInIncoming: number;
    missingInCurrent: number;
  };
  issues: CartridgeI18nDiffIssue[];
}

export interface CartridgeI18nMigrationResult {
  ok: boolean;
  writesFiles: false;
  sql: string;
  warnings: string[];
  summary: {
    entityEntries: number;
    mechanicEntries: number;
    originTemplateEntries: number;
  };
}

interface EntityRow {
  id: number;
  kind: string;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown>;
  i18n: Record<string, unknown>;
}

interface MechanicRow {
  key: string;
  category: string;
  lang: string | null;
  value: string | null;
}

interface OriginTemplate {
  id?: unknown;
  label?: unknown;
  blurb?: unknown;
  i18n?: unknown;
}

const DB_I18N_EXCLUDED_CATEGORIES = new Set([
  // The unified character creator owns these legacy strings in the frontend
  // UI catalog. Spec 110 intentionally keeps them out of cartridge release
  // validation and this authoring export follows the same ownership boundary.
  'examiner',
]);

export async function exportCartridgeI18n(
  options: CartridgeI18nExportOptions = {},
): Promise<CartridgeI18nAuthoringPack> {
  const entries = [
    ...(await loadEntityEntries()),
    ...(await loadMechanicEntries()),
    ...(await loadOriginTemplateEntries()),
  ].sort((a, b) => a.entryId.localeCompare(b.entryId));
  const filtered = options.missingOnly
    ? entries.filter(entry => entry.missingLanguages.length > 0)
    : entries;
  return makePack(filtered);
}

export function diffCartridgeI18n(
  current: CartridgeI18nAuthoringPack,
  incoming: CartridgeI18nAuthoringPack,
): CartridgeI18nDiffResult {
  const currentById = new Map(current.entries.map(entry => [entry.entryId, entry]));
  const incomingById = new Map(incoming.entries.map(entry => [entry.entryId, entry]));
  const issues: CartridgeI18nDiffIssue[] = [];

  for (const entry of incoming.entries) {
    if (!currentById.has(entry.entryId)) {
      issues.push({code: 'entry_added', entryId: entry.entryId});
    }
  }
  for (const entry of current.entries) {
    const next = incomingById.get(entry.entryId);
    if (!next) {
      issues.push({code: 'entry_removed', entryId: entry.entryId});
      continue;
    }
    for (const lang of SUPPORTED_LANGUAGE_CODES) {
      const currentValue = entry.translations[lang] ?? '';
      const incomingValue = next.translations[lang] ?? '';
      if (currentValue && !incomingValue) {
        issues.push({
          code: 'translation_missing_in_incoming',
          entryId: entry.entryId,
          language: lang,
          current: currentValue,
        });
      } else if (!currentValue && incomingValue) {
        issues.push({
          code: 'translation_missing_in_current',
          entryId: entry.entryId,
          language: lang,
          incoming: incomingValue,
        });
      } else if (currentValue !== incomingValue) {
        issues.push({
          code: 'translation_changed',
          entryId: entry.entryId,
          language: lang,
          current: currentValue,
          incoming: incomingValue,
        });
      }
    }
  }

  const count = (code: CartridgeI18nDiffIssue['code']) =>
    issues.filter(issue => issue.code === code).length;
  return {
    ok: issues.length === 0,
    summary: {
      currentEntries: current.entries.length,
      incomingEntries: incoming.entries.length,
      addedEntries: count('entry_added'),
      removedEntries: count('entry_removed'),
      changedTranslations: count('translation_changed'),
      missingInIncoming: count('translation_missing_in_incoming'),
      missingInCurrent: count('translation_missing_in_current'),
    },
    issues,
  };
}

export function generateCartridgeI18nMigration(
  pack: CartridgeI18nAuthoringPack,
): CartridgeI18nMigrationResult {
  validatePackSchema(pack);
  const warnings: string[] = [];
  const entityEntries = pack.entries.filter(entry => entry.source === 'entity');
  const mechanicEntries = pack.entries.filter(entry => entry.source === 'mechanic');
  const originTemplateEntries = pack.entries.filter(
    entry => entry.source === 'origin_template',
  );

  const chunks: string[] = [
    '-- Generated Greenhaven cartridge i18n migration.',
    '-- Review prose quality before committing. Canonical ids and @-mention names stay unchanged.',
    `-- Source schema: ${pack.schema}`,
    '',
  ];

  chunks.push(...entityMigrationChunks(entityEntries, warnings));
  chunks.push(...mechanicMigrationChunks(mechanicEntries, warnings));
  chunks.push(...originTemplateMigrationChunks(originTemplateEntries, warnings));

  return {
    ok: warnings.length === 0,
    writesFiles: false,
    sql: chunks.join('\n'),
    warnings,
    summary: {
      entityEntries: entityEntries.length,
      mechanicEntries: mechanicEntries.length,
      originTemplateEntries: originTemplateEntries.length,
    },
  };
}

export function packToCsv(pack: CartridgeI18nAuthoringPack): string {
  validatePackSchema(pack);
  const header = [
    'schema',
    'source',
    'entry_id',
    'entity_id',
    'entity_name',
    'kind',
    'field',
    'path',
    'mechanic_key',
    'category',
    'origin_template_id',
    'language',
    'base',
    'value',
  ];
  const rows = [header];
  for (const entry of pack.entries) {
    for (const language of pack.languages) {
      rows.push([
        pack.schema,
        entry.source,
        entry.entryId,
        String(entry.entityId ?? ''),
        entry.entityName ?? '',
        entry.kind ?? '',
        entry.field,
        entry.path ?? '',
        entry.mechanicKey ?? '',
        entry.category ?? '',
        entry.originTemplateId ?? '',
        language,
        entry.base,
        entry.translations[language] ?? '',
      ]);
    }
  }
  return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}

export function packFromCsv(text: string): CartridgeI18nAuthoringPack {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  const header = rows[0]!;
  const columns = new Map(header.map((name, index) => [name, index]));
  const required = ['schema', 'source', 'entry_id', 'field', 'language', 'base', 'value'];
  for (const name of required) {
    if (!columns.has(name)) throw new Error(`CSV is missing column ${name}`);
  }
  const grouped = new Map<string, CartridgeI18nEntry>();
  for (const row of rows.slice(1)) {
    if (row.length === 0 || row.every(cell => cell.trim() === '')) continue;
    const entryId = csvValue(row, columns, 'entry_id');
    const language = csvValue(row, columns, 'language');
    if (!entryId || !language) continue;
    const existing = grouped.get(entryId);
    const source = csvValue(row, columns, 'source') as CartridgeI18nSource;
    const entry = existing ?? {
      entryId,
      source,
      field: csvValue(row, columns, 'field'),
      base: csvValue(row, columns, 'base'),
      translations: {},
      missingLanguages: [],
      entityId: optionalNumber(csvValue(row, columns, 'entity_id')),
      entityName: optionalString(csvValue(row, columns, 'entity_name')),
      kind: optionalString(csvValue(row, columns, 'kind')),
      path: optionalString(csvValue(row, columns, 'path')),
      mechanicKey: optionalString(csvValue(row, columns, 'mechanic_key')),
      category: optionalString(csvValue(row, columns, 'category')),
      originTemplateId: optionalString(csvValue(row, columns, 'origin_template_id')),
    };
    entry.translations[language] = csvValue(row, columns, 'value');
    grouped.set(entryId, entry);
  }
  const entries = [...grouped.values()].map(entry =>
    normalizeEntryTranslations(entry),
  );
  return makePack(entries);
}

export function packFromJson(text: string): CartridgeI18nAuthoringPack {
  const parsed = JSON.parse(text) as CartridgeI18nAuthoringPack;
  validatePackSchema(parsed);
  return {
    ...parsed,
    entries: parsed.entries.map(entry => normalizeEntryTranslations(entry)),
  };
}

function makePack(entries: CartridgeI18nEntry[]): CartridgeI18nAuthoringPack {
  const bySource: Record<string, number> = {};
  let missingValues = 0;
  for (const entry of entries) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
    missingValues += entry.missingLanguages.length;
  }
  return {
    schema: CARTRIDGE_I18N_AUTHORING_SCHEMA,
    exportedAt: new Date().toISOString(),
    languages: [...SUPPORTED_LANGUAGE_CODES],
    summary: {
      entries: entries.length,
      missingValues,
      bySource,
    },
    entries,
  };
}

async function loadEntityEntries(): Promise<CartridgeI18nEntry[]> {
  const r = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, COALESCE(i18n, '{}'::jsonb) AS i18n
       FROM entities
      ORDER BY id`,
  );
  const out: CartridgeI18nEntry[] = [];
  for (const entity of r.rows) {
    for (const field of collectEntityLocalizableFields(entity)) {
      out.push(entityEntry(entity, field.field, field.path, field.base));
    }
  }
  return out;
}

async function loadMechanicEntries(): Promise<CartridgeI18nEntry[]> {
  const r = await query<MechanicRow>(
    `SELECT k.key, k.category, t.lang, t.value
       FROM i18n_keys k
       LEFT JOIN i18n_translations t ON t.key = k.key
      WHERE NOT (k.category = ANY($1::text[]))
      ORDER BY k.key, t.lang`,
    [Array.from(DB_I18N_EXCLUDED_CATEGORIES)],
  );
  const grouped = new Map<string, {
    category: string;
    translations: Record<string, string>;
  }>();
  for (const row of r.rows) {
    const entry = grouped.get(row.key) ?? {
      category: row.category,
      translations: {},
    };
    if (row.lang && row.value != null) entry.translations[row.lang] = row.value;
    grouped.set(row.key, entry);
  }
  return [...grouped.entries()].map(([key, data]) => {
    const translations = fillTranslations(
      data.translations['en'] ?? key,
      data.translations,
    );
    return {
      entryId: `mechanic:${key}`,
      source: 'mechanic',
      field: key,
      base: translations['en'] ?? key,
      translations,
      missingLanguages: missingLanguages('mechanic', translations),
      mechanicKey: key,
      category: data.category,
      path: `i18n_translations.${key}`,
    };
  });
}

async function loadOriginTemplateEntries(): Promise<CartridgeI18nEntry[]> {
  const r = await query<{value: unknown}>(
    `SELECT value FROM cartridge_meta WHERE key = 'origin_templates'`,
  );
  const templates = Array.isArray(r.rows[0]?.value)
    ? (r.rows[0]!.value as OriginTemplate[])
    : [];
  const out: CartridgeI18nEntry[] = [];
  templates.forEach((template, index) => {
    if (!isRecord(template)) return;
    const id = typeof template.id === 'string' && template.id.trim()
      ? template.id
      : String(index);
    const i18n = isRecord(template.i18n) ? template.i18n : {};
    for (const field of ['label', 'blurb']) {
      const base = template[field as keyof OriginTemplate];
      if (typeof base !== 'string' || !base.trim()) continue;
      const langMap = isRecord(i18n[field]) ? i18n[field] : {};
      const translations = fillTranslations(base, langMap);
      out.push({
        entryId: `origin_template:${id}:${field}`,
        source: 'origin_template',
        field,
        base,
        translations,
        missingLanguages: missingLanguages('origin_template', translations),
        originTemplateId: id,
        path: `cartridge_meta.origin_templates[${id}].i18n.${field}`,
      });
    }
  });
  return out;
}

function entityEntry(
  entity: EntityRow,
  field: string,
  path: string,
  base: string,
): CartridgeI18nEntry {
  const langMap = isRecord(entity.i18n[field]) ? entity.i18n[field] : {};
  const translations =
    field === 'display_name'
      ? canonicalDisplayNameTranslations(base)
      : fillTranslations(base, langMap);
  return {
    entryId: `entity:${entity.id}:${field}`,
    source: 'entity',
    field,
    base,
    translations,
    missingLanguages:
      field === 'display_name'
        ? []
        : missingLanguages('entity', translations),
    entityId: entity.id,
    entityName: entity.display_name,
    kind: entity.kind,
    path,
  };
}

function collectEntityLocalizableFields(
  entity: EntityRow,
): Array<{field: string; path: string; base: string}> {
  const fields: Array<{field: string; path: string; base: string}> = [
    {field: 'display_name', path: '$.display_name', base: entity.display_name},
  ];
  if (entity.summary?.trim()) {
    fields.push({field: 'summary', path: '$.summary', base: entity.summary});
  }
  for (const [key, value] of Object.entries(entity.profile ?? {})) {
    if (isLocalizableProfileStringKey(entity.profile, key)) {
      fields.push({field: key, path: `$.profile.${key}`, base: value as string});
    }
  }
  if (entity.kind === 'quest') {
    collectQuestProfileI18nFields(entity.profile).forEach(field => fields.push(field));
  }
  return fields;
}

function collectQuestProfileI18nFields(
  profile: Record<string, unknown>,
): Array<{field: string; path: string; base: string}> {
  const fields: Array<{field: string; path: string; base: string}> = [];
  const stages = profile['stages'];
  if (Array.isArray(stages)) {
    stages.forEach((stage, index) => {
      if (!isRecord(stage) || typeof stage['id'] !== 'string') return;
      const stageId = sanitizeI18nPathSegment(stage['id']);
      if (typeof stage['name'] === 'string' && stage['name'].trim()) {
        fields.push({
          field: `profile.stages.${stageId}.name`,
          path: `$.profile.stages[${index}].name`,
          base: stage['name'],
        });
      }
      if (
        typeof stage['description'] === 'string' &&
        stage['description'].trim()
      ) {
        fields.push({
          field: `profile.stages.${stageId}.description`,
          path: `$.profile.stages[${index}].description`,
          base: stage['description'],
        });
      }
      collectStableLabelFields(stage, `profile.stages.${stageId}`, `$.profile.stages[${index}]`, fields);
    });
  }
  collectStableLabelFields(profile, 'profile', '$.profile', fields);
  return dedupeFields(fields);
}

function collectStableLabelFields(
  value: Record<string, unknown>,
  fieldPrefix: string,
  pathPrefix: string,
  out: Array<{field: string; path: string; base: string}>,
): void {
  for (const [key, child] of Object.entries(value)) {
    if (!Array.isArray(child)) continue;
    child.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const id = typeof entry['id'] === 'string'
        ? entry['id']
        : typeof entry['key'] === 'string'
          ? entry['key']
          : typeof entry['slug'] === 'string'
            ? entry['slug']
            : null;
      if (!id) return;
      const baseField = `${fieldPrefix}.${key}.${sanitizeI18nPathSegment(id)}`;
      const basePath = `${pathPrefix}.${key}[${index}]`;
      for (const textKey of [
        'label',
        'title',
        'name',
        'description',
        'text',
        'summary',
        'note',
      ]) {
        if (typeof entry[textKey] === 'string' && entry[textKey].trim()) {
          out.push({
            field: `${baseField}.${textKey}`,
            path: `${basePath}.${textKey}`,
            base: entry[textKey],
          });
        }
      }
    });
  }
}

function dedupeFields(
  fields: Array<{field: string; path: string; base: string}>,
): Array<{field: string; path: string; base: string}> {
  const seen = new Set<string>();
  return fields.filter(field => {
    if (seen.has(field.field)) return false;
    seen.add(field.field);
    return true;
  });
}

function isLocalizableProfileStringKey(
  profile: Record<string, unknown>,
  key: string,
): boolean {
  const value = profile[key];
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (key === 'hidden_until_stage') return false;
  if (key.endsWith('_id') || key.endsWith('_key') || key.endsWith('_slug')) {
    return false;
  }
  if (key === 'category' || key === 'source' || key === 'state') return false;
  return /brief|style|persona|hook|hunger|description|motivation|temperament|voice|text|note|label|title/i.test(key);
}

function fillTranslations(
  base: string,
  langMap: Record<string, unknown>,
): Record<string, string> {
  const translations: Record<string, string> = {};
  for (const lang of SUPPORTED_LANGUAGE_CODES) {
    const value = langMap[lang];
    translations[lang] = typeof value === 'string'
      ? value
      : lang === 'en'
        ? base
        : '';
  }
  return translations;
}

function normalizeEntryTranslations(
  entry: CartridgeI18nEntry,
): CartridgeI18nEntry {
  const isStableDisplayName =
    entry.source === 'entity' && entry.field === 'display_name';
  const translations = isStableDisplayName
    ? canonicalDisplayNameTranslations(entry.base)
    : fillTranslations(entry.base, entry.translations ?? {});
  return {
    ...entry,
    translations,
    missingLanguages: isStableDisplayName
      ? []
      : missingLanguages(entry.source, translations),
  };
}

function canonicalDisplayNameTranslations(base: string): Record<string, string> {
  const translations: Record<string, string> = {};
  for (const lang of SUPPORTED_LANGUAGE_CODES) {
    translations[lang] = base;
  }
  return translations;
}

function missingLanguages(
  source: CartridgeI18nSource,
  translations: Record<string, string>,
): string[] {
  return SUPPORTED_LANGUAGE_CODES.filter(lang => {
    if (source !== 'mechanic' && lang === 'en') return false;
    return !translations[lang]?.trim();
  });
}

function entityMigrationChunks(
  entries: CartridgeI18nEntry[],
  warnings: string[],
): string[] {
  if (entries.length === 0) return [];
  const chunks = ['-- Entity i18n packs.'];
  for (const entry of entries) {
    if (entry.entityId == null) {
      warnings.push(`${entry.entryId}: missing entityId`);
      continue;
    }
    const translations =
      entry.field === 'display_name'
        ? canonicalDisplayNameTranslations(entry.base)
        : entry.translations;
    chunks.push(
      [
        `UPDATE entities`,
        `   SET i18n = COALESCE(i18n, '{}'::jsonb) || jsonb_build_object(${sqlString(entry.field)}, ${sqlJson(cleanTranslations(translations))}::jsonb)`,
        ` WHERE id = ${entry.entityId};`,
        '',
      ].join('\n'),
    );
  }
  return chunks;
}

function mechanicMigrationChunks(
  entries: CartridgeI18nEntry[],
  warnings: string[],
): string[] {
  if (entries.length === 0) return [];
  const chunks = ['-- Mechanic i18n packs.'];
  const keyRows: string[] = [];
  const translationRows: string[] = [];
  for (const entry of entries) {
    const key = entry.mechanicKey ?? entry.field;
    if (!key) {
      warnings.push(`${entry.entryId}: missing mechanic key`);
      continue;
    }
    keyRows.push(`  (${sqlString(key)}, ${sqlString(entry.category ?? 'cartridge')})`);
    for (const [lang, value] of Object.entries(cleanTranslations(entry.translations))) {
      translationRows.push(`  (${sqlString(key)}, ${sqlString(lang)}, ${sqlString(value)})`);
    }
  }
  if (keyRows.length > 0) {
    chunks.push(
      [
        `INSERT INTO i18n_keys (key, category) VALUES`,
        keyRows.join(',\n'),
        `ON CONFLICT (key) DO UPDATE SET category = EXCLUDED.category;`,
        '',
      ].join('\n'),
    );
  }
  if (translationRows.length > 0) {
    chunks.push(
      [
        `INSERT INTO i18n_translations (key, lang, value) VALUES`,
        translationRows.join(',\n'),
        `ON CONFLICT (key, lang) DO UPDATE SET value = EXCLUDED.value;`,
        '',
      ].join('\n'),
    );
  }
  return chunks;
}

function originTemplateMigrationChunks(
  entries: CartridgeI18nEntry[],
  warnings: string[],
): string[] {
  if (entries.length === 0) return [];
  const chunks = ['-- Origin template i18n packs.'];
  for (const entry of entries) {
    if (!entry.originTemplateId) {
      warnings.push(`${entry.entryId}: missing originTemplateId`);
      continue;
    }
    chunks.push(
      [
        `WITH rewritten AS (`,
        `  SELECT jsonb_agg(`,
        `    CASE WHEN origin.value->>'id' = ${sqlString(entry.originTemplateId)}`,
        `      THEN origin.value || jsonb_build_object(`,
        `        'i18n',`,
        `        COALESCE(origin.value->'i18n', '{}'::jsonb) || jsonb_build_object(${sqlString(entry.field)}, ${sqlJson(cleanTranslations(entry.translations))}::jsonb)`,
        `      )`,
        `      ELSE origin.value`,
        `    END`,
        `    ORDER BY origin.ordinality`,
        `  ) AS value`,
        `  FROM cartridge_meta meta`,
        `  CROSS JOIN LATERAL jsonb_array_elements(meta.value) WITH ORDINALITY AS origin(value, ordinality)`,
        `  WHERE meta.key = 'origin_templates'`,
        `)`,
        `UPDATE cartridge_meta`,
        `   SET value = rewritten.value`,
        `  FROM rewritten`,
        ` WHERE cartridge_meta.key = 'origin_templates'`,
        `   AND rewritten.value IS NOT NULL;`,
        '',
      ].join('\n'),
    );
  }
  return chunks;
}

function cleanTranslations(translations: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const lang of SUPPORTED_LANGUAGE_CODES) {
    const value = translations[lang]?.trim();
    if (value) out[lang] = value;
  }
  return out;
}

function validatePackSchema(pack: CartridgeI18nAuthoringPack): void {
  if (!pack || typeof pack !== 'object') throw new Error('invalid i18n pack');
  if (pack.schema !== CARTRIDGE_I18N_AUTHORING_SCHEMA) {
    throw new Error(`unsupported i18n pack schema: ${String(pack.schema)}`);
  }
  if (!Array.isArray(pack.entries)) throw new Error('i18n pack entries must be an array');
}

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvValue(
  row: string[],
  columns: Map<string, number>,
  name: string,
): string {
  const index = columns.get(name);
  return index == null ? '' : row[index] ?? '';
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function sanitizeI18nPathSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
  return sqlString(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
