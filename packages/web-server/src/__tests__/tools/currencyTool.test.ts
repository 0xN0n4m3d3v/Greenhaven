/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `query_currency_balance` broker tool contract.
//
// Pins three guarantees:
//
//   * the tool is registered with the canonical name expected by
//     prompts / agents;
//   * called with no args, it returns the active player's
//     `total_copper` + per-coin breakdown from the bridge service;
//   * called with a different player's id, it rejects without
//     leaking another player's balance.

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
  ({createAnonymousPlayer} = await import('../../playerService.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  // Migration 0122 seeds canonical `forge_currency_bridge` plus
  // canonical currency items (`copper-coin`, `silver-coin`,
  // `gold-coin`). Drop both before each tool case so the tool
  // reads only the test's own seeded `owv17-tool-*` coins.
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
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_currency_bridge'`,
  );
  // Drain FK targets before dropping the test-seeded items rows.
  await queryRows(
    `DELETE FROM player_inventory
       WHERE item_id IN (SELECT id FROM items WHERE slug LIKE 'owv17-tool-%')`,
  );
  await queryRows(
    `DELETE FROM items WHERE category = 'currency' AND slug LIKE 'owv17-tool-%'`,
  );
});

async function newPlayer(label: string): Promise<number> {
  const p = await createAnonymousPlayer(`OWV-17 tool ${label} ${Date.now()}`);
  // Starter currency is seeded by createAnonymousPlayer; clear it so
  // the test asserts on the OWV-17 coins it plants below.
  await queryRows(`DELETE FROM player_inventory WHERE player_id = $1`, [
    p.entity_id,
  ]);
  await queryRows(
    `DELETE FROM inventory_entries WHERE holder_entity_id = $1`,
    [p.entity_id],
  );
  return p.entity_id;
}

async function seedCoin(slug: string, copperValue: number): Promise<number> {
  const rows = await queryRows<{id: number}>(
    `INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour)
     VALUES ($1, 'currency', 0, true, 9999, $2::jsonb)
     ON CONFLICT (slug) DO UPDATE SET behaviour = EXCLUDED.behaviour
     RETURNING id`,
    [slug, JSON.stringify({copper_value: copperValue})],
  );
  CurrencyBridgeService.clearCurrencyCatalogCache();
  return Number(rows[0]!.id);
}

describe('query_currency_balance (OWV-17 currency tool)', () => {
  it('is registered with the canonical tool name', () => {
    const tools = getRegisteredTools();
    expect(tools.has('query_currency_balance')).toBe(true);
  });

  it('returns the active player balance broken down per coin', async () => {
    const playerId = await newPlayer('default-self');
    const copperId = await seedCoin('owv17-tool-copper', 1);
    const silverId = await seedCoin('owv17-tool-silver', 10);
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 4, false), ($1, $3, 2, false)`,
      [playerId, copperId, silverId],
    );
    const tool = getTool('query_currency_balance');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () => tool.execute({}, {sessionId: `s-${playerId}`, playerId}),
    )) as {
      total_copper: number;
      bridge_available: boolean;
      coins: Array<{slug: string; quantity: number; subtotal_copper: number}>;
    };
    expect(result.total_copper).toBe(24); // 4*1 + 2*10
    const bySlug = new Map(result.coins.map(coin => [coin.slug, coin]));
    expect(bySlug.get('owv17-tool-copper')!.quantity).toBe(4);
    expect(bySlug.get('owv17-tool-silver')!.subtotal_copper).toBe(20);
  });

  it('rejects attempts to inspect another player', async () => {
    const callerId = await newPlayer('caller');
    const otherId = await newPlayer('other');
    const tool = getTool('query_currency_balance');
    let caught: unknown = null;
    try {
      await runWithContext(
        {sessionId: `s-${callerId}`, playerId: callerId},
        () =>
          tool.execute(
            {player: otherId},
            {sessionId: `s-${callerId}`, playerId: callerId},
          ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const toolError = caught as InstanceType<typeof ToolExecutionError>;
    expect(toolError.rejected).toBe(true);
    expect(toolError.message).toContain('restricted to the active player');
  });
});
