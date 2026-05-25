/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — merchant payment tool.
//
// Pays a specific authored merchant offer in one transaction:
//   1. resolve the offer via `MerchantContractService` (joined with
//      the currency catalog so every required coin already carries
//      its `items.id` + `legacy_entity_id`);
//   2. lock the player's entire currency inventory FOR UPDATE so a
//      concurrent payment cannot double-spend the same stacks;
//   3. try the authored exact-denomination path first — if the
//      player already holds the required coins, debit/credit them
//      verbatim (byte-for-byte the same shape as the prior slice);
//   4. otherwise route through the change-making planner: minimize
//      overpay first, then coin count, then catalog order. Debit
//      the player tender, credit the merchant the offer's copper
//      value as canonical coin rows, hand any overpay back to the
//      player as canonical change. Reject with `insufficient_funds`
//      if the player's total copper falls short;
//   5. write one durable NPC-memory payment row via `MemoryService`
//      capturing the plan mode + tender + change + merchant
//      credit;
//   6. roll the entire transaction back on any failure so partial
//      payments never persist.
//
// Read-only inspection still flows through `query_currency_balance`
// and `listMerchantOffers`; this tool is the only mutation surface
// the OWV-17 merchant slice adds.

import {z} from 'zod';
import {withTransaction, type TxClient} from '../db.js';
import {
  ToolExecutionError,
  registerTool,
} from './base.js';
import {
  decrementPlayerItem,
  ensureLegacyEntityForItem,
  emitPlayerInventoryEvents,
  incrementLegacyItem,
  incrementPlayerItem,
  type InventoryItemRef,
} from './inventoryCommon.js';
import {
  findMerchantOffer,
  type MerchantOffer,
} from '../services/MerchantContractService.js';
import {
  getCurrencyCatalog,
  type CurrencyCatalog,
} from '../services/CurrencyBridgeService.js';
import {
  decomposeCanonical,
  planTender,
} from '../services/CurrencyChangePlanner.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';
import {MemoryService} from '../domain/memory/index.js';

const PayMerchantArgs = z.object({
  merchant: z
    .string()
    .min(1)
    .describe(
      'Merchant source slug (e.g. `mikka`) or canonical `@Display` mention. The tool resolves it through the `forge_merchant_contracts` bridge.',
    ),
  offer_id: z
    .string()
    .min(1)
    .describe(
      'Stable offer id minted by the Forge SQL export (`sha256(source_slug|line).slice(0,16)`).',
    ),
});

interface CoinPayment {
  coin: string;
  amount: number;
  subtotal_copper: number;
}

