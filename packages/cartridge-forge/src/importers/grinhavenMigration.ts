import path from 'node:path';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import type {EntityKind, ForgeProject, IngestRecord, SourceRecord} from '../core/types.js';
import {makeRecord} from '../core/projectStore.js';
import {projectRoot, repoRoot} from '../core/paths.js';
import {writeJsonl} from '../core/jsonl.js';
import {recordFileName} from '../core/recordFiles.js';

export interface SqlEntity {
  id: number;
  kind: string;
  displayName: string;
  summary: string | null;
  profile: Record<string, unknown>;
  tags: string[];
}

export interface RuntimeField {
  ownerId: number;
  key: string;
  type: string;
  defaultValue: unknown;
  allowedValues: unknown;
  scope: string;
  description: string | null;
}

export interface ImportOptions {
  projectSlug: string;
  migrationPath?: string;
}

export interface GrinhavenImportReport {
  ok: true;
  projectSlug: string;
  migrationPath: string;
  records: number;
  sources: number;
  counts: Record<string, number>;
}

const DEFAULT_MIGRATION = path.join(
  repoRoot,
  'packages',
  'web-server',
  'migrations',
  '0082_grinhaven_full_dataset_cartridge.sql',
);

const ALLOWED_KINDS = new Set<EntityKind>([
  'activity',
  'dialogue',
  'event',
  'faction',
  'item',
  'location',
  'person',
  'quest',
  'relationship',
  'scene',
  'world_fact',
]);

export async function importGrinhavenMigration(
  options: ImportOptions,
): Promise<GrinhavenImportReport> {
  const migrationPath = path.resolve(options.migrationPath ?? DEFAULT_MIGRATION);
  const sql = await readFile(migrationPath, 'utf8');
  const entities = parseEntities(sql);
  const runtimeFields = parseRuntimeFields(sql);
  const idToSlug = uniqueEntitySlugs(entities);
  const slugAliases = buildSlugAliases(entities, idToSlug);
  const runtimeByOwner = groupRuntimeFields(runtimeFields);
  const records = entities.map(entity => toIngestRecord(entity, idToSlug, slugAliases, runtimeByOwner));
  const root = projectRoot(options.projectSlug);
  await writeProject(root, options.projectSlug);
  await writeSources(root);
  await writeRecords(root, records);
  await writeFile(
    path.join(root, 'audit', 'agent-notes.md'),
    [
      `# ${options.projectSlug}`,
      '',
      `Импортировано из: ${migrationPath}`,
      '',
      'Это round-trip снимок текущего DB-катриджа `grinhaven-full`.',
      'Поле `payload.db_profile_json` хранит исходный profile из миграции для обратной сборки.',
      '',
    ].join('\n'),
    'utf8',
  );
  const counts = countBy(records, record => record.kind);
  return {
    ok: true,
    projectSlug: options.projectSlug,
    migrationPath,
    records: records.length,
    sources: 1,
    counts,
  };
}

export function parseEntities(sql: string): SqlEntity[] {
  const blocks = valuesBlocks(sql, 'INSERT INTO entities');
  const out: SqlEntity[] = [];
  for (const block of blocks) {
    for (const tuple of splitTuples(block)) {
      const fields = splitTopLevel(tuple.slice(1, -1));
      // Accept 6 fields (legacy fixtures pre-ARCH-19 Phase 2A) or 8
      // fields (current forge output that includes cartridge_id and
      // dynamic_origin alongside profile/tags). For round-trip parsing
      // we only care about the first six columns; the normalized
      // columns are derivable from profile/tags downstream.
      if (fields.length !== 6 && fields.length !== 8) continue;
      const profile = parseJsonb(fields[4]!);
      out.push({
        id: Number(fields[0]),
        kind: parseSqlString(fields[1]!),
        displayName: parseSqlString(fields[2]!),
        summary: parseNullableString(fields[3]!),
        profile: isRecord(profile) ? profile : {},
        tags: parseArray(fields[5]!),
      });
    }
  }
  return out;
}

