/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import '../tools/index.js';
import {query} from '../db.js';
import {
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGE_SET,
} from '../languages.js';
import {
  isValidAdvanceOn,
  VALID_ADVANCE_ON_VALUES,
} from '../quest/advanceOn.js';
import {getRegisteredTools} from '../tools/index.js';

export interface CartridgeValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  entityId?: number;
  entityName?: string;
  path?: string;
  message: string;
}

export interface CartridgeValidationResult {
  ok: boolean;
  summary: {errors: number; warnings: number; entitiesChecked: number};
  issues: CartridgeValidationIssue[];
}

export type CartridgeI18nValidationMode = 'off' | 'report' | 'strict';
type CartridgeI18nPolicy = 'full' | 'source_only';

export interface CartridgeValidationOptions {
  i18n?: CartridgeI18nValidationMode;
}

const DB_I18N_EXCLUDED_CATEGORIES = new Set([
  // The unified character creator owns these strings in the frontend UI
  // catalog. Keeping them in i18n_keys is legacy-compatible, but cartridge
  // release validation should not require a second DB copy.
  'examiner',
]);

// Exported for focused tests (QE-6 advance_on validation, etc.) so a
// test can call `checkQuestStages(entityFixture, issues)` without
// going through the full DB-backed `validateCartridge(...)`.
export interface EntityRow {
  id: number;
  kind: string;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown>;
  i18n: Record<string, unknown>;
  cartridge_id: string | null;
  dynamic_origin: boolean;
}

interface ItemRow {
  id: number;
  slug: string;
  name: string;
}

