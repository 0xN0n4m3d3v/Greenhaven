/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Player inventory extension tools:
//   use_item    - validate effect, apply it, then consume atomically.
//   equip_item  - toggle equipped state without violating partial indexes.
//   give_to_npc - convenience player -> non-player transfer.

import {z} from 'zod';
import {query, withTransaction} from '../db.js';
import {emitFieldChange, emitFieldChangesById} from '../runtimeFieldEvents.js';
import {registerTool, resolveEntityId} from './base.js';
import {
  decrementLegacyItem,
  decrementPlayerItem,
  emitPlayerInventoryEvents,
  ensureLegacyEntityForItem,
  getPlayerItemQuantity,
  incrementLegacyItem,
  isPlayerHolder,
  resolveInventoryItem,
} from './inventoryCommon.js';
import {applyPatchRawWithClient} from './runtime.js';
import {rollDie, type RollContext} from './gameplayRng.js';
import {applyMaterializersForTrigger} from './materializer.js';

// S-11 / ID-2 — `rollAmount` now returns a parallel `seeds: string[]`
// array so the audit log can replay every die that contributed to a
// heal amount. Flat-number formulas keep `seeds: []` (no dice rolled).
function rollAmount(
  expr: string,
  rollCtx?: RollContext,
): {amount: number; rolls: number[]; seeds: string[]; formula: string} | null {
  const trimmed = expr.trim();
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber > 0) {
    return {amount: asNumber, rolls: [], seeds: [], formula: trimmed};
  }
  const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(trimmed);
  if (!m) return null;
  const count = Number(m[1] || 1);
  const sides = Number(m[2]);
  const mod = Number(m[3] || 0);
  if (count < 1 || count > 20 || sides < 2 || sides > 100) return null;
  const rolls: number[] = [];
  const seeds: string[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rollDie(sides, rollCtx);
    rolls.push(roll.value);
    seeds.push(roll.seed);
  }
  const amount = rolls.reduce((sum, n) => sum + n, 0) + mod;
  return {amount: Math.max(0, amount), rolls, seeds, formula: trimmed};
}

const UseItemArgs = z.object({
  item_slug: z.string(),
  target_location: z.string().optional(),
  target_entity: z.string().optional(),
});

