/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — materializer runtime read layer.
//
// Bridges the generated `forge_materializer_bridge` cartridge_meta
// document (produced by `exportGrinhavenSql` in `packages/cartridge-forge`)
// with the runtime `entities` table so callers can:
//
//   * list every authored materializer row;
//   * resolve one row by `materializer_id` into a fully prepared
//     dispatch plan with the source entity id, the target entity id
//     (when `entity_slug` resolves), and the @mentions parsed out
//     of the free-text `scope` already mapped to entity ids;
//   * recover gracefully when the bridge meta is missing — the
//     catalog stays empty and lookups return `null` instead of
//     fabricating rows.
//
// This module is read-only. Per-type dispatch + the actual mutation
// (exit wiring, item grants, durable memory writes, per-player
// "applied" runtime flags) lives in `tools/materializer.ts` so the
// transactional contract stays under the broker tool registry.

import {query} from '../db.js';
import {bridgeCacheKey, readScopedBridgeMeta} from './scopedBridgeMeta.js';

const BRIDGE_META_KEY = 'forge_materializer_bridge';
const BRIDGE_SCHEMA_VERSION = 'greenhaven.materializers.v1';

export interface MaterializerBridgeOptions {
  /** Active cartridge id. Threaded by callers that resolve player
   *  scope so the catalog comes from `cartridge_meta_scoped` for
   *  that cartridge. Omit for legacy / scriptless callers. */
  cartridgeId?: string | null;
}

export interface MaterializerScopeMention {
  /** The literal `@Name` substring lifted from `scope`. */
  mention: string;
  /** Slug form of the mention (`lowercase`, `'` stripped,
   *  non-alnum collapsed to `-`). Matches the Forge slug rules. */
  slug: string;
  /** Numeric entity id when the slug resolves through
   *  `entities.profile->>'source_slug'`. `null` otherwise — the
   *  tool layer decides whether unresolved scope is fatal. */
  entityId: number | null;
}

export interface MaterializerEntry {
  materializerId: string;
  sourceSlug: string;
  sourceMention: string;
  sourceKind: string;
  sourceEntityId: number | null;
  sourcePath: string;
  entity: string;
  entitySlug: string;
  /** Numeric entity id for `entity_slug`. `null` when no entity
   *  carries that slug yet — the tool layer rejects the call in
   *  that case (or, for `target_status: 'new'` types, decides to
   *  no-op until the entity exists). */
  targetEntityId: number | null;
  targetStatus: string;
  triggerCondition: string;
  triggerSource: string;
  type: string;
  scope: string;
  /** Every `@Mention` substring parsed out of `scope`, already
   *  resolved to entity ids when possible. Order matches the
   *  authored prose. */
  scopeMentions: MaterializerScopeMention[];
  effect: string;
}

interface RawBridgeMeta {
  schema_version?: unknown;
  source_project?: unknown;
  rows?: unknown;
}

interface RawBridgeRow {
  materializer_id?: unknown;
  source_slug?: unknown;
  source_mention?: unknown;
  source_kind?: unknown;
  source_path?: unknown;
  entity?: unknown;
  entity_slug?: unknown;
  target_status?: unknown;
  trigger_condition?: unknown;
  trigger_source?: unknown;
  type?: unknown;
  scope?: unknown;
  effect?: unknown;
}

interface BuiltCatalog {
  entries: MaterializerEntry[];
  byMaterializerId: Map<string, MaterializerEntry>;
  bridgeAvailable: boolean;
}

const cachedCatalogByScope = new Map<string, Promise<BuiltCatalog>>();

export function clearMaterializerBridgeCache(): void {
  cachedCatalogByScope.clear();
}

export async function listMaterializerEntries(
  opts?: MaterializerBridgeOptions,
): Promise<MaterializerEntry[]> {
  const catalog = await getMaterializerCatalog(opts);
  return catalog.entries;
}

export async function findMaterializerEntry(
  materializerId: string,
  opts?: MaterializerBridgeOptions,
): Promise<MaterializerEntry | null> {
  const catalog = await getMaterializerCatalog(opts);
  const id = materializerId.trim();
  if (!id) return null;
  return catalog.byMaterializerId.get(id) ?? null;
}

export async function isMaterializerBridgeAvailable(
  opts?: MaterializerBridgeOptions,
): Promise<boolean> {
  return (await getMaterializerCatalog(opts)).bridgeAvailable;
}

async function getMaterializerCatalog(
  opts?: MaterializerBridgeOptions,
): Promise<BuiltCatalog> {
  const cacheKey = bridgeCacheKey(opts?.cartridgeId);
  const existing = cachedCatalogByScope.get(cacheKey);
  if (existing) return existing;
  const promise = buildCatalog(opts?.cartridgeId ?? null).catch(err => {
    cachedCatalogByScope.delete(cacheKey);
    throw err;
  });
  cachedCatalogByScope.set(cacheKey, promise);
  return promise;
}

