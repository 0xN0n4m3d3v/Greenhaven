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

let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;
let applyQuestRewards: typeof import('../../tools/quest.js').applyQuestRewards;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  await import('../../tools/index.js');
  ({createAnonymousPlayer} = await import('../../playerService.js'));
  ({applyQuestRewards} = await import('../../tools/quest.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

afterEach(async () => {
  await queryRows(`DELETE FROM gui_events WHERE session_id LIKE 'gmv2-reward-%'`);
  await queryRows(`DELETE FROM sessions WHERE id LIKE 'gmv2-reward-%'`);
  await queryRows(
    `DELETE FROM npc_memories
      WHERE 'quest-reward' = ANY(tags)
         OR source_tool = 'quest_reward'`,
  );
  await queryRows(
    `DELETE FROM actor_statuses
      WHERE actor_entity_id IN (
        SELECT id FROM entities
         WHERE display_name LIKE 'GMV2 reward %'
      )`,
  );
  await queryRows(
    `DELETE FROM player_inventory
      WHERE item_id IN (
        SELECT id FROM items
         WHERE slug LIKE 'gmv2_reward_%'
      )`,
  );
  await queryRows(`DELETE FROM items WHERE slug LIKE 'gmv2_reward_%'`);
  await queryRows(
    `DELETE FROM runtime_values
      WHERE field_id IN (
        SELECT id FROM runtime_fields
         WHERE owner_entity_id IN (
           SELECT id FROM entities
            WHERE display_name LIKE 'GMV2 reward %'
         )
      )`,
  );
  await queryRows(
    `DELETE FROM runtime_fields
      WHERE owner_entity_id IN (
        SELECT id FROM entities
         WHERE display_name LIKE 'GMV2 reward %'
      )`,
  );
  await queryRows(`DELETE FROM entities WHERE display_name LIKE 'GMV2 reward %'`);
  await queryRows(`DELETE FROM cartridges WHERE id = 'gmv2-reward-test'`);
});

async function seedSession(sessionId: string, playerId: number): Promise<void> {
  await queryRows(
    `INSERT INTO sessions (id, player_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [sessionId, playerId],
  );
}

async function seedRewardQuest(): Promise<{
  playerId: number;
  sessionId: string;
  npcId: number;
  itemId: number;
  questId: number;
}> {
  await queryRows(
    `INSERT INTO cartridges
       (id, title, version, schema_version, source_kind, content_hash, manifest)
     VALUES (
       'gmv2-reward-test',
       'GMV2 Reward Test',
       '0.0.0',
       'test',
       'builtin',
       'gmv2-reward-test',
       '{}'::jsonb
     )
     ON CONFLICT (id) DO NOTHING`,
  );
  const created = await createAnonymousPlayer(`GMV2 reward player ${Date.now()}`);
  const playerId = created.entity_id;
  const sessionId = `gmv2-reward-${playerId}`;
  await seedSession(sessionId, playerId);

  const npcRows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES (
       'person',
       'GMV2 reward Tessa',
       'Quest reward NPC.',
       '{"source_slug":"gmv2-reward-tessa"}'::jsonb,
       ARRAY['person'],
       'gmv2-reward-test'
     )
     RETURNING id`,
  );
  const npcId = Number(npcRows[0]!.id);
  await queryRows(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value, scope, description)
     VALUES ($1, 'strings', 'json', '{}'::jsonb, 'permanent', 'test strings')`,
    [npcId],
  );
  const itemEntity = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES (
       'item',
       'GMV2 reward Token',
       'Quest reward item.',
       '{"source_slug":"gmv2-reward-token"}'::jsonb,
       ARRAY['item'],
       'gmv2-reward-test'
     )
     RETURNING id`,
  );
  const itemRows = await queryRows<{id: number}>(
    `INSERT INTO items
       (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
     VALUES ('gmv2_reward_token', 'quest', 0, true, 99, '{}'::jsonb, $1)
     RETURNING id`,
    [itemEntity[0]!.id],
  );
  const itemId = Number(itemRows[0]!.id);

  const questRows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES (
       'quest',
       'GMV2 reward Quest',
       'Quest reward contract.',
       $1::jsonb,
       ARRAY['quest'],
       'gmv2-reward-test'
     )
     RETURNING id`,
    [
      JSON.stringify({
        rewards: {
          strings: [
            {
              npc: '@GMV2 reward Tessa',
              delta: 1,
              reason: 'authored +strings reward',
            },
          ],
          companions: [
            {
              npc: '@GMV2 reward Tessa',
              action: 'follow',
              reason: 'Companion: @GMV2 reward Tessa joins the hero.',
            },
          ],
          memories: [
            {
              owner: '@GMV2 reward Tessa',
              about: 'current_player',
              text: 'Memory: @GMV2 reward Tessa remembers the chosen path.',
              importance: 0.6,
            },
          ],
          items: [
            {
              item: '@GMV2 reward Token',
              count: 2,
              reason: 'Inventory: @GMV2 reward Token x2.',
            },
          ],
          statuses: [
            {
              actor: '@GMV2 reward Tessa',
              status_kind: 'trust',
              status_value: 'rewarded witness',
              intensity: 0.75,
              reason: 'Status: @GMV2 reward Tessa trust rewarded witness.',
            },
          ],
        },
      }),
    ],
  );

  return {playerId, sessionId, npcId, itemId, questId: Number(questRows[0]!.id)};
}

describe('GMV2 quest reward runtime contract', () => {
  it('applies @mention strings, companion joins, and memory rewards', async () => {
    const seeded = await seedRewardQuest();

    const applied = await applyQuestRewards(seeded.playerId, seeded.questId, {
      sessionId: seeded.sessionId,
      playerId: seeded.playerId,
      turnId: 'turn-gmv2-reward',
    });

    expect(applied['strings']).toEqual([
      {npc: '@GMV2 reward Tessa', delta: 1},
    ]);
    expect(applied['companions']).toEqual([
      {
        npc: 'GMV2 reward Tessa',
        npc_id: seeded.npcId,
        action: 'follow',
        already: false,
      },
    ]);
    expect(applied['memories']).toEqual([
      {
        owner_entity_id: seeded.npcId,
        about_entity_id: seeded.playerId,
        importance: 0.6,
      },
    ]);
    expect(applied['items']).toEqual([
      {item: '@GMV2 reward Token', item_id: seeded.itemId, count: 2},
    ]);
    expect(applied['statuses']).toEqual([
      {
        actor: '@GMV2 reward Tessa',
        actor_id: seeded.npcId,
        status_kind: 'trust',
        status_value: 'rewarded witness',
        intensity: 0.75,
      },
    ]);

    const strings = await queryRows<{value: Record<string, number>}>(
      `SELECT rv.value
         FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1
          AND rf.field_key = 'strings'`,
      [seeded.npcId],
    );
    expect(strings[0]!.value[String(seeded.playerId)]).toBe(1);

    const player = await queryRows<{companions: number[] | null}>(
      `SELECT metadata->'companions' AS companions
         FROM players
        WHERE entity_id = $1`,
      [seeded.playerId],
    );
    expect(player[0]!.companions).toContain(seeded.npcId);

    const status = await queryRows<{status_value: string}>(
      `SELECT status_value
         FROM actor_statuses
        WHERE player_id = $1
          AND actor_entity_id = $2
          AND status_kind = 'companion'`,
      [seeded.playerId, seeded.npcId],
    );
    expect(status[0]!.status_value).toBe('following');
    const trust = await queryRows<{status_value: string; intensity: number | string}>(
      `SELECT status_value, intensity
         FROM actor_statuses
        WHERE player_id = $1
          AND actor_entity_id = $2
          AND status_kind = 'trust'`,
      [seeded.playerId, seeded.npcId],
    );
    expect(trust[0]!.status_value).toBe('rewarded witness');
    expect(Number(trust[0]!.intensity)).toBe(0.75);

    const inventory = await queryRows<{quantity: number | string}>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
         FROM player_inventory
        WHERE player_id = $1
          AND item_id = $2`,
      [seeded.playerId, seeded.itemId],
    );
    expect(Number(inventory[0]!.quantity)).toBe(2);

    const memories = await queryRows<{text: string}>(
      `SELECT text
         FROM npc_memories
        WHERE owner_entity_id = $1
         AND about_entity_id = $2
          AND 'quest-reward' = ANY(tags)`,
      [seeded.npcId, seeded.playerId],
    );
    expect(memories[0]!.text).toContain('remembers the chosen path');

    const events = await queryRows<{event_type: string}>(
      `SELECT event_type
         FROM gui_events
        WHERE session_id = $1
        ORDER BY id ASC`,
      [seeded.sessionId],
    );
    expect(events.map(event => event.event_type)).toEqual([
      'string:changed',
      'actor:status_changed',
      'companion:added',
    ]);
  });
});
