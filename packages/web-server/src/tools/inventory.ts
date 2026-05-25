/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Inventory tools backed by the consolidated player inventory and the
// legacy holder ledger:
//   - player_inventory is canonical for player-held structured items.
//   - inventory_entries remains canonical for NPC/container holders.
// Transfers keep the player legacy mirror in sync where an item has a
// legacy entity id, preserving older cartridge recipes.

import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { registerTool, resolveEntityId, ToolExecutionError } from './base.js';
import {
  decrementLegacyItem,
  decrementPlayerItem,
  emitPlayerInventoryEvents,
  ensureLegacyEntityForItem,
  incrementLegacyItem,
  incrementPlayerItem,
  isPlayerHolder,
  resolveInventoryItem,
} from './inventoryCommon.js';

const HolderRef = z.union([z.string(), z.number().int().positive()]);
const ItemRef = z.union([z.string(), z.number().int().positive()]);

const QueryInventoryArgs = z.object({
  holder: HolderRef.describe('Holder display name or numeric entity id.'),
});

registerTool({
  name: 'query_inventory',
  description:
    'List inventory for a player, NPC, or container. Players read player_inventory; non-player holders read inventory_entries.',
  paramsSchema: QueryInventoryArgs,
  async execute(args, ctx) {
    const id = await resolveEntityId(args.holder, { playerId: ctx.playerId });
    if (id == null) return { found: false };
    if (!(await isPlayerHolder(id))) {
      const legacy = await query<{
        slug: string | null;
        item_name: string;
        category: string | null;
        quantity: number;
      }>(
        `SELECT i.slug,
                e.display_name AS item_name,
                i.category,
                ie.count AS quantity
           FROM inventory_entries ie
           JOIN entities e ON e.id = ie.item_entity_id
           LEFT JOIN items i ON i.legacy_entity_id = e.id
          WHERE ie.holder_entity_id = $1
            AND ie.count > 0
          ORDER BY COALESCE(i.category, 'legacy'), e.display_name`,
        [id],
      );
      return {
        found: true,
        holder_id: id,
        items: legacy.rows.map((row) => ({
          slug: row.slug ?? row.item_name,
          item_name: row.item_name,
          category: row.category ?? 'legacy',
          quantity: row.quantity,
          equipped: false,
        })),
      };
    }

    const r = await query<{
      slug: string;
      item_name: string;
      category: string;
      quantity: number;
      equipped: boolean;
    }>(
      `SELECT i.slug, i.slug AS item_name, i.category, pi.quantity, pi.equipped
         FROM player_inventory pi
         JOIN items i ON i.id = pi.item_id
        WHERE pi.player_id = $1
          AND pi.quantity > 0
        ORDER BY i.category, i.slug`,
      [id],
    );
    return { found: true, holder_id: id, items: r.rows };
  },
});

const TransferArgs = z
  .object({
    /** Source holder. Pass null for "spawn out of nowhere" (loot, reward). */
    from: HolderRef.nullable()
      .optional()
      .describe(
        'Source holder display name or numeric entity id; JSON null grants from thin air.',
      ),
    /** Preferred source when the source holder is the active player. */
    from_player_id: z.number().int().positive().optional(),
    /** Destination holder. Pass null for "destroy / consumed". */
    to: HolderRef.nullable()
      .optional()
      .describe(
        'Destination holder display name or numeric entity id; JSON null destroys/consumes.',
      ),
    /** Preferred destination when the destination holder is the active player. */
    to_player_id: z.number().int().positive().optional(),
    /** Item slug/display name or numeric item/entity id. */
    item: ItemRef,
    count: z.number().int().positive(),
    reason: z.string().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const sourceRefs = [
      d.from !== undefined,
      d.from_player_id !== undefined,
    ].filter(Boolean).length;
    const targetRefs = [
      d.to !== undefined,
      d.to_player_id !== undefined,
    ].filter(Boolean).length;
    if (sourceRefs > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'use only one source: from or from_player_id',
      });
    }
    if (targetRefs > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'use only one target: to or to_player_id',
      });
    }
    if (sourceRefs === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from is required; use from=null to grant from thin air',
      });
    }
    if (targetRefs === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'to is required; use to=null to destroy or consume',
      });
    }
  })
  .refine(
    (d) =>
      d.from_player_id != null ||
      d.to_player_id != null ||
      (d.from !== null && d.from !== undefined) ||
      (d.to !== null && d.to !== undefined),
    {
      message: 'at least one real holder must be set',
    },
  );

