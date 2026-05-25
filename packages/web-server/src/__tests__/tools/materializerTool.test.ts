/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `apply_materializer_bridge` broker tool contract.
//
//   * the tool is registered with the canonical name;
//   * a `location/hidden-exit` row appends a bidirectional exit
//     between the scope + target locations and writes one durable
//     `npc_memories` applied row; a second call is a no-op
//     (already_applied: true) and does not duplicate the exit;
//   * an `item/*` row scoped to hero inventory or `@NPC inventory`
//     grants non-currency items to that holder and records the
//     applied memory with the granted item id;
//   * a `state/service` row writes only the applied memory — no
//     exits, no inventory grants;
//   * unknown / unresolved materializer ids surface a structured
//     `ToolExecutionError` and leave the world untouched.

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
let applyMaterializersForTrigger: typeof import('../../tools/materializer.js').applyMaterializersForTrigger;
let cartridgeCache: typeof import('../../cartridge.js');
let MaterializerBridgeService: typeof import('../../services/MaterializerBridgeService.js');
let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;
let testCartridgeId = 'quickgrin-lane';

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
  ({applyMaterializersForTrigger} = await import('../../tools/materializer.js'));
  cartridgeCache = await import('../../cartridge.js');
  MaterializerBridgeService = await import(
    '../../services/MaterializerBridgeService.js'
  );
  ({createAnonymousPlayer} = await import('../../playerService.js'));
  const cartridge = await queryRows<{id: string}>(
    `SELECT value #>> '{}' AS id
       FROM cartridge_meta
      WHERE key = 'cartridge_id'
      LIMIT 1`,
  );
  testCartridgeId = cartridge[0]?.id ?? testCartridgeId;
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  // Migration 0122 seeds canonical `forge_materializer_bridge` into
  // every fresh-migration fixture. Drop it before each tool case so
  // the tool only sees the test's own seeded bridge; each test
  // re-inserts its own meta row with `ON CONFLICT DO UPDATE`.
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_materializer_bridge'`,
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped
      WHERE key = 'forge_materializer_bridge'`,
  );
  cartridgeCache.clearMetaCache();
  MaterializerBridgeService.clearMaterializerBridgeCache();
});

afterEach(async () => {
  cartridgeCache.clearMetaCache();
  MaterializerBridgeService.clearMaterializerBridgeCache();
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_materializer_bridge'`,
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped
      WHERE key = 'forge_materializer_bridge'`,
  );
  await queryRows(
    `DELETE FROM npc_memories WHERE memory_kind = 'materializer_applied'`,
  );
  await queryRows(
    `DELETE FROM player_inventory
       WHERE item_id IN (SELECT id FROM items WHERE slug LIKE 'owv17-mat-%')`,
  );
  await queryRows(
    `DELETE FROM inventory_entries
       WHERE item_entity_id IN (
         SELECT legacy_entity_id FROM items
          WHERE slug LIKE 'owv17-mat-%' AND legacy_entity_id IS NOT NULL
       )`,
  );
  // Helper-created target entities can also accumulate
  // inventory_entries (when item/access-state grants seed the
  // legacy ledger against a freshly minted entity id). Sweep
  // those before deleting the entity rows themselves.
  await queryRows(
    `DELETE FROM inventory_entries
       WHERE item_entity_id IN (
         SELECT id FROM entities
          WHERE profile->>'source_slug' LIKE 'owv17-mat-%'
       )`,
  );
  await queryRows(`DELETE FROM items WHERE slug LIKE 'owv17-mat-%'`);
  await queryRows(
    `DELETE FROM actor_statuses
      WHERE source LIKE 'materializer:hero/%'
         OR metadata->>'materializer_id' LIKE 'hero-%'`,
  );
  await queryRows(
    `DELETE FROM chat_messages
      WHERE payload->>'source' = 'cartridge_hero_voice'
         OR payload->>'materializer_id' LIKE 'hero-%'`,
  );
  await queryRows(
    `DELETE FROM entities WHERE display_name LIKE 'OWV-17 mat %'`,
  );
  await queryRows(
    `DELETE FROM entities WHERE profile->>'source_slug' LIKE 'owv17-mat-%'`,
  );
});

async function newPlayer(label: string): Promise<number> {
  const p = await createAnonymousPlayer(`OWV-17 mat ${label} ${Date.now()}`);
  await queryRows(
    `INSERT INTO sessions (id, player_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [`s-${p.entity_id}`, p.entity_id],
  );
  await queryRows(`DELETE FROM player_inventory WHERE player_id = $1`, [
    p.entity_id,
  ]);
  await queryRows(
    `DELETE FROM inventory_entries WHERE holder_entity_id = $1`,
    [p.entity_id],
  );
  return p.entity_id;
}

