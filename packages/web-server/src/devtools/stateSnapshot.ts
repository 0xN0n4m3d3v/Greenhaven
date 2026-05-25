/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';
import {redactRecord} from './dbQuery.js';

export const STATE_SNAPSHOT_SCHEMA_VERSION = 1;

export interface StateSnapshotOptions {
  playerId: number;
  sessionId?: string;
  limit?: number;
}

export interface StateSnapshot {
  schemaVersion: number;
  capturedAt: string;
  scope: {playerId: number; sessionId?: string};
  data: Record<string, unknown>;
}

export interface StateDiff {
  ok: true;
  schemaVersion: number;
  summary: {domainsChanged: number; added: number; removed: number; changed: number};
  groups: Array<{
    domain: string;
    added: unknown[];
    removed: unknown[];
    changed: Array<{key: string; before: unknown; after: unknown}>;
  }>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

export async function captureStateSnapshot(
  options: StateSnapshotOptions,
): Promise<StateSnapshot> {
  const limit = clampLimit(options.limit);
  const [
    player,
    sessions,
    chat,
    tools,
    inventory,
    legacyInventory,
    quests,
    runtimeValues,
    overlays,
    stats,
    skills,
  ] =
    await Promise.all([
      loadPlayer(options.playerId),
      loadSessions(options.playerId, options.sessionId, limit),
      loadChat(options.playerId, options.sessionId, limit),
      loadToolInvocations(options.playerId, options.sessionId, limit),
      loadPlayerInventory(options.playerId),
      loadLegacyInventory(options.playerId),
      loadPlayerQuests(options.playerId),
      loadRuntimeValues(),
      loadRuntimeOverlay(options.playerId),
      loadPlayerStats(options.playerId),
      loadPlayerSkills(options.playerId),
    ]);

  return redactRecord({
    schemaVersion: STATE_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    scope: {
      playerId: options.playerId,
      ...(options.sessionId ? {sessionId: options.sessionId} : {}),
    },
    data: {
      player,
      sessions,
      chat_messages: chat,
      tool_invocations: tools,
      player_inventory: inventory,
      inventory_entries: legacyInventory,
      player_quests: quests,
      runtime_values: runtimeValues,
      runtime_player_overlay: overlays,
      player_stats: stats,
      player_skills: skills,
    },
  }) as StateSnapshot;
}

export function diffStateSnapshots(
  before: StateSnapshot,
  after: StateSnapshot,
): StateDiff {
  const domains = new Set([
    ...Object.keys(before.data ?? {}),
    ...Object.keys(after.data ?? {}),
  ]);
  const groups: StateDiff['groups'] = [];
  let addedTotal = 0;
  let removedTotal = 0;
  let changedTotal = 0;

  for (const domain of [...domains].sort()) {
    const b = toRows((before.data ?? {})[domain]);
    const a = toRows((after.data ?? {})[domain]);
    const beforeMap = keyRows(domain, b);
    const afterMap = keyRows(domain, a);
    const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const changed: Array<{key: string; before: unknown; after: unknown}> = [];
    for (const key of [...keys].sort()) {
      const bRow = beforeMap.get(key);
      const aRow = afterMap.get(key);
      if (bRow === undefined && aRow !== undefined) added.push(aRow);
      else if (bRow !== undefined && aRow === undefined) removed.push(bRow);
      else if (stableJson(bRow) !== stableJson(aRow)) {
        changed.push({key, before: bRow, after: aRow});
      }
    }
    if (added.length || removed.length || changed.length) {
      addedTotal += added.length;
      removedTotal += removed.length;
      changedTotal += changed.length;
      groups.push({domain, added, removed, changed});
    }
  }

  return {
    ok: true,
    schemaVersion: STATE_SNAPSHOT_SCHEMA_VERSION,
    summary: {
      domainsChanged: groups.length,
      added: addedTotal,
      removed: removedTotal,
      changed: changedTotal,
    },
    groups,
  };
}

async function loadPlayer(playerId: number): Promise<unknown> {
  const r = await query(
    `SELECT e.id, e.display_name, e.kind, e.summary, e.profile, e.tags,
            p.public_id, p.class_id, p.current_xp, p.current_level,
            p.current_hp, p.max_hp, p.current_location_id,
            p.current_scene_id, p.dialogue_partner_id, p.metadata
       FROM players p
       JOIN entities e ON e.id = p.entity_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  return r.rows[0] ?? null;
}

async function loadSessions(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const params: unknown[] = [playerId];
  let where = `player_id = $1`;
  if (sessionId) {
    params.push(sessionId);
    where = `(player_id = $1 OR id = $2)`;
  }
  const r = await query(
    `SELECT id, player_id, started_at, last_seen, metadata
       FROM sessions
      WHERE ${where}
      ORDER BY last_seen DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows;
}

async function loadChat(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const params: unknown[] = [playerId];
  let where = `cm.player_id = $1`;
  if (sessionId) {
    params.push(sessionId);
    where = `(cm.player_id = $1 OR cm.session_id = $2)`;
  }
  const r = await query(
    `SELECT cm.id, cm.session_id, cm.player_id, cm.author_entity_id,
            e.display_name AS author_name, cm.tone, cm.text, cm.turn_index,
            cm.payload, cm.created_at
       FROM chat_messages cm
       LEFT JOIN entities e ON e.id = cm.author_entity_id
      WHERE ${where}
      ORDER BY cm.id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

async function loadToolInvocations(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const params: unknown[] = [playerId];
  let where = `player_id = $1`;
  if (sessionId) {
    params.push(sessionId);
    where = `(player_id = $1 OR session_id = $2)`;
  }
  const r = await query(
    `SELECT id, session_id, player_id, turn_id, tool_name, args,
            result, error, duration_ms, invoked_at
       FROM tool_invocations
      WHERE ${where}
      ORDER BY id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

async function loadPlayerInventory(playerId: number): Promise<unknown[]> {
  const r = await query(
    `SELECT pi.player_id, pi.item_id, i.slug, i.category,
            pi.quantity, pi.equipped, pi.meta
       FROM player_inventory pi
       JOIN items i ON i.id = pi.item_id
      WHERE pi.player_id = $1
      ORDER BY i.slug, pi.equipped`,
    [playerId],
  );
  return r.rows;
}

async function loadLegacyInventory(playerId: number): Promise<unknown[]> {
  const r = await query(
    `SELECT ie.holder_entity_id, holder.display_name AS holder_name,
            ie.item_entity_id, item.display_name AS item_name,
            ie.count, ie.metadata
       FROM inventory_entries ie
       JOIN entities holder ON holder.id = ie.holder_entity_id
       JOIN entities item ON item.id = ie.item_entity_id
      WHERE ie.holder_entity_id = $1
      ORDER BY item.display_name`,
    [playerId],
  );
  return r.rows;
}

async function loadPlayerQuests(playerId: number): Promise<unknown[]> {
  const r = await query(
    `SELECT pq.player_id, pq.quest_entity_id, e.display_name AS quest_title,
            pq.status, pq.current_phase, pq.current_stage_id,
            pq.started_at, pq.completed_at, pq.metadata
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
      ORDER BY e.display_name`,
    [playerId],
  );
  return r.rows;
}

async function loadRuntimeOverlay(playerId: number): Promise<unknown[]> {
  const r = await query(
    `SELECT rpo.field_id, rf.owner_entity_id, e.display_name AS owner_name,
            rf.field_key, rpo.player_id, rpo.value, rpo.source, rpo.updated_at
       FROM runtime_player_overlay rpo
       JOIN runtime_fields rf ON rf.id = rpo.field_id
       JOIN entities e ON e.id = rf.owner_entity_id
      WHERE rpo.player_id = $1
      ORDER BY e.display_name, rf.field_key`,
    [playerId],
  );
  return r.rows;
}

async function loadRuntimeValues(): Promise<unknown[]> {
  const r = await query(
    `SELECT rv.field_id, rf.owner_entity_id, e.display_name AS owner_name,
            rf.field_key, rv.value, rv.source, rv.updated_at
       FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
       JOIN entities e ON e.id = rf.owner_entity_id
      ORDER BY e.display_name, rf.field_key`,
  );
  return r.rows;
}

async function loadPlayerStats(playerId: number): Promise<unknown[]> {
  const r = await query(
    `SELECT player_id, stat_key, base, current
       FROM player_stats
      WHERE player_id = $1
      ORDER BY stat_key`,
    [playerId],
  );
  return r.rows;
}

async function loadPlayerSkills(playerId: number): Promise<unknown[]> {
  const r = await query(
    `SELECT ps.player_id, ps.skill_entity_id, e.display_name AS skill_name,
            ps.rank, ps.unlocked_at, ps.metadata
       FROM player_skills ps
       JOIN entities e ON e.id = ps.skill_entity_id
      WHERE ps.player_id = $1
      ORDER BY e.display_name`,
    [playerId],
  );
  return r.rows;
}

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return Math.min(limit, MAX_LIMIT);
}

function toRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function keyRows(domain: string, rows: unknown[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  rows.forEach((row, index) => {
    const key = isRecord(row) ? rowKey(domain, row, index) : String(index);
    out.set(key, row);
  });
  return out;
}

function rowKey(
  domain: string,
  row: Record<string, unknown>,
  index: number,
): string {
  const byDomain: Record<string, string[]> = {
    player: ['id'],
    sessions: ['id'],
    chat_messages: ['id'],
    tool_invocations: ['id'],
    player_inventory: ['player_id', 'item_id', 'equipped'],
    inventory_entries: ['holder_entity_id', 'item_entity_id'],
    player_quests: ['player_id', 'quest_entity_id'],
    runtime_values: ['field_id'],
    runtime_player_overlay: ['player_id', 'field_id'],
    player_stats: ['player_id', 'stat_key'],
    player_skills: ['player_id', 'skill_entity_id'],
  };
  const keys = byDomain[domain] ?? ['id'];
  const parts = keys.map(k => row[k]).filter(v => v !== undefined && v !== null);
  if (parts.length > 0) {
    return parts.map(String).join(':');
  }
  return String(row['id'] ?? index);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key]);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
