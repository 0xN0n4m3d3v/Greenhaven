/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Inspiration — BG3-style per-player resource. 0-3, awarded for
// in-character play, spent for +1d advantage. Capped at 3; doesn't
// reset per turn.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {emitFieldChange} from '../runtimeFieldEvents.js';
import {sessionManager} from '../sessionManager.js';
import {registerTool} from './base.js';

async function readInspiration(playerId: number): Promise<{
  value: number;
  fieldId: number | null;
}> {
  const r = await query<{value: unknown; field_id: number}>(
    `SELECT rv.value, rf.id AS field_id
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'inspiration'`,
    [playerId],
  );
  if (r.rows.length === 0) return {value: 0, fieldId: null};
  return {
    value: Number(r.rows[0]!.value ?? 0),
    fieldId: r.rows[0]!.field_id,
  };
}

async function writeInspiration(
  fieldId: number,
  value: number,
  source: string,
): Promise<void> {
  await query(
    `INSERT INTO runtime_values (field_id, value, source, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (field_id) DO UPDATE
       SET value = EXCLUDED.value,
           source = EXCLUDED.source,
           updated_at = now()`,
    [fieldId, JSON.stringify(value), source],
  );
}

const AwardArgs = z.object({
  reason: z.string().max(240),
  amount: z.number().int().min(1).max(2).default(1),
  /** Spec 47 — set when overriding Reward Calibrator's recommendation. */
  calibrator_override_reason: z.string().max(240).optional(),
});

registerTool({
  name: 'award_inspiration',
  description:
    "Award the player +1 (or +2 for standout) Inspiration when their prose embodies their character's background, temperament, or motivation. Cap at 3.",
  paramsSchema: AwardArgs,
  async execute(args, ctx) {
    const {value: cur, fieldId} = await readInspiration(ctx.playerId);
    if (fieldId == null) return {ok: false, reason: 'no inspiration field'};
    const amount = args.amount ?? 1;
    const next = Math.min(3, cur + amount);
    if (next === cur) {
      return {ok: false, reason: 'already at cap (3)', current: cur};
    }
    await writeInspiration(fieldId, next, 'inspiration_award');
    emitFieldChange(ctx.sessionId, {
      owner_entity_id: ctx.playerId,
      field_key: 'inspiration',
      value: next,
      source: 'inspiration_award',
    });
    const session = sessionManager.get(ctx.sessionId);
    await emitGuiEvent(ctx, 'inspiration:gained', {
      playerId: ctx.playerId,
      amount: next - cur,
      reason: args.reason,
      total: next,
    });
    if (args.calibrator_override_reason) {
      // SSE-OK: emit outside tx (reason: telemetry banner for
      // calibrator override; the canonical inspiration write
      // (writeInspiration) is already committed above and
      // SseBridge.emit auto-defers via onTransactionCommit when
      // nested in withTransaction).
      session?.sse.emit('reward:calibrator_override', {
        tool: 'award_inspiration',
        playerId: ctx.playerId,
        amount: next - cur,
        reason: args.calibrator_override_reason,
      });
    }
    return {
      ok: true,
      current: next,
      awarded: next - cur,
      reason: args.reason,
    };
  },
});

const SpendArgs = z.object({
  for_action: z.string().max(120),
});

registerTool({
  name: 'spend_inspiration',
  description:
    'Spend 1 Inspiration to gain +1d advantage on the next dice_check. Player-initiated only — broker spends only when the player explicitly invokes it.',
  paramsSchema: SpendArgs,
  async execute(args, ctx) {
    const {value: cur, fieldId} = await readInspiration(ctx.playerId);
    if (fieldId == null) return {ok: false, reason: 'no inspiration field'};
    if (cur < 1) {
      return {ok: false, reason: 'no Inspiration to spend', current: 0};
    }
    const next = cur - 1;
    await writeInspiration(fieldId, next, 'inspiration_spend');
    emitFieldChange(ctx.sessionId, {
      owner_entity_id: ctx.playerId,
      field_key: 'inspiration',
      value: next,
      source: 'inspiration_spend',
    });
    await emitGuiEvent(ctx, 'inspiration:spent', {
      playerId: ctx.playerId,
      remaining: next,
      for_action: args.for_action,
    });
    return {ok: true, remaining: next, advantage_for: args.for_action};
  },
});