async function seedEntity(
  kind: string,
  slug: string,
  displayName: string,
  extraProfile: Record<string, unknown> = {},
): Promise<number> {
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES ($1, $2, '', $3::jsonb, ARRAY[$1], $4)
     RETURNING id`,
    [
      kind,
      displayName,
      JSON.stringify({source_slug: slug, ...extraProfile}),
      testCartridgeId,
    ],
  );
  return Number(rows[0]!.id);
}

async function seedItem(
  slug: string,
  displayName: string,
  behaviour: Record<string, unknown> = {},
): Promise<number> {
  // Inventory ledger expects items.legacy_entity_id to point at an
  // entity row; seed both rows so the tool's
  // `ensureLegacyEntityForItem` path sees a pre-linked entry.
  const entityId = await seedEntity('item', slug, displayName);
  const rows = await queryRows<{id: number}>(
    `INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
     VALUES ($1, 'tool', 0.1, false, 1, $3::jsonb, $2)
     RETURNING id`,
    [slug, entityId, JSON.stringify(behaviour)],
  );
  return Number(rows[0]!.id);
}

async function seedMaterializerBridge(rows: unknown[]): Promise<void> {
  const value = JSON.stringify({
    schema_version: 'greenhaven.materializers.v1',
    source_project: 'owv17-test',
    rows,
  });
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('forge_materializer_bridge', $1::jsonb, 'OWV-17 materializer tool seed')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [value],
  );
  cartridgeCache.clearMetaCache();
  MaterializerBridgeService.clearMaterializerBridgeCache();
}

describe('apply_materializer_bridge (OWV-17 materializer tool)', () => {
  it('is registered with the canonical tool name', () => {
    expect(getRegisteredTools().has('apply_materializer_bridge')).toBe(true);
  });

  it('auto-applies matching location_explore materializers and remains idempotent', async () => {
    const playerId = await newPlayer('auto-location');
    const sourceId = await seedEntity(
      'location',
      'owv17-mat-sun-port',
      'OWV-17 mat Sun Port',
    );
    await seedMaterializerBridge([
      {
        materializer_id: 'auto-loc1',
        source_slug: 'owv17-mat-sun-port',
        source_mention: '@OWV17 mat Sun Port',
        source_kind: 'location',
        source_path: 'auto.md',
        entity: '@OWV17 mat Signal Shell',
        entity_slug: 'owv17-mat-signal-shell',
        target_status: 'new',
        trigger_condition: 'When the hero explores the Sun Port.',
        trigger_source: 'location_explore',
        type: 'item/access-state',
        scope: 'hero inventory at @OWV17 mat Sun Port',
        effect: 'The hero pockets a bright signal shell.',
      },
      {
        materializer_id: 'auto-wrong-trigger',
        source_slug: 'owv17-mat-sun-port',
        source_mention: '@OWV17 mat Sun Port',
        source_kind: 'location',
        source_path: 'auto.md',
        entity: '@OWV17 mat Manual Only',
        entity_slug: 'owv17-mat-manual-only',
        target_status: 'new',
        trigger_condition: 'When a narrator explicitly chooses it.',
        trigger_source: 'manual_only',
        type: 'state/service',
        scope: '@OWV17 mat Sun Port',
        effect: 'Should not auto-apply.',
      },
    ]);
    const ctx = {sessionId: `s-${playerId}`, playerId};

    const first = await runWithContext(ctx, () =>
      applyMaterializersForTrigger(ctx, 'location_explore', {
        sourceSlug: 'owv17-mat-sun-port',
      }),
    );
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]!.materializer_id).toBe('auto-loc1');
    expect(first.applied[0]!.already_applied).toBe(false);
    expect(first.rejected).toEqual([]);

    const itemRows = await queryRows<{
      quantity: number | string;
      cartridge_id: string | null;
    }>(
      `SELECT COALESCE(SUM(pi.quantity), 0)::int AS quantity,
              MAX(e.cartridge_id) AS cartridge_id
         FROM player_inventory pi
         JOIN items i ON i.id = pi.item_id
         JOIN entities e ON e.id = i.legacy_entity_id
        WHERE pi.player_id = $1
          AND i.slug = 'owv17-mat-signal-shell'`,
      [playerId],
    );
    expect(Number(itemRows[0]!.quantity)).toBe(1);
    expect(itemRows[0]!.cartridge_id).toBe(testCartridgeId);

    const skipped = await queryRows<{count: number}>(
      `SELECT COUNT(*)::int AS count
         FROM npc_memories
        WHERE memory_kind = 'materializer_applied'
          AND metadata->>'materializer_id' = 'auto-wrong-trigger'`,
    );
    expect(Number(skipped[0]!.count)).toBe(0);

    const second = await runWithContext(ctx, () =>
      applyMaterializersForTrigger(ctx, 'location_explore', {
        sourceSlug: 'owv17-mat-sun-port',
      }),
    );
    expect(second.applied).toHaveLength(1);
    expect(second.applied[0]!.already_applied).toBe(true);
    const memoryRows = await queryRows<{count: number}>(
      `SELECT COUNT(*)::int AS count
         FROM npc_memories
        WHERE owner_entity_id = $1
          AND memory_kind = 'materializer_applied'
          AND metadata->>'materializer_id' = 'auto-loc1'`,
      [sourceId],
    );
    expect(Number(memoryRows[0]!.count)).toBe(1);
    const events = await queryRows<{event_type: string}>(
      `SELECT event_type
         FROM gui_events
        WHERE session_id = $1
          AND event_type LIKE 'materializer:%'
        ORDER BY id ASC`,
      [ctx.sessionId],
    );
    expect(events.map(e => e.event_type)).toEqual(
      expect.arrayContaining(['materializer:applied', 'materializer:auto_applied']),
    );
  });

  it('auto-applies item_use materializers after a successful use_item call', async () => {
    const playerId = await newPlayer('auto-item-use');
    await queryRows(
      `UPDATE players SET current_hp = 1, max_hp = 10 WHERE entity_id = $1`,
      [playerId],
    );
    const itemId = await seedItem(
      'owv17-mat-bright-draught',
      'OWV-17 mat Bright Draught',
      {effect: 'heal', amount: '2'},
    );
    await queryRows(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, 1, false)`,
      [playerId, itemId],
    );
    await seedMaterializerBridge([
      {
        materializer_id: 'auto-item-use1',
        source_slug: 'owv17-mat-bright-draught',
        source_mention: '@OWV17 mat Bright Draught',
        source_kind: 'item',
        source_path: 'item.md',
        entity: '@OWV17 mat Empty Crystal Vial',
        entity_slug: 'owv17-mat-empty-crystal-vial',
        target_status: 'new',
        trigger_condition: 'When the bright draught is drunk.',
        trigger_source: 'item_use',
        type: 'item/access-state',
        scope: 'hero inventory after using @OWV17 mat Bright Draught',
        effect: 'The empty crystal vial remains useful.',
      },
    ]);

    const ctx = {sessionId: `s-${playerId}`, playerId};
    const useItem = getTool('use_item');
    const result = (await runWithContext(ctx, () =>
      useItem.execute({item_slug: 'owv17-mat-bright-draught'}, ctx),
    )) as {ok: boolean; consumed: string};
    expect(result.ok).toBe(true);
    expect(result.consumed).toBe('owv17-mat-bright-draught');

    const granted = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(pi.quantity), 0)::int AS quantity
         FROM player_inventory pi
         JOIN items i ON i.id = pi.item_id
        WHERE pi.player_id = $1
          AND i.slug = 'owv17-mat-empty-crystal-vial'`,
      [playerId],
    );
    expect(Number(granted[0]!.quantity)).toBe(1);
    const events = await queryRows<{event_type: string}>(
      `SELECT event_type
         FROM gui_events
        WHERE session_id = $1
          AND event_type LIKE 'materializer:%'
        ORDER BY id ASC`,
      [ctx.sessionId],
    );
    expect(events.map(e => e.event_type)).toEqual(
      expect.arrayContaining(['materializer:applied', 'materializer:auto_applied']),
    );
  });

  it('wires a bidirectional hidden exit, writes an applied memory, and is idempotent', async () => {
    const playerId = await newPlayer('hidden-exit');
    // Unique slugs to dodge canonical `way-to-thiefs-market`/`town-square`/`thiefs-market` entries
    const sourceId = await seedEntity(
      'quest',
      'owv17-mat-way',
      'OWV-17 mat way quest',
    );
    const townId = await seedEntity(
      'location',
      'owv17-mat-town',
      'OWV-17 mat Town square',
    );
    const marketId = await seedEntity(
      'location',
      'owv17-mat-market',
      "OWV-17 mat Thief's market",
    );
    // OWV-7: simulate what the Obsidian compiler emits for a
    // `location/hidden-exit` target — `profile.hidden_until_stage`
    // is set, the `hidden` tag is on the row. The runtime tool
    // must clear both on apply so `move_player` will route here.
    await queryRows(
      `UPDATE entities
          SET profile = jsonb_set(
                COALESCE(profile, '{}'::jsonb),
                '{hidden_until_stage}',
                $2::jsonb,
                true
              ),
              tags = array_append(COALESCE(tags, ARRAY[]::text[]), 'hidden')
        WHERE id = $1`,
      [marketId, JSON.stringify('materializer:hidden-exit:owv17-mat-way')],
    );
    await seedMaterializerBridge([
      {
        materializer_id: 'hexit1',
        source_slug: 'owv17-mat-way',
        source_mention: '@OWV17 mat way',
        source_kind: 'quest',
        source_path: 'x.md',
        entity: '@OWV17 mat market',
        entity_slug: 'owv17-mat-market',
        target_status: 'existing',
        type: 'location/hidden-exit',
        scope: '@OWV17 mat town',
        effect: 'opens hatch under barrels.',
      },
    ]);
    const preApply = await queryRows<{hidden: string | null; tags: string[]}>(
      `SELECT profile->>'hidden_until_stage' AS hidden, tags FROM entities WHERE id = $1`,
      [marketId],
    );
    expect(preApply[0]?.hidden).toBe('materializer:hidden-exit:owv17-mat-way');
    expect(preApply[0]?.tags).toContain('hidden');
    const tool = getTool('apply_materializer_bridge');
    const first = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'hexit1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      already_applied: boolean;
      type: string;
      exits_wired: number[];
      memory_id: number;
    };
    expect(first.ok).toBe(true);
    expect(first.already_applied).toBe(false);
    expect(first.type).toBe('location/hidden-exit');
    expect(first.exits_wired.sort((a, b) => a - b)).toEqual(
      [townId, marketId].sort((a, b) => a - b),
    );
    expect(first.memory_id).toBeGreaterThan(0);

    const exitsAfter = await queryRows<{exits: number[] | null}>(
      `SELECT (profile->'exits')::jsonb::text::jsonb AS exits FROM entities WHERE id = $1`,
      [townId],
    );
    expect(Array.isArray(exitsAfter[0]!.exits)).toBe(true);
    expect((exitsAfter[0]!.exits as number[]).map(Number)).toContain(marketId);

    const reverseExits = await queryRows<{exits: number[] | null}>(
      `SELECT (profile->'exits')::jsonb::text::jsonb AS exits FROM entities WHERE id = $1`,
      [marketId],
    );
    expect((reverseExits[0]!.exits as number[]).map(Number)).toContain(townId);

    // OWV-7: the hidden-until gate is gone and `'hidden'` is no
    // longer in the tag list, so `move_player` will accept the
    // target. The check uses ?-operator instead of @-operator
    // so we explicitly see that the key was removed (PGlite/
    // Postgres jsonb `profile->>'k'` returns null for missing
    // keys; treat null as "cleared").
    const postApply = await queryRows<{
      gate_cleared: boolean;
      hidden_tag_present: boolean;
      tags: string[];
    }>(
      `SELECT NOT (profile ? 'hidden_until_stage') AS gate_cleared,
              COALESCE(tags @> ARRAY['hidden'], false) AS hidden_tag_present,
              tags
         FROM entities WHERE id = $1`,
      [marketId],
    );
    expect(postApply[0]?.gate_cleared).toBe(true);
    expect(postApply[0]?.hidden_tag_present).toBe(false);
    expect(postApply[0]?.tags).not.toContain('hidden');

    // Second call is idempotent — applied flag short-circuits.
    const second = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'hexit1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {ok: boolean; already_applied: boolean; memory_id: number};
    expect(second.ok).toBe(true);
    expect(second.already_applied).toBe(true);
    expect(second.memory_id).toBe(first.memory_id);
    // Exits array stays single-entry after the idempotent retry.
    const exitsRecheck = await queryRows<{exits: number[] | null}>(
      `SELECT (profile->'exits')::jsonb::text::jsonb AS exits FROM entities WHERE id = $1`,
      [townId],
    );
    const exitsList = ((exitsRecheck[0]!.exits ?? []) as number[]).map(Number);
    expect(exitsList.filter(id => id === marketId)).toHaveLength(1);

    const memoryRows = await queryRows<{count: number}>(
      `SELECT COUNT(*)::int AS count FROM npc_memories
        WHERE owner_entity_id = $1
          AND memory_kind = 'materializer_applied'`,
      [sourceId],
    );
    expect(Number(memoryRows[0]!.count)).toBe(1);
  });

  it('grants a non-currency item to the hero inventory when scope contains hero inventory', async () => {
    const playerId = await newPlayer('access-item');
    const sourceId = await seedEntity(
      'person',
      'owv17-mat-sable',
      'OWV-17 mat Sable Vey',
    );
    await seedEntity(
      'location',
      'owv17-mat-market',
      "OWV-17 mat Thief's market",
    );
    const itemId = await seedItem(
      'owv17-mat-quiet-trading-token',
      'OWV-17 mat Quiet trading token',
    );
    await seedMaterializerBridge([
      {
        materializer_id: 'access1',
        source_slug: 'owv17-mat-sable',
        source_mention: '@OWV17 mat Sable Vey',
        source_kind: 'person',
        source_path: 'y.md',
        entity: '@OWV17 mat Quiet trading token',
        entity_slug: 'owv17-mat-quiet-trading-token',
        target_status: 'new',
        type: 'item/access-state',
        scope: '@OWV17 mat market and hero inventory',
        effect: 'hero may trade for the day.',
      },
    ]);
    const tool = getTool('apply_materializer_bridge');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'access1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      items_granted: Array<{item_id: number; slug: string; count: number}>;
      memory_id: number;
    };
    expect(result.ok).toBe(true);
    expect(result.items_granted).toHaveLength(1);
    expect(result.items_granted[0]!.item_id).toBe(itemId);
    expect(result.items_granted[0]!.count).toBe(1);
    const inv = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
         FROM player_inventory
        WHERE player_id = $1 AND item_id = $2`,
      [playerId, itemId],
    );
    expect(Number(inv[0]!.quantity)).toBe(1);
    const memoryRow = await queryRows<{metadata: Record<string, unknown>}>(
      `SELECT metadata FROM npc_memories
        WHERE owner_entity_id = $1
          AND memory_kind = 'materializer_applied'`,
      [sourceId],
    );
    expect(memoryRow).toHaveLength(1);
    const items_granted = memoryRow[0]!.metadata.items_granted as Array<{
      item_id: number;
    }>;
    expect(items_granted[0]!.item_id).toBe(itemId);
  });

  it('writes only the applied memory for state/service rows — no exits, no inventory mutation', async () => {
    const playerId = await newPlayer('state-service');
    const sourceId = await seedEntity(
      'person',
      'owv17-mat-mikka',
      'OWV-17 mat Mikka companion',
    );
    await seedMaterializerBridge([
      {
        materializer_id: 'state1',
        source_slug: 'owv17-mat-mikka',
        source_mention: '@OWV17 mat Mikka',
        source_kind: 'person',
        source_path: 'z.md',
        entity: '@OWV17 mat Mikka companion contract',
        entity_slug: 'owv17-mat-mikka-contract',
        target_status: 'new',
        type: 'state/service',
        scope: 'between @OWV17 mat Mikka and the hero',
        effect: 'Mikka travels with hero.',
      },
    ]);
    const tool = getTool('apply_materializer_bridge');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'state1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      exits_wired: number[];
      items_granted: Array<unknown>;
      memory_id: number;
    };
    expect(result.ok).toBe(true);
    expect(result.exits_wired).toEqual([]);
    expect(result.items_granted).toEqual([]);
    expect(result.memory_id).toBeGreaterThan(0);
    const memoryRow = await queryRows<{text: string}>(
      `SELECT text FROM npc_memories
        WHERE owner_entity_id = $1
          AND memory_kind = 'materializer_applied'`,
      [sourceId],
    );
    expect(memoryRow).toHaveLength(1);
    expect(memoryRow[0]!.text).toBe('Mikka travels with hero.');
  });

  it('creates a deterministic location entity for location/shelter and reuses it on retry', async () => {
    const playerId = await newPlayer('shelter');
    await seedEntity('person', 'owv17-mat-sable-host', 'OWV-17 mat Sable host');
    await seedMaterializerBridge([
      {
        materializer_id: 'shelter1',
        source_slug: 'owv17-mat-sable-host',
        source_mention: '@OWV17 mat Sable host',
        source_kind: 'person',
        source_path: 'y.md',
        entity: '@OWV17 mat back room',
        entity_slug: 'owv17-mat-back-room',
        target_status: 'new',
        type: 'location/shelter',
        scope: 'inside @OWV17 mat market',
        effect: 'hero has paid shelter for one night.',
      },
    ]);
    const tool = getTool('apply_materializer_bridge');
    const first = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'shelter1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      target_entity_id: number;
      target_entity_created: boolean;
      already_applied: boolean;
    };
    expect(first.ok).toBe(true);
    expect(first.already_applied).toBe(false);
    expect(first.target_entity_created).toBe(true);
    expect(first.target_entity_id).toBeGreaterThan(0);

    const created = await queryRows<{
      kind: string;
      display_name: string;
      tags: string[];
      profile: Record<string, unknown>;
    }>(
      `SELECT kind, display_name, tags, profile FROM entities WHERE id = $1`,
      [first.target_entity_id],
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('location');
    expect(created[0]!.display_name).toBe('OWV17 mat back room');
    expect(created[0]!.tags).toEqual(expect.arrayContaining(['materializer', 'location/shelter']));
    expect(created[0]!.profile.source_slug).toBe('owv17-mat-back-room');
    expect(created[0]!.profile.materializer_id).toBe('shelter1');

    // Second call short-circuits as already_applied; no duplicate
    // entity row appears.
    const second = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'shelter1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      already_applied: boolean;
      target_entity_id: number;
    };
    expect(second.already_applied).toBe(true);
    const count = await queryRows<{count: number}>(
      `SELECT COUNT(*)::int AS count FROM entities
        WHERE profile->>'source_slug' = 'owv17-mat-back-room'`,
    );
    expect(Number(count[0]!.count)).toBe(1);
  });

  it('creates a container/service entity tagged container + service', async () => {
    const playerId = await newPlayer('container');
    await seedEntity('person', 'owv17-mat-sable-keeper', 'OWV-17 mat Sable keeper');
    await seedMaterializerBridge([
      {
        materializer_id: 'cont1',
        source_slug: 'owv17-mat-sable-keeper',
        source_mention: '@OWV17 mat Sable keeper',
        source_kind: 'person',
        source_path: 'q.md',
        entity: '@OWV17 mat locked box',
        entity_slug: 'owv17-mat-locked-box',
        target_status: 'new',
        type: 'container/service',
        scope: 'under @OWV17 mat Sable keeper control',
        effect: 'sable holds the box for the hero.',
      },
    ]);
    const tool = getTool('apply_materializer_bridge');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'cont1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      target_entity_id: number;
      target_entity_created: boolean;
    };
    expect(result.target_entity_created).toBe(true);
    const row = await queryRows<{kind: string; tags: string[]}>(
      `SELECT kind, tags FROM entities WHERE id = $1`,
      [result.target_entity_id],
    );
    expect(row[0]!.kind).toBe('item');
    expect(row[0]!.tags).toEqual(
      expect.arrayContaining(['materializer', 'container', 'service', 'container/service']),
    );
  });

  it('creates items row + entity on item/access-state when both are absent', async () => {
    const playerId = await newPlayer('access-new');
    await seedEntity('person', 'owv17-mat-sable-token', 'OWV-17 mat Sable token');
    await seedMaterializerBridge([
      {
        materializer_id: 'access2',
        source_slug: 'owv17-mat-sable-token',
        source_mention: '@OWV17 mat Sable token',
        source_kind: 'person',
        source_path: 'y.md',
        entity: '@OWV17 mat permit',
        entity_slug: 'owv17-mat-permit',
        target_status: 'new',
        type: 'item/access-state',
        scope: 'hero inventory and @OWV17 mat market',
        effect: 'hero may move freely.',
      },
    ]);
    const tool = getTool('apply_materializer_bridge');
    const first = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'access2'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      target_entity_id: number;
      target_entity_created: boolean;
      items_granted: Array<{item_id: number; slug: string; count: number}>;
    };
    expect(first.target_entity_created).toBe(true);
    expect(first.items_granted).toHaveLength(1);
    expect(first.items_granted[0]!.slug).toBe('owv17-mat-permit');
    expect(first.items_granted[0]!.count).toBe(1);

    const itemRow = await queryRows<{
      id: number;
      legacy_entity_id: number | null;
      category: string;
    }>(
      `SELECT id, legacy_entity_id, category FROM items WHERE slug = $1`,
      ['owv17-mat-permit'],
    );
    expect(itemRow).toHaveLength(1);
    expect(itemRow[0]!.category).toBe('tool');
    expect(itemRow[0]!.legacy_entity_id).toBe(first.target_entity_id);
    const inv = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
         FROM player_inventory
        WHERE player_id = $1 AND item_id = $2`,
      [playerId, itemRow[0]!.id],
    );
    expect(Number(inv[0]!.quantity)).toBe(1);

    // Repeat: idempotent — no second item, no duplicate entity, no
    // duplicate memory.
    const second = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'access2'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {already_applied: boolean};
    expect(second.already_applied).toBe(true);
    const invAfter = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
         FROM player_inventory
        WHERE player_id = $1 AND item_id = $2`,
      [playerId, itemRow[0]!.id],
    );
    expect(Number(invAfter[0]!.quantity)).toBe(1);
    const itemCount = await queryRows<{count: number}>(
      `SELECT COUNT(*)::int AS count FROM items WHERE slug = $1`,
      ['owv17-mat-permit'],
    );
    expect(Number(itemCount[0]!.count)).toBe(1);
  });

  it('grants materialized items to a named NPC holder from cartridge scope', async () => {
    const playerId = await newPlayer('npc-access-item');
    const sourceId = await seedEntity(
      'scene',
      'owv17-mat-bram-choice',
      'OWV-17 mat Bram choice',
    );
    const npcId = await seedEntity(
      'person',
      'owv17-mat-tamara',
      'OWV-17 mat Tamara',
    );
    await seedMaterializerBridge([
      {
        materializer_id: 'npc-access1',
        source_slug: 'owv17-mat-bram-choice',
        source_mention: '@OWV17 mat Bram choice',
        source_kind: 'scene',
        source_path: 'scene.md',
        entity: '@OWV17 mat Dock Pass',
        entity_slug: 'owv17-mat-dock-pass',
        target_status: 'new',
        type: 'item/clue',
        scope: '@OWV17 mat Tamara inventory',
        effect: 'Tamara receives count=2 dock passes for the next scene.',
      },
    ]);
    const tool = getTool('apply_materializer_bridge');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'npc-access1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      items_granted: Array<{
        item_id: number;
        slug: string;
        count: number;
        holder_entity_id: number;
        holder_kind: string;
      }>;
    };

    expect(result.ok).toBe(true);
    expect(result.items_granted).toHaveLength(1);
    expect(result.items_granted[0]).toMatchObject({
      slug: 'owv17-mat-dock-pass',
      count: 2,
      holder_entity_id: npcId,
      holder_kind: 'entity',
    });

    const npcInventory = await queryRows<{
      count: number | string;
      slug: string;
    }>(
      `SELECT ie.count, i.slug
         FROM inventory_entries ie
         JOIN items i ON i.legacy_entity_id = ie.item_entity_id
        WHERE ie.holder_entity_id = $1
          AND i.slug = 'owv17-mat-dock-pass'`,
      [npcId],
    );
    expect(npcInventory).toHaveLength(1);
    expect(Number(npcInventory[0]!.count)).toBe(2);

    const heroInventory = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(pi.quantity), 0)::int AS quantity
         FROM player_inventory pi
         JOIN items i ON i.id = pi.item_id
        WHERE pi.player_id = $1
          AND i.slug = 'owv17-mat-dock-pass'`,
      [playerId],
    );
    expect(Number(heroInventory[0]!.quantity)).toBe(0);

    const memoryRow = await queryRows<{metadata: Record<string, unknown>}>(
      `SELECT metadata FROM npc_memories
        WHERE owner_entity_id = $1
          AND memory_kind = 'materializer_applied'`,
      [sourceId],
    );
    const items_granted = memoryRow[0]!.metadata.items_granted as Array<{
      holder_entity_id: number;
      holder_kind: string;
      count: number;
    }>;
    expect(items_granted[0]).toMatchObject({
      holder_entity_id: npcId,
      holder_kind: 'entity',
      count: 2,
    });
  });

  it('applies cartridge-authored hero backstory directives into the player profile context', async () => {
    const playerId = await newPlayer('hero-profile');
    await seedEntity(
      'scene',
      'owv17-mat-hero-origin-scene',
      'OWV-17 mat hero origin scene',
    );
    const prompt =
      'Treat the hero as a dockside witness whose old smuggling past makes the Blue Warehouse personal.';
    await seedMaterializerBridge([
      {
        materializer_id: 'hero-profile1',
        source_slug: 'owv17-mat-hero-origin-scene',
        source_mention: '@OWV17 mat hero origin scene',
        source_kind: 'scene',
        source_path: 'hero-origin.md',
        entity: '@OWV17 mat Hero Origin Directive',
        entity_slug: 'owv17-mat-hero-origin-directive',
        target_status: 'new',
        type: 'hero / backstory',
        scope: 'active hero profile',
        effect: prompt,
      },
    ]);
    const tool = getTool('apply_materializer_bridge');
    const result = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'hero-profile1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      target_entity_id: number;
      hero_profile_directive: {prompt: string; type: string};
    };

    expect(result.ok).toBe(true);
    expect(result.target_entity_id).toBe(playerId);
    expect(result.hero_profile_directive).toMatchObject({
      type: 'hero/backstory',
      prompt,
    });

    const profileRows = await queryRows<{profile: Record<string, unknown>}>(
      `SELECT profile FROM entities WHERE id = $1`,
      [playerId],
    );
    const profile = profileRows[0]!.profile;
    expect((profile['background'] as Record<string, unknown>)['cartridge_prompt']).toBe(
      prompt,
    );
    expect(profile['cartridge_directives']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          materializer_id: 'hero-profile1',
          prompt,
        }),
      ]),
    );

    const {renderPlayerSnapshot} = await import('../../turnContext/playerContext.js');
    const playerRow = await queryRows<{
      entity_id: number;
      display_name: string;
      current_xp: number;
      current_level: number;
      current_hp: number;
      max_hp: number;
      current_location_id: number | null;
      current_scene_id: number | null;
      dialogue_partner_id: number | null;
    }>(
      `SELECT p.entity_id, e.display_name, p.current_xp, p.current_level,
              p.current_hp, p.max_hp, p.current_location_id,
              p.current_scene_id, p.dialogue_partner_id
         FROM players p
         JOIN entities e ON e.id = p.entity_id
        WHERE p.entity_id = $1`,
      [playerId],
    );
    const context = await renderPlayerSnapshot(playerRow[0]!);
    expect(context).toContain('Cartridge backstory directive');
    expect(context).toContain('old smuggling past');
  });

  it('applies cartridge-authored hero statuses and hero voice lines', async () => {
    const playerId = await newPlayer('hero-status-voice');
    await seedEntity(
      'scene',
      'owv17-mat-hero-voice-scene',
      'OWV-17 mat hero voice scene',
    );
    await seedMaterializerBridge([
      {
        materializer_id: 'hero-status1',
        source_slug: 'owv17-mat-hero-voice-scene',
        source_mention: '@OWV17 mat hero voice scene',
        source_kind: 'scene',
        source_path: 'hero-voice.md',
        entity: '@OWV17 mat Hero Status Directive',
        entity_slug: 'owv17-mat-hero-status-directive',
        target_status: 'new',
        type: 'hero / status / mood',
        scope: 'active hero',
        effect: 'value=watchful; intensity=0.75; reason=the hatch feels familiar',
      },
      {
        materializer_id: 'hero-voice1',
        source_slug: 'owv17-mat-hero-voice-scene',
        source_mention: '@OWV17 mat hero voice scene',
        source_kind: 'scene',
        source_path: 'hero-voice.md',
        entity: '@OWV17 mat Hero Voice Line',
        entity_slug: 'owv17-mat-hero-voice-line',
        target_status: 'new',
        type: 'hero / voice',
        scope: 'active hero speech',
        effect: 'line=I know this lock. I have seen this mark before.',
      },
    ]);
    const tool = getTool('apply_materializer_bridge');
    const statusResult = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'hero-status1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      hero_status: {status_kind: string; status_value: string; intensity: number};
    };
    expect(statusResult.ok).toBe(true);
    expect(statusResult.hero_status).toMatchObject({
      status_kind: 'mood',
      status_value: 'watchful',
      intensity: 0.75,
    });

    const statusRows = await queryRows<{
      status_kind: string;
      status_value: string;
      intensity: number | string;
    }>(
      `SELECT status_kind, status_value, intensity
         FROM actor_statuses
        WHERE player_id = $1
          AND actor_entity_id = $1
          AND status_kind = 'mood'`,
      [playerId],
    );
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]!.status_value).toBe('watchful');

    const voiceResult = (await runWithContext(
      {sessionId: `s-${playerId}`, playerId},
      () =>
        tool.execute(
          {materializer_id: 'hero-voice1'},
          {sessionId: `s-${playerId}`, playerId},
        ),
    )) as {
      ok: boolean;
      hero_voice: {message_id: number; text: string};
    };
    expect(voiceResult.ok).toBe(true);
    expect(voiceResult.hero_voice.text).toBe(
      'I know this lock. I have seen this mark before.',
    );

    const messageRows = await queryRows<{
      tone: string;
      text: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT tone, text, payload
         FROM chat_messages
        WHERE id = $1`,
      [voiceResult.hero_voice.message_id],
    );
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]).toMatchObject({
      tone: 'player',
      text: 'I know this lock. I have seen this mark before.',
    });
    expect(messageRows[0]!.payload).toMatchObject({
      source: 'cartridge_hero_voice',
      materializer_id: 'hero-voice1',
    });
  });

  it('rejects unknown materializer ids and unresolved source slugs without mutation', async () => {
    const playerId = await newPlayer('reject');
    await seedMaterializerBridge([
      {
        materializer_id: 'orphan',
        source_slug: 'phantom-source',
        source_mention: '@Phantom source',
        source_kind: 'person',
        source_path: 'x.md',
        entity: '@Thing',
        entity_slug: 'thing',
        target_status: 'new',
        type: 'state/service',
        scope: 'between @Phantom source and the hero',
        effect: 'never resolves.',
      },
    ]);
    const tool = getTool('apply_materializer_bridge');

    let unknownCaught: unknown = null;
    try {
      await runWithContext(
        {sessionId: `s-${playerId}`, playerId},
        () =>
          tool.execute(
            {materializer_id: 'does-not-exist'},
            {sessionId: `s-${playerId}`, playerId},
          ),
      );
    } catch (err) {
      unknownCaught = err;
    }
    expect(unknownCaught).toBeInstanceOf(ToolExecutionError);
    expect((unknownCaught as InstanceType<typeof ToolExecutionError>).message).toContain(
      'unknown materializer',
    );

    let orphanCaught: unknown = null;
    try {
      await runWithContext(
        {sessionId: `s-${playerId}`, playerId},
        () =>
          tool.execute(
            {materializer_id: 'orphan'},
            {sessionId: `s-${playerId}`, playerId},
          ),
      );
    } catch (err) {
      orphanCaught = err;
    }
    expect(orphanCaught).toBeInstanceOf(ToolExecutionError);
    const orphanError = orphanCaught as InstanceType<typeof ToolExecutionError>;
    expect(orphanError.rejected).toBe(true);
    expect(orphanError.message).toContain('source entity not resolved');

    const memoryRows = await queryRows<{count: number}>(
      `SELECT COUNT(*)::int AS count FROM npc_memories
        WHERE memory_kind = 'materializer_applied'`,
    );
    expect(Number(memoryRows[0]!.count)).toBe(0);
  });
});
