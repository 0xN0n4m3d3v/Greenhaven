/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterAll,
  afterEach,
  beforeAll,
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
let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;
let cartridgeCache: typeof import('../../cartridge.js');
let MaterializerBridgeService: typeof import('../../services/MaterializerBridgeService.js');

interface ToolHandle {
  execute: (
    args: Record<string, unknown>,
    ctx: {sessionId: string; playerId: number; turnId?: string},
  ) => Promise<unknown>;
}

function getTool(name: string): ToolHandle {
  const def = getRegisteredTools().get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def as unknown as ToolHandle;
}

beforeAll(async () => {
  await setupTurnTestEnvironment();
  await import('../../tools/index.js');
  ({getRegisteredTools, runWithContext} = await import('../../tools/base.js'));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
  cartridgeCache = await import('../../cartridge.js');
  MaterializerBridgeService = await import(
    '../../services/MaterializerBridgeService.js'
  );
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

afterEach(async () => {
  await queryRows(`DELETE FROM gui_events WHERE session_id LIKE 'gmv2-relation-%'`);
  await queryRows(`DELETE FROM sessions WHERE id LIKE 'gmv2-relation-%'`);
  await queryRows(
    `DELETE FROM npc_memories
      WHERE source_tool = 'apply_relationship_trigger_rule'
         OR memory_kind = 'materializer_applied'`,
  );
  await queryRows(`DELETE FROM cartridge_meta WHERE key = 'forge_materializer_bridge'`);
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE key = 'forge_materializer_bridge'`,
  );
  cartridgeCache.clearMetaCache();
  MaterializerBridgeService.clearMaterializerBridgeCache();
  await queryRows(
    `DELETE FROM player_inventory
      WHERE item_id IN (
        SELECT id FROM items
         WHERE slug LIKE 'gmv2-relation-%'
      )`,
  );
  await queryRows(`DELETE FROM items WHERE slug LIKE 'gmv2-relation-%'`);
  await queryRows(
    `DELETE FROM runtime_values
      WHERE field_id IN (
        SELECT id FROM runtime_fields
         WHERE owner_entity_id IN (
           SELECT id FROM entities
            WHERE display_name LIKE 'GMV2 relation %'
         )
      )`,
  );
  await queryRows(
    `DELETE FROM runtime_fields
      WHERE owner_entity_id IN (
        SELECT id FROM entities
         WHERE display_name LIKE 'GMV2 relation %'
      )`,
  );
  await queryRows(`DELETE FROM entities WHERE display_name LIKE 'GMV2 relation %'`);
  await queryRows(`DELETE FROM cartridges WHERE id = 'gmv2-relation-test'`);
});

async function newPlayer(): Promise<number> {
  const p = await createAnonymousPlayer(`GMV2 relation player ${Date.now()}`);
  return p.entity_id;
}

async function seedSession(sessionId: string, playerId: number): Promise<void> {
  await queryRows(
    `INSERT INTO sessions (id, player_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [sessionId, playerId],
  );
}

async function seedNpc(): Promise<number> {
  const cartridge = await queryRows<{id: string}>(
    `SELECT value #>> '{}' AS id
       FROM cartridge_meta
      WHERE key = 'cartridge_id'
      LIMIT 1`,
  );
  const cartridgeId = cartridge[0]?.id ?? null;
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES (
       'person',
       'GMV2 relation Tessa',
       '',
       $1::jsonb,
       ARRAY['person'],
       $2
     )
     RETURNING id`,
    [
      JSON.stringify({
        source_slug: 'gmv2-relation-tessa',
        relationship_trigger_rules: [
          {
            kind: 'strings_delta',
            delta: 1,
            condition: 'The hero protects a witness in public.',
            mentions: [],
            source: 'npc_relationship_triggers',
          },
          {
            kind: 'strings_delta',
            delta: -1,
            condition: 'The hero sells the witness.',
            mentions: [],
            source: 'npc_relationship_triggers',
          },
        ],
      }),
      cartridgeId,
    ],
  );
  const npcId = Number(rows[0]!.id);
  await queryRows(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value, scope, description)
     VALUES ($1, 'strings', 'json', '{}'::jsonb, 'permanent', 'test strings')`,
    [npcId],
  );
  return npcId;
}

async function seedMaterializerBridge(rows: unknown[]): Promise<void> {
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('forge_materializer_bridge', $1::jsonb, 'GMV2 relationship materializer seed')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        schema_version: 'greenhaven.materializers.v1',
        source_project: 'gmv2-relation-test',
        rows,
      }),
    ],
  );
  cartridgeCache.clearMetaCache();
  MaterializerBridgeService.clearMaterializerBridgeCache();
}