export async function validateCartridge(
  options: CartridgeValidationOptions = {},
): Promise<CartridgeValidationResult> {
  const i18nMode = options.i18n ?? 'off';
  const [
    entities,
    items,
    i18nMissing,
    activeCartridgeId,
    activeCartridgeI18nPolicy,
  ] = await Promise.all([
    loadEntities(),
    loadItems(),
    loadMissingI18nTranslations(),
    loadActiveCartridgeId(),
    loadActiveCartridgeI18nPolicy(),
  ]);
  const issues: CartridgeValidationIssue[] = [];
  const entityById = new Map(entities.map(e => [Number(e.id), e]));
  const entityByName = new Map(entities.map(e => [e.display_name, e]));
  const itemIds = new Set(items.map(i => i.id));
  const itemNames = new Set(items.flatMap(i => [i.slug, i.name]));
  const tools = getRegisteredTools();

  for (const entity of entities) {
    checkEntityRefs(entity, entity.profile, '$.profile', entityById, issues);
    checkExits(entity, entityById, entityByName, issues);
    checkQuestStages(entity, issues);
    checkToolRefs(entity, entity.profile, '$.profile', tools, issues);
    checkItemRefs(entity, entity.profile, '$.profile', itemIds, itemNames, issues);
    checkMentions(entity, entity.profile, '$.profile', entityByName, issues);
    checkI18nShape(entity, issues);
    checkDisplayNameI18nStability(entity, issues);
    if (
      i18nMode !== 'off' &&
      activeCartridgeI18nPolicy !== 'source_only' &&
      isActiveCartridgeEntity(entity, activeCartridgeId)
    ) {
      checkEntityI18nCoverage(entity, i18nMode, issues);
    }
  }

  for (const key of i18nMissing) {
    issues.push({
      severity: 'warning',
      code: 'i18n_key_without_translation',
      path: `i18n_keys.${key}`,
      message: `i18n key "${key}" has no translations`,
    });
  }

  if (i18nMode !== 'off') {
    for (const gap of await loadMechanicI18nCoverageGaps()) {
      issues.push({
        severity: i18nMode === 'strict' ? 'error' : 'warning',
        code: 'mechanic_i18n_missing_language_pack',
        path: `i18n_translations.${gap.key}`,
        message: `i18n key "${gap.key}" is missing translations for: ${gap.missingLanguages.join(', ')}`,
      });
    }
    await checkOriginTemplateI18nCoverage(i18nMode, issues);
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  return {
    ok: errors === 0,
    summary: {errors, warnings, entitiesChecked: entities.length},
    issues,
  };
}

export async function injectBrokenExitFixture(): Promise<void> {
  const r = await query<{id: number}>(
    `SELECT id FROM entities WHERE kind = 'location' ORDER BY id LIMIT 1`,
  );
  const id = r.rows[0]?.id;
  if (id == null) throw new Error('cannot inject broken exit: no location');
  await query(
    `UPDATE entities
        SET profile = jsonb_set(
          COALESCE(profile, '{}'::jsonb),
          '{exits}',
          COALESCE(profile->'exits', '[]'::jsonb) || '[999999999]'::jsonb
        )
      WHERE id = $1`,
    [id],
  );
}

async function loadEntities(): Promise<EntityRow[]> {
  const r = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile,
            COALESCE(i18n, '{}'::jsonb) AS i18n,
            cartridge_id, dynamic_origin
       FROM entities
      ORDER BY id`,
  );
  return r.rows;
}

async function loadActiveCartridgeId(): Promise<string> {
  // ARCH-8 — no more 'quickgrin-lane' fallback. cartridge_meta is
  // the single source of truth; if it's missing the cartridge id
  // the validator should fail loudly so the operator notices.
  const r = await query<{value: unknown}>(
    `SELECT value FROM cartridge_meta WHERE key = 'cartridge_id' LIMIT 1`,
  );
  const value = r.rows[0]?.value;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      `cartridge_meta missing required key: 'cartridge_id'. Apply migration 0106 or seed the active cartridge.`,
    );
  }
  return value.trim();
}

async function loadActiveCartridgeI18nPolicy(): Promise<CartridgeI18nPolicy> {
  const r = await query<{value: unknown}>(
    `SELECT value FROM cartridge_meta WHERE key = 'cartridge_i18n_policy' LIMIT 1`,
  );
  return r.rows[0]?.value === 'source_only' ? 'source_only' : 'full';
}

function isActiveCartridgeEntity(
  entity: EntityRow,
  activeCartridgeId: string,
): boolean {
  // ARCH-19 Phase 3 — read the normalized column. After 0106
  // cleanup every cartridge-scoped row has cartridge_id set
  // (including legacy quickgrin-lane-fallback rows that 0106
  // stamped explicitly). Dynamic-origin and player rows aren't
  // covered here because callers filter by kind already; the
  // cartridge scope check is purely about cartridge ownership.
  return entity.cartridge_id === activeCartridgeId;
}

async function loadItems(): Promise<ItemRow[]> {
  try {
    const r = await query<ItemRow>(
      `SELECT id, slug, name FROM items ORDER BY id`,
    );
    return r.rows;
  } catch {
    return [];
  }
}

async function loadMissingI18nTranslations(): Promise<string[]> {
  try {
    const r = await query<{key: string}>(
      `SELECT k.key
         FROM i18n_keys k
         LEFT JOIN i18n_translations t ON t.key = k.key
        WHERE NOT (k.category = ANY($1::text[]))
        GROUP BY k.key
       HAVING COUNT(t.key) = 0
        ORDER BY k.key`,
      [Array.from(DB_I18N_EXCLUDED_CATEGORIES)],
    );
    return r.rows.map(row => row.key);
  } catch {
    return [];
  }
}

async function loadMechanicI18nCoverageGaps(): Promise<Array<{
  key: string;
  missingLanguages: string[];
}>> {
  try {
    const r = await query<{key: string; languages: string[] | null}>(
      `SELECT k.key,
              COALESCE(array_agg(t.lang ORDER BY t.lang) FILTER (WHERE t.lang IS NOT NULL), ARRAY[]::text[]) AS languages
         FROM i18n_keys k
         LEFT JOIN i18n_translations t ON t.key = k.key
        WHERE NOT (k.category = ANY($1::text[]))
        GROUP BY k.key
        ORDER BY k.key`,
      [Array.from(DB_I18N_EXCLUDED_CATEGORIES)],
    );
    return r.rows
      .map(row => {
        const present = new Set(row.languages ?? []);
        return {
          key: row.key,
          missingLanguages: SUPPORTED_LANGUAGE_CODES.filter(lang => !present.has(lang)),
        };
      })
      .filter(row => row.missingLanguages.length > 0);
  } catch {
    return [];
  }
}

async function checkOriginTemplateI18nCoverage(
  mode: CartridgeI18nValidationMode,
  issues: CartridgeValidationIssue[],
): Promise<void> {
  const severity = mode === 'strict' ? 'error' : 'warning';
  let templates: unknown[] = [];
  try {
    const r = await query<{value: unknown}>(
      `SELECT value FROM cartridge_meta WHERE key = 'origin_templates'`,
    );
    templates = Array.isArray(r.rows[0]?.value) ? r.rows[0]!.value as unknown[] : [];
  } catch {
    return;
  }
  templates.forEach((template, index) => {
    if (!isRecord(template)) {
      issues.push({
        severity,
        code: 'origin_template_invalid_shape',
        path: `cartridge_meta.origin_templates[${index}]`,
        message: 'origin template must be an object',
      });
      return;
    }
    const id = typeof template['id'] === 'string' && template['id'].trim()
      ? template['id']
      : String(index);
    const i18n = isRecord(template['i18n']) ? template['i18n'] : {};
    checkOriginTemplateI18nShape(i18n, id, index, issues, severity);
    for (const field of ['label', 'blurb']) {
      if (typeof template[field] !== 'string' || !template[field].trim()) continue;
      const missingLanguages = missingLanguagesForField(i18n, field);
      if (missingLanguages.length === 0) continue;
      issues.push({
        severity,
        code: 'origin_template_i18n_missing_language_pack',
        path: `cartridge_meta.origin_templates[${index}].i18n.${field}`,
        message: `origin template "${id}" field "${field}" is missing translations for: ${missingLanguages.join(', ')}`,
      });
    }
  });
}

function checkOriginTemplateI18nShape(
  i18n: Record<string, unknown>,
  id: string,
  index: number,
  issues: CartridgeValidationIssue[],
  severity: 'error' | 'warning',
): void {
  for (const [field, langMap] of Object.entries(i18n)) {
    if (!isRecord(langMap)) {
      issues.push({
        severity,
        code: 'origin_template_invalid_i18n_shape',
        path: `cartridge_meta.origin_templates[${index}].i18n.${field}`,
        message: `origin template "${id}" i18n field "${field}" must map language code to string value`,
      });
      continue;
    }
    for (const [lang, translated] of Object.entries(langMap)) {
      const path = `cartridge_meta.origin_templates[${index}].i18n.${field}.${lang}`;
      if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang)) {
        issues.push({
          severity,
          code: 'origin_template_invalid_i18n_lang',
          path,
          message: `origin template "${id}" has invalid language key ${lang}`,
        });
      } else if (!SUPPORTED_LANGUAGE_SET.has(lang)) {
        issues.push({
          severity,
          code: 'origin_template_unsupported_i18n_lang',
          path,
          message: `origin template "${id}" has unsupported language key ${lang}`,
        });
      }
      if (typeof translated !== 'string') {
        issues.push({
          severity,
          code: 'origin_template_invalid_i18n_value',
          path,
          message: `origin template "${id}" translation value must be a string`,
        });
      } else if (translated.trim().length === 0) {
        issues.push({
          severity,
          code: 'origin_template_empty_i18n_value',
          path,
          message: `origin template "${id}" translation value must not be empty`,
        });
      }
    }
  }
}

function checkEntityRefs(
  entity: EntityRow,
  value: unknown,
  path: string,
  entityById: Map<number, EntityRow>,
  issues: CartridgeValidationIssue[],
): void {
  visit(value, path, (child, childPath, key) => {
    if (typeof child !== 'number') return;
    if (!key || !isEntityRefKey(key)) return;
    if (!entityById.has(child)) {
      issues.push({
        severity: 'error',
        code: 'missing_entity_ref',
        entityId: entity.id,
        entityName: entity.display_name,
        path: childPath,
        message: `${childPath} references missing entity id ${child}`,
      });
    }
  });
}

function checkExits(
  entity: EntityRow,
  entityById: Map<number, EntityRow>,
  entityByName: Map<string, EntityRow>,
  issues: CartridgeValidationIssue[],
): void {
  if (entity.kind !== 'location') return;
  const exits = entity.profile?.['exits'];
  if (exits == null) return;
  if (!Array.isArray(exits)) {
    issues.push(issue(entity, 'invalid_exits_shape', '$.profile.exits', 'location exits must be an array'));
    return;
  }
  exits.forEach((exit, index) => {
    const path = `$.profile.exits[${index}]`;
    const target =
      typeof exit === 'number'
        ? entityById.get(exit)
        : typeof exit === 'string'
          ? entityByName.get(exit)
          : undefined;
    if (!target) {
      issues.push(issue(entity, 'broken_exit_ref', path, `exit target not found: ${String(exit)}`));
    } else if (target.kind !== 'location' && target.kind !== 'district') {
      issues.push(issue(entity, 'exit_target_not_place', path, `exit target ${target.display_name} is kind=${target.kind}`));
    }
  });
}

// Exported for focused tests (QE-6 advance_on validation, etc.).
// `validateCartridge(...)` is the canonical entry point.
export function checkQuestStages(
  entity: EntityRow,
  issues: CartridgeValidationIssue[],
): void {
  if (entity.kind !== 'quest') return;
  const stages = entity.profile?.['stages'];
  if (!Array.isArray(stages)) return;
  const ids = new Set<string>();
  stages.forEach((stage, index) => {
    if (!isRecord(stage)) return;
    const id = stage['id'];
    if (typeof id === 'string') ids.add(id);
    else issues.push(issue(entity, 'quest_stage_missing_id', `$.profile.stages[${index}].id`, 'quest stage is missing string id'));
  });
  stages.forEach((stage, index) => {
    if (!isRecord(stage)) return;
    for (const key of ['next_stage_id', 'on_success_stage_id', 'on_failure_stage_id']) {
      const next = stage[key];
      if (next == null) continue;
      if (typeof next !== 'string' || !ids.has(next)) {
        issues.push(issue(entity, 'broken_quest_stage_ref', `$.profile.stages[${index}].${key}`, `stage reference not found: ${String(next)}`));
      }
    }
    // QE-6 — `advance_on` must be missing / null OR one of the four
    // shared aliases. Any other value (`'manual'`, `'manual_debug'`,
    // typos) is an authoring bug: the runtime would otherwise treat
    // it as `'all'` silently.
    const advanceOn = stage['advance_on'];
    if (advanceOn != null && !isValidAdvanceOn(advanceOn)) {
      issues.push(
        issue(
          entity,
          'invalid_quest_advance_on',
          `$.profile.stages[${index}].advance_on`,
          `invalid advance_on value ${JSON.stringify(advanceOn)} (expected one of ${VALID_ADVANCE_ON_VALUES.join(', ')})`,
        ),
      );
    }
  });
}

function checkToolRefs(
  entity: EntityRow,
  value: unknown,
  path: string,
  tools: ReturnType<typeof getRegisteredTools>,
  issues: CartridgeValidationIssue[],
): void {
  visit(value, path, (child, childPath) => {
    if (!isRecord(child)) return;
    const toolName = readToolName(child);
    if (!toolName) return;
    const tool = tools.get(toolName);
    if (!tool) {
      issues.push(issue(entity, 'unknown_tool_ref', childPath, `unknown tool reference: ${toolName}`));
      return;
    }
    const args = child['effect_args'] ?? child['args'];
    if (args !== undefined) {
      const parsed = tool.paramsSchema.safeParse(args);
      if (!parsed.success) {
        issues.push(issue(entity, 'invalid_tool_args', childPath, `args for ${toolName} do not match schema: ${parsed.error.issues.map(i => i.path.join('.') || '<root>').join(', ')}`));
      }
    }
  });
}

function checkItemRefs(
  entity: EntityRow,
  value: unknown,
  path: string,
  itemIds: Set<number>,
  itemNames: Set<string>,
  issues: CartridgeValidationIssue[],
): void {
  visit(value, path, (child, childPath, key) => {
    if (!key || !/(^item$|item_id|item_slug|item_name|item_entity_id)/i.test(key)) return;
    if (typeof child === 'number' && !itemIds.has(child)) {
      issues.push(issue(entity, 'missing_item_ref', childPath, `missing item id ${child}`));
    } else if (typeof child === 'string' && itemNames.size > 0 && !itemNames.has(child)) {
      issues.push(issue(entity, 'missing_item_ref', childPath, `missing item "${child}"`));
    }
  });
}

// Exported for focused unit testing in
// `__tests__/cartridge/materializesMentionValidation.test.ts`. The
// canonical entry point stays `validateCartridge(...)`.
export function checkMentions(
  entity: EntityRow,
  value: unknown,
  path: string,
  entityByName: Map<string, EntityRow>,
  issues: CartridgeValidationIssue[],
): void {
  // Authored Materializes rows with `target_status: 'new'` declare
  // a forward reference to an entity the materializer tool will
  // create at runtime. These names are not yet present in
  // `entities.display_name`, so the i18n check used to flag them as
  // `missing_mention_target` even though the Obsidian vault
  // validator already treats them as create-candidate questions
  // rather than broken links. We mirror that contract here by:
  //   1. collecting the create-candidate names from this entity's
  //      `profile.materializes[*].entity` rows whose
  //      `target_status === 'new'`,
  //   2. injecting them as additional "known names" for
  //      `extractMentions` so longest-match captures the full
  //      multi-word target ("@Quiet trading token") instead of
  //      tokenizing it to its first word ("@Quiet"), and
  //   3. suppressing `missing_mention_target` only when an extracted
  //      mention matches one of those create-candidate names.
  // Mentions in any other field that resolve via `entityByName`
  // still validate normally; ordinary unresolved prose mentions
  // outside the create-candidate set still produce errors.
  const createCandidates = collectMaterializerCreateCandidates(entity);
  const knownNames =
    createCandidates.size === 0
      ? [...entityByName.keys()]
      : [...entityByName.keys(), ...createCandidates];
  visit(value, path, (child, childPath) => {
    if (typeof child !== 'string' || !child.includes('@')) return;
    for (const mention of extractMentions(child, knownNames)) {
      if (entityByName.has(mention)) continue;
      if (createCandidates.has(mention)) continue;
      issues.push(issue(entity, 'missing_mention_target', childPath, `@${mention} does not match an entity display_name`));
    }
  });
}

// Exported for focused unit testing.
export function collectMaterializerCreateCandidates(
  entity: EntityRow,
): Set<string> {
  const out = new Set<string>();
  const materializes = entity.profile?.['materializes'];
  if (!Array.isArray(materializes)) return out;
  for (const row of materializes) {
    if (!isRecord(row)) continue;
    if (row['target_status'] !== 'new') continue;
    const entityField = row['entity'];
    if (typeof entityField !== 'string') continue;
    const stripped = entityField.startsWith('@')
      ? entityField.slice(1)
      : entityField;
    const trimmed = stripped.trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

function checkI18nShape(
  entity: EntityRow,
  issues: CartridgeValidationIssue[],
): void {
  if (!isRecord(entity.i18n)) return;
  for (const [field, langMap] of Object.entries(entity.i18n)) {
    if (!isRecord(langMap)) {
      issues.push(issue(entity, 'invalid_i18n_shape', `$.i18n.${field}`, 'i18n field must map language code to string value'));
      continue;
    }
    for (const [lang, translated] of Object.entries(langMap)) {
      if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang)) {
        issues.push(issue(entity, 'invalid_i18n_lang', `$.i18n.${field}.${lang}`, `invalid language key ${lang}`));
      } else if (!SUPPORTED_LANGUAGE_SET.has(lang)) {
        issues.push(issue(entity, 'unsupported_i18n_lang', `$.i18n.${field}.${lang}`, `unsupported language key ${lang}`));
      }
      if (typeof translated !== 'string') {
        issues.push(issue(entity, 'invalid_i18n_value', `$.i18n.${field}.${lang}`, 'translation value must be a string'));
      } else if (translated.trim().length === 0) {
        issues.push(issue(entity, 'empty_i18n_value', `$.i18n.${field}.${lang}`, 'translation value must not be empty'));
      }
    }
  }
}

// Exported for focused tests. `display_name` is the canonical runtime
// @mention key, so i18n may repeat it for coverage but must not translate it.
export function checkDisplayNameI18nStability(
  entity: EntityRow,
  issues: CartridgeValidationIssue[],
): void {
  if (!isRecord(entity.i18n)) return;
  const langMap = entity.i18n['display_name'];
  if (!isRecord(langMap)) return;
  for (const [lang, translated] of Object.entries(langMap)) {
    if (typeof translated !== 'string') continue;
    if (translated === entity.display_name) continue;
    issues.push(
      issue(
        entity,
        'entity_i18n_display_name_must_remain_canonical',
        `$.i18n.display_name.${lang}`,
        `${entity.kind} "${entity.display_name}" display_name is the canonical @-mention key and must not be translated`,
      ),
    );
  }
}

function checkEntityI18nCoverage(
  entity: EntityRow,
  mode: CartridgeI18nValidationMode,
  issues: CartridgeValidationIssue[],
): void {
  const severity = mode === 'strict' ? 'error' : 'warning';
  const requiredFields = new Set<string>(['display_name']);
  if (typeof entity.summary === 'string' && entity.summary.trim().length > 0) {
    requiredFields.add('summary');
  }
  for (const key of Object.keys(entity.profile ?? {})) {
    if (isLocalizableProfileStringKey(entity.profile, key)) {
      requiredFields.add(key);
    }
  }
  if (entity.kind === 'quest') {
    collectQuestProfileI18nPaths(entity.profile).forEach(field => requiredFields.add(field));
  }
  for (const field of [...requiredFields].sort()) {
    const missingLanguages = missingLanguagesForField(entity.i18n, field);
    if (missingLanguages.length === 0) continue;
    issues.push({
      severity,
      code: field.startsWith('profile.')
        ? 'nested_profile_i18n_missing_language_pack'
        : 'entity_i18n_missing_language_pack',
      entityId: entity.id,
      entityName: entity.display_name,
      path: `$.i18n.${field}`,
      message: `${entity.kind} "${entity.display_name}" field "${field}" is missing translations for: ${missingLanguages.join(', ')}`,
    });
  }
}

function missingLanguagesForField(
  i18n: Record<string, unknown>,
  field: string,
): string[] {
  const langMap = isRecord(i18n[field]) ? i18n[field] : {};
  return SUPPORTED_LANGUAGE_CODES.filter(lang => {
    if (lang === 'en') return false;
    const value = langMap[lang];
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

function isLocalizableProfileStringKey(
  profile: Record<string, unknown>,
  key: string,
): boolean {
  const value = profile[key];
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (key === 'hidden_until_stage') return false;
  if (key.endsWith('_id') || key.endsWith('_key') || key.endsWith('_slug')) return false;
  if (key === 'category' || key === 'source' || key === 'state') return false;
  return /brief|style|persona|hook|hunger|description|motivation|temperament|voice|text|note|label|title/i.test(key);
}

function collectQuestProfileI18nPaths(profile: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const stages = profile['stages'];
  if (Array.isArray(stages)) {
    for (const stage of stages) {
      if (!isRecord(stage) || typeof stage['id'] !== 'string') continue;
      const stageId = sanitizeI18nPathSegment(stage['id']);
      if (typeof stage['name'] === 'string' && stage['name'].trim()) {
        paths.push(`profile.stages.${stageId}.name`);
      }
      if (typeof stage['description'] === 'string' && stage['description'].trim()) {
        paths.push(`profile.stages.${stageId}.description`);
      }
      collectStableLabelPaths(stage, `profile.stages.${stageId}`, paths);
    }
  }
  collectStableLabelPaths(profile, 'profile', paths);
  return [...new Set(paths)];
}

function collectStableLabelPaths(
  value: Record<string, unknown>,
  prefix: string,
  paths: string[],
): void {
  for (const [key, child] of Object.entries(value)) {
    if (!Array.isArray(child)) continue;
    for (const entry of child) {
      if (!isRecord(entry)) continue;
      const id = typeof entry['id'] === 'string'
        ? entry['id']
        : typeof entry['key'] === 'string'
          ? entry['key']
          : typeof entry['slug'] === 'string'
            ? entry['slug']
            : null;
      if (!id) continue;
      const base = `${prefix}.${key}.${sanitizeI18nPathSegment(id)}`;
      for (const textKey of ['label', 'title', 'name', 'description', 'text', 'summary', 'note']) {
        if (typeof entry[textKey] === 'string' && entry[textKey].trim()) {
          paths.push(`${base}.${textKey}`);
        }
      }
    }
  }
}

function sanitizeI18nPathSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
}

function readToolName(value: Record<string, unknown>): string | null {
  for (const key of ['effect_tool', 'tool_name', 'tool']) {
    const candidate = value[key];
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function isEntityRefKey(key: string): boolean {
  return /(entity_id|location_id|scene_id|npc_id|quest_id|giver_id|target_id|home_id|owner_entity_id|about_entity_id|class_id)$/i.test(key);
}

// Token continuation class for `@name` mentions. Letters / digits /
// underscore are part of the name; whitespace / punctuation / EOF
// terminate it. Mirrors the DP-1 `MENTION_TOKEN_CONTINUES` semantics
// from `dialogueParticipants.ts` so the two parsers stay consistent.
const MENTION_TOKEN_CONTINUES = /[\p{L}\p{N}_]/u;

function isMentionTailBoundary(nextChar: string | undefined): boolean {
  return nextChar === undefined || !MENTION_TOKEN_CONTINUES.test(nextChar);
}

/**
 * Extracts `@Name` mentions from cartridge prose.
 *
 * The previous implementation used a greedy regex that captured up to
 * 80 chars of `[\p{L}\p{N} _'.-]` after `@`, which absorbed prose like
 * "перевести" or "или рядом с палаткой" into the matched mention and
 * produced false-positive `missing_mention_target` errors on Russian
 * quest text. The new implementation scans the known display-name
 * set (sorted longest-first so `@Mikka Quickgrin` wins over `@Mikka`),
 * accepts a match only when the next character is a token boundary
 * (whitespace / punctuation / EOF), and falls back to a single-word
 * extraction only when no known name matches — so genuinely unresolved
 * mentions like `@TotallyUnknown` still surface for the validator.
 *
 * Exported for focused unit testing in
 * `__tests__/cartridge/extractMentions.test.ts`.
 */
export function extractMentions(
  text: string,
  knownNames: ReadonlyArray<string>,
): string[] {
  const sorted = [...new Set(knownNames)]
    .filter((n) => typeof n === 'string' && n.length > 0)
    .sort((a, b) => {
      if (a.length !== b.length) return b.length - a.length;
      return a.localeCompare(b);
    });
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    const nameStart = i + 1;
    if (nameStart >= text.length) continue;
    // Try the longest known display name that starts at this position.
    let matched: string | null = null;
    for (const name of sorted) {
      const end = nameStart + name.length;
      if (end > text.length) continue;
      if (text.slice(nameStart, end) !== name) continue;
      const nextChar = end < text.length ? text[end] : undefined;
      if (!isMentionTailBoundary(nextChar)) continue;
      matched = name;
      break;
    }
    if (matched != null) {
      out.push(matched);
      i = nameStart + matched.length - 1;
      continue;
    }
    // No known name matches — fall back to a single-token extraction so
    // truly unresolved mentions still get reported. The fallback class
    // intentionally excludes spaces so prose suffixes never re-enter
    // the mention; it tolerates apostrophes / dots / hyphens that may
    // appear inside cartridge names but trims trailing punctuation.
    const tailRe = /^[\p{L}\p{N}_][\p{L}\p{N}_'.-]{0,80}/u;
    const tail = text.slice(nameStart).match(tailRe);
    if (!tail) continue;
    const cleaned = tail[0].replace(/[.,;:!?'-]+$/, '');
    if (cleaned) out.push(cleaned);
    i = nameStart + tail[0].length - 1;
  }
  return out;
}

function visit(
  value: unknown,
  path: string,
  fn: (value: unknown, path: string, key?: string) => void,
  key?: string,
): void {
  fn(value, path, key);
  if (Array.isArray(value)) {
    value.forEach((child, index) => visit(child, `${path}[${index}]`, fn));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visit(child, `${path}.${key}`, fn, key);
  }
}

function issue(
  entity: EntityRow,
  code: string,
  path: string,
  message: string,
): CartridgeValidationIssue {
  return {
    severity: 'error',
    code,
    entityId: entity.id,
    entityName: entity.display_name,
    path,
    message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
