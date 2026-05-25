/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — read-only currency tool.
//
// Surfaces the active player's canonical copper-unit balance + the
// per-denomination breakdown that `CurrencyBridgeService` resolves
// from `cartridge_meta.forge_currency_bridge` + `items`. Read-only:
// no debit, credit, transfer, or change-making here. Merchant
// transactions still go through the existing `tools/inventory*.ts`
// surface (next slice will replace those with bridge-aware logic).

import {z} from 'zod';
import {
  ToolExecutionError,
  registerTool,
  resolveEntityId,
} from './base.js';
import {getPlayerCurrencyBalance} from '../services/CurrencyBridgeService.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';

const QueryCurrencyArgs = z.object({
  /**
   * Optional player ref. Accepts a display name or numeric entity
   * id. Defaults to the active player. The tool rejects attempts to
   * inspect a *different* player's balance — currency is private
   * state on the protagonist surface.
   */
  player: z
    .union([z.string(), z.number().int().positive()])
    .optional()
    .describe(
      'Player display name or numeric entity id. Defaults to the active player. Other players are refused.',
    ),
});

registerTool({
  name: 'query_currency_balance',
  description:
    'Read-only currency balance for the active player. Returns per-coin denominations plus a canonical `total_copper`. No mutations.',
  paramsSchema: QueryCurrencyArgs,
  async execute(args, ctx) {
    const requested = args.player ?? ctx.playerId;
    const resolved = await resolveEntityId(requested, {playerId: ctx.playerId});
    if (resolved == null) {
      throw new ToolExecutionError(
        `unknown player: ${String(args.player ?? '')}`,
      );
    }
    if (resolved !== ctx.playerId) {
      throw new ToolExecutionError(
        'query_currency_balance is restricted to the active player',
        {rejected: true},
      );
    }
    const cartridgeId = await resolveActivePlayerCartridgeId(ctx.playerId);
    const balance = await getPlayerCurrencyBalance(resolved, {cartridgeId});
    return {
      ok: true,
      player_id: resolved,
      total_copper: balance.totalCopper,
      bridge_available: balance.bridgeAvailable,
      coins: balance.coins.map(coin => ({
        slug: coin.slug,
        mention: coin.mention,
        copper_value: coin.copperValue,
        quantity: coin.quantity,
        subtotal_copper: coin.subtotalCopper,
      })),
    };
  },
});