registerTool({
  name: 'use_item',
  description:
    "Use an item from the player's inventory. Validates target/effect before consuming. Supports applies_surface and heal behaviours.",
  paramsSchema: UseItemArgs,
  async execute(args, ctx) {
    const item = await resolveInventoryItem(args.item_slug);
    if (item == null) return {ok: false, error: `unknown item: ${args.item_slug}`};
    const itemRow = await query<{behaviour: unknown}>(
      `SELECT behaviour FROM items WHERE id = $1`,
      [item.id],
    );
    const behaviour = (itemRow.rows[0]?.behaviour ?? {}) as Record<string, unknown>;

    if (typeof behaviour['applies_surface'] === 'string') {
      if (!args.target_location) {
        return {ok: false, error: 'target_location_required', consumed: false};
      }
      const locId = await resolveEntityId(args.target_location);
      if (locId == null) {
        return {ok: false, error: `unknown target_location: ${args.target_location}`, consumed: false};
      }
      const fieldRow = await query<{id: number}>(
        `SELECT id FROM runtime_fields
          WHERE owner_entity_id = $1 AND field_key = 'active_surfaces'`,
        [locId],
      );
      const fieldId = fieldRow.rows[0]?.id;
      if (fieldId == null) {
        return {ok: false, error: 'target_has_no_active_surfaces', consumed: false};
      }
      const turnRow = await query<{turn_no: number}>(
        `SELECT COALESCE(MAX(turn_index), 0)::int AS turn_no
           FROM chat_messages WHERE session_id = $1`,
        [ctx.sessionId],
      );
      const currentTurn = Number(turnRow.rows[0]?.turn_no ?? 0);
      const lifetime = Number(behaviour['duration_turns'] ?? 3);
      const entry = {
        type: behaviour['applies_surface'],
        severity: 1,
        applied_turn: currentTurn,
        expires_turn: currentTurn + lifetime,
        source: `use_item:${item.slug}`,
        area: 'central',
      };
      const result = await withTransaction(async client => {
        const remaining = await decrementPlayerItem(client, ctx.playerId, item.id, 1);
        await applyPatchRawWithClient(client, fieldId, entry, 'append', 'use_item');
        return {remaining};
      });
      await emitFieldChangesById(ctx.sessionId, [
        {field_id: fieldId, source: 'use_item'},
      ]);
      await emitPlayerInventoryEvents(ctx.sessionId, ctx.playerId, item);
      await applyItemUseMaterializers(ctx, item);
      return {
        ok: true,
        consumed: item.slug,
        remaining: result.remaining,
        effects: {
          applied_surface: behaviour['applies_surface'],
          target_location: locId,
        },
      };
    }

    if (behaviour['effect'] === 'heal' && typeof behaviour['amount'] === 'string') {
      const rolled = rollAmount(behaviour['amount'], {
        purpose: 'use_item_heal',
        sessionId: ctx.sessionId,
        playerId: ctx.playerId,
        turnId: ctx.turnId,
      });
      if (rolled == null || rolled.amount <= 0) {
        return {ok: false, error: 'invalid_heal_amount', consumed: false};
      }
      const result = await withTransaction(async client => {
        const p = await client.query<{current_hp: number; max_hp: number}>(
          `SELECT current_hp, max_hp FROM players WHERE entity_id = $1 FOR UPDATE`,
          [ctx.playerId],
        );
        const player = p.rows[0];
        if (!player) throw new Error(`unknown player: ${ctx.playerId}`);
        if (player.current_hp >= player.max_hp) {
          return {
            consumed: false,
            remaining: await getPlayerItemQuantity(ctx.playerId, item.id, client),
            hp_before: player.current_hp,
            hp_after: player.current_hp,
            hp_max: player.max_hp,
          };
        }
        const after = Math.min(player.max_hp, player.current_hp + rolled.amount);
        await client.query(
          `UPDATE players SET current_hp = $1 WHERE entity_id = $2`,
          [after, ctx.playerId],
        );
        const remaining = await decrementPlayerItem(client, ctx.playerId, item.id, 1);
        return {
          consumed: true,
          remaining,
          hp_before: player.current_hp,
          hp_after: after,
          hp_max: player.max_hp,
        };
      });
      if (!result.consumed) {
        return {...result, ok: false, error: 'hp_already_full'};
      }
      emitFieldChange(ctx.sessionId, {
        owner_entity_id: ctx.playerId,
        field_key: 'current_hp',
        value: result.hp_after,
        source: 'use_item',
      });
      await emitPlayerInventoryEvents(ctx.sessionId, ctx.playerId, item);
      await applyItemUseMaterializers(ctx, item);
      return {
        ok: true,
        consumed: item.slug,
        remaining: result.remaining,
        effects: {
          heal_requested: rolled.amount,
          heal_formula: rolled.formula,
          heal_rolls: rolled.rolls,
          // S-11 / ID-2 — auditable entropy per heal die.
          heal_seeds: rolled.seeds,
          heal_applied: result.hp_after - result.hp_before,
          hp_before: result.hp_before,
          hp_after: result.hp_after,
          hp_max: result.hp_max,
        },
      };
    }

    return {ok: false, error: 'item_has_no_supported_use', consumed: false};
  },
});

async function applyItemUseMaterializers(
  ctx: Parameters<typeof applyMaterializersForTrigger>[0],
  item: {slug: string; legacy_entity_id: number | null},
): Promise<void> {
  const sourceSlug = await sourceSlugForInventoryItem(item);
  if (!sourceSlug) return;
  await applyMaterializersForTrigger(ctx, 'item_use', {sourceSlug});
}

async function sourceSlugForInventoryItem(item: {
  slug: string;
  legacy_entity_id: number | null;
}): Promise<string | null> {
  if (item.legacy_entity_id != null) {
    const row = await query<{source_slug: string | null}>(
      `SELECT profile->>'source_slug' AS source_slug
         FROM entities
        WHERE id = $1`,
      [item.legacy_entity_id],
    );
    const sourceSlug = row.rows[0]?.source_slug?.trim().toLowerCase();
    if (sourceSlug) return sourceSlug;
  }
  const fallback = item.slug.trim().toLowerCase().replace(/_/g, '-');
  return fallback || null;
}

