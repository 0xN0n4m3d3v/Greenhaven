/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — scene-instructions runtime read layer.
//
// Bridges the generated `forge_scene_instructions` cartridge_meta
// document (produced by `exportGrinhavenSql` in
// `packages/cartridge-forge`) with the runtime `entities` table so
// the turn-context builder can:
//
//   * see authored scene rows for the current location;
//   * see NPC-attached scene rows for the focused dialogue partner
//     and any active dialogue participants;
//   * fall back gracefully when the bridge meta is missing — the
//     catalog stays empty and the relevant-rows query returns `[]`
//     instead of throwing.
//
// This module is intentionally read-only. The scene instructions
// are static cartridge content; runtime mutation (`state_fields`
// allocation, transition firing) continues to flow through the
// existing runtime_fields pipeline.

import {query} from '../db.js';
import {bridgeCacheKey, readScopedBridgeMeta} from './scopedBridgeMeta.js';

const BRIDGE_META_KEY = 'forge_scene_instructions';
const BRIDGE_SCHEMA_VERSION = 'greenhaven.scene_instructions.v1';

export interface SceneInstructionBridgeOptions {
  /** Active cartridge id. Threaded by callers that resolve player
   *  scope so the catalog comes from `cartridge_meta_scoped` for
   *  that cartridge. Omit for legacy / scriptless callers. */
  cartridgeId?: string | null;
}

export type ScenePriority = 'low' | 'normal' | 'high';

export interface SceneStateField {
  key: string;
  type: string;
  default?: unknown;
  scope?: string;
  description?: string;
}

export interface SceneVisualAsset {
  path: string;
  role?: string;
}

export interface SceneMediaCommand {
  action: string;
  asset_role?: string;
  label?: string;
  title?: string;
  caption?: string;
  alt?: string;
  loop?: boolean;
  volume?: number;
}

export interface SceneInstructionEntry {
  sceneSlug: string;
  sceneMention: string;
  sourceKind: string;
  sourcePath: string;
  locationSlug: string | null;
  locationEntityId: number | null;
  ownerNpcSlug: string | null;
  ownerNpcEntityId: number | null;
  participantSlugs: string[];
  participantEntityIds: number[];
  trigger: string;
  priority: ScenePriority;
  hook: string;
  beatByBeat: string;
  playerChoices: string;
  memoryAndStringChanges: string;
  successResult: string;
  failureResult: string;
  behavior: string;
  doNot: string;
  voice: string;
  modelInstructions: string[];
  stateFields: SceneStateField[];
  mediaScript: SceneMediaCommand[];
  visualAsset: SceneVisualAsset | null;
}

export interface RelevantSceneQuery {
  /** Current player location. `null` skips location-anchored rows. */
  locationId?: number | null;
  /** Focused dialogue partner. `null` skips NPC-anchored rows. */
  focusedNpcId?: number | null;
  /** Additional active dialogue participants. */
  participantIds?: readonly number[];
  /** Soft cap on returned rows. Defaults to 6 so the preamble
   *  block stays bounded. */
  limit?: number;
  /** Active cartridge id (see `SceneInstructionBridgeOptions`). */
  cartridgeId?: string | null;
}

interface RawBridgeMeta {
  schema_version?: unknown;
  source_project?: unknown;
  rows?: unknown;
}

interface BuiltCatalog {
  rows: SceneInstructionEntry[];
  byLocationId: Map<number, SceneInstructionEntry[]>;
  byOwnerNpcId: Map<number, SceneInstructionEntry[]>;
  byParticipantId: Map<number, SceneInstructionEntry[]>;
  bridgeAvailable: boolean;
}

const cachedCatalogByScope = new Map<string, Promise<BuiltCatalog>>();

export function clearSceneInstructionBridgeCache(): void {
  cachedCatalogByScope.clear();
}

export async function isSceneInstructionBridgeAvailable(
  opts?: SceneInstructionBridgeOptions,
): Promise<boolean> {
  return (await getCatalog(opts)).bridgeAvailable;
}

