/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `SceneInstructionBridgeService` contract.
//
//   * the bridge is unavailable until the meta row is seeded;
//   * a wrong `schema_version` is a no-op (defensive guard);
//   * resolved rows expose `locationEntityId`, `ownerNpcEntityId`,
//     and `participantEntityIds` from `entities.profile->>'source_slug'`;
//   * `listRelevantSceneInstructions` dedupes across the three
//     anchor axes, sorts `high > normal > low` then by slug, and
//     honours the `limit` cap.

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

let SceneInstructionBridgeService: typeof import('../../services/SceneInstructionBridgeService.js');
let cartridgeCache: typeof import('../../cartridge.js');

beforeAll(async () => {
  await setupTurnTestEnvironment();
  SceneInstructionBridgeService = await import(
    '../../services/SceneInstructionBridgeService.js'
  );
  cartridgeCache = await import('../../cartridge.js');
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  // Migration 0122 seeds canonical `forge_scene_instructions` into
  // every fresh-migration fixture. Tests in this file must start
  // each case with an explicitly empty bridge so the
  // `bridge missing` assertions are deterministic regardless of the
  // migration-baked-in payload. Seeded happy-path tests re-insert
  // their own meta row with `ON CONFLICT DO UPDATE` after this.
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_scene_instructions'`,
  );
  await queryRows(
    `INSERT INTO cartridges
       (id, title, version, schema_version, source_kind, content_hash, manifest)
     VALUES (
       'owv17-scene-test',
       'OWV-17 Scene Test',
       '0.0.0',
       'test',
       'builtin',
       'owv17-scene-test',
       '{}'::jsonb
     )
     ON CONFLICT (id) DO NOTHING`,
  );
  cartridgeCache.clearMetaCache();
  SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
});

afterEach(async () => {
  cartridgeCache.clearMetaCache();
  SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_scene_instructions'`,
  );
  await queryRows(
    `DELETE FROM entities WHERE display_name LIKE 'OWV-17 scene %'`,
  );
  await queryRows(`DELETE FROM cartridges WHERE id = 'owv17-scene-test'`);
});

async function seedSceneInstructionsBridge(rows: unknown[]): Promise<void> {
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('forge_scene_instructions', $1::jsonb, 'OWV-17 scene-instructions test seed')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        schema_version: 'greenhaven.scene_instructions.v1',
        source_project: 'owv17-test',
        rows,
      }),
    ],
  );
}

