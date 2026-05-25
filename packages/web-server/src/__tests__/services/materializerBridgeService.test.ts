/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `MaterializerBridgeService` contract.
//
// Pins the read layer that joins the `forge_materializer_bridge`
// cartridge_meta document with `entities.profile->>'source_slug'`:
//
//   * the bridge is unavailable until the meta row is seeded;
//   * `listMaterializerEntries` returns every authored row with
//     source / target entity ids resolved when their slugs exist
//     in the runtime;
//   * `findMaterializerEntry` resolves an id into one entry or
//     `null`;
//   * an `@Mention` lifted from `scope` carries its resolved
//     `entityId` when the slug exists, `null` otherwise;
//   * unresolved source slugs surface as `sourceEntityId: null` so
//     the tool layer can reject the row instead of fabricating an
//     entity id.

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

let MaterializerBridgeService: typeof import('../../services/MaterializerBridgeService.js');
let cartridgeCache: typeof import('../../cartridge.js');

beforeAll(async () => {
  await setupTurnTestEnvironment();
  MaterializerBridgeService = await import(
    '../../services/MaterializerBridgeService.js'
  );
  cartridgeCache = await import('../../cartridge.js');
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  // Migration 0122 seeds canonical `forge_materializer_bridge` into
  // every fresh-migration fixture. Clear it before each case so the
  // `bridge missing` assertions are deterministic; seeded happy-path
  // tests re-insert their own meta row with `ON CONFLICT DO UPDATE`.
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_materializer_bridge'`,
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
    `DELETE FROM entities WHERE display_name LIKE 'OWV-17 materializer %'`,
  );
});

async function seedMaterializerBridge(rows: unknown[]): Promise<void> {
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('forge_materializer_bridge', $1::jsonb, 'OWV-17 materializer test seed')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        schema_version: 'greenhaven.materializers.v1',
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
    `INSERT INTO entities (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES ($1, $2, '', $3::jsonb, ARRAY[$1], 'quickgrin-lane')
     RETURNING id`,
    [kind, displayName, JSON.stringify({source_slug: slug})],
  );
  return Number(rows[0]!.id);
}

