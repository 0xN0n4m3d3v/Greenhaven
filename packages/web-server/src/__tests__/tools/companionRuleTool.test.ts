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
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

afterEach(async () => {
  await queryRows(`DELETE FROM gui_events WHERE session_id LIKE 'gmv2-companion-%'`);
  await queryRows(`DELETE FROM sessions WHERE id LIKE 'gmv2-companion-%'`);
  await queryRows(
    `DELETE FROM companion_universe_projections
      WHERE companion_bond_id IN (
        SELECT id FROM hero_companion_bonds
         WHERE companion_key LIKE 'entity:gmv2-companion-%'
      )`,
  );
  await queryRows(
    `DELETE FROM hero_companion_capsules
      WHERE companion_bond_id IN (
        SELECT id FROM hero_companion_bonds
         WHERE companion_key LIKE 'entity:gmv2-companion-%'
      )`,
  );
  await queryRows(
    `DELETE FROM hero_companion_bonds
      WHERE companion_key LIKE 'entity:gmv2-companion-%'`,
  );
  await queryRows(
    `DELETE FROM npc_memories
      WHERE source_tool = 'apply_companion_rule_contract'`,
  );
  await queryRows(
    `DELETE FROM actor_statuses
      WHERE actor_entity_id IN (
        SELECT id FROM entities
         WHERE display_name LIKE 'GMV2 companion %'
      )`,
  );
  await queryRows(`DELETE FROM entities WHERE display_name LIKE 'GMV2 companion %'`);
  await queryRows(`DELETE FROM cartridges WHERE id = 'gmv2-companion-test'`);
});

async function newPlayer(): Promise<number> {
  const p = await createAnonymousPlayer(`GMV2 companion player ${Date.now()}`);
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
  await queryRows(
    `INSERT INTO cartridges
       (id, title, version, schema_version, source_kind, content_hash, manifest)
     VALUES (
       'gmv2-companion-test',
       'GMV2 Companion Test',
       '0.0.0',
       'test',
       'builtin',
       'gmv2-companion-test',
       '{}'::jsonb
     )
     ON CONFLICT (id) DO NOTHING`,
  );
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES (
       'person',
       'GMV2 companion Tessa',
       '',
       $1::jsonb,
       ARRAY['person'],
       'gmv2-companion-test'
     )
     RETURNING id`,
    [
      JSON.stringify({
        source_slug: 'gmv2-companion-tessa',
        companion_rule_contract: {
          schema_version: 'greenhaven.companion_rules.v1',
          can_be_companion: true,
          portability: 'conditional_portable',
          rules: [
            {
              kind: 'join_condition',
              label: 'Join condition',
              text: 'The hero proves the route is safe.',
              mentions: [],
              source: 'npc_companion_rules',
            },
            {
              kind: 'depart_condition',
              label: 'Depart condition',
              text: 'The hero abandons two civilians.',
              mentions: [],
              source: 'npc_companion_rules',
            },
          ],
        },
      }),
    ],
  );
  return Number(rows[0]!.id);
}

describe('apply_companion_rule_contract', () => {
  it('applies a join rule through companion roster and continuity bond', async () => {
    const playerId = await newPlayer();
    const sessionId = `gmv2-companion-${playerId}`;
    await seedSession(sessionId, playerId);
    const npcId = await seedNpc();
    const tool = getTool('apply_companion_rule_contract');

    const first = (await runWithContext(
      {sessionId, playerId, turnId: 'turn-companion-1'},
      () =>
        tool.execute(
          {
            npc: String(npcId),
            rule_number: 1,
            evidence: 'quest chain proved the route is safe',
          },
          {sessionId, playerId, turnId: 'turn-companion-1'},
        ),
    )) as {
      ok: boolean;
      already_applied: boolean;
      action: string;
      bond_status: string;
      portability: string;
      memory_id: number;
    };

    expect(first.ok).toBe(true);
    expect(first.already_applied).toBe(false);
    expect(first.action).toBe('follow');
    expect(first.bond_status).toBe('bonded');
    expect(first.portability).toBe('portable');

    const playerRows = await queryRows<{companions: number[] | null}>(
      `SELECT metadata->'companions' AS companions
         FROM players
        WHERE entity_id = $1`,
      [playerId],
    );
    expect(playerRows[0]!.companions).toContain(npcId);

    const bonds = await queryRows<{
      status: string;
      portability: string;
      source_entity_id: number;
    }>(
      `SELECT status, portability, source_entity_id
         FROM hero_companion_bonds
        WHERE player_id = $1 AND companion_key = 'entity:gmv2-companion-tessa'`,
      [playerId],
    );
    expect(bonds).toHaveLength(1);
    expect(bonds[0]!.status).toBe('bonded');
    expect(bonds[0]!.portability).toBe('portable');
    expect(Number(bonds[0]!.source_entity_id)).toBe(npcId);

    const second = (await runWithContext(
      {sessionId, playerId, turnId: 'turn-companion-2'},
      () =>
        tool.execute(
          {
            npc: String(npcId),
            rule_number: 1,
            evidence: 'same join event replayed',
          },
          {sessionId, playerId, turnId: 'turn-companion-2'},
        ),
    )) as {
      ok: boolean;
      already_applied: boolean;
      memory_id: number;
    };

    expect(second.ok).toBe(true);
    expect(second.already_applied).toBe(true);
    expect(second.memory_id).toBe(first.memory_id);
  });
});