registerTool({
  name: 'pay_merchant_offer',
  description:
    "Pay one authored merchant offer in full from the active player's currency balance. Tries the offer's exact authored denominations first; if the player is short on those, computes a deterministic tender/change plan from the currency-bridge catalog (minimize overpay, then coin count, then catalog order) and hands back canonical change. Single transaction: debit player tender from player_inventory, credit the merchant's legacy ledger with canonical coin rows for the offer's exact copper value, return any change to the player, and record a durable NPC-memory payment row. Rejects with `insufficient_funds` when the player's total copper is below the offer's copper value.",
  paramsSchema: PayMerchantArgs,
  async execute(args, ctx) {
    const merchantSlug = normalizeMerchantSlug(args.merchant);
    if (!merchantSlug) {
      throw new ToolExecutionError(`unknown merchant: ${args.merchant}`);
    }
    const cartridgeId = await resolveActivePlayerCartridgeId(ctx.playerId);
    const offer = await findMerchantOffer(merchantSlug, args.offer_id, {
      cartridgeId,
    });
    if (!offer) {
      throw new ToolExecutionError(
        `unknown merchant offer: ${merchantSlug}/${args.offer_id}`,
      );
    }
    if (offer.merchantEntityId == null) {
      throw new ToolExecutionError(
        `merchant entity not resolved for slug \`${merchantSlug}\``,
        {rejected: true},
      );
    }
    const missing = offer.requirements.filter(req => req.itemId == null);
    if (missing.length > 0) {
      throw new ToolExecutionError(
        `merchant offer requires unknown coin(s): ${missing.map(r => r.coin).join(', ')}`,
        {rejected: true},
      );
    }

    const catalog = await getCurrencyCatalog({cartridgeId});

    interface AffectedItem {
      id: number;
      slug: string;
      legacyEntityId: number | null;
    }
    const affectedItems = new Map<number, AffectedItem>();
    function trackAffected(itemId: number, fallbackCoinLabel?: string): void {
      if (affectedItems.has(itemId)) return;
      const coin = catalog.byItemId.get(itemId);
      affectedItems.set(itemId, {
        id: itemId,
        slug: coin
          ? `coin:${coin.slug}`
          : fallbackCoinLabel
            ? `coin:${fallbackCoinLabel}`
            : `coin:${itemId}`,
        legacyEntityId: coin?.legacyEntityId ?? null,
      });
    }

    const result = await withTransaction(async client => {
      // Lock every currency stack the player holds. Locking the
      // full currency cursor (not just the required denominations)
      // keeps a concurrent payment from draining a coin the change
      // planner is about to tender or hand back.
      const heldRes = await client.query<{
        item_id: number | string;
        quantity: number | string;
      }>(
        `SELECT pi.item_id, pi.quantity
           FROM player_inventory pi
           JOIN items i ON i.id = pi.item_id
          WHERE pi.player_id = $1
            AND pi.equipped = false
            AND i.category = 'currency'
          FOR UPDATE`,
        [ctx.playerId],
      );
      const playerAvailable = new Map<number, number>();
      for (const row of heldRes.rows) {
        playerAvailable.set(Number(row.item_id), Number(row.quantity));
      }

      const exactPathOk = offer.requirements.every(
        req => (playerAvailable.get(req.itemId!) ?? 0) >= req.amount,
      );

      if (exactPathOk) {
        return await applyExactPayment(
          client,
          ctx.playerId,
          offer,
          trackAffected,
          ctx.turnId ?? null,
        );
      }
      return await applyChangeMakingPayment(
        client,
        ctx.playerId,
        offer,
        catalog,
        playerAvailable,
        trackAffected,
        ctx.turnId ?? null,
      );
    });

    // SSE-OK: the underlying inventory writes already committed via
    // `withTransaction`; `emitPlayerInventoryEvents` is safe to fire
    // post-commit. Each affected coin item gets its own emit so the
    // currency bridge sees a fresh balance per denomination — for
    // both tendered debits and any change-back credits.
    for (const item of affectedItems.values()) {
      await emitPlayerInventoryEvents(ctx.sessionId, [ctx.playerId], {
        id: item.id,
        slug: item.slug,
        category: 'currency',
        legacy_entity_id: item.legacyEntityId,
      });
    }
    return result;
  },
});

async function applyExactPayment(
  client: TxClient,
  playerId: number,
  offer: MerchantOffer,
  trackAffected: (itemId: number, fallback?: string) => void,
  turnId: string | null,
) {
  for (const req of offer.requirements) {
    await decrementPlayerItem(client, playerId, req.itemId!, req.amount);
    const legacyId = await ensureMerchantCoinLegacy(client, req);
    await incrementLegacyItem(
      client,
      offer.merchantEntityId!,
      legacyId,
      req.amount,
    );
    trackAffected(req.itemId!, req.coin);
  }
  const coinsPaid: CoinPayment[] = offer.requirements.map(r => ({
    coin: r.coin,
    amount: r.amount,
    subtotal_copper: r.amount * r.copperValue,
  }));
  const memory = await MemoryService.insertNpcMemory({
    ownerEntityId: offer.merchantEntityId!,
    aboutEntityId: playerId,
    text: paymentMemoryText(offer),
    importance: 0.7,
    tags: paymentTags(offer),
    sensitive: false,
    salience: 0.7,
    memoryKind: 'merchant_payment',
    memoryFamily: 'commerce',
    sourceTurnId: turnId,
    sourceTool: 'pay_merchant_offer',
    metadata: {
      offer_id: offer.offerId,
      merchant_slug: offer.merchantSlug,
      line: offer.line,
      copper_total: offer.copperTotal,
      plan_mode: 'exact',
      coins: coinsPaid.map(c => ({coin: c.coin, amount: c.amount})),
    },
  });
  return {
    ok: true,
    offer_id: offer.offerId,
    merchant_slug: offer.merchantSlug,
    merchant_entity_id: offer.merchantEntityId,
    copper_paid: offer.copperTotal,
    plan_mode: 'exact' as const,
    coins_paid: coinsPaid,
    change_returned: [] as CoinPayment[],
    merchant_credited: coinsPaid,
    memory_id: memory.id,
  };
}