export async function listSceneInstructionEntries(
  opts?: SceneInstructionBridgeOptions,
): Promise<SceneInstructionEntry[]> {
  return (await getCatalog(opts)).rows;
}

/** Pull every authored scene-instruction row relevant to the
 *  current turn frame: location-anchored rows for the player's
 *  current location, NPC-anchored rows for the focused partner,
 *  and NPC-anchored rows where the focused / participant NPCs are
 *  authored as scene participants. Rows are deduped, ordered by
 *  priority (`high` > `normal` > `low`) then `scene_slug`, and
 *  capped at `limit`.
 */
export async function listRelevantSceneInstructions(
  q: RelevantSceneQuery,
): Promise<SceneInstructionEntry[]> {
  const catalog = await getCatalog({cartridgeId: q.cartridgeId ?? null});
  if (!catalog.bridgeAvailable) return [];
  const seen = new Set<string>();
  const out: SceneInstructionEntry[] = [];
  const push = (row: SceneInstructionEntry) => {
    if (seen.has(row.sceneSlug)) return;
    seen.add(row.sceneSlug);
    out.push(row);
  };
  if (q.locationId != null) {
    for (const r of catalog.byLocationId.get(q.locationId) ?? []) push(r);
  }
  if (q.focusedNpcId != null) {
    for (const r of catalog.byOwnerNpcId.get(q.focusedNpcId) ?? []) push(r);
    for (const r of catalog.byParticipantId.get(q.focusedNpcId) ?? []) push(r);
  }
  for (const pid of q.participantIds ?? []) {
    for (const r of catalog.byOwnerNpcId.get(pid) ?? []) push(r);
    for (const r of catalog.byParticipantId.get(pid) ?? []) push(r);
  }
  out.sort((a, b) => {
    const pa = priorityRank(a.priority);
    const pb = priorityRank(b.priority);
    if (pa !== pb) return pa - pb;
    return a.sceneSlug.localeCompare(b.sceneSlug);
  });
  const limit = Math.max(0, q.limit ?? 6);
  return out.slice(0, limit);
}

export async function findSceneInstructionEntry(
  sceneSlug: string,
  opts?: SceneInstructionBridgeOptions,
): Promise<SceneInstructionEntry | null> {
  const normalized = sceneSlug.trim().toLowerCase();
  if (!normalized) return null;
  const catalog = await getCatalog(opts);
  return catalog.rows.find(row => row.sceneSlug === normalized) ?? null;
}

function priorityRank(p: ScenePriority): number {
  switch (p) {
    case 'high':
      return 0;
    case 'normal':
      return 1;
    case 'low':
    default:
      return 2;
  }
}