export function parseRuntimeFields(sql: string): RuntimeField[] {
  const blocks = valuesBlocks(sql, 'INSERT INTO runtime_fields');
  const out: RuntimeField[] = [];
  for (const block of blocks) {
    for (const tuple of splitTuples(block)) {
      const fields = splitTopLevel(tuple.slice(1, -1));
      if (fields.length !== 7) continue;
      out.push({
        ownerId: Number(fields[0]),
        key: parseSqlString(fields[1]!),
        type: parseSqlString(fields[2]!),
        defaultValue: parseJsonb(fields[3]!),
        allowedValues: parseJsonb(fields[4]!),
        scope: parseSqlString(fields[5]!),
        description: parseNullableString(fields[6]!),
      });
    }
  }
  return out;
}

function toIngestRecord(
  entity: SqlEntity,
  idToSlug: Map<number, string>,
  slugAliases: Map<string, string>,
  runtimeByOwner: Map<number, RuntimeField[]>,
): IngestRecord {
  const kind = ingestKind(entity.kind);
  const slug = idToSlug.get(entity.id) ?? sourceSlug(entity);
  const payload = normalizePayload(entity, kind, slug, idToSlug, slugAliases, runtimeByOwner.get(entity.id) ?? []);
  const summary = readableSummary(entity, kind);
  return {
    ...makeRecord({
      kind,
      slug,
      name: entity.displayName,
      summary: normalizeText(summary),
      tags: sanitizeTags([kind, 'grinhaven-full', 'imported-current', ...entity.tags]),
      sourceLanguage: 'en',
      payload,
    }),
    operation: 'upsert',
    record_id: `ghc:${kind}:${slug}`,
    provenance: [
      {
        source_id: 'src:greenhaven:current-cartridge',
        use: 'internal_greenhaven_canon',
        confidence: 1,
        note: 'Imported from the current grinhaven-full SQL cartridge migration.',
      },
    ],
    quality: {
      review_status: 'human_reviewed',
      playable: true,
      density_role: densityRole(entity),
      risk_flags: [],
    },
  };
}

function normalizePayload(
  entity: SqlEntity,
  kind: EntityKind,
  recordSlug: string,
  idToSlug: Map<number, string>,
  slugAliases: Map<string, string>,
  runtimeFields: RuntimeField[],
): Record<string, unknown> {
  const profile = entity.profile;
  const summaryObject = parseSummaryObject(entity.summary);
  const base: Record<string, unknown> = {
    db_entity_id: String(entity.id),
    db_kind: entity.kind,
    cartridge_id: String(profile.cartridge_id ?? 'grinhaven-full'),
    source_slug: sourceSlug(entity),
    forge_slug: recordSlug,
    db_profile_json: JSON.stringify(profile),
    ...(summaryObject ? {imported_summary_object: summaryObject} : {}),
  };

  if (kind === 'location') {
    const parent = firstSlug(idToSlug, profile.topology_parent_id, profile.parent_id, profile.power_center_id);
    const exits = slugArray(idToSlug, profile.exits);
    return {
      ...base,
      location_kind: stringValue(profile.location_kind, 'location'),
      parent_slug: parent,
      power_center_role: profile.power_center_role ?? null,
      exits: exits.length > 0 ? exits : parent ? [parent] : [recordSlug],
      narrator_brief: stringValue(profile.narrator_brief, entity.summary ?? entity.displayName),
      mood_axes: isRecord(profile.mood_axes) ? profile.mood_axes : {warmth: 1, danger: 0, intimacy: 0, pressure: 1},
      default_hooks: defaultHooks(entity),
      scene_slugs: densitySlugs(idToSlug, profile, 'scene_ids'),
      resident_npc_slugs: densitySlugs(idToSlug, profile, 'npc_ids'),
      event_slugs: densitySlugs(idToSlug, profile, 'event_ids'),
      activity_slugs: densitySlugs(idToSlug, profile, 'activity_ids'),
      quest_slugs: densitySlugs(idToSlug, profile, 'quest_ids'),
    };
  }

  if (kind === 'person') {
    const source = isRecord(profile.source) ? profile.source : {};
    return {
      ...base,
      species: stringValue(source.species, 'unknown'),
      pronouns: stringValue(source.pronouns, 'they/them'),
      occupation: source.occupation ?? null,
      home_slug: firstSlug(idToSlug, profile.home_id, profile.location_id, profile.power_center_id),
      faction_slug: kindSlug(slugAliases, source.faction, 'faction'),
      archetype: source.archetype ?? profile.source_category ?? 'imported-npc',
      speech_style: stringValue(source.speech_style, 'Use the imported NPC voice, registers, and source profile.'),
      registers: Array.isArray(source.registers) ? source.registers : [],
      npc_role_in_cartridge: isRecord(source.npc_role_in_cartridge)
        ? source.npc_role_in_cartridge
        : summaryObject,
    };
  }

  if (kind === 'quest') {
    const stages = normalizeStages(profile, idToSlug);
    const giver = firstSlug(idToSlug, profile.giver_entity_id, profile.npc_entity_id);
    const start = firstSlug(idToSlug, profile.location_id, profile.start_location_id, profile.power_center_id);
    return {
      ...base,
      quest_type: profile.quest_type ?? 'imported',
      giver_slug: giver ?? recordSlug,
      start_location_slug: start ?? recordSlug,
      objective: stringValue(profile.objective, entity.summary ?? entity.displayName),
      prepared_entity_slugs: uniqueStrings([giver, start, ...stages.map(stage => stage.location_slug)]),
      stages,
    };
  }

  if (kind === 'scene') {
    const location = firstSlug(idToSlug, profile.location_id, profile.power_center_id);
    return {
      ...base,
      location_slug: location ?? recordSlug,
      participant_slugs: slugArray(idToSlug, profile.participant_entity_ids),
      entry: true,
      state_fields: runtimeFields.map(field => ({
        key: field.key,
        type: field.type,
        default: field.defaultValue,
        allowed: field.allowedValues,
        scope: field.scope,
        description: field.description,
      })),
      model_instructions: ['Use imported scene source, participants, and runtime state without inventing replacement canon.'],
    };
  }

  if (kind === 'item') {
    return {
      ...base,
      item_kind: profile.item_kind ?? 'imported',
      holder_slug: firstSlug(idToSlug, profile.holder_id, profile.owner_id),
      location_slug: firstSlug(idToSlug, profile.location_id, profile.power_center_id),
      use_contract: profile.use_contract ?? entity.summary ?? entity.displayName,
    };
  }

  return {
    ...base,
    location_slug: firstSlug(idToSlug, profile.location_id, profile.power_center_id),
    participant_slugs: slugArray(idToSlug, profile.participant_entity_ids),
    source_category: profile.source_category ?? null,
  };
}