const EquipArgs = z.object({
  item_slug: z.string(),
  equipped: z.boolean().default(true),
});

registerTool({
  name: 'equip_item',
  description:
    "Toggle equipped flag on the player's item by slug. Equipping is idempotent; unequipping merges back into the unequipped stack when needed.",
  paramsSchema: EquipArgs,
  async execute(args, ctx) {
    const item = await resolveInventoryItem(args.item_slug);
    if (item == null) return {ok: false, error: `unknown item: ${args.item_slug}`};
    const wantEquipped = args.equipped ?? true;
    const result = await withTransaction(async client => {
      const rows = await client.query<{id: number; quantity: number; equipped: boolean}>(
        `SELECT id, quantity, equipped
           FROM player_inventory
          WHERE player_id = $1 AND item_id = $2
          ORDER BY equipped DESC, id ASC
          FOR UPDATE`,
        [ctx.playerId, item.id],
      );
      if (rows.rows.length === 0) return {ok: false as const, already: false};

      const equippedRow = rows.rows.find(row => row.equipped);
      const unequippedRow = rows.rows.find(row => !row.equipped);

      if (wantEquipped) {
        if (equippedRow) return {ok: true as const, already: true};
        const target = unequippedRow ?? rows.rows[0]!;
        await client.query(
          `UPDATE player_inventory SET equipped = true WHERE id = $1`,
          [target.id],
        );
        return {ok: true as const, already: false};
      }

      if (!equippedRow) return {ok: true as const, already: true};
      if (unequippedRow) {
        await client.query(
          `UPDATE player_inventory
              SET quantity = quantity + $2
            WHERE id = $1`,
          [unequippedRow.id, equippedRow.quantity],
        );
        await client.query(`DELETE FROM player_inventory WHERE id = $1`, [
          equippedRow.id,
        ]);
      } else {
        await client.query(
          `UPDATE player_inventory SET equipped = false WHERE id = $1`,
          [equippedRow.id],
        );
      }
      return {ok: true as const, already: false};
    });
    if (!result.ok) return {ok: false, error: `player has no ${args.item_slug}`};
    await emitPlayerInventoryEvents(ctx.sessionId, ctx.playerId, item);
    return {
      ok: true,
      item_slug: item.slug,
      equipped: wantEquipped,
      already: result.already,
    };
  },
});

const GiveArgs = z.object({
  item_slug: z.string(),
  npc: z.string(),
  quantity: z.number().int().min(1).default(1),
});

registerTool({
  name: 'give_to_npc',
  description:
    "Transfer an item from the player's inventory to an NPC/non-player holder and record it in inventory_entries.",
  paramsSchema: GiveArgs,
  async execute(args, ctx) {
    const npcId = await resolveEntityId(args.npc);
    if (!npcId) return {ok: false, error: `unknown NPC: ${args.npc}`};
    if (await isPlayerHolder(npcId)) {
      return {ok: false, error: 'target_is_player; use inventory_transfer'};
    }
    const item = await resolveInventoryItem(args.item_slug);
    if (item == null) return {ok: false, error: `unknown item: ${args.item_slug}`};
    const qty = args.quantity ?? 1;
    const result = await withTransaction(async client => {
      const legacyItemId = await ensureLegacyEntityForItem(client, item);
      const remaining = await decrementPlayerItem(client, ctx.playerId, item.id, qty);
      await decrementLegacyItem(client, ctx.playerId, legacyItemId, qty, {
        strict: false,
      });
      await incrementLegacyItem(client, npcId, legacyItemId, qty);
      return {remaining, legacyItemId};
    });
    await emitPlayerInventoryEvents(ctx.sessionId, ctx.playerId, item);
    return {
      ok: true,
      item_slug: item.slug,
      npc_id: npcId,
      transferred: qty,
      remaining: result.remaining,
      legacy_item: result.legacyItemId,
    };
  },
});