async function buildCatalog(
  cartridgeId: string | null,
): Promise<BuiltCatalog> {
  const meta = await readScopedBridgeMeta<RawBridgeMeta>(BRIDGE_META_KEY, {
    cartridgeId,
  });
  const rows = parseRows(meta);
  if (rows.length === 0) {
    return {
      entries: [],
      byMaterializerId: new Map(),
      bridgeAvailable: false,
    };
  }
  const slugs = new Set<string>();
  const scopeIndex = new Map<
    string,
    Array<{mention: string; slug: string}>
  >();
  for (const row of rows) {
    if (row.source_slug) slugs.add(row.source_slug);
    if (row.entity_slug) slugs.add(row.entity_slug);
    const mentions = scanMentions(row.scope);
    scopeIndex.set(row.materializer_id, mentions);
    for (const m of mentions) slugs.add(m.slug);
  }
  const slugToId = await resolveSlugIds(Array.from(slugs), cartridgeId);
  const entries: MaterializerEntry[] = rows.map(row => {
    const mentions = scopeIndex.get(row.materializer_id) ?? [];
    return {
      materializerId: row.materializer_id,
      sourceSlug: row.source_slug,
      sourceMention: row.source_mention,
      sourceKind: row.source_kind,
      sourceEntityId: slugToId.get(row.source_slug) ?? null,
      sourcePath: row.source_path,
      entity: row.entity,
      entitySlug: row.entity_slug,
      targetEntityId: slugToId.get(row.entity_slug) ?? null,
      targetStatus: row.target_status,
      triggerCondition: row.trigger_condition,
      triggerSource: row.trigger_source,
      type: row.type,
      scope: row.scope,
      scopeMentions: mentions.map(m => ({
        mention: m.mention,
        slug: m.slug,
        entityId: slugToId.get(m.slug) ?? null,
      })),
      effect: row.effect,
    };
  });
  const byMaterializerId = new Map<string, MaterializerEntry>();
  for (const entry of entries) byMaterializerId.set(entry.materializerId, entry);
  return {entries, byMaterializerId, bridgeAvailable: true};
}

interface CleanRow {
  materializer_id: string;
  source_slug: string;
  source_mention: string;
  source_kind: string;
  source_path: string;
  entity: string;
  entity_slug: string;
  target_status: string;
  trigger_condition: string;
  trigger_source: string;
  type: string;
  scope: string;
  effect: string;
}

function parseRows(meta: RawBridgeMeta | undefined): CleanRow[] {
  if (!meta || typeof meta !== 'object') return [];
  if (meta.schema_version !== BRIDGE_SCHEMA_VERSION) return [];
  if (!Array.isArray(meta.rows)) return [];
  const out: CleanRow[] = [];
  for (const raw of meta.rows) {
    const parsed = parseRow(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseRow(value: unknown): CleanRow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as RawBridgeRow;
  const materializer_id =
    typeof raw.materializer_id === 'string' ? raw.materializer_id.trim() : '';
  const source_slug =
    typeof raw.source_slug === 'string'
      ? raw.source_slug.trim().toLowerCase()
      : '';
  const entity_slug =
    typeof raw.entity_slug === 'string'
      ? raw.entity_slug.trim().toLowerCase()
      : '';
  const type =
    typeof raw.type === 'string' ? normalizeMaterializerType(raw.type) : '';
  if (!materializer_id || !source_slug || !entity_slug || !type) return null;
  return {
    materializer_id,
    source_slug,
    source_mention:
      typeof raw.source_mention === 'string'
        ? raw.source_mention
        : `@${source_slug}`,
    source_kind: typeof raw.source_kind === 'string' ? raw.source_kind : 'person',
    source_path: typeof raw.source_path === 'string' ? raw.source_path : '',
    entity: typeof raw.entity === 'string' ? raw.entity : `@${entity_slug}`,
    entity_slug,
    target_status:
      typeof raw.target_status === 'string' ? raw.target_status : 'existing',
    trigger_condition:
      typeof raw.trigger_condition === 'string' ? raw.trigger_condition : '',
    trigger_source:
      typeof raw.trigger_source === 'string' ? raw.trigger_source : 'manual_only',
    type,
    scope: typeof raw.scope === 'string' ? raw.scope : '',
    effect: typeof raw.effect === 'string' ? raw.effect : '',
  };
}

function normalizeMaterializerType(type: string): string {
  return type
    .split('/')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .join('/');
}

// Mirrors `vault_scan.MENTION_PATTERN` byte-for-byte so the runtime
// extracts the same @-mentions the Python compiler did when it
// minted the materializer rows.
const MENTION_PATTERN = /@[A-Za-z0-9][A-Za-z0-9' -]*[A-Za-z0-9]/g;

/** Lift every `@Name` substring out of `text` and return its slug
 *  form. Mirrors `vault_scan.clean_mention` semantics: strip a
 *  trailing `.,;:)` and a `" - <digits>"` price tail. Slugs are
 *  minted with the same rules as `vault_scan.get_slug`: lowercase,
 *  drop `'`, collapse non-`[a-z0-9]` runs to `-`, trim. */
function scanMentions(text: string): Array<{mention: string; slug: string}> {
  if (!text) return [];
  const out: Array<{mention: string; slug: string}> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const mention = cleanMention(match[0]);
    const slug = slugify(mention);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({mention, slug});
  }
  return out;
}

function cleanMention(raw: string): string {
  let mention = raw.trim().replace(/[.,;:)]+$/, '');
  mention = mention.replace(/\s+-\s+\d+$/, '');
  return mention;
}

function slugify(mention: string): string {
  const stripped = mention.startsWith('@') ? mention.slice(1) : mention;
  return stripped
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function resolveSlugIds(
  slugs: string[],
  cartridgeId: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (slugs.length === 0) return out;
  const sql = cartridgeId
    ? `SELECT id, profile->>'source_slug' AS source_slug
         FROM entities
        WHERE profile->>'source_slug' = ANY($1::text[])
          AND cartridge_id = $2`
    : `SELECT id, profile->>'source_slug' AS source_slug
         FROM entities
        WHERE profile->>'source_slug' = ANY($1::text[])`;
  const params: unknown[] = cartridgeId ? [slugs, cartridgeId] : [slugs];
  const rows = await query<{id: number | string; source_slug: string | null}>(
    sql,
    params,
  );
  for (const row of rows.rows) {
    const slug = String(row.source_slug ?? '').trim().toLowerCase();
    if (!slug) continue;
    if (!out.has(slug)) out.set(slug, Number(row.id));
  }
  return out;
}
