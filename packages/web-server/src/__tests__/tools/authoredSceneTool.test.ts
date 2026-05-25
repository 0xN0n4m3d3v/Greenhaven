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
let clearSceneInstructionBridgeCache: typeof import('../../services/SceneInstructionBridgeService.js').clearSceneInstructionBridgeCache;
let clearMetaCache: typeof import('../../cartridge.js').clearMetaCache;

interface ToolHandle {
  execute: (
    args: Record<string, unknown>,
    ctx: {sessionId: string; playerId: number; turnId?: string},
  ) => Promise<unknown>;
}

interface SeededScene {
  playerId: number;
  sessionId: string;
  locationId: number;
  npcId: number;
  sceneId: number;
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
  ({clearSceneInstructionBridgeCache} = await import(
    '../../services/SceneInstructionBridgeService.js'
  ));
  ({clearMetaCache} = await import('../../cartridge.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

afterEach(async () => {
  clearSceneInstructionBridgeCache();
  clearMetaCache();
  await queryRows(`DELETE FROM gui_events WHERE session_id LIKE 'gmv2-scene-%'`);
  await queryRows(`DELETE FROM sessions WHERE id LIKE 'gmv2-scene-%'`);
  await queryRows(
    `DELETE FROM npc_memories
      WHERE source_tool = 'close_authored_scene'`,
  );
  await queryRows(
    `DELETE FROM runtime_values
      WHERE field_id IN (
        SELECT id FROM runtime_fields
         WHERE owner_entity_id IN (
           SELECT id FROM entities
            WHERE display_name LIKE 'GMV2 scene %'
         )
      )`,
  );
  await queryRows(
    `DELETE FROM runtime_fields
      WHERE owner_entity_id IN (
        SELECT id FROM entities
         WHERE display_name LIKE 'GMV2 scene %'
      )`,
  );
  await queryRows(`DELETE FROM hero_cartridge_states WHERE cartridge_id = 'gmv2-scene-test'`);
  await queryRows(`DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'gmv2-scene-test'`);
  await queryRows(
    `DELETE FROM cartridge_meta
      WHERE key IN ('cartridge_id', 'forge_scene_instructions')`,
  );
  await queryRows(`DELETE FROM entities WHERE display_name LIKE 'GMV2 scene %'`);
  await queryRows(`DELETE FROM cartridges WHERE id = 'gmv2-scene-test'`);
});

async function seedSession(sessionId: string, playerId: number): Promise<void> {
  await queryRows(
    `INSERT INTO sessions (id, player_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [sessionId, playerId],
  );
}

async function seedScene(): Promise<SeededScene> {
  await queryRows(
    `INSERT INTO cartridges
       (id, title, version, schema_version, source_kind, content_hash, manifest)
     VALUES (
       'gmv2-scene-test',
       'GMV2 Scene Test',
       '0.0.0',
       'test',
       'builtin',
       'gmv2-scene-test',
       '{}'::jsonb
     )
     ON CONFLICT (id) DO NOTHING`,
  );
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description)
     VALUES ('cartridge_id', '"gmv2-scene-test"'::jsonb, 'gmv2 scene test')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  const created = await createAnonymousPlayer(`GMV2 scene player ${Date.now()}`);
  const playerId = created.entity_id;
  const sessionId = `gmv2-scene-${playerId}`;
  await seedSession(sessionId, playerId);

  const locationRows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES (
       'location',
       'GMV2 scene Port',
       'A bright port for scene state tests.',
       '{"source_slug":"gmv2-scene-port"}'::jsonb,
       ARRAY['location'],
       'gmv2-scene-test'
     )
     RETURNING id`,
  );
  const npcRows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES (
       'person',
       'GMV2 scene Tessa Wrenlight',
       'A witness in the port standoff.',
       '{"source_slug":"tessa-wrenlight"}'::jsonb,
       ARRAY['person'],
       'gmv2-scene-test'
     )
     RETURNING id`,
  );
  const sceneRows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES (
       'scene',
       'GMV2 scene Port Standoff',
       'An authored port standoff.',
       '{"source_slug":"gmv2-scene-port-standoff","location_slug":"gmv2-scene-port"}'::jsonb,
       ARRAY['scene'],
       'gmv2-scene-test'
     )
     RETURNING id`,
  );
  const locationId = Number(locationRows[0]!.id);
  const npcId = Number(npcRows[0]!.id);
  const sceneId = Number(sceneRows[0]!.id);

  await queryRows(
    `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
    [locationId, playerId],
  );

  await queryRows(
    `INSERT INTO cartridge_meta_scoped
       (cartridge_id, key, value, description)
     VALUES (
       'gmv2-scene-test',
       'forge_scene_instructions',
       $1::jsonb,
       'gmv2 scene test bridge'
     )
     ON CONFLICT (cartridge_id, key)
     DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        schema_version: 'greenhaven.scene_instructions.v1',
        source_project: 'gmv2-scene-test',
        rows: [
          {
            scene_slug: 'gmv2-scene-port-standoff',
            scene_mention: '@GMV2 Scene Port Standoff',
            source_kind: 'scene',
            source_path: 'Locations/@Port/scenes/@Port Standoff.md',
            location_slug: 'gmv2-scene-port',
            owner_npc_slug: 'tessa-wrenlight',
            participant_slugs: ['tessa-wrenlight'],
            trigger: 'The hero notices Tessa being cornered.',
            priority: 'high',
            hook: 'A dockside witness is being pressured.',
            beat_by_beat: '- Tessa locks eyes with the hero.\n- The dockers close in.',
            player_choices: '- Watch quietly.\n- Shield Tessa.\n- Threaten the dockers.',
            memory_and_string_changes:
              '- @Tessa Wrenlight: +strings for being protected.\n- Status: @Tessa Wrenlight trust = protected witness, intensity=0.7.',
            success_result: 'Tessa escapes with the ledger page.',
            failure_result: 'The dockers scatter the witness and hide the page.',
            behavior: 'Keep pressure high and choices concrete.',
            do_not: 'Do not skip the witness choice.',
            voice: 'Bright danger, fast dockside rhythm.',
            model_instructions: ['Ask for one concrete choice.'],
            state_fields: [
              {
                key: 'gmv2-scene-port-standoff_seen',
                type: 'bool',
                default: false,
                scope: 'permanent',
                description: 'Whether the authored scene was opened.',
              },
              {
                key: 'dockers_pressure',
                type: 'int',
                default: 1,
                scope: 'session',
                description: 'Pressure from the dockers.',
              },
            ],
            visual_asset: null,
          },
        ],
      }),
    ],
  );

  clearMetaCache();
  clearSceneInstructionBridgeCache();
  return {playerId, sessionId, locationId, npcId, sceneId};
}