async function resolveHolderRef(
  role: 'from' | 'to',
  name: string | number | null | undefined,
  playerId: number | undefined,
): Promise<number | null> {
  if (playerId != null) return playerId;
  if (name === null) return null;
  if (typeof name === 'string' || typeof name === 'number') {
    return resolveEntityId(name);
  }
  throw new Error(`${role} is required; use ${role}=null or ${role}_player_id`);
}

registerTool({
  name: 'inventory_transfer',
  description:
    'Move items between players, NPCs, locations, and containers. Exact keys only: from or from_player_id, to or to_player_id, item, count. Use from_player_id/to_player_id for player holders; use from/to with a display name or numeric entity id for NPC/location/container holders. item accepts a slug, display name, numeric item id, or numeric item entity id. from=null grants from thin air; to=null destroys/consumes. Unknown keys are rejected.',
  paramsSchema: TransferArgs,
  async execute(args, ctx) {
    const count = args.count;
    const fromId = await resolveHolderRef(
      'from',
      args.from,
      args.from_player_id,
    );
    const toId = await resolveHolderRef('to', args.to, args.to_player_id);
    if (args.from !== null && args.from_player_id == null && fromId == null) {
      throw new Error(`unknown from: ${args.from}`);
    }
    if (args.to !== null && args.to_player_id == null && toId == null) {
      throw new Error(`unknown to: ${args.to}`);
    }
    if (fromId === toId && fromId !== null) {
      return { transferred: 0, reason: 'same holder' };
    }

    const item = await resolveInventoryItem(
      args.item,
      { query },
      {
        preferredHolderEntityId: fromId,
      },
    );
    if (item == null) throw new Error(`unknown item: ${args.item}`);

    const fromIsPlayer = fromId !== null ? await isPlayerHolder(fromId) : false;
    const toIsPlayer = toId !== null ? await isPlayerHolder(toId) : false;
    if (args.from_player_id != null && !fromIsPlayer) {
      throw new ToolExecutionError(
        `from_player_id ${args.from_player_id} is not a player`,
        {
          rejected: true,
          suggestion: {
            from_player_id: ctx.playerId,
            reason: 'use_current_player_id',
          },
        },
      );
    }
    if (args.to_player_id != null && !toIsPlayer) {
      throw new ToolExecutionError(
        `to_player_id ${args.to_player_id} is not a player`,
        {
          rejected: true,
          suggestion: {
            to_player_id: ctx.playerId,
            reason: 'use_current_player_id',
          },
        },
      );
    }
    if (fromIsPlayer && fromId !== ctx.playerId) {
      throw new ToolExecutionError(
        `from resolved to another player (id ${fromId}); use from_player_id=${ctx.playerId} for this session`,
        {
          rejected: true,
          suggestion: {
            from_player_id: ctx.playerId,
            reason: 'cross_player_mutation_denied',
          },
        },
      );
    }
    if (toIsPlayer && toId !== ctx.playerId) {
      throw new ToolExecutionError(
        `to resolved to another player (id ${toId}); use to_player_id=${ctx.playerId} for this session`,
        {
          rejected: true,
          suggestion: {
            to_player_id: ctx.playerId,
            reason: 'cross_player_mutation_denied',
          },
        },
      );
    }
    const affectedPlayers = [
      fromIsPlayer ? fromId : null,
      toIsPlayer ? toId : null,
    ].filter((id): id is number => id != null);

    const result = await withTransaction(async (client) => {
      const needsLegacy =
        (fromId !== null && !fromIsPlayer) ||
        (toId !== null && !toIsPlayer) ||
        affectedPlayers.length > 0;
      const legacyItemId = needsLegacy
        ? await ensureLegacyEntityForItem(client, item)
        : null;

      if (fromIsPlayer && fromId !== null) {
        await decrementPlayerItem(client, fromId, item.id, count);
        if (legacyItemId != null) {
          await decrementLegacyItem(client, fromId, legacyItemId, count, {
            strict: false,
          });
        }
      } else if (fromId !== null && legacyItemId != null) {
        await decrementLegacyItem(client, fromId, legacyItemId, count, {
          strict: true,
        });
      }

      if (toIsPlayer && toId !== null) {
        await incrementPlayerItem(client, toId, item.id, count);
        if (legacyItemId != null) {
          await incrementLegacyItem(client, toId, legacyItemId, count);
        }
      } else if (toId !== null && legacyItemId != null) {
        await incrementLegacyItem(client, toId, legacyItemId, count);
      }

      return {
        transferred: count,
        from: fromId,
        to: toId,
        item: item.id,
        slug: item.slug,
        legacy_item: legacyItemId,
        reason: args.reason ?? null,
      };
    });

    await emitPlayerInventoryEvents(ctx.sessionId, affectedPlayers, item);
    return result;
  },
});