async function applyChangeMakingPayment(
  client: TxClient,
  playerId: number,
  offer: MerchantOffer,
  catalog: CurrencyCatalog,
  playerAvailable: Map<number, number>,
  trackAffected: (itemId: number, fallback?: string) => void,
  turnId: string | null,
) {
  let totalCopper = 0;
  for (const [itemId, qty] of playerAvailable) {
    const coin = catalog.byItemId.get(itemId);
    if (coin) totalCopper += coin.copperValue * qty;
  }
  if (totalCopper < offer.copperTotal) {
    throw new ToolExecutionError(
      `insufficient_funds: need ${offer.copperTotal} copper, have ${totalCopper}`,
      {
        rejected: true,
        suggestion: {
          required_copper: offer.copperTotal,
          have_copper: totalCopper,
        },
      },
    );
  }
  const tender = planTender(catalog.coins, playerAvailable, offer.copperTotal);
  if (!tender) {
    throw new ToolExecutionError(
      `insufficient_funds: cannot tender ${offer.copperTotal} copper from the available denominations`,
      {rejected: true},
    );
  }
  // Canonical decomposition for merchant credit + player change uses
  // only bridge-backed coins when the bridge is wired (so the
  // merchant ledger and the player's change come back in authored
  // denominations, never in legacy fallback coins that happen to
  // sit in the `items` table). When no bridge is available the
  // service surfaces every currency item as a fallback row, so the
  // catalog is the same as the unfiltered list.
  const canonicalCoins = catalog.bridgeAvailable
    ? catalog.coins.filter(c => c.bridgeBacked)
    : catalog.coins;
  const merchantCredit = decomposeCanonical(canonicalCoins, offer.copperTotal);
  if (!merchantCredit) {
    throw new ToolExecutionError(
      `currency catalog cannot represent ${offer.copperTotal} copper in canonical denominations`,
      {rejected: true},
    );
  }
  const changeAmount = tender.totalCopper - offer.copperTotal;
  const changeMap = decomposeCanonical(canonicalCoins, changeAmount);
  if (!changeMap) {
    throw new ToolExecutionError(
      `currency catalog cannot represent ${changeAmount} copper of change`,
      {rejected: true},
    );
  }

  // Debit player tender.
  for (const [itemId, qty] of tender.tendered) {
    await decrementPlayerItem(client, playerId, itemId, qty);
    trackAffected(itemId);
  }
  // Credit the merchant the offer's full copper value as canonical
  // coin rows. The merchant always receives the same shape for the
  // same `offer.copperTotal`, regardless of which player coins
  // were tendered.
  for (const [itemId, qty] of merchantCredit) {
    const coin = catalog.byItemId.get(itemId);
    if (!coin) {
      throw new ToolExecutionError(
        `merchant credit coin missing from catalog: items.id=${itemId}`,
        {rejected: true},
      );
    }
    const legacyId = await ensureMerchantCoinLegacy(client, {
      itemId,
      legacyEntityId: coin.legacyEntityId,
      coin: coin.mention ?? coin.slug,
    });
    await incrementLegacyItem(
      client,
      offer.merchantEntityId!,
      legacyId,
      qty,
    );
  }
  // Return any overpay to the player as canonical change.
  for (const [itemId, qty] of changeMap) {
    await incrementPlayerItem(client, playerId, itemId, qty);
    trackAffected(itemId);
  }

  const coinsPaid = mapToCoinPayments(tender.tendered, catalog);
  const changeReturned = mapToCoinPayments(changeMap, catalog);
  const merchantCredited = mapToCoinPayments(merchantCredit, catalog);

  const memory = await MemoryService.insertNpcMemory({
    ownerEntityId: offer.merchantEntityId!,
    aboutEntityId: playerId,
    text: paymentMemoryText(offer),
    importance: 0.7,
    tags: paymentTags(offer),
    sensitive: false,
    salience: 0.7,
    memoryKind: 'merchant_payment',
    memoryFamily: 'commerce',
    sourceTurnId: turnId,
    sourceTool: 'pay_merchant_offer',
    metadata: {
      offer_id: offer.offerId,
      merchant_slug: offer.merchantSlug,
      line: offer.line,
      copper_total: offer.copperTotal,
      plan_mode: 'change_making',
      coins: coinsPaid.map(c => ({coin: c.coin, amount: c.amount})),
      change_returned: changeReturned.map(c => ({coin: c.coin, amount: c.amount})),
      merchant_credited: merchantCredited.map(c => ({
        coin: c.coin,
        amount: c.amount,
      })),
      change_copper: changeAmount,
      tender_copper: tender.totalCopper,
    },
  });

  return {
    ok: true,
    offer_id: offer.offerId,
    merchant_slug: offer.merchantSlug,
    merchant_entity_id: offer.merchantEntityId,
    copper_paid: offer.copperTotal,
    plan_mode: 'change_making' as const,
    coins_paid: coinsPaid,
    change_returned: changeReturned,
    merchant_credited: merchantCredited,
    memory_id: memory.id,
  };
}