describe('apply_relationship_trigger_rule', () => {
  it('applies one authored strings rule and dedupes repeated calls', async () => {
    const playerId = await newPlayer();
    const sessionId = `gmv2-relation-${playerId}`;
    await seedSession(sessionId, playerId);
    const npcId = await seedNpc();
    const tool = getTool('apply_relationship_trigger_rule');

    const first = (await runWithContext(
      {sessionId, playerId, turnId: 'turn-relationship-1'},
      () =>
        tool.execute(
          {
            npc: '@GMV2 relation Tessa',
            rule_number: 1,
            evidence: 'quest stage confirmed the public witness defense',
          },
          {sessionId, playerId, turnId: 'turn-relationship-1'},
        ),
    )) as {
      ok: boolean;
      already_applied: boolean;
      remaining: number;
      memory_id: number;
    };

    expect(first.ok).toBe(true);
    expect(first.already_applied).toBe(false);
    expect(first.remaining).toBe(1);

    const stringsAfterFirst = await queryRows<{value: Record<string, number>}>(
      `SELECT rv.value
         FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = 'strings'`,
      [npcId],
    );
    expect(stringsAfterFirst[0]!.value[String(playerId)]).toBe(1);

    const second = (await runWithContext(
      {sessionId, playerId, turnId: 'turn-relationship-2'},
      () =>
        tool.execute(
          {
            npc: '@GMV2 relation Tessa',
            rule_number: 1,
            evidence: 'same event replayed',
          },
          {sessionId, playerId, turnId: 'turn-relationship-2'},
        ),
    )) as {
      ok: boolean;
      already_applied: boolean;
      remaining: number;
      memory_id: number;
    };

    expect(second.ok).toBe(true);
    expect(second.already_applied).toBe(true);
    expect(second.remaining).toBe(1);
    expect(second.memory_id).toBe(first.memory_id);

    const memories = await queryRows<{count: number}>(
      `SELECT COUNT(*)::int AS count
         FROM npc_memories
        WHERE owner_entity_id = $1
          AND about_entity_id = $2
          AND source_tool = 'apply_relationship_trigger_rule'`,
      [npcId, playerId],
    );
    expect(Number(memories[0]!.count)).toBe(1);
  });

  it('auto-applies relationship materializers after a confirmed relationship trigger', async () => {
    const playerId = await newPlayer();
    const sessionId = `gmv2-relation-${playerId}`;
    await seedSession(sessionId, playerId);
    await seedNpc();
    await seedMaterializerBridge([
      {
        materializer_id: 'rel-mat1',
        source_slug: 'gmv2-relation-tessa',
        source_mention: '@GMV2 relation Tessa',
        source_kind: 'person',
        source_path: 'npc.md',
        entity: '@GMV2 relation Trust Ribbon',
        entity_slug: 'gmv2-relation-trust-ribbon',
        target_status: 'new',
        trigger_condition: 'When Tessa trusts the hero after a public defense.',
        trigger_source: 'relationship',
        type: 'item/access-state',
        scope: 'hero inventory from @GMV2 relation Tessa',
        effect: 'Tessa gives a trust ribbon.',
      },
    ]);
    const tool = getTool('apply_relationship_trigger_rule');

    await runWithContext({sessionId, playerId, turnId: 'turn-rel-mat'}, () =>
      tool.execute(
        {
          npc: '@GMV2 relation Tessa',
          rule_number: 1,
          evidence: 'backend-confirmed public defense',
        },
        {sessionId, playerId, turnId: 'turn-rel-mat'},
      ),
    );

    const granted = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(pi.quantity), 0)::int AS quantity
         FROM player_inventory pi
         JOIN items i ON i.id = pi.item_id
        WHERE pi.player_id = $1
          AND i.slug = 'gmv2-relation-trust-ribbon'`,
      [playerId],
    );
    expect(Number(granted[0]!.quantity)).toBe(1);
    const events = await queryRows<{event_type: string}>(
      `SELECT event_type
         FROM gui_events
        WHERE session_id = $1
          AND event_type LIKE 'materializer:%'
        ORDER BY id ASC`,
      [sessionId],
    );
    expect(events.map(e => e.event_type)).toEqual(
      expect.arrayContaining(['materializer:applied', 'materializer:auto_applied']),
    );
  });
});