describe('MaterializerBridgeService (OWV-17)', () => {
  it('reports no entries when the bridge meta is missing', async () => {
    const entries = await MaterializerBridgeService.listMaterializerEntries();
    expect(entries).toEqual([]);
    expect(
      await MaterializerBridgeService.isMaterializerBridgeAvailable(),
    ).toBe(false);
  });

  it('lists rows with resolved source + target ids', async () => {
    // Unique OWV-17-prefixed slugs so we don't collide with the
    // canonical `mikka` / `town-square` / `thiefs-market` entities
    // the migration seeds populate into the fixture DB.
    const sourceId = await seedEntity(
      'person',
      'owv17-mat-mikka',
      'OWV-17 materializer Mikka',
    );
    const townId = await seedEntity(
      'location',
      'owv17-mat-town',
      'OWV-17 materializer Town square',
    );
    const marketId = await seedEntity(
      'location',
      'owv17-mat-market',
      "OWV-17 materializer Thief's market",
    );
    cartridgeCache.clearMetaCache();
    MaterializerBridgeService.clearMaterializerBridgeCache();
    await seedMaterializerBridge([
      {
        materializer_id: 'hidden01',
        source_slug: 'owv17-mat-mikka',
        source_mention: '@OWV17 mat Mikka',
        source_kind: 'person',
        source_path: 'x.md',
        entity: '@OWV17 mat market',
        entity_slug: 'owv17-mat-market',
        target_status: 'existing',
        type: 'location/hidden-exit',
        scope: '@OWV17 mat town',
        effect: 'opens hatch.',
      },
    ]);
    cartridgeCache.clearMetaCache();
    MaterializerBridgeService.clearMaterializerBridgeCache();
    const entries = await MaterializerBridgeService.listMaterializerEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.materializerId).toBe('hidden01');
    expect(entry.sourceEntityId).toBe(sourceId);
    expect(entry.targetEntityId).toBe(marketId);
    expect(entry.scopeMentions).toHaveLength(1);
    expect(entry.scopeMentions[0]!.slug).toBe('owv17-mat-town');
    expect(entry.scopeMentions[0]!.entityId).toBe(townId);
  });

  it('findMaterializerEntry returns null for unknown ids', async () => {
    await seedMaterializerBridge([
      {
        materializer_id: 'aaa111',
        source_slug: 'owv17-mat-mikka',
        source_mention: '@OWV17 mat Mikka',
        source_kind: 'person',
        source_path: 'x.md',
        entity: '@Thing',
        entity_slug: 'owv17-mat-thing',
        target_status: 'existing',
        type: 'state/service',
        scope: 'between @OWV17 mat Mikka and the hero',
        effect: 'mikka companions hero.',
      },
    ]);
    cartridgeCache.clearMetaCache();
    MaterializerBridgeService.clearMaterializerBridgeCache();
    const entry = await MaterializerBridgeService.findMaterializerEntry(
      'does-not-exist',
    );
    expect(entry).toBeNull();
  });

  it('OBSIDIAN-VAULT-IMPORT-2 — scoped read shadows the legacy global row and caches per cartridge', async () => {
    // Seed a cartridges row so the cartridge_meta_scoped FK satisfies.
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version, source_kind, content_hash)
       VALUES ('scoped-mat', 'scoped-mat', '1.0.0', 'greenhaven.cartridge.v1', 'builtin', 'scoped-mat')
       ON CONFLICT (id) DO NOTHING`,
    );
    // Legacy global row — one materializer named `from-global`.
    await seedMaterializerBridge([
      {
        materializer_id: 'from-global',
        source_slug: 'phantom-source',
        source_mention: '@Phantom source',
        source_kind: 'person',
        source_path: 'g.md',
        entity: '@Thing',
        entity_slug: 'phantom-target',
        target_status: 'new',
        type: 'state/service',
        scope: '@Phantom source',
        effect: 'from global.',
      },
    ]);
    // Scoped row for cartridge `scoped-mat` — different id.
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
       VALUES ('scoped-mat', 'forge_materializer_bridge', $1::jsonb, 'OBSIDIAN-VAULT-IMPORT-2 scoped test seed')
       ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          schema_version: 'greenhaven.materializers.v1',
          source_project: 'scoped-mat',
          rows: [
            {
              materializer_id: 'from-scoped',
              source_slug: 'phantom-source',
              source_mention: '@Phantom source',
              source_kind: 'person',
              source_path: 's.md',
              entity: '@Thing',
              entity_slug: 'phantom-target',
              target_status: 'new',
              type: 'state/service',
              scope: '@Phantom source',
              effect: 'from scoped.',
            },
          ],
        }),
      ],
    );
    cartridgeCache.clearMetaCache();
    MaterializerBridgeService.clearMaterializerBridgeCache();
    const scoped = await MaterializerBridgeService.listMaterializerEntries({
      cartridgeId: 'scoped-mat',
    });
    expect(scoped.map(e => e.materializerId)).toEqual(['from-scoped']);
    const legacy = await MaterializerBridgeService.listMaterializerEntries();
    expect(legacy.map(e => e.materializerId)).toEqual(['from-global']);
    await queryRows(
      `DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'scoped-mat'`,
    );
    await queryRows(`DELETE FROM cartridges WHERE id = 'scoped-mat'`);
  });

  it('OBSIDIAN-VAULT-IMPORT-2 — scoped tombstone shadows the legacy global row', async () => {
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version, source_kind, content_hash)
       VALUES ('tomb-mat', 'tomb-mat', '1.0.0', 'greenhaven.cartridge.v1', 'builtin', 'tomb-mat')
       ON CONFLICT (id) DO NOTHING`,
    );
    await seedMaterializerBridge([
      {
        materializer_id: 'global-only',
        source_slug: 'phantom-source',
        source_mention: '@Phantom source',
        source_kind: 'person',
        source_path: 'g.md',
        entity: '@Thing',
        entity_slug: 'phantom-target',
        target_status: 'new',
        type: 'state/service',
        scope: '@Phantom source',
        effect: 'legacy.',
      },
    ]);
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
       VALUES ('tomb-mat', 'forge_materializer_bridge', $1::jsonb, 'OBSIDIAN-VAULT-IMPORT-2 tombstone test seed')
       ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          schema_version: 'greenhaven.materializers.v1',
          source_project: 'tomb-mat',
          rows: [],
        }),
      ],
    );
    cartridgeCache.clearMetaCache();
    MaterializerBridgeService.clearMaterializerBridgeCache();
    const entries = await MaterializerBridgeService.listMaterializerEntries({
      cartridgeId: 'tomb-mat',
    });
    expect(entries).toEqual([]);
    expect(
      await MaterializerBridgeService.isMaterializerBridgeAvailable({
        cartridgeId: 'tomb-mat',
      }),
    ).toBe(false);
    await queryRows(
      `DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'tomb-mat'`,
    );
    await queryRows(`DELETE FROM cartridges WHERE id = 'tomb-mat'`);
  });

  it('leaves source/target entity ids null when no entity has the source_slug', async () => {
    await seedMaterializerBridge([
      {
        materializer_id: 'orphan',
        source_slug: 'phantom-source',
        source_mention: '@Phantom source',
        source_kind: 'person',
        source_path: 'x.md',
        entity: '@Phantom target',
        entity_slug: 'phantom-target',
        target_status: 'new',
        type: 'state/service',
        scope: 'between @Phantom source and the hero',
        effect: 'never resolves.',
      },
    ]);
    cartridgeCache.clearMetaCache();
    MaterializerBridgeService.clearMaterializerBridgeCache();
    const entry = await MaterializerBridgeService.findMaterializerEntry(
      'orphan',
    );
    expect(entry).not.toBeNull();
    expect(entry!.sourceEntityId).toBeNull();
    expect(entry!.targetEntityId).toBeNull();
    expect(entry!.scopeMentions[0]!.entityId).toBeNull();
  });
});