function normalizeStages(
  profile: Record<string, unknown>,
  idToSlug: Map<number, string>,
): Array<{stage_slug: string; goal: string; location_slug: string}> {
  const raw = Array.isArray(profile.stages) ? profile.stages.filter(isRecord) : [];
  if (raw.length === 0) {
    return [
      {
        stage_slug: 'imported-stage',
        goal: 'Play through the imported quest objective.',
        location_slug: firstSlug(idToSlug, profile.location_id, profile.power_center_id) ?? 'grinhaven-full-travel-hub',
      },
    ];
  }
  return raw.map((stage, index) => ({
    stage_slug: slugify(String(stage.id ?? stage.stage_slug ?? `stage-${index + 1}`)),
    goal: stringValue(stage.goal, stringValue(stage.description, `Imported quest stage ${index + 1}.`)),
    location_slug:
      stringToSlug(stage.location_slug) ??
      firstSlug(idToSlug, stage.location_id, profile.location_id, profile.power_center_id) ??
      'grinhaven-full-travel-hub',
  }));
}

function valuesBlocks(sql: string, marker: string): string[] {
  const blocks: string[] = [];
  let offset = 0;
  while (true) {
    const start = sql.indexOf(marker, offset);
    if (start < 0) break;
    const values = sql.indexOf(' VALUES', start);
    const end = sql.indexOf('\nON CONFLICT', values);
    if (values < 0 || end < 0) break;
    blocks.push(sql.slice(values + ' VALUES'.length, end).trim().replace(/;$/, ''));
    offset = end + 1;
  }
  return blocks;
}

function splitTuples(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (ch === "'" && value[i + 1] === "'") {
        i += 1;
      } else if (ch === "'") {
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0 && start >= 0) out.push(value.slice(start, i + 1));
    }
  }
  return out;
}