async function getCatalog(
  opts?: SceneInstructionBridgeOptions,
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
  const rawRows = parseRows(meta);
  if (rawRows.length === 0) {
    return {
      rows: [],
      byLocationId: new Map(),
      byOwnerNpcId: new Map(),
      byParticipantId: new Map(),
      bridgeAvailable: false,
    };
  }
  const slugs = new Set<string>();
  for (const row of rawRows) {
    if (row.location_slug) slugs.add(row.location_slug);
    if (row.owner_npc_slug) slugs.add(row.owner_npc_slug);
    for (const p of row.participant_slugs) slugs.add(p);
  }
  const slugToId = await resolveSlugIds(Array.from(slugs), cartridgeId);

  const rows: SceneInstructionEntry[] = [];
  const byLocationId = new Map<number, SceneInstructionEntry[]>();
  const byOwnerNpcId = new Map<number, SceneInstructionEntry[]>();
  const byParticipantId = new Map<number, SceneInstructionEntry[]>();
  for (const raw of rawRows) {
    const locationEntityId =
      raw.location_slug ? slugToId.get(raw.location_slug) ?? null : null;
    const ownerNpcEntityId =
      raw.owner_npc_slug ? slugToId.get(raw.owner_npc_slug) ?? null : null;
    const participantEntityIds: number[] = [];
    for (const p of raw.participant_slugs) {
      const id = slugToId.get(p);
      if (id != null && !participantEntityIds.includes(id)) {
        participantEntityIds.push(id);
      }
    }
    const entry: SceneInstructionEntry = {
      sceneSlug: raw.scene_slug,
      sceneMention: raw.scene_mention,
      sourceKind: raw.source_kind,
      sourcePath: raw.source_path,
      locationSlug: raw.location_slug,
      locationEntityId,
      ownerNpcSlug: raw.owner_npc_slug,
      ownerNpcEntityId,
      participantSlugs: raw.participant_slugs,
      participantEntityIds,
      trigger: raw.trigger,
      priority: raw.priority,
      hook: raw.hook,
      beatByBeat: raw.beat_by_beat,
      playerChoices: raw.player_choices,
      memoryAndStringChanges: raw.memory_and_string_changes,
      successResult: raw.success_result,
      failureResult: raw.failure_result,
      behavior: raw.behavior,
      doNot: raw.do_not,
      voice: raw.voice,
      modelInstructions: raw.model_instructions,
      stateFields: raw.state_fields,
      mediaScript: raw.media_script,
      visualAsset: raw.visual_asset,
    };
    rows.push(entry);
    if (locationEntityId != null) {
      append(byLocationId, locationEntityId, entry);
    }
    if (ownerNpcEntityId != null) {
      append(byOwnerNpcId, ownerNpcEntityId, entry);
    }
    for (const id of participantEntityIds) {
      append(byParticipantId, id, entry);
    }
  }
  return {rows, byLocationId, byOwnerNpcId, byParticipantId, bridgeAvailable: true};
}

function append(
  map: Map<number, SceneInstructionEntry[]>,
  id: number,
  entry: SceneInstructionEntry,
): void {
  const arr = map.get(id);
  if (arr) arr.push(entry);
  else map.set(id, [entry]);
}

interface CleanRow {
  scene_slug: string;
  scene_mention: string;
  source_kind: string;
  source_path: string;
  location_slug: string | null;
  owner_npc_slug: string | null;
  participant_slugs: string[];
  trigger: string;
  priority: ScenePriority;
  hook: string;
  beat_by_beat: string;
  player_choices: string;
  memory_and_string_changes: string;
  success_result: string;
  failure_result: string;
  behavior: string;
  do_not: string;
  voice: string;
  model_instructions: string[];
  state_fields: SceneStateField[];
  media_script: SceneMediaCommand[];
  visual_asset: SceneVisualAsset | null;
}

function parseRows(meta: RawBridgeMeta | undefined): CleanRow[] {
  if (!meta || typeof meta !== 'object') return [];
  if (meta.schema_version !== BRIDGE_SCHEMA_VERSION) return [];
  if (!Array.isArray(meta.rows)) return [];
  const out: CleanRow[] = [];
  for (const raw of meta.rows) {
    const row = parseRow(raw);
    if (row) out.push(row);
  }
  return out;
}

