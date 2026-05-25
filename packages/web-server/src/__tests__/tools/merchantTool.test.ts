/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `pay_merchant_offer` broker tool contract.
//
//   * the tool is registered with the canonical name;
//   * exact-denomination payments debit the player by exact
//     denominations, credit the merchant ledger, and write one
//     payment memory row whose metadata records the offer + coin
//     breakdown;
//   * change-making payments use the bridge catalog to tender
//     player coins (minimize overpay then coin count), credit the
//     merchant canonical coin rows for the offer's copper value,
//     and return canonical change to the player;
//   * shortfall payments leave the world untouched (no debit, no
//     credit, no memory row) and surface a structured
//     `insufficient_funds` `ToolExecutionError`.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let getRegisteredTools: typeof import('../../tools/base.js').getRegisteredTools;
let runWithContext: typeof import('../../tools/base.js').runWithContext;
let ToolExecutionError: typeof import('../../tools/base.js').ToolExecutionError;
let cartridgeCache: typeof import('../../cartridge.js');
let CurrencyBridgeService: typeof import('../../services/CurrencyBridgeService.js');
let MerchantContractService: typeof import('../../services/MerchantContractService.js');
let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;

interface ToolHandle {
  execute: (
    args: Record<string, unknown>,
    ctx: {sessionId: string; playerId: number},
  ) => Promise<unknown>;
}

function getTool(name: string): ToolHandle {
  const def = getRegisteredTools().get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def as unknown as ToolHandle;
}

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({getRegisteredTools, runWithContext, ToolExecutionError} = await import(
    '../../tools/base.js'
  ));
  cartridgeCache = await import('../../cartridge.js');
  CurrencyBridgeService = await import(
    '../../services/CurrencyBridgeService.js'
  );
  MerchantContractService = await import(
    '../../services/MerchantContractService.js'
  );
  ({createAnonymousPlayer} = await import('../../playerService.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  await queryRows(
    `INSERT INTO cartridges (id, title, version, schema_version, source_kind, content_hash)
     VALUES ('quickgrin-lane', 'quickgrin-lane', '1.0.0', 'greenhaven.cartridge.v1', 'builtin', 'quickgrin-lane')
     ON CONFLICT (id) DO NOTHING`
  );
  // Migration 0122 seeds canonical \`forge_currency_bridge\` and
  // `forge_merchant_contracts` into every fresh-migration fixture,
  // PLUS canonical currency items (`copper-coin`, `silver-coin`,
  // `gold-coin`) and a `mikka` entity. Without dropping all three
  // sets, the merchant-tool resolver picks the migration's mikka
  // (lower entity id) or the migration's silver coin (lower item
  // id) instead of the test's seeded fixtures.
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key IN ('forge_currency_bridge','forge_merchant_contracts')`,
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'quickgrin-lane' AND key IN ('forge_currency_bridge','forge_merchant_contracts')`,
  );
  await queryRows(
    `DELETE FROM items WHERE category = 'currency'
       AND slug IN ('copper-coin','silver-coin','gold-coin')`,
  );
  await queryRows(
    `DELETE FROM entities
       WHERE profile->>'source_slug' = 'mikka'
         AND tags @> ARRAY['grinhaven-full']::text[]`,
  );
  cartridgeCache.clearMetaCache();
  CurrencyBridgeService.clearCurrencyCatalogCache();
  MerchantContractService.clearMerchantContractsCache();
});

afterEach(async () => {
  cartridgeCache.clearMetaCache();
  CurrencyBridgeService.clearCurrencyCatalogCache();
  MerchantContractService.clearMerchantContractsCache();
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key IN ('forge_currency_bridge','forge_merchant_contracts')`,
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'quickgrin-lane' AND key IN ('forge_currency_bridge','forge_merchant_contracts')`,
  );
  await queryRows(
    `DELETE FROM player_inventory
       WHERE item_id IN (SELECT id FROM items WHERE slug LIKE 'owv17-tool-merch-%')`,
  );
  await queryRows(
    `DELETE FROM inventory_entries
       WHERE item_entity_id IN (
         SELECT legacy_entity_id FROM items
          WHERE slug LIKE 'owv17-tool-merch-%' AND legacy_entity_id IS NOT NULL
       )`,
  );
  await queryRows(
    `DELETE FROM items WHERE category = 'currency' AND slug LIKE 'owv17-tool-merch-%'`,
  );
  await queryRows(
    `DELETE FROM npc_memories WHERE memory_kind = 'merchant_payment'`,
  );
  await queryRows(
    `DELETE FROM entities WHERE display_name LIKE 'OWV-17 tool merch %'`,
  );
  await queryRows(
    `DELETE FROM hero_cartridge_states WHERE cartridge_id = 'quickgrin-lane'`,
  );
});

