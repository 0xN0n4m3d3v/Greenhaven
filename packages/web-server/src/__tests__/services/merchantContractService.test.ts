/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `MerchantContractService` contract.
//
// Pins the read layer that joins the `forge_merchant_contracts`
// cartridge_meta document with the currency catalog:
//
//   * the bridge is unavailable until the meta row is seeded;
//   * `listMerchantOffers` returns offers per merchant slug with
//     coin requirements resolved through the currency catalog;
//   * `findMerchantOffer` resolves a specific `(slug, offer_id)`
//     pair into a payment-ready offer or `null`;
//   * merchant entity ids are resolved via
//     `entities.profile->>'source_slug'`;
//   * a coin mention with no currency-catalog match surfaces as
//     `itemId = null` so callers reject the offer instead of
//     fabricating an item id.

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

let MerchantContractService: typeof import('../../services/MerchantContractService.js');
let CurrencyBridgeService: typeof import('../../services/CurrencyBridgeService.js');
let cartridgeCache: typeof import('../../cartridge.js');

beforeAll(async () => {
  await setupTurnTestEnvironment();
  MerchantContractService = await import(
    '../../services/MerchantContractService.js'
  );
  CurrencyBridgeService = await import(
    '../../services/CurrencyBridgeService.js'
  );
  cartridgeCache = await import('../../cartridge.js');
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  // Migration 0122 seeds canonical `forge_currency_bridge` and
  // `forge_merchant_contracts` into every fresh-migration fixture,
  // PLUS canonical currency items and entities (e.g. 'mikka',
  // 'silver-coin', 'copper-coin') whose mentions collide with the
  // test's seeded coins. Drop the bridge meta rows, the
  // cartridge-owned currency items, and the cartridge-owned mikka
  // entity so the merchant resolver only sees the test fixtures.
  await queryRows(
    `DELETE FROM cartridge_meta
       WHERE key IN ('forge_currency_bridge','forge_merchant_contracts')`,
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
    `DELETE FROM items WHERE category = 'currency' AND slug LIKE 'owv17-merch-%'`,
  );
  await queryRows(
    `DELETE FROM entities WHERE display_name LIKE 'OWV-17 merchant %'`,
  );
});

async function seedMerchantBridge(rows: unknown[]): Promise<void> {
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('forge_merchant_contracts', $1::jsonb, 'OWV-17 merchant test seed')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        schema_version: 'greenhaven.merchant_contracts.v1',
        source_project: 'owv17-test',
        offers: rows,
      }),
    ],
  );
}

async function seedCurrencyBridge(coins: Array<{slug: string; mention: string; copper_value: number}>): Promise<void> {
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('forge_currency_bridge', $1::jsonb, 'OWV-17 currency seed for merchant test')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        schema_version: 'greenhaven.currency_rates.v1',
        source_project: 'owv17-test',
        coins,
        world_currency_facts: [],
      }),
    ],
  );
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
     VALUES ('person', $1, 'merchant', $2::jsonb, ARRAY['person','merchant'], 'owv17-test')
     RETURNING id`,
    [displayName, JSON.stringify({source_slug: slug, cartridge_id: 'owv17-test'})],
  );
  return Number(rows[0]!.id);
}

describe('MerchantContractService (OWV-17)', () => {
  it('reports no offers when the bridge meta is missing', async () => {
    const offers = await MerchantContractService.listMerchantOffers('mikka');
    expect(offers).toEqual([]);
    expect(await MerchantContractService.isMerchantBridgeAvailable()).toBe(false);
  });

  it('lists offers per merchant slug with resolved coin item ids', async () => {
    await seedCurrencyBridge([
      {slug: 'owv17-merch-copper', mention: '@Copper coin', copper_value: 1},
      {slug: 'owv17-merch-silver', mention: '@Silver coin', copper_value: 10},
    ]);
    const copperId = await seedCoin('owv17-merch-copper', 1, '@Copper coin');
    const silverId = await seedCoin('owv17-merch-silver', 10, '@Silver coin');
    const merchantId = await seedMerchant('mikka', 'OWV-17 merchant Mikka');
    cartridgeCache.clearMetaCache();
    CurrencyBridgeService.clearCurrencyCatalogCache();
    MerchantContractService.clearMerchantContractsCache();
    await seedMerchantBridge([
      {
        offer_id: 'aaa111',
        source_slug: 'mikka',
        source_mention: '@Mikka',
        source_kind: 'person',
        source_path: 'GreenHavenWorld/.../Mikka.md',
        line: 'cheap rumor - 3 @Copper coin',
        coins: [{coin: '@Copper coin', amount: 3}],
        copper_value: 3,
      },
      {
        offer_id: 'bbb222',
        source_slug: 'mikka',
        source_mention: '@Mikka',
        source_kind: 'person',
        source_path: 'GreenHavenWorld/.../Mikka.md',
        line: 'private tip - 2 @Silver coin',
        coins: [{coin: '@Silver coin', amount: 2}],
        copper_value: 20,
      },
    ]);
    cartridgeCache.clearMetaCache();
    MerchantContractService.clearMerchantContractsCache();
    const offers = await MerchantContractService.listMerchantOffers('mikka');
    expect(offers).toHaveLength(2);
    expect(offers.map(o => o.offerId).sort()).toEqual(['aaa111', 'bbb222']);
    const cheap = offers.find(o => o.offerId === 'aaa111')!;
    expect(cheap.merchantEntityId).toBe(merchantId);
    expect(cheap.requirements[0]!.itemId).toBe(copperId);
    expect(cheap.requirements[0]!.copperValue).toBe(1);
    const tip = offers.find(o => o.offerId === 'bbb222')!;
    expect(tip.requirements[0]!.itemId).toBe(silverId);
    expect(tip.requirements[0]!.copperValue).toBe(10);
    expect(tip.copperTotal).toBe(20);
  });

  it('findMerchantOffer returns null for unknown ids', async () => {
    await seedMerchantBridge([
      {
        offer_id: 'aaa111',
        source_slug: 'mikka',
        source_mention: '@Mikka',
        source_kind: 'person',
        source_path: 'x.md',
        line: 'cheap',
        coins: [{coin: '@Copper coin', amount: 1}],
        copper_value: 1,
      },
    ]);
    cartridgeCache.clearMetaCache();
    MerchantContractService.clearMerchantContractsCache();
    const offer = await MerchantContractService.findMerchantOffer(
      'mikka',
      'does-not-exist',
    );
    expect(offer).toBeNull();
  });

  it('flags unresolved coin mentions with itemId=null', async () => {
    await seedMerchantBridge([
      {
        offer_id: 'orphan',
        source_slug: 'mikka',
        source_mention: '@Mikka',
        source_kind: 'person',
        source_path: 'x.md',
        line: 'unknown coin offer',
        coins: [{coin: '@Phantom coin', amount: 1}],
        copper_value: 1,
      },
    ]);
    cartridgeCache.clearMetaCache();
    CurrencyBridgeService.clearCurrencyCatalogCache();
    MerchantContractService.clearMerchantContractsCache();
    const offer = await MerchantContractService.findMerchantOffer(
      'mikka',
      'orphan',
    );
    expect(offer).not.toBeNull();
    expect(offer!.requirements[0]!.itemId).toBeNull();
  });
});
