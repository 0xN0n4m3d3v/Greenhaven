/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-PRESENCE-1 — batched per-NPC relationship + actor-status reader
// for the `/api/session/:id/locations` `nearby[]` enrichment. Reads
// strictly from server-canonical sources (`runtime_fields` /
// `runtime_values` for relationship strings; `actor_statuses` for
// visible status effects) and never exposes the underlying string
// count or hidden status kinds; the UI only sees a stable band
// (`hostile` / `wary` / `neutral` / `friendly` / `trusted` / `bonded`)
// plus a small whitelisted list of status values.
//
// Status whitelist: only public, player-facing status entries are
// returned. Private NPC thoughts (`emotion`, `mood`, `intent`, etc.)
// stay inside the broker prompt path and never leak to the rail.

import {query} from './db.js';
import {clampStringCount, stringBandForCount} from './stringsContract.js';
import type {RelationshipBand} from './stringsContract.js';

export interface PresenceRelationship {
  band: RelationshipBand;
  /** Clamped count (-10..10). Useful for sorting / sparklines; UI
   *  surfaces the band label rather than the raw count. */
  count: number;
}

export interface PresenceStatusBadge {
  /** Stable kind label (e.g. `injured`, `tired`, `friendly`,
   *  `hostile`, `dead`, `missing`). Pulled from the source row's
   *  `status_kind` after the whitelist filter. */
  kind: string;
  /** Author-supplied descriptor (e.g. `flesh-wound`, `exhausted`).
   *  Always non-empty per the DB CHECK constraint. */
  value: string;
  /** Source's `intensity` field, clamped to [0, 1]. */
  intensity: number;
}

export interface PresenceEnrichment {
  /** Map keyed by NPC entity id → relationship band + clamped count.
   *  Missing entries indicate "no relationship recorded yet" and
   *  callers should render a neutral / unknown badge. */
  relationships: Map<number, PresenceRelationship>;
  /** Map keyed by NPC entity id → status badges, capped per NPC to
   *  keep the rail payload compact. Order is `intensity DESC,
   *  updated_at DESC` so the strongest current effect leads. */
  statuses: Map<number, PresenceStatusBadge[]>;
}

const STATUS_PER_NPC_CAP = 3;

// Public, player-facing actor-status kinds the rail / map / profile
// modal may render. Anything outside the whitelist (private NPC
// thoughts, internal-state markers, gossip flags) is excluded by the
// SQL filter below so the read model cannot leak it.
const PUBLIC_STATUS_KINDS: readonly string[] = [
  'injured',
  'wounded',
  'sick',
  'tired',
  'exhausted',
  'drunk',
  'asleep',
  'unconscious',
  'busy',
  'hostile',
  'wary',
  'friendly',
  'grieving',
  'missing',
  'dead',
];

/**
 * Build per-NPC relationship + status enrichment for `nearby[]`.
 *
 * Both sub-queries are bounded: relationships are read once per
 * `runtime_fields` row owned by the listed NPCs; statuses select
 * up to {@link STATUS_PER_NPC_CAP} per NPC ordered by
 * `intensity DESC, updated_at DESC` via SQL window function.
 *
 * Empty `npcIds` short-circuits to empty maps so callers don't pay
 * for a wasted round-trip when a location has no NPCs.
 */
export async function buildPresenceEnrichment(
  playerId: number,
  npcIds: readonly number[],
): Promise<PresenceEnrichment> {
  const relationships = new Map<number, PresenceRelationship>();
  const statuses = new Map<number, PresenceStatusBadge[]>();
  if (npcIds.length === 0 || !Number.isInteger(playerId) || playerId <= 0) {
    return {relationships, statuses};
  }

  const filtered = npcIds.filter(
    (id): id is number => Number.isInteger(id) && id > 0,
  );
  if (filtered.length === 0) return {relationships, statuses};

  const relRows = await query<{owner_entity_id: number | string; strings: unknown}>(
    `SELECT rf.owner_entity_id,
            COALESCE(rv.value, rf.default_value, '{}'::jsonb) AS strings
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.field_key = 'strings'
        AND rf.owner_entity_id = ANY($1::bigint[])`,
    [filtered],
  );
  for (const row of relRows.rows) {
    const npcId = Number(row.owner_entity_id);
    if (!Number.isInteger(npcId) || npcId <= 0) continue;
    const map = readStringMap(row.strings);
    const raw = Number(map[String(playerId)] ?? 0);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const count = clampStringCount(raw);
    relationships.set(npcId, {band: stringBandForCount(count), count});
  }

  const statusRows = await query<{
    actor_entity_id: number | string;
    status_kind: string;
    status_value: string;
    intensity: number;
  }>(
    `SELECT actor_entity_id, status_kind, status_value, intensity
       FROM (
         SELECT s.actor_entity_id,
                s.status_kind,
                s.status_value,
                s.intensity,
                ROW_NUMBER() OVER (
                  PARTITION BY s.actor_entity_id
                  ORDER BY s.intensity DESC, s.updated_at DESC
                ) AS rn
           FROM actor_statuses s
          WHERE s.player_id = $1::bigint
            AND s.actor_entity_id = ANY($2::bigint[])
            AND s.intensity > 0
            AND s.status_kind = ANY($3::text[])
       ) ranked
      WHERE ranked.rn <= $4
      ORDER BY actor_entity_id, intensity DESC`,
    [playerId, filtered, PUBLIC_STATUS_KINDS, STATUS_PER_NPC_CAP],
  );
  for (const row of statusRows.rows) {
    const npcId = Number(row.actor_entity_id);
    if (!Number.isInteger(npcId) || npcId <= 0) continue;
    const intensity = clampIntensity(row.intensity);
    const badge: PresenceStatusBadge = {
      kind: row.status_kind,
      value: row.status_value,
      intensity,
    };
    const bucket = statuses.get(npcId);
    if (bucket) bucket.push(badge);
    else statuses.set(npcId, [badge]);
  }

  return {relationships, statuses};
}

function readStringMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = clampStringCount(n);
  }
  return out;
}

function clampIntensity(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return Math.round(n * 100) / 100;
}
