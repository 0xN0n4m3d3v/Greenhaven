/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 53 — Companion auto-depart engine.
//
// Async post-turn hook. For each NPC in
// `players.metadata.companions[]`, reads the NPC's
// `profile.depart_when` predicate (cartridge-declared) and
// evaluates it against the current world state. On match, fires
// `set_companion(stop_following, reason='auto: …')` server-side
// (so the same SSE / metadata path runs as for a broker-initiated
// unbond) and additionally emits `companion:auto_departed` SSE so
// the frontend can render a distinct EventCard.
//
// Cartridges that don't set `profile.depart_when` are unaffected —
// the companion stays bonded forever until broker manually unbonds.
//
// Per-companion fail-open. One predicate failing (malformed shape,
// DB error, etc.) doesn't poison the rest. Errors logged but never
// thrown to caller.

import {query} from '../db.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import {POST_TURN_SLOT_WATCHDOG_MS} from '../postTurnTiming.js';
import {dispatch} from '../tools/base.js';
import {readStrings} from '../tools/strings.js';
import type {PostTurnHook, SpecialistContext} from './base.js';

export const companionDepartEngineHook: PostTurnHook = {
  name: 'companion_depart_engine',
  presentation: {
    slotKey: 'post.companion_depart',
    lane: 'post_response',
    ordinal: 70,
    visible: true,
    barrierMode: 'chat_visible',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, _turnRecord) {
    try {
      await runOnce(ctx);
    } catch (err) {
      // CATCH-WARN-OK: post-turn slot wrapper; the surrounding `runOnce` failure is recorded by the specialist scheduler through the post-turn slot telemetry channel (S-14 / presentationSlot.telemetry) which writes the slot outcome with its own status.
      console.warn(
        '[agent:companion_depart_engine] failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    }
  },
};

// ── Predicate types ───────────────────────────────────────────────────

type DepartPredicate =
  | {
      kind: 'string_threshold';
      op: '<' | '<=' | '>' | '>=' | '==';
      value: number;
    }
  | {
      kind: 'condition_present';
      tag: string;
    }
  | {
      kind: 'runtime_field_threshold';
      field_key: string;
      op: '<' | '<=' | '>' | '>=' | '==';
      value: number | string;
    }
  | {
      kind: 'quest_completed';
      quest_display_name: string;
    };

interface CompanionRow {
  id: number;
  display_name: string;
  profile: Record<string, unknown> | null;
}

// ── Main loop ──────────────────────────────────────────────────────────

async function runOnce(ctx: SpecialistContext): Promise<void> {
  // Read the player's current companion roster.
  const roster = await query<{companions: number[] | null}>(
    `SELECT (metadata->'companions') AS companions
       FROM players WHERE entity_id = $1`,
    [ctx.playerId],
  );
  const companionIds = Array.isArray(roster.rows[0]?.companions)
    ? (roster.rows[0]!.companions as number[])
    : [];
  if (companionIds.length === 0) return;

  // Load each companion's entity row (we need profile + display_name).
  const companions = await query<CompanionRow>(
    `SELECT id, display_name, profile
       FROM entities WHERE id = ANY($1::bigint[])`,
    [companionIds],
  );

  for (const npc of companions.rows) {
    try {
      await evaluateAndMaybeDepart(npc, ctx);
    } catch (err) {
      // CATCH-WARN-OK: per-companion predicate iteration; the outer `runOnce` failure is recorded through the post-turn slot telemetry channel (see neighbouring catch above), so individual companion failures aggregate into the slot outcome.
      console.warn(
        `[companion_depart_engine] ${npc.display_name} predicate failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function evaluateAndMaybeDepart(
  npc: CompanionRow,
  ctx: SpecialistContext,
): Promise<void> {
  const predRaw = npc.profile?.['depart_when'];
  if (!predRaw || typeof predRaw !== 'object') return;
  const pred = predRaw as DepartPredicate;
  if (!isKnownPredicate(pred)) {
    console.warn(
      `[companion_depart_engine] unknown predicate kind on @${npc.display_name}:`,
      pred,
    );
    return;
  }

  // Idempotency guard — re-check roster right before firing. If
  // someone else (broker, another postTurn hook) already removed
  // this NPC this turn, skip.
  const stillRostered = await query<{companions: number[] | null}>(
    `SELECT (metadata->'companions') AS companions
       FROM players WHERE entity_id = $1`,
    [ctx.playerId],
  );
  const companionsNow = Array.isArray(stillRostered.rows[0]?.companions)
    ? (stillRostered.rows[0]!.companions as number[])
    : [];
  if (!companionsNow.includes(npc.id)) return;

  const verdict = await evaluatePredicate(pred, npc.id, ctx.playerId);
  if (!verdict.fired) return;

  // Reuse spec 52's set_companion tool path so all the same SSE /
  // metadata mutations happen consistently. Auto-depart wraps the
  // reason with an `auto:` prefix so telemetry can distinguish.
  await dispatch(
    'set_companion',
    {
      npc: npc.display_name,
      action: 'stop_following',
      reason: `auto: ${verdict.reason}`,
    },
    {
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
    },
  );

  // Additional auto-departed SSE so the frontend EventCard can show
  // this was engine-driven (vs broker-driven) departure.
  await (ctx.presentation?.emit(
    'companion:auto_departed',
    {
      npcId: npc.id,
      npcName: npc.display_name,
      predicate_kind: pred.kind,
      reason: verdict.reason,
    },
    {
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      lane: 'post_response',
      phase: 'post_turn',
    },
  ) ?? emitGuiEventForSession(
    ctx.sessionId,
    'companion:auto_departed',
    {
      npcId: npc.id,
      npcName: npc.display_name,
      predicate_kind: pred.kind,
      reason: verdict.reason,
    },
    {
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      lane: 'post_response',
      phase: 'post_turn',
    },
  ));
}

function isKnownPredicate(p: unknown): p is DepartPredicate {
  if (!p || typeof p !== 'object') return false;
  const kind = (p as Record<string, unknown>)['kind'];
  return (
    kind === 'string_threshold' ||
    kind === 'condition_present' ||
    kind === 'runtime_field_threshold' ||
    kind === 'quest_completed'
  );
}

// ── Predicate evaluators ──────────────────────────────────────────────

async function evaluatePredicate(
  pred: DepartPredicate,
  npcId: number,
  playerId: number,
): Promise<{fired: boolean; reason: string}> {
  switch (pred.kind) {
    case 'string_threshold':
      return evalStringThreshold(pred, npcId, playerId);
    case 'condition_present':
      return evalConditionPresent(pred, npcId);
    case 'runtime_field_threshold':
      return evalRuntimeFieldThreshold(pred, npcId);
    case 'quest_completed':
      return evalQuestCompleted(pred, playerId);
  }
}

async function evalStringThreshold(
  pred: Extract<DepartPredicate, {kind: 'string_threshold'}>,
  npcId: number,
  playerId: number,
): Promise<{fired: boolean; reason: string}> {
  const map = await readStrings(npcId);
  const cur = Number(map[String(playerId)] ?? 0);
  const fired = cmpNum(cur, pred.op, pred.value);
  return {
    fired,
    reason: `strings(player→npc) = ${cur} ${pred.op} ${pred.value}`,
  };
}

async function evalConditionPresent(
  pred: Extract<DepartPredicate, {kind: 'condition_present'}>,
  npcId: number,
): Promise<{fired: boolean; reason: string}> {
  const r = await query<{value: unknown}>(
    `SELECT COALESCE(rv.value, rf.default_value) AS value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'conditions'
      LIMIT 1`,
    [npcId],
  );
  const v = r.rows[0]?.value;
  if (!Array.isArray(v)) return {fired: false, reason: 'no conditions field'};
  const present = (v as Array<Record<string, unknown>>).some(
    c => typeof c['tag'] === 'string' && c['tag'] === pred.tag,
  );
  return {
    fired: present,
    reason: `condition '${pred.tag}' ${present ? 'present' : 'absent'}`,
  };
}

async function evalRuntimeFieldThreshold(
  pred: Extract<DepartPredicate, {kind: 'runtime_field_threshold'}>,
  npcId: number,
): Promise<{fired: boolean; reason: string}> {
  const r = await query<{value: unknown}>(
    `SELECT COALESCE(rv.value, rf.default_value) AS value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = $2
      LIMIT 1`,
    [npcId, pred.field_key],
  );
  const v = r.rows[0]?.value;
  if (v == null) return {fired: false, reason: `field ${pred.field_key} unset`};
  let fired: boolean;
  let displayCur: string;
  if (typeof pred.value === 'number') {
    const cur = Number(v);
    if (!Number.isFinite(cur)) {
      return {fired: false, reason: `field ${pred.field_key} non-numeric`};
    }
    fired = cmpNum(cur, pred.op, pred.value);
    displayCur = String(cur);
  } else {
    if (pred.op !== '==') {
      return {
        fired: false,
        reason: `op ${pred.op} not supported on string value`,
      };
    }
    fired = String(v) === pred.value;
    displayCur = String(v);
  }
  return {
    fired,
    reason: `${pred.field_key} = ${displayCur} ${pred.op} ${pred.value}`,
  };
}

async function evalQuestCompleted(
  pred: Extract<DepartPredicate, {kind: 'quest_completed'}>,
  playerId: number,
): Promise<{fired: boolean; reason: string}> {
  const r = await query<{count: string}>(
    `SELECT COUNT(*)::text AS count FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status = 'completed'
        AND e.display_name = $2`,
    [playerId, pred.quest_display_name],
  );
  const fired = Number(r.rows[0]?.count ?? '0') > 0;
  return {
    fired,
    reason: `quest '${pred.quest_display_name}' ${fired ? 'completed' : 'not yet completed'}`,
  };
}

function cmpNum(a: number, op: string, b: number): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '==':
      return a === b;
    default:
      return false;
  }
}