function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let inString = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (ch === "'" && value[i + 1] === "'") i += 1;
      else if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;
    else if (ch === ',' && paren === 0 && bracket === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

function parseNullableString(value: string): string | null {
  return value.trim().toUpperCase() === 'NULL' ? null : parseSqlString(value);
}

function parseJsonb(value: string): unknown {
  const text = value.trim().replace(/::jsonb$/i, '');
  if (text.toUpperCase() === 'NULL') return null;
  return JSON.parse(parseSqlString(text));
}

function parseArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('ARRAY[') || !trimmed.endsWith(']')) return [];
  return splitTopLevel(trimmed.slice(6, -1)).map(parseSqlString);
}

function parseSqlString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) {
    throw new Error(`expected SQL string, got ${trimmed.slice(0, 80)}`);
  }
  let out = '';
  for (let i = 1; i < trimmed.length - 1; i += 1) {
    const ch = trimmed[i];
    if (ch === "'" && trimmed[i + 1] === "'") {
      out += "'";
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

async function writeProject(root: string, projectSlug: string): Promise<void> {
  await mkdir(path.join(root, 'records'), {recursive: true});
  await mkdir(path.join(root, 'audit'), {recursive: true});
  await mkdir(path.join(root, 'export'), {recursive: true});
  const project: ForgeProject = {
    schema_version: 'greenhaven.cartridge_forge_project.v1',
    project_slug: projectSlug,
    pack_slug: projectSlug,
    target_cartridge_id: 'grinhaven-full',
    mode: 'append_patch',
    source_language: 'en',
    created_at: new Date().toISOString(),
    density_goal: {
      power_centers: ['tavern', 'guild', 'authority'],
      minimum_hooks_per_location: 3,
    },
    provider: {
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      api_key_env: 'DEEPSEEK_API_KEY',
    },
  };
  await writeFile(path.join(root, 'forge.project.json'), JSON.stringify(project, null, 2), 'utf8');
}

async function writeSources(root: string): Promise<void> {
  const sources: SourceRecord[] = [
    {
      source_id: 'src:greenhaven:current-cartridge',
      title: 'Current grinhaven-full cartridge SQL migration',
      retrieved_at: new Date().toISOString().slice(0, 10),
      license: 'internal',
      robots_status: 'internal',
      notes: 'Imported from packages/web-server/migrations/0082_grinhaven_full_dataset_cartridge.sql.',
    },
  ];
  await writeJsonl(path.join(root, 'sources.jsonl'), sources);
}

async function writeRecords(root: string, records: IngestRecord[]): Promise<void> {
  const byKind = new Map<EntityKind, IngestRecord[]>();
  for (const record of records) {
    byKind.set(record.kind, [...(byKind.get(record.kind) ?? []), record]);
  }
  for (const [kind, rows] of byKind) {
    await writeJsonl(path.join(root, 'records', recordFileName(kind)), rows);
  }
}

function groupRuntimeFields(fields: RuntimeField[]): Map<number, RuntimeField[]> {
  const out = new Map<number, RuntimeField[]>();
  for (const field of fields) out.set(field.ownerId, [...(out.get(field.ownerId) ?? []), field]);
  return out;
}

function ingestKind(kind: string): EntityKind {
  if (ALLOWED_KINDS.has(kind as EntityKind)) return kind as EntityKind;
  return 'world_fact';
}

function uniqueEntitySlugs(entities: SqlEntity[]): Map<number, string> {
  const baseCounts = new Map<string, number>();
  for (const entity of entities) {
    const base = sourceSlug(entity);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  const used = new Set<string>();
  const out = new Map<number, string>();
  for (const entity of entities) {
    const base = sourceSlug(entity);
    const initial =
      (baseCounts.get(base) ?? 0) > 1 ? `${ingestKind(entity.kind)}-${base}` : base;
    let slug = initial;
    let suffix = 2;
    while (used.has(slug)) {
      slug = `${initial}-${suffix}`;
      suffix += 1;
    }
    used.add(slug);
    out.set(entity.id, slug);
  }
  return out;
}

function buildSlugAliases(
  entities: SqlEntity[],
  idToSlug: Map<number, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const entity of entities) {
    out.set(kindSlugKey(ingestKind(entity.kind), sourceSlug(entity)), idToSlug.get(entity.id) ?? sourceSlug(entity));
  }
  return out;
}

function sourceSlug(entity: SqlEntity): string {
  return slugify(String(entity.profile.source_slug ?? entity.displayName ?? `${entity.kind}-${entity.id}`));
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

function stringToSlug(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? slugify(value) : null;
}

function kindSlug(
  aliases: Map<string, string>,
  value: unknown,
  kind: EntityKind,
): string | null {
  const slug = stringToSlug(value);
  return slug ? aliases.get(kindSlugKey(kind, slug)) ?? slug : null;
}

function kindSlugKey(kind: EntityKind, slug: string): string {
  return `${kind}\0${slug}`;
}

function firstSlug(idToSlug: Map<number, string>, ...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'number' && idToSlug.has(value)) return idToSlug.get(value)!;
    if (typeof value === 'string') {
      const direct = Number(value);
      if (Number.isInteger(direct) && idToSlug.has(direct)) return idToSlug.get(direct)!;
      if (value.trim()) return slugify(value);
    }
  }
  return null;
}

function slugArray(idToSlug: Map<number, string>, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.map(item => {
      if (typeof item === 'number') return idToSlug.get(item);
      if (typeof item === 'string') return firstSlug(idToSlug, item);
      return null;
    }),
  );
}