function parseRow(value: unknown): CleanRow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const scene_slug =
    typeof raw.scene_slug === 'string' ? raw.scene_slug.trim().toLowerCase() : '';
  if (!scene_slug) return null;
  const scene_mention =
    typeof raw.scene_mention === 'string' ? raw.scene_mention : `@${scene_slug}`;
  const source_kind = typeof raw.source_kind === 'string' ? raw.source_kind : 'scene';
  const source_path = typeof raw.source_path === 'string' ? raw.source_path : '';
  const location_slug =
    typeof raw.location_slug === 'string' && raw.location_slug.trim()
      ? raw.location_slug.trim().toLowerCase()
      : null;
  const owner_npc_slug =
    typeof raw.owner_npc_slug === 'string' && raw.owner_npc_slug.trim()
      ? raw.owner_npc_slug.trim().toLowerCase()
      : null;
  const participant_slugs = Array.isArray(raw.participant_slugs)
    ? Array.from(
        new Set(
          raw.participant_slugs
            .filter((s): s is string => typeof s === 'string')
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length > 0),
        ),
      )
    : [];
  const priority = parsePriority(raw.priority);
  const hook = typeof raw.hook === 'string' ? raw.hook : '';
  const beat_by_beat =
    typeof raw.beat_by_beat === 'string' ? raw.beat_by_beat : '';
  const player_choices =
    typeof raw.player_choices === 'string' ? raw.player_choices : '';
  const memory_and_string_changes =
    typeof raw.memory_and_string_changes === 'string'
      ? raw.memory_and_string_changes
      : '';
  const success_result =
    typeof raw.success_result === 'string' ? raw.success_result : '';
  const failure_result =
    typeof raw.failure_result === 'string' ? raw.failure_result : '';
  const behavior = typeof raw.behavior === 'string' ? raw.behavior : '';
  const do_not = typeof raw.do_not === 'string' ? raw.do_not : '';
  const trigger = typeof raw.trigger === 'string' ? raw.trigger : '';
  const voice = typeof raw.voice === 'string' ? raw.voice : '';
  const model_instructions = Array.isArray(raw.model_instructions)
    ? raw.model_instructions
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.trim())
        .filter(s => s.length > 0)
    : [];
  const state_fields = Array.isArray(raw.state_fields)
    ? raw.state_fields
        .map(parseStateField)
        .filter((f): f is SceneStateField => f !== null)
    : [];
  const media_script = Array.isArray(raw.media_script)
    ? raw.media_script
        .map(parseMediaCommand)
        .filter((f): f is SceneMediaCommand => f !== null)
    : [];
  const visual_asset = parseVisualAsset(raw.visual_asset);
  return {
    scene_slug,
    scene_mention,
    source_kind,
    source_path,
    location_slug,
    owner_npc_slug,
    participant_slugs,
    trigger,
    priority,
    hook,
    beat_by_beat,
    player_choices,
    memory_and_string_changes,
    success_result,
    failure_result,
    behavior,
    do_not,
    voice,
    model_instructions,
    state_fields,
    media_script,
    visual_asset,
  };
}

function parsePriority(value: unknown): ScenePriority {
  if (typeof value !== 'string') return 'normal';
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'low' || trimmed === 'high') return trimmed;
  return 'normal';
}

function parseStateField(value: unknown): SceneStateField | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const out: SceneStateField = {
    key,
    type: typeof raw.type === 'string' ? raw.type : 'string',
  };
  if (raw.default !== undefined) out.default = raw.default;
  if (typeof raw.scope === 'string') out.scope = raw.scope;
  if (typeof raw.description === 'string') out.description = raw.description;
  return out;
}

function parseVisualAsset(value: unknown): SceneVisualAsset | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path) return null;
  const out: SceneVisualAsset = {path};
  if (typeof raw.role === 'string') out.role = raw.role;
  return out;
}

function parseMediaCommand(value: unknown): SceneMediaCommand | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : '';
  if (!action) return null;
  const out: SceneMediaCommand = {action};
  if (typeof raw.asset_role === 'string' && raw.asset_role.trim()) {
    out.asset_role = raw.asset_role.trim().toLowerCase();
  }
  if (typeof raw.label === 'string' && raw.label.trim()) {
    out.label = raw.label.trim();
  }
  if (typeof raw.title === 'string' && raw.title.trim()) {
    out.title = raw.title.trim();
  }
  if (typeof raw.caption === 'string' && raw.caption.trim()) {
    out.caption = raw.caption.trim();
  }
  if (typeof raw.alt === 'string' && raw.alt.trim()) {
    out.alt = raw.alt.trim();
  }
  if (typeof raw.loop === 'boolean') out.loop = raw.loop;
  if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) {
    out.volume = Math.max(0, Math.min(1, raw.volume));
  }
  return out;
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
