/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `CurrencyBridgeService` contract.
//
// Pins the read layer that fronts `cartridge_meta.forge_currency_bridge`
// + `items.category = 'currency'`:
//
//   * the catalog is sorted ascending by copper value;
//   * a missing bridge meta falls back to every currency items row,
//     `copper_value` defaulting to 1 (so legacy single-currency
//     cartridges keep their old behaviour);
//   * a mis-versioned bridge document is ignored — same fallback;
//   * `getPlayerCurrencyBalance` returns per-coin rows + `totalCopper`
//     summed from `player_inventory`;
//   * `getHolderCurrencyBalance` reads the legacy `inventory_entries`
//     ledger via the `items.legacy_entity_id` join.

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

let CurrencyBridgeService: typeof import('../../services/CurrencyBridgeService.js');
let cartridgeCache: typeof import('../../cartridge.js');
let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  CurrencyBridgeService = await import(
    '../../services/CurrencyBridgeService.js'
  );
  cartridgeCache = await import('../../cartridge.js');
  ({createAnonymousPlayer} = await import('../../playerService.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  // Migration 0122 seeds canonical `forge_currency_bridge` into
  // every fresh-migration fixture PLUS canonical currency items
  // (`copper-coin`, `silver-coin`, `gold-coin`). Tests in this file
  // want to start each case with neither the bridge nor those
  // canonical coins so the "falls back to items.category" + the
  // multi-denomination catalog cases see only the test's own
  // `owv17-*` seeds. Seeded happy-path tests re-insert their own
  // bridge meta + coin rows with `ON CONFLICT DO UPDATE`.
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_currency_bridge'`,
  );
  await queryRows(
    `DELETE FROM items WHERE category = 'currency'
       AND slug IN ('copper-coin','silver-coin','gold-coin')`,
  );
  cartridgeCache.clearMetaCache();
  CurrencyBridgeService.clearCurrencyCatalogCache();
});

afterEach(async () => {
  cartridgeCache.clearMetaCache();
  CurrencyBridgeService.clearCurrencyCatalogCache();
  // Roll back any test-mutated cartridge_meta and currency rows.
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_currency_bridge'`,
  );
  // Drain player_inventory and inventory_entries FK targets before
  // dropping the test-seeded items rows.
  await queryRows(
    `DELETE FROM player_inventory
       WHERE item_id IN (SELECT id FROM items WHERE slug LIKE 'owv17-%')`,
  );
  await queryRows(
    `DELETE FROM inventory_entries
       WHERE item_entity_id IN (
         SELECT legacy_entity_id FROM items
          WHERE slug LIKE 'owv17-%' AND legacy_entity_id IS NOT NULL
       )`,
  );
  await queryRows(
    `DELETE FROM items WHERE category = 'currency' AND slug LIKE 'owv17-%'`,
  );
});

async function seedBridge(meta: Record<string, unknown>): Promise<void> {
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('forge_currency_bridge', $1::jsonb, 'OWV-17 currency bridge test seed')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(meta)],
  );
  cartridgeCache.clearMetaCache();
  CurrencyBridgeService.clearCurrencyCatalogCache();
}