async function newPlayer(label: string): Promise<number> {
  const p = await createAnonymousPlayer(`OWV-17 tool merch ${label} ${Date.now()}`);
  await queryRows(`DELETE FROM player_inventory WHERE player_id = $1`, [
    p.entity_id,
  ]);
  await queryRows(
    `DELETE FROM inventory_entries WHERE holder_entity_id = $1`,
    [p.entity_id],
  );
  await queryRows(
    `INSERT INTO hero_cartridge_states (player_id, cartridge_id, status)
     VALUES ($1, 'quickgrin-lane', 'active')`,
    [p.entity_id],
  );
  return p.entity_id;
}

async function seedCoin(slug: string, copperValue: number, mention: string): Promise<number> {
  const rows = await queryRows<{id: number}>(
    `INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour)
     VALUES ($1, 'currency', 0, true, 9999, $2::jsonb)
     ON CONFLICT (slug) DO UPDATE SET behaviour = EXCLUDED.behaviour
     RETURNING id`,
    [slug, JSON.stringify({copper_value: copperValue, canonical_mention: mention})],
  );
  return Number(rows[0]!.id);
}

async function seedMerchant(slug: string, displayName: string): Promise<number> {
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES ('person', $1, 'merchant', $2::jsonb, ARRAY['person','merchant'], 'quickgrin-lane')
     RETURNING id`,
    [displayName, JSON.stringify({source_slug: slug, cartridge_id: 'quickgrin-lane'})],
  );
  return Number(rows[0]!.id);
}

async function seedBridgesAndOffer(opts: {
  merchantSlug: string;
  offerId: string;
  line: string;
  coinMention: string;
  coinAmount: number;
  copperTotal: number;
}): Promise<void> {
  await queryRows(
    `INSERT INTO cartridges (id, title, version, schema_version, source_kind, content_hash)
     VALUES ('quickgrin-lane', 'quickgrin-lane', '1.0.0', 'greenhaven.cartridge.v1', 'builtin', 'quickgrin-lane')
     ON CONFLICT (id) DO NOTHING`
  );
  await queryRows(
    `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description) VALUES
       ('quickgrin-lane', 'forge_currency_bridge', $1::jsonb, 'OWV-17 merchant tool seed'),
       ('quickgrin-lane', 'forge_merchant_contracts', $2::jsonb, 'OWV-17 merchant tool seed')
     ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        schema_version: 'greenhaven.currency_rates.v1',
        source_project: 'owv17-test',
        coins: [
          {slug: 'owv17-tool-merch-copper', mention: '@Copper coin', copper_value: 1},
          {slug: 'owv17-tool-merch-silver', mention: '@Silver coin', copper_value: 10},
        ],
        world_currency_facts: [],
      }),
      JSON.stringify({
        schema_version: 'greenhaven.merchant_contracts.v1',
        source_project: 'owv17-test',
        offers: [
          {
            offer_id: opts.offerId,
            source_slug: opts.merchantSlug,
            source_mention: `@${opts.merchantSlug}`,
            source_kind: 'person',
            source_path: 'GreenHavenWorld/.../merchant.md',
            line: opts.line,
            coins: [{coin: opts.coinMention, amount: opts.coinAmount}],
            copper_value: opts.copperTotal,
          },
        ],
      }),
    ],
  );
  cartridgeCache.clearMetaCache();
  CurrencyBridgeService.clearCurrencyCatalogCache();
  MerchantContractService.clearMerchantContractsCache();
}

