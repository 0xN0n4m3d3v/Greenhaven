/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 49 — Quest Pacer.
//
// Async post-turn advisor. NEVER calls tools, NEVER mutates DB
// outside writing its own signals. Reads:
//   - active quests for this player
//   - latest progress timestamp per quest (from tool_invocations
//     scanning advance_quest / complete_quest / start_quest calls
//     referencing each quest_entity_id)
//   - giver entity presence in recent chat_messages
//
// Produces signals:
//   - overload          : > N active quests (default 7)
//   - stale             : no progress in T hours (default 24h)
//   - dead_npc_arc      : giver absent from chat for D days
//                         (default 5) AND quest is also stale
//
// Writes the signal list into players.metadata.quest_pacer with
// updated_at_turn and elapsed-time fields. Next preamble surfaces
// `## QUEST PACER` block (turnContext/index.ts) so broker reads them
// and decides whether to close stale quests with
// complete_quest(outcome='abandoned').
//
// Cost optimization: deterministic check first; emits SSE only
// when there are signals. No LLM call in MVP — manual telemetry
// row written for accountability.

import {playerScopedChatPredicate} from '../chatHistoryScope.js';
import {query, withTransaction} from '../db.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import {POST_TURN_SLOT_WATCHDOG_MS} from '../postTurnTiming.js';
import type {PostTurnHook, SpecialistContext} from './base.js';

const OVERLOAD_THRESHOLD = 7;
const STALE_HOURS = 24;
const DEAD_ARC_DAYS = 5;

type SignalType = 'overload' | 'stale' | 'dead_npc_arc';

interface PacerSignal {
  signal_type: SignalType;
  quest_id?: number;
  quest_title?: string;
  giver_entity_id?: number;
  giver_name?: string;
  active_count?: number;
  threshold?: number;
  elapsed_hours?: number;
  dead_arc_days?: number;
  details: string;
  suggestion: string;
}