async function seedCartridge(id: string): Promise<void> {
  // FK target for cartridge_meta_scoped writes in the scoped-read
  // regression tests below. A minimal builtin row is enough for the
  // FK to satisfy — the scoped-read path only joins on cartridge_id.
  await queryRows(
    `INSERT INTO cartridges (
        id, title, version, schema_version, source_kind, content_hash
      ) VALUES ($1, $1, '1.0.0', 'greenhaven.cartridge.v1', 'builtin', $1)
      ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function seedCoin(opts: {
  slug: string;
  copperValue?: number | null;
  mention?: string;
}): Promise<number> {
  const behaviour: Record<string, unknown> = {};
  if (opts.copperValue != null) behaviour['copper_value'] = opts.copperValue;
  if (opts.mention) behaviour['canonical_mention'] = opts.mention;
  const rows = await queryRows<{id: number}>(
    `INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour)
     VALUES ($1, 'currency', 0, true, 9999, $2::jsonb)
     ON CONFLICT (slug) DO UPDATE SET behaviour = EXCLUDED.behaviour
     RETURNING id`,
    [opts.slug, JSON.stringify(behaviour)],
  );
  CurrencyBridgeService.clearCurrencyCatalogCache();
  return Number(rows[0]!.id);
}

async function newPlayer(label: string): Promise<number> {
  const p = await createAnonymousPlayer(`OWV-17 ${label} ${Date.now()}`);
  // Starter currency is seeded by `createAnonymousPlayer`; clear it
  // so each balance test asserts on the coins it plants below.
  await queryRows(`DELETE FROM player_inventory WHERE player_id = $1`, [
    p.entity_id,
  ]);
  await queryRows(
    `DELETE FROM inventory_entries WHERE holder_entity_id = $1`,
    [p.entity_id],
  );
  return p.entity_id;
}

describe('CurrencyBridgeService (OWV-17 currency runtime)', () => {
  it('serves a multi-denomination catalog sorted ascending by copper value', async () => {
    await seedCoin({slug: 'owv17-copper', copperValue: 1, mention: '@Copper coin'});
    await seedCoin({slug: 'owv17-silver', copperValue: 10, mention: '@Silver coin'});
    await seedCoin({slug: 'owv17-gold', copperValue: 100, mention: '@Gold coin'});
    await seedBridge({
      schema_version: 'greenhaven.currency_rates.v1',
      source_project: 'owv17-test',
      coins: [
        {slug: 'owv17-gold', copper_value: 100, mention: '@Gold coin'},
        {slug: 'owv17-copper', copper_value: 1, mention: '@Copper coin'},
        {slug: 'owv17-silver', copper_value: 10, mention: '@Silver coin'},
      ],
    });
    const catalog = await CurrencyBridgeService.getCurrencyCatalog();
    expect(catalog.bridgeAvailable).toBe(true);
    // The catalog also surfaces every pre-existing
    // `items.category = 'currency'` row from earlier migrations.
    // Filter to the OWV-17 test seeds; their relative order
    // (ascending by copperValue) is what we lock here.
    const owvCoins = catalog.coins.filter(coin =>
      coin.slug.startsWith('owv17-'),
    );
    expect(owvCoins.map(coin => coin.slug)).toEqual([
      'owv17-copper',
      'owv17-silver',
      'owv17-gold',
    ]);
    expect(owvCoins.map(coin => coin.copperValue)).toEqual([1, 10, 100]);
    expect(owvCoins[0]!.mention).toBe('@Copper coin');
  });

  it('falls back to items.category currency rows when the bridge meta is missing', async () => {
    await seedCoin({slug: 'owv17-only', copperValue: null});
    const catalog = await CurrencyBridgeService.getCurrencyCatalog();
    expect(catalog.bridgeAvailable).toBe(false);
    const owv = catalog.coins.find(coin => coin.slug === 'owv17-only');
    expect(owv).toBeDefined();
    expect(owv!.copperValue).toBe(1);
    expect(owv!.mention).toBeNull();
  });

  it('ignores a mis-versioned bridge document', async () => {
    await seedCoin({slug: 'owv17-fallback', copperValue: 5});
    await seedBridge({
      schema_version: 'greenhaven.currency_rates.v2',
      coins: [{slug: 'owv17-fallback', copper_value: 999}],
    });
    const catalog = await CurrencyBridgeService.getCurrencyCatalog();
    expect(catalog.bridgeAvailable).toBe(false);
    const coin = catalog.coins.find(c => c.slug === 'owv17-fallback');
    expect(coin!.copperValue).toBe(5); // from items.behaviour, not the rejected bridge
  });

  it('reports per-denomination balances + total_copper for a player', async () => {
    const playerId = await newPlayer('balance');
    const copperId = await seedCoin({slug: 'owv17-copper', copperValue: 1});
    const silverId = await seedCoin({slug: 'owv17-silver', copperValue: 10});
    const goldId = await seedCoin({slug: 'owv17-gold', copperValue: 100});
    await seedBridge({
      schema_version: 'greenhaven.currency_rates.v1',
      source_project: 'owv17-test',
      coins: [
        {slug: 'owv17-copper', copper_value: 1},
        {slug: 'owv17-silver', copper_value: 10},
        {slug: 'owv17-gold', copper_value: 100},
      ],
    });
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 7, false), ($1, $3, 3, false), ($1, $4, 2, false)`,
      [playerId, copperId, silverId, goldId],
    );
    const balance =
      await CurrencyBridgeService.getPlayerCurrencyBalance(playerId);
    expect(balance.bridgeAvailable).toBe(true);
    // 7*1 + 3*10 + 2*100 = 237. Pre-existing cartridge currency
    // rows may also appear in `balance.coins` (with quantity 0)
    // because the catalog mirrors every items.category='currency'
    // row; we filter to the OWV-17 seeds.
    expect(balance.totalCopper).toBe(237);
    const owvCoins = balance.coins.filter(coin => coin.slug.startsWith('owv17-'));
    expect(owvCoins).toHaveLength(3);
    const bySlug = new Map(owvCoins.map(coin => [coin.slug, coin]));
    expect(bySlug.get('owv17-copper')!.quantity).toBe(7);
    expect(bySlug.get('owv17-silver')!.subtotalCopper).toBe(30);
    expect(bySlug.get('owv17-gold')!.subtotalCopper).toBe(200);
  });

  it('legacy single-currency cartridges keep their pre-bridge SUM behaviour', async () => {
    const playerId = await newPlayer('legacy-single');
    const coinId = await seedCoin({slug: 'owv17-legacy', copperValue: null});
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 42, false)`,
      [playerId, coinId],
    );
    const balance =
      await CurrencyBridgeService.getPlayerCurrencyBalance(playerId);
    expect(balance.bridgeAvailable).toBe(false);
    expect(balance.totalCopper).toBe(42);
    const coin = balance.coins.find(c => c.slug === 'owv17-legacy')!;
    expect(coin.quantity).toBe(42);
    expect(coin.subtotalCopper).toBe(42);
  });

  it('OBSIDIAN-VAULT-IMPORT-2 — scoped read overrides the legacy global row when a per-cartridge row exists', async () => {
    await seedCoin({slug: 'owv17-copper', copperValue: 1});
    await seedCoin({slug: 'owv17-gold', copperValue: 100});
    await seedCartridge('scoped-cart');
    // Global / legacy cartridge_meta — declares only the copper coin.
    await seedBridge({
      schema_version: 'greenhaven.currency_rates.v1',
      source_project: 'legacy',
      coins: [{slug: 'owv17-copper', copper_value: 1}],
    });
    // Scoped per-cartridge row — declares the gold coin and omits the
    // copper coin. The runtime must see only the scoped catalog.
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
       VALUES ('scoped-cart', 'forge_currency_bridge', $1::jsonb, 'OBSIDIAN-VAULT-IMPORT-2 scoped test seed')
       ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          schema_version: 'greenhaven.currency_rates.v1',
          source_project: 'scoped-cart',
          coins: [{slug: 'owv17-gold', copper_value: 100}],
        }),
      ],
    );
    cartridgeCache.clearMetaCache();
    CurrencyBridgeService.clearCurrencyCatalogCache();

    const scopedCatalog = await CurrencyBridgeService.getCurrencyCatalog({
      cartridgeId: 'scoped-cart',
    });
    expect(scopedCatalog.bridgeAvailable).toBe(true);
    const scopedBridgeBacked = scopedCatalog.coins.filter(
      coin => coin.bridgeBacked && coin.slug.startsWith('owv17-'),
    );
    expect(scopedBridgeBacked.map(coin => coin.slug)).toEqual(['owv17-gold']);

    // The unscoped reader still sees the legacy global row.
    const legacyCatalog = await CurrencyBridgeService.getCurrencyCatalog();
    expect(legacyCatalog.bridgeAvailable).toBe(true);
    const legacyBridgeBacked = legacyCatalog.coins.filter(
      coin => coin.bridgeBacked && coin.slug.startsWith('owv17-'),
    );
    expect(legacyBridgeBacked.map(coin => coin.slug)).toEqual(['owv17-copper']);

    await queryRows(
      `DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'scoped-cart'`,
    );
  });

  it('OBSIDIAN-VAULT-IMPORT-2 — scoped tombstone shadows the legacy global row', async () => {
    await seedCoin({slug: 'owv17-copper', copperValue: 1});
    await seedCartridge('tomb-cart');
    // Legacy global declares a real coin set.
    await seedBridge({
      schema_version: 'greenhaven.currency_rates.v1',
      source_project: 'legacy',
      coins: [{slug: 'owv17-copper', copper_value: 1}],
    });
    // Reimport wrote an empty v1 tombstone for the scoped cartridge —
    // the runtime must treat it as "no bridge coins" and NOT fall back
    // to the legacy global.
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
       VALUES ('tomb-cart', 'forge_currency_bridge', $1::jsonb, 'OBSIDIAN-VAULT-IMPORT-2 tombstone test seed')
       ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          schema_version: 'greenhaven.currency_rates.v1',
          source_project: 'tomb-cart',
          coins: [],
          world_currency_facts: [],
        }),
      ],
    );
    cartridgeCache.clearMetaCache();
    CurrencyBridgeService.clearCurrencyCatalogCache();

    const catalog = await CurrencyBridgeService.getCurrencyCatalog({
      cartridgeId: 'tomb-cart',
    });
    expect(catalog.bridgeAvailable).toBe(false);
    const bridgeBacked = catalog.coins.filter(coin => coin.bridgeBacked);
    expect(bridgeBacked).toHaveLength(0);

    await queryRows(
      `DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'tomb-cart'`,
    );
  });

  it('holder balances read the legacy inventory_entries ledger', async () => {
    const holderRows = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, summary, profile, cartridge_id)
       VALUES ('person', 'OWV-17 Holder', 'shopkeeper', '{}'::jsonb, 'quickgrin-lane')
       RETURNING id`,
    );
    const holderId = Number(holderRows[0]!.id);
    const coinEntity = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, summary, profile, cartridge_id)
       VALUES ('item', 'OWV-17 Holder Silver', 'silver', '{"item_kind":"currency"}'::jsonb, 'quickgrin-lane')
       RETURNING id`,
    );
    const legacyItemId = Number(coinEntity[0]!.id);
    await queryRows(
      `INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
       VALUES ('owv17-holder-silver', 'currency', 0, true, 9999, '{"copper_value":10}'::jsonb, $1)
       ON CONFLICT (slug) DO UPDATE SET legacy_entity_id = EXCLUDED.legacy_entity_id`,
      [legacyItemId],
    );
    CurrencyBridgeService.clearCurrencyCatalogCache();
    await queryRows(
      `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count, metadata)
       VALUES ($1, $2, 4, '{}'::jsonb)`,
      [holderId, legacyItemId],
    );
    const balance =
      await CurrencyBridgeService.getHolderCurrencyBalance(holderId);
    expect(balance.totalCopper).toBe(40);
    const coin = balance.coins.find(c => c.slug === 'owv17-holder-silver')!;
    expect(coin.quantity).toBe(4);
    expect(coin.subtotalCopper).toBe(40);
    // Clean up the legacy fixtures we minted.
    await queryRows(
      `DELETE FROM inventory_entries WHERE holder_entity_id = $1`,
      [holderId],
    );
    await queryRows(`DELETE FROM items WHERE slug = 'owv17-holder-silver'`);
    await queryRows(`DELETE FROM entities WHERE id IN ($1, $2)`, [
      holderId,
      legacyItemId,
    ]);
  });
});