describe('pay_merchant_offer (OWV-17 merchant tool)', () => {
  it('is registered with the canonical tool name', () => {
    expect(getRegisteredTools().has('pay_merchant_offer')).toBe(true);
  });

  it('debits player, credits merchant ledger, and writes one payment memory', async () => {
    const playerId = await newPlayer('happy-path');
    const silverId = await seedCoin('owv17-tool-merch-silver', 10, '@Silver coin');
    await seedCoin('owv17-tool-merch-copper', 1, '@Copper coin');
    const merchantId = await seedMerchant('mikka', 'OWV-17 tool merch Mikka');
    await seedBridgesAndOffer({
      merchantSlug: 'mikka',
      offerId: 'pay001',
      line: 'private tip - 2 @Silver coin',
      coinMention: '@Silver coin',
      coinAmount: 2,
      copperTotal: 20,
    });
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 5, false)`,
      [playerId, silverId],
    );
    const tool = getTool('pay_merchant_offer');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {merchant: 'mikka', offer_id: 'pay001'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      copper_paid: number;
      merchant_entity_id: number;
      memory_id: number;
    };
    expect(result.ok).toBe(true);
    expect(result.copper_paid).toBe(20);
    expect(result.merchant_entity_id).toBe(merchantId);
    expect(result.memory_id).toBeGreaterThan(0);
    const after = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
         FROM player_inventory
        WHERE player_id = $1 AND item_id = $2`,
      [playerId, silverId],
    );
    expect(Number(after[0]!.quantity)).toBe(3);
    const ledger = await queryRows<{count: number}>(
      `SELECT count FROM inventory_entries
        WHERE holder_entity_id = $1`,
      [merchantId],
    );
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]!.count)).toBe(2);
    const memory = await queryRows<{
      memory_kind: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT memory_kind, metadata
         FROM npc_memories
        WHERE owner_entity_id = $1
          AND memory_kind = 'merchant_payment'`,
      [merchantId],
    );
    expect(memory).toHaveLength(1);
    expect(memory[0]!.metadata.offer_id).toBe('pay001');
    expect(memory[0]!.metadata.copper_total).toBe(20);
  });

  it('rolls back the entire payment when the player has too little total copper', async () => {
    const playerId = await newPlayer('insufficient');
    const silverId = await seedCoin('owv17-tool-merch-silver', 10, '@Silver coin');
    await seedCoin('owv17-tool-merch-copper', 1, '@Copper coin');
    const merchantId = await seedMerchant('mikka', 'OWV-17 tool merch Mikka short');
    await seedBridgesAndOffer({
      merchantSlug: 'mikka',
      offerId: 'pay002',
      line: 'private tip - 2 @Silver coin',
      coinMention: '@Silver coin',
      coinAmount: 2,
      copperTotal: 20,
    });
    // Player has 1 silver = 10 copper but offer needs 20. Total is
    // short → reject as `insufficient_funds` with no mutation.
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 1, false)`,
      [playerId, silverId],
    );
    const tool = getTool('pay_merchant_offer');
    let caught: unknown = null;
    try {
      await runWithContext(
        {sessionId: `s-${playerId}`, playerId},
        () =>
          tool.execute(
            {merchant: 'mikka', offer_id: 'pay002'},
            {sessionId: `s-${playerId}`, playerId},
          ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const toolError = caught as InstanceType<typeof ToolExecutionError>;
    expect(toolError.rejected).toBe(true);
    expect(toolError.message).toContain('insufficient_funds');
    expect(toolError.suggestion).toMatchObject({
      required_copper: 20,
      have_copper: 10,
    });
    const after = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
         FROM player_inventory
        WHERE player_id = $1 AND item_id = $2`,
      [playerId, silverId],
    );
    expect(Number(after[0]!.quantity)).toBe(1);
    const ledger = await queryRows<{count: number}>(
      `SELECT count FROM inventory_entries
        WHERE holder_entity_id = $1`,
      [merchantId],
    );
    expect(ledger).toEqual([]);
    const memory = await queryRows<{id: number}>(
      `SELECT id FROM npc_memories
        WHERE owner_entity_id = $1
          AND memory_kind = 'merchant_payment'`,
      [merchantId],
    );
    expect(memory).toEqual([]);
  });

  it('tenders mixed denominations with zero change when exact change is possible', async () => {
    const playerId = await newPlayer('mixed-tender');
    const silverId = await seedCoin('owv17-tool-merch-silver', 10, '@Silver coin');
    const copperId = await seedCoin('owv17-tool-merch-copper', 1, '@Copper coin');
    const merchantId = await seedMerchant('mikka', 'OWV-17 tool merch Mikka mixed');
    await seedBridgesAndOffer({
      merchantSlug: 'mikka',
      offerId: 'pay003',
      line: 'private tip - 2 @Silver coin',
      coinMention: '@Silver coin',
      coinAmount: 2,
      copperTotal: 20,
    });
    // Player has 1 silver + 15 copper = 25 copper total. Offer is
    // 20 copper. Exact-denomination path fails (needs 2 silver, has
    // 1). Best change-making tender: {silver:1, copper:10} = 20.
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 1, false), ($1, $3, 15, false)`,
      [playerId, silverId, copperId],
    );
    const tool = getTool('pay_merchant_offer');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {merchant: 'mikka', offer_id: 'pay003'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      plan_mode: string;
      copper_paid: number;
      coins_paid: Array<{coin: string; amount: number; subtotal_copper: number}>;
      change_returned: Array<unknown>;
      merchant_credited: Array<{coin: string; amount: number}>;
      memory_id: number;
    };
    expect(result.ok).toBe(true);
    expect(result.plan_mode).toBe('change_making');
    expect(result.copper_paid).toBe(20);
    expect(result.change_returned).toEqual([]);
    // Tender shape: 1 silver + 10 copper.
    const tenderBySlug = Object.fromEntries(
      result.coins_paid.map(c => [c.coin, c.amount]),
    );
    expect(tenderBySlug['@Silver coin']).toBe(1);
    expect(tenderBySlug['@Copper coin']).toBe(10);
    // Merchant credit is canonical: 2 silver.
    const creditBySlug = Object.fromEntries(
      result.merchant_credited.map(c => [c.coin, c.amount]),
    );
    expect(creditBySlug['@Silver coin']).toBe(2);
    // Player balance after: silver 0, copper 5.
    const after = await queryRows<{item_id: number; quantity: number}>(
      `SELECT item_id, quantity FROM player_inventory WHERE player_id = $1`,
      [playerId],
    );
    const balance = Object.fromEntries(
      after.map(r => [Number(r.item_id), Number(r.quantity)]),
    );
    expect(balance[silverId] ?? 0).toBe(0);
    expect(balance[copperId] ?? 0).toBe(5);
    // Merchant ledger: one silver row with count = 2.
    const ledger = await queryRows<{count: number}>(
      `SELECT count FROM inventory_entries
        WHERE holder_entity_id = $1
        ORDER BY count DESC`,
      [merchantId],
    );
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]!.count)).toBe(2);
  });

  it('returns canonical change when the tender overpays', async () => {
    const playerId = await newPlayer('overpay');
    const silverId = await seedCoin('owv17-tool-merch-silver', 10, '@Silver coin');
    const copperId = await seedCoin('owv17-tool-merch-copper', 1, '@Copper coin');
    const merchantId = await seedMerchant('mikka', 'OWV-17 tool merch Mikka overpay');
    // Offer needs 2 silver + 5 copper = 25 copper. The two-coin
    // requirement guarantees the exact-denomination path cannot
    // be satisfied when the player has no copper.
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version, source_kind, content_hash)
       VALUES ('quickgrin-lane', 'quickgrin-lane', '1.0.0', 'greenhaven.cartridge.v1', 'builtin', 'quickgrin-lane')
       ON CONFLICT (id) DO NOTHING`
    );
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description) VALUES
         ('quickgrin-lane', 'forge_currency_bridge', $1::jsonb, 'OWV-17 merchant tool seed'),
         ('quickgrin-lane', 'forge_merchant_contracts', $2::jsonb, 'OWV-17 merchant tool seed')
       ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          schema_version: 'greenhaven.currency_rates.v1',
          source_project: 'owv17-test',
          coins: [
            {slug: 'owv17-tool-merch-copper', mention: '@Copper coin', copper_value: 1},
            {slug: 'owv17-tool-merch-silver', mention: '@Silver coin', copper_value: 10},
          ],
          world_currency_facts: [],
        }),
        JSON.stringify({
          schema_version: 'greenhaven.merchant_contracts.v1',
          source_project: 'owv17-test',
          offers: [
            {
              offer_id: 'pay004',
              source_slug: 'mikka',
              source_mention: '@mikka',
              source_kind: 'person',
              source_path: 'x.md',
              line: 'special tip - 25 copper',
              coins: [
                {coin: '@Silver coin', amount: 2},
                {coin: '@Copper coin', amount: 5},
              ],
              copper_value: 25,
            },
          ],
        }),
      ],
    );
    cartridgeCache.clearMetaCache();
    CurrencyBridgeService.clearCurrencyCatalogCache();
    MerchantContractService.clearMerchantContractsCache();
    // Player has 3 silver (30 copper) and no copper. Offer is 25
    // copper. Exact path fails (needs 5 copper, has 0). Best
    // change-making tender: 3 silver → 30. Overpay 5 → change 5
    // copper.
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 3, false)`,
      [playerId, silverId],
    );
    const tool = getTool('pay_merchant_offer');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {merchant: 'mikka', offer_id: 'pay004'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      plan_mode: string;
      copper_paid: number;
      coins_paid: Array<{coin: string; amount: number}>;
      change_returned: Array<{coin: string; amount: number; subtotal_copper: number}>;
      merchant_credited: Array<{coin: string; amount: number}>;
    };
    expect(result.plan_mode).toBe('change_making');
    expect(result.copper_paid).toBe(25);
    // Tender = 3 silver.
    const tenderBySlug = Object.fromEntries(
      result.coins_paid.map(c => [c.coin, c.amount]),
    );
    expect(tenderBySlug['@Silver coin']).toBe(3);
    // Change = 5 copper.
    const changeBySlug = Object.fromEntries(
      result.change_returned.map(c => [c.coin, c.amount]),
    );
    expect(changeBySlug['@Copper coin']).toBe(5);
    // Merchant credit = canonical(25) = 2 silver + 5 copper.
    const creditBySlug = Object.fromEntries(
      result.merchant_credited.map(c => [c.coin, c.amount]),
    );
    expect(creditBySlug['@Silver coin']).toBe(2);
    expect(creditBySlug['@Copper coin']).toBe(5);
    // Player balance after: 0 silver, 5 copper.
    const after = await queryRows<{item_id: number; quantity: number}>(
      `SELECT item_id, quantity FROM player_inventory WHERE player_id = $1`,
      [playerId],
    );
    const balance = Object.fromEntries(
      after.map(r => [Number(r.item_id), Number(r.quantity)]),
    );
    expect(balance[silverId] ?? 0).toBe(0);
    expect(balance[copperId] ?? 0).toBe(5);
    // Conservation: player lost 30 copper, gained 5 → net -25 copper.
    // Merchant ledger gained 25 copper.
    const ledger = await queryRows<{count: number}>(
      `SELECT count FROM inventory_entries
        WHERE holder_entity_id = $1
        ORDER BY count DESC`,
      [merchantId],
    );
    const ledgerSum = ledger.reduce((s, r) => s + Number(r.count), 0);
    // 2 silver (worth 20) + 5 copper (worth 5) → row counts sum to 7;
    // the copper-value sum is 25 by construction.
    expect(ledgerSum).toBe(7);
    // The memory metadata should mark this as change_making.
    const memory = await queryRows<{metadata: Record<string, unknown>}>(
      `SELECT metadata FROM npc_memories
        WHERE owner_entity_id = $1 AND memory_kind = 'merchant_payment'`,
      [merchantId],
    );
    expect(memory).toHaveLength(1);
    expect(memory[0]!.metadata.plan_mode).toBe('change_making');
    expect(memory[0]!.metadata.change_copper).toBe(5);
    expect(memory[0]!.metadata.tender_copper).toBe(30);
  });
});