async function seedEntity(
  kind: string,
  slug: string,
  displayName: string,
): Promise<number> {
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES ($1, $2, '', $3::jsonb, ARRAY[$1], 'owv17-scene-test')
     RETURNING id`,
    [kind, displayName, JSON.stringify({source_slug: slug})],
  );
  return Number(rows[0]!.id);
}

describe('SceneInstructionBridgeService (OWV-17)', () => {
  it('reports no entries when the bridge meta is missing', async () => {
    expect(
      await SceneInstructionBridgeService.isSceneInstructionBridgeAvailable(),
    ).toBe(false);
    expect(
      await SceneInstructionBridgeService.listSceneInstructionEntries(),
    ).toEqual([]);
    expect(
      await SceneInstructionBridgeService.listRelevantSceneInstructions({
        locationId: 1,
      }),
    ).toEqual([]);
  });

  it('skips rows with a wrong schema_version', async () => {
    await queryRows(
      `INSERT INTO cartridge_meta (key, value, description) VALUES
         ('forge_scene_instructions', $1::jsonb, 'OWV-17 scene-instructions guard')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          schema_version: 'unknown.future.v999',
          source_project: 'owv17-test',
          rows: [{scene_slug: 'will-be-skipped', source_path: 'x.md'}],
        }),
      ],
    );
    cartridgeCache.clearMetaCache();
    SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
    expect(
      await SceneInstructionBridgeService.listSceneInstructionEntries(),
    ).toEqual([]);
    expect(
      await SceneInstructionBridgeService.isSceneInstructionBridgeAvailable(),
    ).toBe(false);
  });

  it('resolves location, owner, and participant slugs to entity ids', async () => {
    const marketId = await seedEntity(
      'location',
      'owv17-scene-market',
      'OWV-17 scene Market',
    );
    const sableId = await seedEntity(
      'person',
      'owv17-scene-sable',
      'OWV-17 scene Sable',
    );
    const mikkaId = await seedEntity(
      'person',
      'owv17-scene-mikka',
      'OWV-17 scene Mikka',
    );
    cartridgeCache.clearMetaCache();
    SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
    await seedSceneInstructionsBridge([
      {
        scene_slug: 'first-descent',
        scene_mention: '@First descent',
        source_kind: 'scene',
        source_path: 'A.md',
        location_slug: 'owv17-scene-market',
        owner_npc_slug: null,
        participant_slugs: ['owv17-scene-sable', 'owv17-scene-mikka'],
        priority: 'normal',
        hook: 'A market bell rings once.',
        beat_by_beat: '1. Descend.\n2. Name a sponsor.',
        player_choices: '- Listen.\n- Ask for a sponsor.',
        memory_and_string_changes: '- @OWV-17 scene Sable: +strings for listening.',
        success_result: 'The market lets the hero enter under watch.',
        failure_result: 'The lanterns turn red.',
        trigger: 't',
        behavior: 'b',
        do_not: 'd',
        voice: '',
        model_instructions: ['mi'],
        state_fields: [],
        visual_asset: null,
      },
    ]);
    cartridgeCache.clearMetaCache();
    SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
    const entries =
      await SceneInstructionBridgeService.listSceneInstructionEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.locationEntityId).toBe(marketId);
    expect(entries[0]!.ownerNpcEntityId).toBeNull();
    expect(entries[0]!.participantEntityIds).toEqual(
      expect.arrayContaining([sableId, mikkaId]),
    );
    expect(entries[0]!.playerChoices).toContain('Ask for a sponsor');
    expect(entries[0]!.memoryAndStringChanges).toContain('+strings');
    expect(
      await SceneInstructionBridgeService.isSceneInstructionBridgeAvailable(),
    ).toBe(true);
  });

  it('OWV-9 — surfaces companion do_not constraints verbatim (priority high anchors the cohort)', async () => {
    // The live Mikka violence-starts scene authors `do_not:` as
    // "не заставлять @Mikka успокаивать героя как generic companion"
    // and `priority: высокий` so the broker sees the constraint
    // before the generic-companion chains. The bridge must:
    //   * carry the `do_not` text through unchanged, and
    //   * sort `priority: high` rows ahead of `normal` rows that
    //     share the same anchor (location + owner).
    const townId = await seedEntity(
      'location',
      'owv17-scene-square-9',
      'OWV-17 scene Town Square 9',
    );
    const mikkaId = await seedEntity(
      'person',
      'owv17-scene-mikka-9',
      'OWV-17 scene Mikka 9',
    );
    cartridgeCache.clearMetaCache();
    SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
    await seedSceneInstructionsBridge([
      {
        scene_slug: 'mikka-first-glance-9',
        scene_mention: '@Mikka first glance 9',
        source_kind: 'scene',
        source_path: 'A.md',
        location_slug: 'owv17-scene-square-9',
        owner_npc_slug: 'owv17-scene-mikka-9',
        participant_slugs: ['owv17-scene-mikka-9'],
        priority: 'normal',
        trigger: '',
        behavior: '',
        do_not: '',
        voice: '',
        model_instructions: [],
        state_fields: [],
        visual_asset: null,
      },
      {
        scene_slug: 'mikka-violence-starts-9',
        scene_mention: '@Mikka violence starts 9',
        source_kind: 'scene',
        source_path: 'B.md',
        location_slug: 'owv17-scene-square-9',
        owner_npc_slug: 'owv17-scene-mikka-9',
        participant_slugs: ['owv17-scene-mikka-9'],
        priority: 'high',
        trigger: '',
        behavior: 'Mikka uchodit iz linii udara.',
        do_not:
          'Ne zastavljat’ @Mikka uspokaivat’ geroja kak generic companion.',
        voice: '',
        model_instructions: [],
        state_fields: [],
        visual_asset: null,
      },
    ]);
    cartridgeCache.clearMetaCache();
    SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
    const sorted =
      await SceneInstructionBridgeService.listRelevantSceneInstructions({
        locationId: townId,
        focusedNpcId: mikkaId,
      });
    // `priority: high` row leads the cohort even though it sorts
    // after the `normal` row by slug.
    expect(sorted[0]?.sceneSlug).toBe('mikka-violence-starts-9');
    expect(sorted[0]?.priority).toBe('high');
    expect(sorted[0]?.doNot).toContain('generic companion');
  });

  it('preserves cartridge media_script commands for runtime scene music', async () => {
    await seedSceneInstructionsBridge([
      {
        scene_slug: 'music-scene',
        scene_mention: '@Music scene',
        source_kind: 'scene',
        source_path: 'Music.md',
        location_slug: null,
        owner_npc_slug: null,
        participant_slugs: [],
        priority: 'normal',
        trigger: '',
        behavior: '',
        do_not: '',
        voice: '',
        model_instructions: [],
        state_fields: [],
        visual_asset: null,
        media_script: [
          {
            action: 'play',
            asset_role: 'music_port_theme',
            label: 'Port Theme',
            loop: true,
            volume: 0.65,
          },
          {
            action: 'show',
            asset_role: 'scene_plate',
            title: 'The torn ledger',
            caption: 'Wax seal and blue thread.',
            alt: 'A torn ledger page.',
          },
          {action: 'stop'},
        ],
      },
    ]);
    cartridgeCache.clearMetaCache();
    SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
    const entries =
      await SceneInstructionBridgeService.listSceneInstructionEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.mediaScript).toEqual([
      {
        action: 'play',
        asset_role: 'music_port_theme',
        label: 'Port Theme',
        loop: true,
        volume: 0.65,
      },
      {
        action: 'show',
        asset_role: 'scene_plate',
        title: 'The torn ledger',
        caption: 'Wax seal and blue thread.',
        alt: 'A torn ledger page.',
      },
      {action: 'stop'},
    ]);
  });

  it('listRelevantSceneInstructions dedupes, sorts by priority, and honours the limit', async () => {
    const townId = await seedEntity(
      'location',
      'owv17-scene-town',
      'OWV-17 scene Town',
    );
    const mikkaId = await seedEntity(
      'person',
      'owv17-scene-mikka2',
      'OWV-17 scene Mikka2',
    );
    cartridgeCache.clearMetaCache();
    SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
    await seedSceneInstructionsBridge([
      {
        scene_slug: 'low-priority-tour',
        scene_mention: '@Low tour',
        source_kind: 'scene',
        source_path: 'A.md',
        location_slug: 'owv17-scene-town',
        owner_npc_slug: null,
        participant_slugs: [],
        priority: 'low',
        trigger: '',
        behavior: '',
        do_not: '',
        voice: '',
        model_instructions: [],
        state_fields: [],
        visual_asset: null,
      },
      {
        scene_slug: 'mikka-combat',
        scene_mention: '@Mikka combat',
        source_kind: 'scene',
        source_path: 'B.md',
        location_slug: 'owv17-scene-town',
        owner_npc_slug: 'owv17-scene-mikka2',
        participant_slugs: ['owv17-scene-mikka2'],
        priority: 'high',
        trigger: '',
        behavior: '',
        do_not: '',
        voice: '',
        model_instructions: [],
        state_fields: [],
        visual_asset: null,
      },
      {
        scene_slug: 'mikka-talk',
        scene_mention: '@Mikka talk',
        source_kind: 'scene',
        source_path: 'C.md',
        location_slug: 'owv17-scene-town',
        owner_npc_slug: 'owv17-scene-mikka2',
        participant_slugs: ['owv17-scene-mikka2'],
        priority: 'normal',
        trigger: '',
        behavior: '',
        do_not: '',
        voice: '',
        model_instructions: [],
        state_fields: [],
        visual_asset: null,
      },
    ]);
    cartridgeCache.clearMetaCache();
    SceneInstructionBridgeService.clearSceneInstructionBridgeCache();
    const sorted =
      await SceneInstructionBridgeService.listRelevantSceneInstructions({
        locationId: townId,
        focusedNpcId: mikkaId,
      });
    expect(sorted.map(r => r.sceneSlug)).toEqual([
      'mikka-combat',
      'mikka-talk',
      'low-priority-tour',
    ]);
    // Dedupe: mikka rows appear via both owner and location anchors,
    // but only once each.
    const slugCounts = new Map<string, number>();
    for (const r of sorted) {
      slugCounts.set(r.sceneSlug, (slugCounts.get(r.sceneSlug) ?? 0) + 1);
    }
    expect([...slugCounts.values()]).toEqual([1, 1, 1]);
    // Limit cap.
    const capped =
      await SceneInstructionBridgeService.listRelevantSceneInstructions({
        locationId: townId,
        focusedNpcId: mikkaId,
        limit: 2,
      });
    expect(capped.map(r => r.sceneSlug)).toEqual([
      'mikka-combat',
      'mikka-talk',
    ]);
  });
});
