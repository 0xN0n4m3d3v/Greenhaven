/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 35 — combat death loop. mark_downed → death_save (3 success →
// stable, 3 fail → dead) → stabilize (ally revives). Field IDs follow
// the 12000-block scheme: 12000+entity, 12100+entity, 12200+entity.

import {z} from 'zod';
import {withTransaction, type TxClient} from '../db.js';
import {emitFieldChange} from '../runtimeFieldEvents.js';
import {applyPatchRawWithClient} from './runtime.js';
import {registerTool, resolveEntityId} from './base.js';
import {rollDie} from './gameplayRng.js';

async function setCombatFieldWithClient(
  client: TxClient,
  entityId: number,
  fieldOffset: number,
  fieldKey: string,
  value: unknown,
  source: string,
): Promise<number> {
  const fieldRow = await client.query<{id: number}>(
    `SELECT id FROM runtime_fields
      WHERE owner_entity_id = $1 AND field_key = $2`,
    [entityId, fieldKey],
  );
  let fieldId: number | null = fieldRow.rows[0]?.id ?? null;
  if (fieldId == null) fieldId = fieldOffset + entityId;
  await applyPatchRawWithClient(client, fieldId, value, 'set', source);
  return fieldId;
}

async function readIntForUpdate(
  client: TxClient,
  entityId: number,
  fieldKey: string,
): Promise<number> {
  const r = await client.query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = $2
        FOR UPDATE OF rv`,
    [entityId, fieldKey],
  );
  return Number(r.rows[0]?.value ?? 0);
}

const MarkDownedArgs = z.object({
  target: z.string(),
  reason: z.string().max(200).optional(),
});

registerTool({
  name: 'mark_downed',
  description:
    "Mark an actor as downed when HP drops to 0. Initiates BG3-style death saves on subsequent death_save calls. Resets death-save counters.",
  paramsSchema: MarkDownedArgs,
  async execute(args, ctx) {
    const targetId = await resolveEntityId(args.target);
    if (!targetId) return {ok: false, error: `unknown target: ${args.target}`};
    // Wrap in transaction so combat_state + counters are written
    // atomically (GH-BUG-090). Prevents partial state where state
    // is 'downed' but counters weren't reset.
    await withTransaction(async client => {
      await setCombatFieldWithClient(client, targetId, 12000, 'combat_state', 'downed', 'mark_downed');
      await setCombatFieldWithClient(client, targetId, 12100, 'death_save_successes', 0, 'mark_downed');
      await setCombatFieldWithClient(client, targetId, 12200, 'death_save_failures', 0, 'mark_downed');
    });
    emitFieldChange(ctx.sessionId, {
      owner_entity_id: targetId,
      field_key: 'combat_state',
      value: 'downed',
      source: 'mark_downed',
    });
    return {ok: true, target_id: targetId, state: 'downed'};
  },
});

const DeathSaveArgs = z.object({
  target: z.string(),
  proficiency_advantage: z.boolean().default(false),
});

registerTool({
  name: 'death_save',
  description:
    'Roll a death save for a downed actor. d20 ≥ 10 = success, < 10 = failure, nat 20 = restore to active with 1 HP, nat 1 = 2 failures. 3 successes → stable; 3 failures → dead.',
  paramsSchema: DeathSaveArgs,
  async execute(args, ctx) {
    const targetId = await resolveEntityId(args.target);
    if (!targetId) return {ok: false, error: `unknown target: ${args.target}`};
    // Wrap in transaction with row-level locks. Prevents TOCTOU
    // race where concurrent death_save calls on same target read
    // the same failure/success count and both write the incremented
    // value, causing lost death saves (GH-BUG-082).
    return withTransaction(async client => {
      const state = await client.query<{value: unknown}>(
        `SELECT rv.value FROM runtime_values rv
           JOIN runtime_fields rf ON rf.id = rv.field_id
          WHERE rf.owner_entity_id = $1 AND rf.field_key = 'combat_state'
            FOR UPDATE OF rv`,
        [targetId],
      );
      if (String(state.rows[0]?.value ?? '"active"').replace(/"/g, '') !== 'downed') {
        return {ok: false, error: 'target not downed'};
      }
      // S-11 / ID-2 — auditable death-save rolls. Seed hex per die is
      // attached to every outcome branch below so the audit log can
      // replay the resolved death save from the seed + sides.
      const rollCtx = {
        purpose: 'death_save',
        sessionId: ctx.sessionId,
        playerId: ctx.playerId,
        turnId: ctx.turnId,
      };
      const primary = rollDie(20, rollCtx);
      const r1 = primary.value;
      const primarySeed = primary.seed;
      const advantageRoll = (args.proficiency_advantage ?? false)
        ? rollDie(20, rollCtx)
        : null;
      const r2 = advantageRoll ? advantageRoll.value : null;
      const secondarySeed = advantageRoll ? advantageRoll.seed : null;
      const roll = r2 != null ? Math.max(r1, r2) : r1;

      // S-11 / ID-2 — share `seed` / `secondary_seed` across every
      // outcome branch so the audit log can replay any death-save
      // resolution from the recorded entropy.
      const seedMeta = {seed: primarySeed, secondary_seed: secondarySeed};
      if (roll === 20) {
        await setCombatFieldWithClient(client, targetId, 12000, 'combat_state', 'active', 'death_save');
        return {ok: true, roll, outcome: 'natural_20_revives_with_1_hp', ...seedMeta};
      }
      if (roll === 1) {
        const cur = await readIntForUpdate(client, targetId, 'death_save_failures');
        const next = cur + 2;
        if (next >= 3) {
          await setCombatFieldWithClient(client, targetId, 12000, 'combat_state', 'dead', 'death_save_nat1');
          return {ok: true, roll, outcome: 'dead', failures: next, ...seedMeta};
        }
        await setCombatFieldWithClient(client, targetId, 12200, 'death_save_failures', next, 'death_save_nat1');
        return {ok: true, roll, outcome: 'failure_x2', failures: next, ...seedMeta};
      }
      if (roll >= 10) {
        const cur = await readIntForUpdate(client, targetId, 'death_save_successes');
        const next = cur + 1;
        if (next >= 3) {
          await setCombatFieldWithClient(client, targetId, 12000, 'combat_state', 'stable', 'death_save');
          return {ok: true, roll, outcome: 'stable', successes: next, ...seedMeta};
        }
        await setCombatFieldWithClient(client, targetId, 12100, 'death_save_successes', next, 'death_save');
        return {ok: true, roll, outcome: 'success', successes: next, ...seedMeta};
      }
      const cur = await readIntForUpdate(client, targetId, 'death_save_failures');
      const next = cur + 1;
      if (next >= 3) {
        await setCombatFieldWithClient(client, targetId, 12000, 'combat_state', 'dead', 'death_save');
        return {ok: true, roll, outcome: 'dead', failures: next, ...seedMeta};
      }
      await setCombatFieldWithClient(client, targetId, 12200, 'death_save_failures', next, 'death_save');
      return {ok: true, roll, outcome: 'failure', failures: next, ...seedMeta};
    });
  },
});

const StabilizeArgs = z.object({
  target: z.string(),
  by: z.string().optional(),
  description: z.string().max(200).optional(),
});

registerTool({
  name: 'stabilize',
  description:
    'Ally / cleric / medic stabilises a downed target without restoring HP. Requires Medicine check resolved by the broker before calling.',
  paramsSchema: StabilizeArgs,
  async execute(args, ctx) {
    const targetId = await resolveEntityId(args.target);
    if (!targetId) return {ok: false, error: `unknown target: ${args.target}`};
    // Wrapped in transaction (GH-BUG-090).
    await withTransaction(async client => {
      await setCombatFieldWithClient(client, targetId, 12000, 'combat_state', 'stable', 'stabilize');
    });
    emitFieldChange(ctx.sessionId, {
      owner_entity_id: targetId,
      field_key: 'combat_state',
      value: 'stable',
      source: 'stabilize',
    });
    return {ok: true, target_id: targetId, state: 'stable'};
  },
});
