/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-objective-kind evaluator registry. One evaluator per objective
// `kind`. Each returns `{satisfied: boolean, detail?: string}` so
// callers can render ✓/☐ + a short hint in the preamble.

import {query} from '../db.js';
import {readStrings} from '../tools/strings.js';

export type ObjectiveResult = {satisfied: boolean; detail?: string};

export interface ObjectiveContext {
  playerId: number;
  sessionId: string;
  recentToolCalls: Array<{name: string; args: Record<string, unknown>}>;
}

export type ObjectiveEvaluator = (
  obj: Record<string, unknown>,
  ctx: ObjectiveContext,
) => Promise<ObjectiveResult>;

function matchAll(
  args: Record<string, unknown> | undefined,
  pattern: Record<string, unknown> | undefined,
): boolean {
  if (!pattern) return true;
  if (!args) return false;
  for (const [k, v] of Object.entries(pattern)) {
    if (k.endsWith('_min')) {
      const realKey = k.slice(0, -'_min'.length);
      if (Number(args[realKey] ?? 0) < Number(v)) return false;
    } else if (args[k] !== v) {
      return false;
    }
  }
  return true;
}

const evaluators: Record<string, ObjectiveEvaluator> = {
  tool_called: async (obj, ctx) => {
    const tool = obj['tool'];
    const argsMatch = (obj['args_match'] ?? {}) as Record<string, unknown>;
    const hit = ctx.recentToolCalls.some(
      tc => tc.name === tool && matchAll(tc.args, argsMatch),
    );
    return {
      satisfied: hit,
      detail: hit ? `${tool} fired` : `awaiting ${tool}`,
    };
  },

  field_threshold: async (obj, ctx) => {
    const r = await query<{
      value_type: string;
      scope_per_player: boolean;
      default_value: unknown;
      overlay_value: unknown;
      global_value: unknown;
    }>(
      `SELECT rf.value_type, rf.scope_per_player, rf.default_value,
              rpo.value AS overlay_value,
              rv.value AS global_value
         FROM runtime_fields rf
         LEFT JOIN runtime_player_overlay rpo
                ON rpo.field_id = rf.id AND rpo.player_id = $3
         LEFT JOIN runtime_values rv ON rv.field_id = rf.id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = $2
        LIMIT 1`,
      [obj['owner_entity_id'], obj['field_key'], ctx.playerId],
    );
    const row = r.rows[0];
    if (!row) {
      return {
        satisfied: false,
        detail: `missing runtime field ${obj['field_key']} on entity ${obj['owner_entity_id']}`,
      };
    }
    const cur =
      row.scope_per_player && row.overlay_value !== null && row.overlay_value !== undefined
        ? row.overlay_value
        : row.global_value !== null && row.global_value !== undefined
          ? row.global_value
          : row.default_value;
    const target = obj['value'];
    const op = String(obj['op'] ?? '');
    const ok = compareRuntimeObjective(cur, op, target);
    return {
      satisfied: ok,
      detail: `${obj['field_key']}=${formatObjectiveValue(cur)} ${op} ${formatObjectiveValue(target)}`,
    };
  },

  condition_present: async obj => {
    const r = await query<{value: unknown}>(
      `SELECT rv.value FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = 'conditions'`,
      [obj['owner_entity_id']],
    );
    const conds = Array.isArray(r.rows[0]?.value)
      ? (r.rows[0]!.value as Array<Record<string, unknown>>)
      : [];
    const tag = obj['tag'];
    const ok = conds.some(c => c['tag'] === tag);
    return {
      satisfied: ok,
      detail: ok ? `${tag} present` : `awaiting ${tag}`,
    };
  },

  string_threshold: async (obj, ctx) => {
    const npcRow = await query<{id: number}>(
      `SELECT id FROM entities
        WHERE display_name = $1 AND kind = 'person' LIMIT 1`,
      [obj['npc']],
    );
    const npcId = npcRow.rows[0]?.id;
    if (!npcId) return {satisfied: false, detail: `unknown NPC ${obj['npc']}`};
    const map = await readStrings(npcId);
    const cur = Number(map[String(ctx.playerId)] ?? 0);
    const target = Number(obj['value']);
    const op = obj['op'];
    const ok =
      op === '>=' ? cur >= target :
      op === '<=' ? cur <= target :
      cur === target;
    return {satisfied: ok, detail: `strings(${obj['npc']})=${cur} ${op} ${target}`};
  },

  narrate_text_match: async (obj, ctx) => {
    const re = new RegExp(String(obj['regex']), 'i');
    const r = await query<{text: string}>(
      `SELECT text FROM chat_messages
        WHERE session_id = $1 ORDER BY turn_index DESC LIMIT 20`,
      [ctx.sessionId],
    );
    const ok = r.rows.some(row => re.test(row.text));
    return {satisfied: ok};
  },

  // Spec 24 — quest stage requires the player has NOT accumulated a
  // specific trauma tag. Trauma lives in runtime_field 'trauma' on
  // the player entity (see spec 20).
  trauma_absent: async (obj, ctx) => {
    const tag = String(obj['tag'] ?? '');
    const r = await query<{value: unknown}>(
      `SELECT rv.value FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = 'trauma'`,
      [ctx.playerId],
    );
    const list = Array.isArray(r.rows[0]?.value)
      ? (r.rows[0]!.value as unknown[])
      : [];
    const ok = !list.some(t => t === tag);
    return {satisfied: ok, detail: ok ? `no ${tag}` : `has ${tag}`};
  },

  // Spec 24 — most recent dice_check resolved with at least the
  // named effect level. Reads from this turn's recentToolCalls.
  last_dice_effect: async (obj, ctx) => {
    const recent = ctx.recentToolCalls
      .filter(t => t.name === 'dice_check')
      .slice(-1)[0];
    if (!recent) return {satisfied: false, detail: 'no recent roll'};
    const eff = String(recent.args['effect'] ?? 'standard');
    const min = String(obj['min_level'] ?? 'standard');
    const ladder = ['limited', 'standard', 'great'];
    const minIdx = ladder.indexOf(min);
    const effIdx = ladder.indexOf(eff);
    const ok = minIdx >= 0 && effIdx >= 0 && effIdx >= minIdx;
    return {satisfied: ok, detail: `last effect=${eff}`};
  },
};

function compareRuntimeObjective(left: unknown, op: string, right: unknown): boolean {
  if (op === '==' || op === 'eq') return deepEqual(left, right);
  if (op === '!=' || op === 'neq') return !deepEqual(left, right);
  if (op === 'in') {
    return Array.isArray(right) && right.some(v => deepEqual(left, v));
  }

  const l = Number(left);
  const r = Number(right);
  if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
  if (op === '>=') return l >= r;
  if (op === '<=') return l <= r;
  if (op === '>') return l > r;
  if (op === '<') return l < r;
  return false;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatObjectiveValue(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

export async function evaluateObjective(
  obj: Record<string, unknown>,
  ctx: ObjectiveContext,
): Promise<ObjectiveResult> {
  const kind = obj['kind'];
  if (typeof kind !== 'string') {
    return {satisfied: false, detail: 'objective kind missing'};
  }
  const evalFn = evaluators[kind];
  if (!evalFn) return {satisfied: false, detail: `unknown objective kind: ${kind}`};
  return evalFn(obj, ctx);
}