describe('authored scene state tools', () => {
  it('opens, chooses, closes, and applies authored scene memory plus strings', async () => {
    const seeded = await seedScene();

    const open = (await runWithContext(
      {
        sessionId: seeded.sessionId,
        playerId: seeded.playerId,
        turnId: 'turn-scene-open',
      },
      () =>
        getTool('open_authored_scene').execute(
          {
            scene_slug: 'gmv2-scene-port-standoff',
            evidence: 'player inspected the port standoff hook',
          },
          {
            sessionId: seeded.sessionId,
            playerId: seeded.playerId,
            turnId: 'turn-scene-open',
          },
        ),
    )) as {
      ok: boolean;
      scene_entity_id: number;
      choices: string[];
      state_fields_initialized: number;
    };

    expect(open.ok).toBe(true);
    expect(open.scene_entity_id).toBe(seeded.sceneId);
    expect(open.choices).toContain('Shield Tessa.');
    expect(open.state_fields_initialized).toBe(2);

    const playerOpen = await queryRows<{
      current_scene_id: number | null;
      active: Record<string, unknown> | null;
    }>(
      `SELECT current_scene_id,
              metadata->'active_authored_scene' AS active
         FROM players
        WHERE entity_id = $1`,
      [seeded.playerId],
    );
    expect(Number(playerOpen[0]!.current_scene_id)).toBe(seeded.sceneId);
    expect(playerOpen[0]!.active?.['scene_slug']).toBe(
      'gmv2-scene-port-standoff',
    );

    const seen = await queryRows<{value: boolean}>(
      `SELECT rv.value
         FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1
          AND rf.field_key = 'gmv2-scene-port-standoff_seen'`,
      [seeded.sceneId],
    );
    expect(seen[0]!.value).toBe(true);

    const choice = (await runWithContext(
      {
        sessionId: seeded.sessionId,
        playerId: seeded.playerId,
        turnId: 'turn-scene-choice',
      },
      () =>
        getTool('choose_authored_scene_option').execute(
          {
            choice_number: 2,
            evidence: 'player explicitly shielded Tessa',
          },
          {
            sessionId: seeded.sessionId,
            playerId: seeded.playerId,
            turnId: 'turn-scene-choice',
          },
        ),
    )) as {
      ok: boolean;
      choice_text: string;
      selected_choice_count: number;
    };

    expect(choice.ok).toBe(true);
    expect(choice.choice_text).toBe('Shield Tessa.');
    expect(choice.selected_choice_count).toBe(1);

    const close = (await runWithContext(
      {
        sessionId: seeded.sessionId,
        playerId: seeded.playerId,
        turnId: 'turn-scene-close',
      },
      () =>
        getTool('close_authored_scene').execute(
          {
            result: 'success',
            evidence: 'player protected the witness and resolved the scene',
          },
          {
            sessionId: seeded.sessionId,
            playerId: seeded.playerId,
            turnId: 'turn-scene-close',
          },
        ),
    )) as {
      ok: boolean;
      result: string;
      memory_id: number;
      string_deltas: Array<{npcId: number; delta: number; newValue: number}>;
      status_changes: Array<{
        actorId: number;
        actorName: string;
        statusKind: string;
        statusValue: string;
        intensity: number;
      }>;
      selected_choice_count: number;
    };

    expect(close.ok).toBe(true);
    expect(close.result).toBe('success');
    expect(close.memory_id).toBeGreaterThan(0);
    expect(close.selected_choice_count).toBe(1);
    expect(close.string_deltas).toEqual([
      {npcId: seeded.npcId, npcName: 'GMV2 scene Tessa Wrenlight', delta: 1, newValue: 1},
    ]);
    expect(close.status_changes).toEqual([
      {
        actorId: seeded.npcId,
        actorName: 'GMV2 scene Tessa Wrenlight',
        statusKind: 'trust',
        statusValue: 'protected witness',
        intensity: 0.7,
      },
    ]);

    const playerClosed = await queryRows<{
      current_scene_id: number | null;
      active: unknown;
      last: Record<string, unknown> | null;
    }>(
      `SELECT current_scene_id,
              metadata->'active_authored_scene' AS active,
              metadata->'last_authored_scene' AS last
         FROM players
        WHERE entity_id = $1`,
      [seeded.playerId],
    );
    expect(playerClosed[0]!.current_scene_id).toBeNull();
    expect(playerClosed[0]!.active).toBeNull();
    expect(playerClosed[0]!.last?.['result']).toBe('success');

    const strings = await queryRows<{value: Record<string, number>}>(
      `SELECT rv.value
         FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = 'strings'`,
      [seeded.npcId],
    );
    expect(strings[0]!.value[String(seeded.playerId)]).toBe(1);
    const status = await queryRows<{status_value: string; intensity: number | string}>(
      `SELECT status_value, intensity
         FROM actor_statuses
        WHERE player_id = $1
          AND actor_entity_id = $2
          AND status_kind = 'trust'`,
      [seeded.playerId, seeded.npcId],
    );
    expect(status[0]!.status_value).toBe('protected witness');
    expect(Number(status[0]!.intensity)).toBe(0.7);

    const memory = await queryRows<{text: string; source_tool: string}>(
      `SELECT text, source_tool
         FROM npc_memories
        WHERE id = $1`,
      [close.memory_id],
    );
    expect(memory[0]!.source_tool).toBe('close_authored_scene');
    expect(memory[0]!.text).toContain('closed as success');

    const events = await queryRows<{event_type: string}>(
      `SELECT event_type
         FROM gui_events
        WHERE session_id = $1
        ORDER BY id ASC`,
      [seeded.sessionId],
    );
    expect(events.map(event => event.event_type)).toEqual([
      'scene:opened',
      'scene:choice_selected',
      'actor:status_changed',
      'scene:closed',
    ]);
  });
});
