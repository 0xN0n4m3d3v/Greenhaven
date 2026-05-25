/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 138: compact continuity briefing for resume/start/long-gap turns.

import {query} from '../../../db.js';

export interface ContinuityPacket {
  playerId: number;
  sessionId: string;
  locationId: number | null;
  sceneId: number | null;
  activeQuestIds: number[];
  focusedActorIds: number[];
  unresolvedPromiseMemoryIds: number[];
  recentThreadIds: string[];
  warnings: string[];
}

export async function buildContinuityPacket(args: {
  playerId: number;
  sessionId: string;
}): Promise<ContinuityPacket> {
  const player = await query<{
    current_location_id: number | null;
    current_scene_id: number | null;
    dialogue_partner_id: number | null;
  }>(
    `SELECT current_location_id, current_scene_id, dialogue_partner_id
       FROM players
      WHERE entity_id = $1
      LIMIT 1`,
    [args.playerId],
  );
  const activeQuests = await query<{quest_entity_id: number}>(
    `SELECT quest_entity_id
       FROM player_quests
      WHERE player_id = $1
        AND status = 'active'
      ORDER BY started_at NULLS LAST, quest_entity_id
      LIMIT 8`,
    [args.playerId],
  );
  const promises = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE (about_entity_id = $1 OR owner_entity_id = $1)
        AND memory_kind = 'promise'
        AND NOT (tags && ARRAY['resolved','closed']::text[])
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT 8`,
    [args.playerId],
  );
  const threads = await query<{id: string}>(
    `SELECT id
       FROM memory_threads
      WHERE player_id = $1
        AND (session_id = $2 OR session_id IS NULL)
      ORDER BY updated_at DESC
      LIMIT 4`,
    [args.playerId, args.sessionId],
  );

  const p = player.rows[0];
  const warnings: string[] = [];
  if (!p) warnings.push('player state not found');
  if (threads.rows.length === 0) warnings.push('no session memory thread yet');

  return {
    playerId: args.playerId,
    sessionId: args.sessionId,
    locationId: p?.current_location_id ?? null,
    sceneId: p?.current_scene_id ?? null,
    activeQuestIds: activeQuests.rows.map(row => Number(row.quest_entity_id)),
    focusedActorIds:
      p?.dialogue_partner_id != null ? [Number(p.dialogue_partner_id)] : [],
    unresolvedPromiseMemoryIds: promises.rows.map(row => Number(row.id)),
    recentThreadIds: threads.rows.map(row => row.id),
    warnings: warnings.slice(0, 8),
  };
}

export function renderContinuityPacket(packet: ContinuityPacket): string {
  const lines = ['## CONTINUITY PACKET'];
  lines.push(
    `- Player ${packet.playerId}; location=${packet.locationId ?? 'none'}; scene=${packet.sceneId ?? 'none'}`,
  );
  if (packet.activeQuestIds.length > 0) {
    lines.push(`- Active quests: ${packet.activeQuestIds.join(', ')}`);
  }
  if (packet.focusedActorIds.length > 0) {
    lines.push(`- Focused actors: ${packet.focusedActorIds.join(', ')}`);
  }
  if (packet.unresolvedPromiseMemoryIds.length > 0) {
    lines.push(
      `- Unresolved promise memories: ${packet.unresolvedPromiseMemoryIds.join(', ')}`,
    );
  }
  if (packet.recentThreadIds.length > 0) {
    lines.push(`- Recent memory threads: ${packet.recentThreadIds.join(', ')}`);
  }
  if (packet.warnings.length > 0) {
    lines.push(`- Warnings: ${packet.warnings.join(' | ')}`);
  }
  return lines.join('\n');
}