export const questPacerHook: PostTurnHook = {
  name: 'quest_pacer',
  presentation: {
    slotKey: 'post.quest_pacer',
    lane: 'post_response',
    ordinal: 20,
    visible: true,
    barrierMode: 'chat_visible',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, _turnRecord) {
    try {
      await runOnce(ctx);
    } catch (err) {
      // CATCH-WARN-OK: post-turn slot wrapper; the slot's own `presentationSlot.telemetry` (S-14) records the slot outcome with the failure status, and the inner `runOnce` separately records its own `quest_pacer` telemetry through the questEngine telemetry channel.
      console.warn(
        '[agent:quest_pacer] failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    }
  },
};

async function runOnce(ctx: SpecialistContext): Promise<void> {
  const startedAt = Date.now();
  const active = await loadActiveQuests(ctx.playerId);

  const signals: PacerSignal[] = [];

  // 1. Overload check (cheap, runs always).
  if (active.length > OVERLOAD_THRESHOLD) {
    signals.push({
      signal_type: 'overload',
      active_count: active.length,
      threshold: OVERLOAD_THRESHOLD,
      details: `${active.length} active quests (threshold ${OVERLOAD_THRESHOLD})`,
      suggestion:
        'consider closing some with complete_quest(outcome="abandoned") before creating new ones',
    });
  }

  // 2. Per-quest stale + dead-NPC checks.
  for (const q of active) {
    const lastProgress = await loadLastProgressTimestamp(q.quest_entity_id);
    const elapsedMs =
      lastProgress != null
        ? Date.now() - lastProgress.getTime()
        : q.started_at != null
          ? Date.now() - q.started_at.getTime()
          : 0;
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    if (elapsedHours < STALE_HOURS) continue;

    const giver = await loadQuestGiver(q.quest_entity_id);
    const giverPresent = giver
      ? await giverPresentRecently(giver, DEAD_ARC_DAYS, ctx.playerId)
      : false;

    if (giver && !giverPresent && elapsedHours > DEAD_ARC_DAYS * 24) {
      const giverLabel = giver.giverName ?? String(giver.giverEntityId);
      signals.push({
        signal_type: 'dead_npc_arc',
        quest_id: q.quest_entity_id,
        quest_title: q.title,
        giver_entity_id: giver.giverEntityId ?? undefined,
        giver_name: giver.giverName ?? undefined,
        elapsed_hours: Math.round(elapsedHours),
        dead_arc_days: DEAD_ARC_DAYS,
        details: `giver @${giverLabel} absent ${DEAD_ARC_DAYS}+ days; quest stale ${elapsedHours.toFixed(0)}h`,
        suggestion: `complete_quest(quest_id=${q.quest_entity_id}, outcome="failed") if the arc is abandoned`,
      });
    } else {
      signals.push({
        signal_type: 'stale',
        quest_id: q.quest_entity_id,
        quest_title: q.title,
        elapsed_hours: Math.round(elapsedHours),
        details: `no progress in ${elapsedHours.toFixed(0)}h`,
        suggestion:
          'continue or complete_quest(outcome="abandoned") if the player has moved on',
      });
    }
  }

  // 3. Persist + emit. USER-5/USER-6 — pacer's durable write
  // (players.metadata.quest_pacer) and the quest_pacer:* GUI events
  // share one transaction so a failed UPDATE rolls back the
  // gui_events inserts and the deferred SSE never escapes.
  // `emitGuiEvent*` does its own INSERT into `gui_events`, and the
  // SseBridge wrapper auto-defers via `onTransactionCommit` from
  // inside `withTransaction(...)`.
  await withTransaction(async () => {
    await persistSignals(ctx.playerId, signals, ctx.turnId);
    for (const s of signals) {
      const payload = {
        questId: s.quest_id ?? null,
        questTitle: s.quest_title ?? null,
        giverEntityId: s.giver_entity_id ?? null,
        giverName: s.giver_name ?? null,
        activeCount: s.active_count ?? null,
        threshold: s.threshold ?? null,
        elapsedHours: s.elapsed_hours ?? null,
        deadArcDays: s.dead_arc_days ?? null,
        details: s.details,
        suggestion: s.suggestion,
      };
      const opts = {
        playerId: ctx.playerId,
        turnId: ctx.turnId,
        lane: 'post_response' as const,
        phase: 'post_turn' as const,
      };
      await (ctx.presentation?.emit(
        `quest_pacer:${s.signal_type}`,
        payload,
        opts,
      ) ?? emitGuiEventForSession(
        ctx.sessionId,
        `quest_pacer:${s.signal_type}`,
        payload,
        opts,
      ));
    }
  });

  // Manual telemetry — Pacer is deterministic so no runSpecialist call.
  try {
    await query(
      `INSERT INTO turn_telemetry
         (session_id, turn_id, role, model_id, thinking, input_tokens,
          output_tokens, cache_hit_tokens, cache_miss_tokens,
          duration_ms, cost_usd, player_id, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        ctx.sessionId,
        ctx.turnId ?? null,
        'agent:quest_pacer',
        'deterministic',
        false,
        0,
        0,
        0,
        0,
        Date.now() - startedAt,
        0,
        ctx.playerId ?? null,
        null,
      ],
    );
  } catch (err) {
    // Non-fatal, but log so telemetry gaps are diagnosable.
    // VOID-FF-OK: the dynamic-import `.then(...)` itself records `telemetry.write_failed` through the facade; an import-load rejection would still surface through the facade's internal sink-rejection logger (matches the pattern in questTransitionArbiter.ts).
    void import('../telemetry/index.js').then(({telemetry}) =>
      telemetry.record({
        channel: 'gameplay',
        name: 'telemetry.write_failed',
        error: err,
        data: {agent: 'quest_pacer', function: 'telemetryWrite'},
      }),
    );
  }
}

// ── DB helpers ─────────────────────────────────────────────────────────

interface ActiveQuestRow {
  player_id: number;
  quest_entity_id: number;
  title: string;
  started_at: Date | null;
  current_stage_id: string | null;
}

async function loadActiveQuests(playerId: number): Promise<ActiveQuestRow[]> {
  const r = await query<{
    player_id: number;
    quest_entity_id: number;
    title: string;
    started_at: Date | null;
    current_stage_id: string | null;
  }>(
    `SELECT pq.player_id, pq.quest_entity_id, e.display_name AS title,
            pq.started_at, pq.current_stage_id
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1 AND pq.status = 'active'`,
    [playerId],
  );
  return r.rows;
}

async function loadLastProgressTimestamp(
  questEntityId: number,
): Promise<Date | null> {
  const quest = await query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [questEntityId],
  );
  const title = quest.rows[0]?.display_name ?? '';
  // Compare JSON refs as text. Do not cast arbitrary args->>'quest'
  // values to bigint: legacy title refs are valid and must not throw.
  const r = await query<{invoked_at: Date}>(
    `SELECT MAX(invoked_at) AS invoked_at FROM tool_invocations
      WHERE tool_name IN ('advance_quest','complete_quest','start_quest','create_quest')
        AND (
          args->>'quest_id' = $1
          OR args->>'quest_entity_id' = $1
          OR result->>'quest_id' = $1
          OR result->>'quest_entity_id' = $1
          OR LOWER(COALESCE(args->>'quest', '')) = LOWER($2)
          OR LOWER(COALESCE(args->>'title', '')) = LOWER($2)
        )`,
    [String(questEntityId), title],
  );
  return r.rows[0]?.invoked_at ?? null;
}

async function loadQuestGiver(
  questEntityId: number,
): Promise<{giverEntityId: number | null; giverName: string | null} | null> {
  const r = await query<{giver_entity_id: string | null; giver: string | null}>(
    `SELECT profile->>'giver_entity_id' AS giver_entity_id,
            profile->>'giver' AS giver
       FROM entities
      WHERE id = $1`,
    [questEntityId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const giverEntityId =
    row.giver_entity_id && /^\d+$/.test(row.giver_entity_id)
      ? Number(row.giver_entity_id)
      : null;
  if (giverEntityId != null) {
    const entity = await query<{display_name: string}>(
      `SELECT display_name FROM entities WHERE id = $1`,
      [giverEntityId],
    );
    return {
      giverEntityId,
      giverName: entity.rows[0]?.display_name ?? row.giver ?? null,
    };
  }
  if (row.giver) return {giverEntityId: null, giverName: row.giver};
  return null;
}

async function giverPresentRecently(
  giver: {giverEntityId: number | null; giverName: string | null},
  withinDays: number,
  playerId: number,
): Promise<boolean> {
  const r = await query<{present: number}>(
    `SELECT COUNT(*)::int AS present
       FROM chat_messages cm
       LEFT JOIN entities e ON e.id = cm.author_entity_id
      WHERE (
          ($1::bigint IS NOT NULL AND cm.author_entity_id = $1::bigint)
          OR ($2::text IS NOT NULL AND LOWER(e.display_name) = LOWER($2::text))
        )
        AND ${playerScopedChatPredicate('cm', 4)}
        AND cm.created_at > now() - ($3::int || ' days')::interval`,
    [giver.giverEntityId, giver.giverName, withinDays, playerId],
  );
  return (r.rows[0]?.present ?? 0) > 0;
}

async function persistSignals(
  playerId: number,
  signals: PacerSignal[],
  turnId: string,
): Promise<void> {
  const payload = {
    signals,
    updated_at_turn: turnId,
    updated_at: new Date().toISOString(),
  };
  await query(
    `UPDATE players
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('quest_pacer', $1::jsonb)
      WHERE entity_id = $2`,
    [JSON.stringify(payload), playerId],
  );
}
