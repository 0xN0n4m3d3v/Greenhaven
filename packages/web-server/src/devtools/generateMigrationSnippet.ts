/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MigrationEntityInput {
  kind: string;
  display_name: string;
  summary?: string;
  profile?: Record<string, unknown>;
  tags?: string[];
  i18n?: Record<string, unknown>;
}

export interface MigrationSnippetInput {
  migrationName?: string;
  entities?: MigrationEntityInput[];
}

export interface MigrationSnippetResult {
  ok: true;
  writesFiles: false;
  sql: string;
  warnings: string[];
}

export function generateMigrationSnippet(
  input: MigrationSnippetInput | MigrationEntityInput,
): MigrationSnippetResult {
  const entities = normalizeEntities(input);
  const warnings: string[] = [];
  if (entities.length === 0) warnings.push('no entities supplied');
  const header = [
    `-- Generated Greenhaven migration snippet.`,
    `-- Review IDs, references, and ordering before saving under migrations/.`,
  ];
  const chunks = entities.map((entity, index) => entitySql(entity, index, warnings));
  return {
    ok: true,
    writesFiles: false,
    sql: [...header, '', ...chunks].join('\n'),
    warnings,
  };
}

function normalizeEntities(
  input: MigrationSnippetInput | MigrationEntityInput,
): MigrationEntityInput[] {
  const maybe = input as MigrationSnippetInput;
  if (Array.isArray(maybe.entities)) return maybe.entities;
  return [input as MigrationEntityInput];
}

function entitySql(
  entity: MigrationEntityInput,
  index: number,
  warnings: string[],
): string {
  if (!entity.kind) warnings.push(`entity[${index}] missing kind`);
  if (!entity.display_name) warnings.push(`entity[${index}] missing display_name`);
  const tags = entity.tags ?? [];
  const profile = entity.profile ?? {};
  const i18n = entity.i18n ?? {};
  // ARCH-19 Phase 4 (migration 0123) — emit cartridge_id +
  // dynamic_origin from the input but strip the retired JSONB keys
  // and `'dynamic'` tag from the emitted profile/tags. topology_
  // parent_id is left NULL because a batch migration snippet cannot
  // guarantee parents land before children; rebuild_local_density /
  // explicit post-INSERT projection covers that.
  const cartridgeRaw = profile['cartridge_id'];
  const cartridgeId =
    typeof cartridgeRaw === 'string' && cartridgeRaw.trim().length > 0
      ? cartridgeRaw.trim()
      : null;
  const dynamicOrigin = profile['origin'] === 'dynamic' || tags.includes('dynamic');
  const profileForPersist: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (key === 'cartridge_id' || key === 'topology_parent_id' || key === 'origin') continue;
    profileForPersist[key] = value;
  }
  const tagsForPersist = tags.filter((t) => t !== 'dynamic');
  return [
    `INSERT INTO entities (kind, display_name, summary, profile, tags, i18n, cartridge_id, dynamic_origin)`,
    `VALUES (`,
    `  ${sqlString(entity.kind)},`,
    `  ${sqlString(entity.display_name)},`,
    `  ${entity.summary == null ? 'NULL' : sqlString(entity.summary)},`,
    `  ${sqlJson(profileForPersist)}::jsonb,`,
    `  ARRAY[${tagsForPersist.map(sqlString).join(', ')}]::text[],`,
    `  ${sqlJson(i18n)}::jsonb,`,
    `  ${cartridgeId == null ? 'NULL' : sqlString(cartridgeId)},`,
    `  ${dynamicOrigin ? 'TRUE' : 'FALSE'}`,
    `);`,
  ].join('\n');
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
  return sqlString(JSON.stringify(value));
}
