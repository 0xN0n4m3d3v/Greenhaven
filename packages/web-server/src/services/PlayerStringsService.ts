/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';
import {
  stringBandForCount,
  stringEdgeId,
  stringFallbackSummary,
  stringIntensityForCount,
  stringKindForCount,
  stringValenceForCount,
} from '../stringsContract.js';

export interface PlayerStringsGraph {
  playerId: number;
  asOfTurn: string | null;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

export class PlayerStringsService {
  static async graph(
    playerId: number,
    language?: string | null,
  ): Promise<PlayerStringsGraph | null> {
    const player = await query<{
      entity_id: number | string;
      display_name: string;
      persona_slug: string | null;
    }>(
      `SELECT p.entity_id,
              e.display_name,
              e.persona_slug
         FROM players p
         JOIN entities e ON e.id = p.entity_id
        WHERE p.entity_id = $1`,
      [playerId],
    );
    const playerRow = player.rows[0];
    if (!playerRow) return null;

    void language;
    const latest = await latestStringEvents(playerId);
    const asOfTurn = latest.asOfTurn ?? (await latestTurnId(playerId));

    const nodes: Array<Record<string, unknown>> = [
      {
        id: Number(playerRow.entity_id),
        kind: 'player',
        name: playerRow.display_name,
        portraitPersonaId: playerRow.persona_slug,
      },
    ];
    const edges: Array<Record<string, unknown>> = [];
    const seenNodes = new Set<number>([playerId]);

    const rows = await query<{
      id: number | string;
      display_name: string;
      persona_slug: string | null;
      strings: unknown;
    }>(
      `SELECT e.id,
              e.display_name,
              e.persona_slug,
              COALESCE(rv.value, rf.default_value, '{}'::jsonb) AS strings
         FROM runtime_fields rf
         JOIN entities e ON e.id = rf.owner_entity_id
         LEFT JOIN runtime_values rv ON rv.field_id = rf.id
        WHERE rf.field_key = 'strings'
          AND e.kind = 'person'
        ORDER BY e.display_name, e.id`,
    );

    for (const row of rows.rows) {
      const npcId = Number(row.id);
      if (!Number.isInteger(npcId) || npcId <= 0) continue;
      const map = readStringMap(row.strings);
      const count = Number(map[String(playerId)] ?? 0);
      if (!Number.isFinite(count) || count === 0) continue;
      const npcName = row.display_name;
      if (!seenNodes.has(npcId)) {
        seenNodes.add(npcId);
        nodes.push({
          id: npcId,
          kind: 'npc',
          name: npcName,
          portraitPersonaId: row.persona_slug,
        });
      }
      const latestForNpc = latest.byNpcId.get(npcId);
      const band = stringBandForCount(count);
      edges.push({
        id: stringEdgeId(playerId, npcId),
        from: playerId,
        to: npcId,
        kind: stringKindForCount(count),
        intensity: stringIntensityForCount(count),
        valence: stringValenceForCount(count),
        lastEventId: latestForNpc?.eventId ?? null,
        lastTurnId: latestForNpc?.turnId ?? null,
        summary:
          latestForNpc?.summary ??
          stringFallbackSummary({npcName, count, band}),
      });
    }

    return {
      playerId,
      asOfTurn,
      nodes,
      edges,
    };
  }
}

function readStringMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n))
      out[key] = Math.max(-10, Math.min(10, Math.trunc(n)));
  }
  return out;
}

async function latestStringEvents(playerId: number): Promise<{
  asOfTurn: string | null;
  byNpcId: Map<
    number,
    {eventId: string; turnId: string | null; summary: string | null}
  >;
}> {
  const events = await query<{
    id: number | string;
    turn_id: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, turn_id, payload
       FROM gui_events
      WHERE player_id = $1
        AND event_type = 'string:changed'
      ORDER BY release_seq DESC NULLS LAST, id DESC
      LIMIT 200`,
    [playerId],
  );
  const byNpcId = new Map<
    number,
    {eventId: string; turnId: string | null; summary: string | null}
  >();
  let asOfTurn: string | null = null;
  for (const event of events.rows) {
    const payload = event.payload ?? {};
    const npcId = Number(payload['to'] ?? payload['npcId']);
    if (!Number.isInteger(npcId) || byNpcId.has(npcId)) continue;
    const turnId = stringOrNull(payload['turnId']) ?? event.turn_id ?? null;
    if (!asOfTurn && turnId) asOfTurn = turnId;
    byNpcId.set(npcId, {
      eventId: String(event.id),
      turnId,
      summary:
        stringOrNull(payload['summary']) ??
        stringOrNull(payload['reason']) ??
        null,
    });
  }
  return {asOfTurn, byNpcId};
}

async function latestTurnId(playerId: number): Promise<string | null> {
  const latest = await query<{turn_id: string | null}>(
    `SELECT turn_id
       FROM gui_events
      WHERE player_id = $1 AND turn_id IS NOT NULL
      ORDER BY release_seq DESC NULLS LAST, id DESC
      LIMIT 1`,
    [playerId],
  );
  return latest.rows[0]?.turn_id ?? null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
