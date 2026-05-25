/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 137: post-turn memory loop watcher. It is deterministic and fail-open:
// no LLM call, no gameplay blocking, no reward/XP coupling.

import {query} from '../../../db.js';
import {assignMemoryCluster} from '../clusters/clusters.js';
import {
  attachMemoryToThread,
  recordThreadEvidence,
} from '../npc/sessionThread.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
} from '../../../postTurnTiming.js';
import type {PostTurnHook} from '../../../agents/base.js';

export const memoryLoopWatcherHook: PostTurnHook = {
  name: 'memory_loop_watcher',
  presentation: {
    slotKey: 'post.memory_loop_watcher',
    lane: 'rail',
    ordinal: 15,
    visible: false,
    barrierMode: 'non_blocking',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, turnRecord) {
    const addedMemoryIds = extractAddedMemoryIds(turnRecord.toolHistory);
    for (const memoryId of addedMemoryIds) {
      try {
        await attachMemoryToThread({
          sessionId: ctx.sessionId,
          playerId: ctx.playerId,
          memoryId,
          questId: await firstActiveQuestId(ctx.playerId),
        });
        await assignMemoryCluster(memoryId);
      } catch (err) {
        // CATCH-WARN-OK: per-memory follow-through inside the post-turn watcher; the outer `runSpecialist` records the specialist's overall `ok` / failureReason through `recordAgentTelemetry` in base.ts.
        console.warn(
          `[memory_loop_watcher] memory ${memoryId} follow-through failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const recalled = extractRecalledMemoryIds(turnRecord.toolHistory);
    const bumped = extractBumpedMemoryIds(turnRecord.toolHistory);
    const missedBump = recalled.filter(id => !bumped.has(id));
    if (missedBump.length > 0) {
      await recordThreadEvidence({
        sessionId: ctx.sessionId,
        playerId: ctx.playerId,
        kind: 'memory_recalled_without_salience_bump',
        payload: {
          memory_ids: missedBump.slice(0, 12),
          turn_id: ctx.turnId,
        },
      });
    }

    const hasActiveQuest = await hasActiveQuestForPlayer(ctx.playerId);
    const recalledAnything = recalled.length > 0;
    if (hasActiveQuest && !recalledAnything && turnRecord.narrative.trim().length > 400) {
      await recordThreadEvidence({
        sessionId: ctx.sessionId,
        playerId: ctx.playerId,
        kind: 'important_turn_without_memory_recall',
        payload: {
          turn_id: ctx.turnId,
          mode: turnRecord.mode ?? null,
          narrative_chars: turnRecord.narrative.length,
        },
      });
    }
  },
};

function extractAddedMemoryIds(
  history: Array<{name: string; result?: unknown}>,
): number[] {
  const ids: number[] = [];
  for (const call of history) {
    if (call.name !== 'add_memory') continue;
    const result = objectOrNull(call.result);
    const id = Number(result?.['id']);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return [...new Set(ids)].slice(0, 24);
}

function extractRecalledMemoryIds(
  history: Array<{name: string; result?: unknown}>,
): number[] {
  const ids: number[] = [];
  for (const call of history) {
    if (call.name !== 'query_memory') continue;
    const result = objectOrNull(call.result);
    const memories = Array.isArray(result?.['memories'])
      ? (result['memories'] as unknown[])
      : [];
    for (const memory of memories) {
      const id = Number(objectOrNull(memory)?.['id']);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
  }
  return [...new Set(ids)].slice(0, 24);
}

function extractBumpedMemoryIds(
  history: Array<{name: string; args?: Record<string, unknown>}>,
): Set<number> {
  const ids = new Set<number>();
  for (const call of history) {
    if (call.name !== 'bump_memory_salience') continue;
    const id = Number(call.args?.['memory_id']);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

async function hasActiveQuestForPlayer(playerId: number): Promise<boolean> {
  const rows = await query<{count: number | string}>(
    `SELECT COUNT(*)::int AS count
       FROM player_quests
      WHERE player_id = $1
        AND status = 'active'`,
    [playerId],
  );
  return Number(rows.rows[0]?.count ?? 0) > 0;
}

async function firstActiveQuestId(playerId: number): Promise<number | null> {
  const rows = await query<{quest_entity_id: number}>(
    `SELECT quest_entity_id
       FROM player_quests
      WHERE player_id = $1
        AND status = 'active'
      ORDER BY started_at NULLS LAST, quest_entity_id
      LIMIT 1`,
    [playerId],
  );
  return rows.rows[0]?.quest_entity_id ?? null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
