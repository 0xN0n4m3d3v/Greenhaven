/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-INV-1 — `InventoryReadService.snapshot` contract.
//
// Pins the DTO shape consumed by `GET /api/player/:id/inventory`
// and the web-UI `useInventorySnapshot` hook. Each case seeds a
// pristine player via `createAnonymousPlayer`, plants the
// inventory row(s) it cares about (structured `player_inventory`
// or legacy `inventory_entries` + `entities`), and asserts the
// returned snapshot's slot.

import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let InventoryReadService: typeof import('../../services/InventoryReadService.js').InventoryReadService;
let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;
let cartridgeCache: typeof import('../../cartridge.js');
let CurrencyBridgeService: typeof import('../../services/CurrencyBridgeService.js');

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({InventoryReadService} = await import(
    '../../services/InventoryReadService.js'
  ));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
  cartridgeCache = await import('../../cartridge.js');
  CurrencyBridgeService = await import(
    '../../services/CurrencyBridgeService.js'
  );
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

afterEach(async () => {
  cartridgeCache.clearMetaCache();
  CurrencyBridgeService.clearCurrencyCatalogCache();
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_currency_bridge'`,
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'quickgrin-lane' AND key = 'forge_currency_bridge'`,
  );
  await queryRows(
    `DELETE FROM hero_cartridge_states WHERE cartridge_id = 'quickgrin-lane'`,
  );
  await queryRows(
    `DELETE FROM player_inventory
       WHERE item_id IN (SELECT id FROM items WHERE slug LIKE 'owv17-snap-%')`,
  );
  await queryRows(
    `DELETE FROM items WHERE category = 'currency' AND slug LIKE 'owv17-snap-%'`,
  );
});

async function newPlayer(label: string): Promise<number> {
  const p = await createAnonymousPlayer(`FEAT-INV-1 ${label} ${Date.now()}`);
  return p.entity_id;
}

async function clearInventory(playerId: number): Promise<void> {
  await queryRows(`DELETE FROM player_inventory WHERE player_id = $1`, [
    playerId,
  ]);
  await queryRows(`DELETE FROM inventory_entries WHERE holder_entity_id = $1`, [
    playerId,
  ]);
}

async function getItemId(slug: string): Promise<number> {
  const rows = await queryRows<{id: number}>(
    `SELECT id FROM items WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (rows.length === 0) {
    throw new Error(`seed item missing: ${slug}`);
  }
  return Number(rows[0]!.id);
}

async function upsertItem(opts: {
  slug: string;
  category: string;
  weightKg?: number;
  stackable?: boolean;
  maxStack?: number;
  rarity?: string | null;
  iconKey?: string | null;
}): Promise<number> {
  const rows = await queryRows<{id: number}>(
    `INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour, rarity, icon_key)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7)
     ON CONFLICT (slug) DO UPDATE SET rarity = EXCLUDED.rarity, icon_key = EXCLUDED.icon_key
     RETURNING id`,
    [
      opts.slug,
      opts.category,
      opts.weightKg ?? 0,
      opts.stackable ?? false,
      opts.maxStack ?? 1,
      opts.rarity ?? null,
      opts.iconKey ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

describe('InventoryReadService.snapshot (FEAT-INV-1)', () => {
  it('returns an empty snapshot for a player with no inventory', async () => {
    const playerId = await newPlayer('empty');
    await clearInventory(playerId);
    const snapshot = await InventoryReadService.snapshot(playerId);
    expect(snapshot.playerId).toBe(playerId);
    expect(snapshot.currency.count).toBe(0);
    expect(snapshot.equipment).toEqual([]);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.totals).toEqual({
      itemCount: 0,
      uniqueItems: 0,
      weightKg: 0,
      equippedCount: 0,
    });
  });

  it('summarises a legacy currency stack into currency.count without emitting an item row', async () => {
    const playerId = await newPlayer('legacy-currency');
    await clearInventory(playerId);
    // Currency lives in the modern items table — the canonical
    // path uses `player_inventory` for currency stacks. Plant
    // one such row to exercise the "category=currency rolls up
    // to count" branch.
    const goldId = await upsertItem({
      slug: `gold_coin_test_${playerId}`,
      category: 'currency',
      weightKg: 0,
      stackable: true,
      maxStack: 9999,
    });
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity)
       VALUES ($1, $2, $3)`,
      [playerId, goldId, 47],
    );
    const snapshot = await InventoryReadService.snapshot(playerId);
    expect(snapshot.currency.count).toBe(47);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.equipment).toEqual([]);
    expect(snapshot.totals.itemCount).toBe(0);
  });

  it('returns a stacked consumable row with quantity and category', async () => {
    const playerId = await newPlayer('stacked-consumable');
    await clearInventory(playerId);
    const itemId = await getItemId('healing_potion');
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity)
       VALUES ($1, $2, $3)`,
      [playerId, itemId, 3],
    );
    const snapshot = await InventoryReadService.snapshot(playerId);
    expect(snapshot.items).toHaveLength(1);
    const potion = snapshot.items[0]!;
    expect(potion.category).toBe('consumable');
    expect(potion.slug).toBe('healing_potion');
    expect(potion.quantity).toBe(3);
    expect(potion.stackable).toBe(true);
    expect(potion.equipped).toBe(false);
    expect(potion.source).toBe('player_inventory');
    expect(snapshot.totals.itemCount).toBe(3);
    expect(snapshot.totals.uniqueItems).toBe(1);
    expect(snapshot.totals.equippedCount).toBe(0);
  });

  it('returns an equipped weapon in both `equipment` and `items`', async () => {
    const playerId = await newPlayer('equipped-weapon');
    await clearInventory(playerId);
    const itemId = await getItemId('shortsword');
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped, equipped_slot)
       VALUES ($1, $2, 1, true, 'main_hand')`,
      [playerId, itemId],
    );
    const snapshot = await InventoryReadService.snapshot(playerId);
    expect(snapshot.equipment).toHaveLength(1);
    expect(snapshot.equipment[0]!.equipped).toBe(true);
    expect(snapshot.equipment[0]!.equippedSlot).toBe('main_hand');
    expect(snapshot.items[0]!.category).toBe('weapon');
    expect(snapshot.totals.equippedCount).toBe(1);
  });

  it('reports copper-unit totals + per-denomination coins when the bridge is wired', async () => {
    // OWV-17 regression: a multi-denomination cartridge (gold/
    // silver/copper) must roll up `currency.count` to the total
    // copper-unit wealth, surface every coin in `currency.coins`
    // ascending by copper value, and flag `bridgeAvailable = true`.
    const playerId = await newPlayer('multi-denom');
    await clearInventory(playerId);
    const copperId = await upsertItem({
      slug: 'owv17-snap-copper',
      category: 'currency',
      stackable: true,
      maxStack: 9999,
    });
    const silverId = await upsertItem({
      slug: 'owv17-snap-silver',
      category: 'currency',
      stackable: true,
      maxStack: 9999,
    });
    const goldId = await upsertItem({
      slug: 'owv17-snap-gold',
      category: 'currency',
      stackable: true,
      maxStack: 9999,
    });
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version, source_kind, content_hash)
       VALUES ('quickgrin-lane', 'quickgrin-lane', '1.0.0', 'greenhaven.cartridge.v1', 'builtin', 'quickgrin-lane')
       ON CONFLICT (id) DO NOTHING`
    );
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value) VALUES
         ('quickgrin-lane', 'forge_currency_bridge', $1::jsonb)
         ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          schema_version: 'greenhaven.currency_rates.v1',
          source_project: 'owv17-test',
          coins: [
            {slug: 'owv17-snap-copper', copper_value: 1, mention: '@Copper coin'},
            {slug: 'owv17-snap-silver', copper_value: 10, mention: '@Silver coin'},
            {slug: 'owv17-snap-gold', copper_value: 100, mention: '@Gold coin'},
          ],
        }),
      ],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (player_id, cartridge_id, status)
       VALUES ($1, 'quickgrin-lane', 'active')`,
      [playerId],
    );
    cartridgeCache.clearMetaCache();
    CurrencyBridgeService.clearCurrencyCatalogCache();
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 9, false), ($1, $3, 4, false), ($1, $4, 2, false)`,
      [playerId, copperId, silverId, goldId],
    );
    const snapshot = await InventoryReadService.snapshot(playerId);
    expect(snapshot.currency.bridgeAvailable).toBe(true);
    // 9*1 + 4*10 + 2*100 = 249. The catalog also surfaces every
    // pre-seeded `items.category = 'currency'` row, but the player
    // holds 0 of those, so `totalCopper` reflects only the OWV-17
    // seeded coins.
    expect(snapshot.currency.count).toBe(249);
    const owvSlugs = snapshot.currency.coins
      .filter(coin => coin.slug.startsWith('owv17-snap-'))
      .map(coin => coin.slug);
    expect(owvSlugs).toEqual([
      'owv17-snap-copper',
      'owv17-snap-silver',
      'owv17-snap-gold',
    ]);
    const gold = snapshot.currency.coins.find(coin => coin.slug === 'owv17-snap-gold')!;
    expect(gold.quantity).toBe(2);
    expect(gold.subtotalCopper).toBe(200);
    expect(gold.mention).toBe('@Gold coin');
    // Currency rows still do not appear as bag items.
    expect(snapshot.items.every(item => item.category !== 'currency')).toBe(true);
  });

  it('reconciles a legacy entity-based quest item via inventory_entries', async () => {
    const playerId = await newPlayer('legacy-quest-item');
    await clearInventory(playerId);
    // Seed a quest entity to act as the item.
    const entity = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, summary, profile, cartridge_id)
       VALUES ('item', 'Sealed Letter', 'A wax-sealed envelope.', '{"item_kind":"quest"}'::jsonb, 'quickgrin-lane')
       RETURNING id`,
    );
    const entityId = Number(entity[0]!.id);
    await queryRows(
      `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count, metadata)
       VALUES ($1, $2, 1, '{}'::jsonb)`,
      [playerId, entityId],
    );
    const snapshot = await InventoryReadService.snapshot(playerId);
    expect(snapshot.items).toHaveLength(1);
    const letter = snapshot.items[0]!;
    expect(letter.source).toBe('inventory_entries');
    expect(letter.name).toBe('Sealed Letter');
    expect(letter.summary).toBe('A wax-sealed envelope.');
    expect(letter.category).toBe('quest');
    expect(letter.quantity).toBe(1);
    expect(letter.equipped).toBe(false);
    // Cleanup the entity we just minted.
    await queryRows(`DELETE FROM inventory_entries WHERE holder_entity_id = $1`, [
      playerId,
    ]);
    await queryRows(`DELETE FROM entities WHERE id = $1`, [entityId]);
  });
});