function densitySlugs(
  idToSlug: Map<number, string>,
  profile: Record<string, unknown>,
  key: string,
): string[] {
  const density = isRecord(profile.local_density) ? profile.local_density : {};
  return slugArray(idToSlug, density[key]);
}

function defaultHooks(entity: SqlEntity): string[] {
  const profileHooks = entity.profile.default_hooks;
  if (Array.isArray(profileHooks)) return uniqueStrings(profileHooks.filter(isString).map(slugify)).slice(0, 6);
  const tags = sanitizeTags(entity.tags).filter(tag => tag !== 'grinhaven-full').slice(0, 3);
  return tags.length >= 3 ? tags : uniqueStrings([`${sourceSlug(entity)}-hook`, ...tags, 'talk', 'look']).slice(0, 3);
}

function densityRole(entity: SqlEntity): IngestRecord['quality']['density_role'] {
  if (entity.profile.power_center_role) return 'power_center';
  if (entity.kind === 'location') return 'hub_spoke';
  if (entity.kind === 'quest') return 'quest_site';
  return 'ambient';
}

function readableSummary(entity: SqlEntity, kind: EntityKind): string {
  const profile = entity.profile;
  const source = isRecord(profile.source) ? profile.source : {};
  const summaryObject = parseSummaryObject(entity.summary);
  const role = isRecord(source.npc_role_in_cartridge)
    ? source.npc_role_in_cartridge
    : summaryObject;
  const rolePrimary = isRecord(role) ? readableText(role.primary) : '';
  const sourceText = firstText([
    source.summary,
    source.description,
    source.personality_seed,
    source.npc_concept,
    source.relationship,
    source.appearance,
    source.role,
    profile.narrator_brief,
    profile.objective,
    profile.description,
  ]);
  const rawSummary = summaryObject ? '' : stringValue(entity.summary, '');
  const summary =
    sourceText ||
    rolePrimary ||
    readableText(summaryObject) ||
    rawSummary ||
    entity.displayName;
  return kind === 'person' && rolePrimary && sourceText
    ? `${sourceText} Role: ${rolePrimary}`
    : summary;
}

function parseSummaryObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? normalizeText(value) : fallback;
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const text = readableText(value);
    if (text) return text;
  }
  return '';
}

function readableText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(item => readableText(item, depth + 1))
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
  }
  if (!isRecord(value) || depth > 2) return '';

  const priorityKeys = [
    'summary',
    'description',
    'primary',
    'objective',
    'narrator_brief',
    'personality_seed',
    'npc_concept',
    'role',
    'use_contract',
    'class',
  ];
  for (const key of priorityKeys) {
    const text = readableText(value[key], depth + 1);
    if (text) return text;
  }

  const parts: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const text = readableText(child, depth + 1);
    if (!text) continue;
    parts.push(`${titleFromKey(key)}: ${text}`);
    if (parts.length >= 4) break;
  }
  return parts.join('. ');
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function titleFromKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

function sanitizeTags(values: string[]): string[] {
  const tags = values
    .map(value => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  return uniqueStrings(tags.length > 0 ? tags : ['imported']);
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function countBy<T>(items: T[], fn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = fn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