function mapToCoinPayments(
  map: Map<number, number>,
  catalog: CurrencyCatalog,
): CoinPayment[] {
  const out: CoinPayment[] = [];
  // Sort by copper_value DESC then slug ASC for a deterministic
  // payload — the merchant always sees the same canonical shape.
  const entries = [...map.entries()].map(([itemId, amount]) => {
    const coin = catalog.byItemId.get(itemId);
    return {itemId, amount, coin};
  });
  entries.sort((a, b) => {
    const av = a.coin?.copperValue ?? 0;
    const bv = b.coin?.copperValue ?? 0;
    if (av !== bv) return bv - av;
    return (a.coin?.slug ?? String(a.itemId)).localeCompare(
      b.coin?.slug ?? String(b.itemId),
    );
  });
  for (const {itemId, amount, coin} of entries) {
    out.push({
      coin: coin?.mention ?? coin?.slug ?? `item:${itemId}`,
      amount,
      subtotal_copper: amount * (coin?.copperValue ?? 1),
    });
  }
  return out;
}

function normalizeMerchantSlug(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Accept either `@Display name` or the raw slug. We normalize
  // mentions to slug form: lowercase, strip `@`, collapse spaces
  // to `-`. This matches how `vault_scan.get_slug` mints slugs in
  // the Python compiler.
  const stripped = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return stripped
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function ensureMerchantCoinLegacy(
  client: TxClient,
  req: {itemId: number | null; legacyEntityId: number | null; coin: string},
): Promise<number> {
  if (req.legacyEntityId != null) return req.legacyEntityId;
  const itemRows = await client.query<InventoryItemRef>(
    `SELECT id, slug, category, legacy_entity_id
       FROM items
      WHERE id = $1`,
    [req.itemId!],
  );
  const item = itemRows.rows[0];
  if (!item) {
    throw new ToolExecutionError(
      `merchant offer coin item not found: ${req.coin}`,
      {rejected: true},
    );
  }
  return ensureLegacyEntityForItem(client, item);
}

function paymentMemoryText(offer: MerchantOffer): string {
  const coinSummary = offer.requirements
    .map(r => `${r.amount} ${r.coin}`)
    .join(', ');
  return `Hero paid ${offer.copperTotal} copper (${coinSummary}) for: ${offer.line}`;
}

function paymentTags(offer: MerchantOffer): string[] {
  return [
    'payment',
    'merchant',
    offer.merchantSlug,
    `offer:${offer.offerId}`,
  ];
}

