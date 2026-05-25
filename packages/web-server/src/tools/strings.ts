/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Strings — Monsterhearts-derived emotional-leverage mechanic.
//
// Storage: per-NPC runtime_field 'strings' is a JSONB map
//   { "<player_entity_id>": <int>, ... }
// The OWNER of the field is one side of the bond; the KEYS are the
// other side's player_ids. We store from the NPC side because strings
// live on entities; player→NPC strings ride this same map keyed by
// player_id. Read-modify-write at low concurrency is fine — strings
// are tiny per-NPC objects with at most one int per active player.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {emitFieldChange} from '../runtimeFieldEvents.js';
import {sessionManager} from '../sessionManager.js';
import {
  clampStringCount,
  stringEdgeId,
  stringFallbackSummary,
  stringIntensityForCount,
  stringKindForCount,
  stringValenceForCount,
} from '../stringsContract.js';
import {registerTool, resolveEntityId} from './base.js';

export async function readStrings(npcId: number): Promise<Record<string, number>> {
  const r = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'strings'`,
    [npcId],
  );
  const v = r.rows[0]?.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, number>;
  }
  return {};
}

async function writeStrings(
  npcId: number,
  map: Record<string, number>,
): Promise<void> {
  await query(
    `INSERT INTO runtime_values (field_id, value, source, updated_at)
     SELECT rf.id, $1::jsonb, 'strings_tool', now()
       FROM runtime_fields rf
      WHERE rf.owner_entity_id = $2 AND rf.field_key = 'strings'
     ON CONFLICT (field_id)
     DO UPDATE SET value = EXCLUDED.value,
                   source = EXCLUDED.source,
                   updated_at = now()`,
    [JSON.stringify(map), npcId],
  );
}

export async function addString(
  npcId: number,
  playerId: number,
  delta: number,
): Promise<number> {
  const map = await readStrings(npcId);
  const cur = Number(map[String(playerId)] ?? 0);
  map[String(playerId)] = clampStringCount(cur + delta);
  await writeStrings(npcId, map);
  return map[String(playerId)]!;
}

export async function spendString(
  npcId: number,
  playerId: number,
  count: number = 1,
): Promise<{ok: boolean; remaining: number}> {
  const map = await readStrings(npcId);
  const cur = Number(map[String(playerId)] ?? 0);
  if (cur < count) return {ok: false, remaining: cur};
  map[String(playerId)] = cur - count;
  await writeStrings(npcId, map);
  return {ok: true, remaining: map[String(playerId)]!};
}

const AwardArgs = z.object({
  npc: z.string(),
  /** +1 typical, +2 for huge moments. Negatives allowed (forfeit). */
  delta: z.number().int().min(-3).max(3),
  /** Short reason — surfaces in the SSE event for telemetry. */
  reason: z.string().optional(),
  /** Spec 47 — set when overriding Reward Calibrator's recommendation. */
  calibrator_override_reason: z.string().max(240).optional(),
});

registerTool({
  name: 'string_award',
  description:
    'Add or remove strings between the player and an NPC. +1 for an intimate initiation; +1 for mutual climax; +1 for a vulnerable confession; -1 if a betrayal cuts the leverage. Symmetric — call once per side that gained leverage. Use sparingly; strings are emotional currency.',
  paramsSchema: AwardArgs,
  async execute(args, ctx) {
    const npcId = await resolveEntityId(args.npc);
    if (!npcId) return {ok: false, error: `unknown NPC: ${args.npc}`};
    const remaining = await addString(npcId, ctx.playerId, args.delta);
    emitFieldChange(ctx.sessionId, {
      owner_entity_id: npcId,
      field_key: 'strings',
      value: await readStrings(npcId),
      source: 'string_award',
    });
    await emitGuiEvent(ctx, 'string:changed', {
      stringId: stringEdgeId(ctx.playerId, npcId),
      from: ctx.playerId,
      to: npcId,
      kind: stringKindForCount(remaining),
      intensity: stringIntensityForCount(remaining),
      valence: stringValenceForCount(remaining),
      turnId: ctx.turnId ?? null,
      npcId,
      npcName: args.npc,
      delta: args.delta,
      newValue: remaining,
      band: bandFor(remaining),
      reason: args.reason ?? null,
      summary:
        args.reason ??
        stringFallbackSummary({
          npcName: args.npc,
          count: remaining,
          band: bandFor(remaining),
        }),
    });
    if (args.calibrator_override_reason) {
      // SSE-OK: emit outside tx (reason: telemetry banner for
      // calibrator override; the canonical string write above
      // is already committed and SseBridge.emit auto-defers via
      // onTransactionCommit when nested in withTransaction).
      sessionManager.get(ctx.sessionId)?.sse.emit('reward:calibrator_override', {
        tool: 'string_award',
        npcId,
        npcName: args.npc,
        delta: args.delta,
        reason: args.calibrator_override_reason,
      });
    }
    return {
      ok: true,
      npc: args.npc,
      npcId,
      remaining,
      reason: args.reason ?? null,
    };
  },
});

const SpendArgs = z.object({
  npc: z.string(),
  count: z.number().int().min(1).max(3).default(1),
  /** What the spend buys. Surfaces in the SSE event. */
  effect: z.string(),
});

registerTool({
  name: 'string_spend',
  description:
    'Spend strings to gain +1d advantage on the next social/intimate dice_check vs this NPC, or to force them into a tight emotional spot ("Spend 1: she has to look you in the eye"). Returns ok:false if insufficient.',
  paramsSchema: SpendArgs,
  async execute(args, ctx) {
    const npcId = await resolveEntityId(args.npc);
    if (!npcId) return {ok: false, error: `unknown NPC: ${args.npc}`};
    const result = await spendString(npcId, ctx.playerId, args.count ?? 1);
    if (result.ok) {
      emitFieldChange(ctx.sessionId, {
        owner_entity_id: npcId,
        field_key: 'strings',
        value: await readStrings(npcId),
        source: 'string_spend',
      });
      await emitGuiEvent(ctx, 'string:changed', {
        stringId: stringEdgeId(ctx.playerId, npcId),
        from: ctx.playerId,
        to: npcId,
        kind: stringKindForCount(result.remaining),
        intensity: stringIntensityForCount(result.remaining),
        valence: stringValenceForCount(result.remaining),
        turnId: ctx.turnId ?? null,
        npcId,
        npcName: args.npc,
        delta: -(args.count ?? 1),
        newValue: result.remaining,
        band: bandFor(result.remaining),
        reason: args.effect,
        summary: args.effect,
      });
    }
    return {npc: args.npc, npcId, ...result, effect: args.effect};
  },
});

/** Map a strings count to a discrete relationship band. Cross-cutting
 *  registry: bands feed the preamble + future NPCCard band-color UI. */
export type StringBand =
  | 'hostile'
  | 'wary'
  | 'neutral'
  | 'friendly'
  | 'trusted'
  | 'bonded';

export function bandFor(count: number): StringBand {
  if (count <= -5) return 'hostile';
  if (count <= -2) return 'wary';
  if (count <= 1) return 'neutral';
  if (count <= 4) return 'friendly';
  if (count <= 7) return 'trusted';
  return 'bonded';
}
