/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 137: bounded memory loop packet. It tells a turn which memory was
// surfaced and what categories are still missing; it does not dump raw
// memory text.
//
// ARCH-6 — internal `*Kind*` names renamed to `*Category*` to avoid the
// "kind" collision with entity/tool/quest discriminators. The
// `memory_kind` DB column name is preserved.

import {query} from '../../../db.js';
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
} from '../kinds.js';

export interface MemoryLoopPacket {
  actorId: number;
  aboutEntityId?: number;
  activeQuestIds: number[];
  recalledMemoryIds: number[];
  usedMemoryIds: number[];
  requiredMemoryCategories: MemoryCategory[];
  missingMemoryCategories: MemoryCategory[];
  clusterIds: string[];
  warnings: string[];
  turnEvidence: {
    playerSignalIds: string[];
    toolCallIds: number[];
    questMutationIds: string[];
    npcInitiativeIds: string[];
    visibleConsequenceIds: string[];
  };
}

interface MemoryRow {
  id: number;
  memory_kind: MemoryCategory | string | null;
  cluster_id: string | null;
  salience: number;
  importance: number;
}

const MAX_MEMORIES = 8;
const MAX_CLUSTERS = 4;
const MAX_WARNINGS = 8;

export async function buildMemoryLoopPacket(args: {
  actorId: number;
  playerId: number;
  aboutEntityId?: number;
  sessionId?: string;
  activeQuestIds?: number[];
  requiredMemoryCategories?: MemoryCategory[];
  usedMemoryIds?: number[];
  toolCallIds?: number[];
}): Promise<MemoryLoopPacket> {
  const aboutId = args.aboutEntityId ?? args.playerId;
  const activeQuestIds =
    args.activeQuestIds ?? (await loadActiveQuestIds(args.playerId));
  const required =
    args.requiredMemoryCategories ?? defaultRequiredCategories(activeQuestIds);
  const memories = await loadTopMemories(args.actorId, aboutId, required);
  const recalled = memories.map(row => Number(row.id));
  const recalledCategories = new Set(
    memories
      .map(row => row.memory_kind)
      .filter((category): category is MemoryCategory => isMemoryCategory(category)),
  );
  const missing = required.filter(category => !recalledCategories.has(category));
  const warnings: string[] = [];
  if (required.length > 0 && recalled.length === 0) {
    warnings.push('important context requested but no relevant memories recalled');
  }
  if (missing.length > 0) {
    warnings.push(`missing memory categories: ${missing.join(', ')}`);
  }

  return {
    actorId: args.actorId,
    aboutEntityId: aboutId,
    activeQuestIds,
    recalledMemoryIds: recalled,
    usedMemoryIds: (args.usedMemoryIds ?? []).slice(0, MAX_MEMORIES),
    requiredMemoryCategories: required,
    missingMemoryCategories: missing,
    clusterIds: [
      ...new Set(
        memories
          .map(row => row.cluster_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ].slice(0, MAX_CLUSTERS),
    warnings: warnings.slice(0, MAX_WARNINGS),
    turnEvidence: {
      playerSignalIds: args.sessionId ? [`session:${args.sessionId}`] : [],
      toolCallIds: (args.toolCallIds ?? []).slice(0, 12),
      questMutationIds: activeQuestIds.map(id => `quest:${id}`).slice(0, 8),
      npcInitiativeIds: [],
      visibleConsequenceIds: [],
    },
  };
}

export function renderMemoryLoopPacket(packet: MemoryLoopPacket): string {
  const lines = ['## MEMORY LOOP'];
  lines.push(
    `- Actor ${packet.actorId}; about=${packet.aboutEntityId ?? 'ambient'}; active_quests=${packet.activeQuestIds.join(', ') || 'none'}`,
  );
  if (packet.requiredMemoryCategories.length > 0) {
    lines.push(`- Required categories: ${packet.requiredMemoryCategories.join(', ')}`);
  }
  if (packet.recalledMemoryIds.length > 0) {
    lines.push(`- Recalled memory ids: ${packet.recalledMemoryIds.join(', ')}`);
  }
  if (packet.usedMemoryIds.length > 0) {
    lines.push(`- Used memory ids: ${packet.usedMemoryIds.join(', ')}`);
  }
  if (packet.clusterIds.length > 0) {
    lines.push(`- Cluster ids: ${packet.clusterIds.join(', ')}`);
  }
  if (packet.missingMemoryCategories.length > 0) {
    lines.push(`- Missing categories: ${packet.missingMemoryCategories.join(', ')}`);
  }
  if (packet.warnings.length > 0) {
    lines.push(`- Warnings: ${packet.warnings.join(' | ')}`);
  }
  return lines.join('\n');
}

async function loadActiveQuestIds(playerId: number): Promise<number[]> {
  const rows = await query<{quest_entity_id: number}>(
    `SELECT quest_entity_id
       FROM player_quests
      WHERE player_id = $1
        AND status = 'active'
      ORDER BY started_at NULLS LAST, quest_entity_id
      LIMIT 8`,
    [playerId],
  );
  return rows.rows.map(row => Number(row.quest_entity_id));
}

async function loadTopMemories(
  actorId: number,
  aboutId: number,
  required: readonly MemoryCategory[],
): Promise<MemoryRow[]> {
  const rows = await query<MemoryRow>(
    `SELECT id, memory_kind, cluster_id, salience, importance
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND (about_entity_id IS NULL OR about_entity_id = $2)
        AND ($3::text[] = '{}'::text[] OR memory_kind = ANY($3::text[]))
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT $4`,
    [actorId, aboutId, required, MAX_MEMORIES],
  );
  if (rows.rows.length > 0 || required.length === 0) return rows.rows;
  const fallback = await query<MemoryRow>(
    `SELECT id, memory_kind, cluster_id, salience, importance
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND (about_entity_id IS NULL OR about_entity_id = $2)
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT $3`,
    [actorId, aboutId, MAX_MEMORIES],
  );
  return fallback.rows;
}

function defaultRequiredCategories(
  activeQuestIds: readonly number[],
): MemoryCategory[] {
  return activeQuestIds.length > 0
    ? ['quest_lesson', 'promise', 'failure_pattern']
    : ['bond_memory', 'desire_or_boundary'];
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return (
    typeof value === 'string' &&
    (MEMORY_CATEGORIES as readonly string[]).includes(value)
  );
}
