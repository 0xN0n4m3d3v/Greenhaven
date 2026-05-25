/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-3 — `CartridgeImportApplyService` contract.
//
// Drives the full apply pipeline against PGlite so the real
// `withTransaction` boundary, real `cartridge_records` /
// `cartridge_install_cache` writes, and the dynamic-origin
// guard are exercised end-to-end.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

interface ImportJobView {
  jobId: string;
  status: string;
  result: {
    cartridgeId: string | null;
    totalRecords: number;
    contentHash: string;
    applyResult?: {
      diff: {
        new: number;
        changed: number;
        unchanged: number;
        deprecated: number;
        blocked: number;
      };
      blockedRecordIds: string[];
      deprecatedRecordIds: string[];
    };
  } | null;
  error: {code: string; message: string} | null;
}

let CartridgeImportPreviewService: typeof import('../../services/CartridgeImportPreviewService.js').CartridgeImportPreviewService;
let CartridgeImportApplyService: typeof import('../../services/CartridgeImportApplyService.js').CartridgeImportApplyService;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({CartridgeImportPreviewService} = await import(
    '../../services/CartridgeImportPreviewService.js'
  ));
  ({CartridgeImportApplyService} = await import(
    '../../services/CartridgeImportApplyService.js'
  ));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

let TMP_FIXTURES: string[] = [];

beforeEach(async () => {
  // Each test starts on a fresh apply target by clearing the rows
  // we own. We never touch `entities` rows we did not create here.
  await queryRows(
    `DELETE FROM location_intro_bubbles
      WHERE location_entity_id IN (
        SELECT id FROM entities WHERE cartridge_id LIKE 'cart-apply-test-%'
      )`,
  );
  await queryRows(
    `DELETE FROM cartridge_records WHERE cartridge_id LIKE 'cart-apply-test-%'`,
  );
  await queryRows(
    `DELETE FROM cartridge_install_cache WHERE cartridge_id LIKE 'cart-apply-test-%'`,
  );
  await queryRows(
    `DELETE FROM cartridge_import_runs WHERE cartridge_id LIKE 'cart-apply-test-%'`,
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE cartridge_id LIKE 'cart-apply-test-%'`,
  );
  // Note: we delete cartridges last because of FK dependencies above.
  await queryRows(
    `DELETE FROM cartridges WHERE id LIKE 'cart-apply-test-%'`,
  );
});

afterAll(async () => {
  for (const dir of TMP_FIXTURES) {
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
});

async function makeForgeProject(opts: {
  cartridgeId: string;
  records: Array<{
    recordId: string;
    kind: string;
    slug: string;
    canonicalName: string;
    summary?: string;
    tags?: string[];
    extra?: Record<string, unknown>;
  }>;
}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cart-apply-fixture-'));
  TMP_FIXTURES.push(dir);
  await mkdir(path.join(dir, 'records'), {recursive: true});
  await writeFile(
    path.join(dir, 'forge.project.json'),
    JSON.stringify({
      schema_version: 'greenhaven.cartridge_forge_project.v1',
      project_slug: opts.cartridgeId,
      pack_slug: opts.cartridgeId,
      target_cartridge_id: opts.cartridgeId,
      title: `Apply Test ${opts.cartridgeId}`,
      version: '0.1.0',
    }),
  );
  const byKind = new Map<string, string[]>();
  for (const r of opts.records) {
    const row = JSON.stringify({
      record_id: r.recordId,
      kind: r.kind,
      slug: r.slug,
      canonical_name: r.canonicalName,
      summary: r.summary ?? '',
      tags: r.tags ?? [r.kind],
      payload: {canonical_mention: '@' + r.canonicalName, ...(r.extra ?? {})},
    });
    const list = byKind.get(r.kind) ?? [];
    list.push(row);
    byKind.set(r.kind, list);
  }
  for (const [kind, lines] of byKind) {
    await writeFile(
      path.join(dir, 'records', `${kind}s.jsonl`),
      lines.join('\n') + '\n',
    );
  }
  return dir;
}

async function previewToReady(
  sourcePath: string,
  timeoutMs = 8_000,
): Promise<ImportJobView> {
  const created = await CartridgeImportPreviewService.createJob({
    sourceKind: 'forge_project',
    sourcePath,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    const next = (await CartridgeImportPreviewService.getJob(
      created.jobId,
    )) as ImportJobView | null;
    if (next && (next.status === 'ready' || next.status === 'failed')) {
      return next;
    }
  }
  throw new Error('preview did not reach ready');
}

describe('CartridgeImportApplyService (FEAT-CART-LIB-3)', () => {
  it('initial apply writes cartridges + records + install cache + scoped meta', async () => {
    const cartridgeId = 'cart-apply-test-initial';
    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:initial:square',
          kind: 'location',
          slug: 'square',
          canonicalName: 'Test Square',
        },
        {
          recordId: 'rec:initial:mira',
          kind: 'person',
          slug: 'mira',
          canonicalName: 'Test Mira',
        },
      ],
    });
    const preview = await previewToReady(fixture);
    expect(preview.status).toBe('ready');
    const applied = (await CartridgeImportApplyService.apply({
      jobId: preview.jobId,
    })) as unknown as ImportJobView;
    expect(applied.status).toBe('applied');
    expect(applied.result?.applyResult?.diff).toEqual({
      new: 2,
      changed: 0,
      unchanged: 0,
      deprecated: 0,
      blocked: 0,
    });

    const cart = await queryRows<{id: string; content_hash: string}>(
      `SELECT id, content_hash FROM cartridges WHERE id = $1`,
      [cartridgeId],
    );
    expect(cart[0]?.id).toBe(cartridgeId);
    expect(cart[0]?.content_hash).toMatch(/^sha256:/);

    const records = await queryRows<{record_id: string; status: string}>(
      `SELECT record_id, status FROM cartridge_records
        WHERE cartridge_id = $1 ORDER BY record_id`,
      [cartridgeId],
    );
    expect(records.map((r) => r.record_id)).toEqual([
      'rec:initial:mira',
      'rec:initial:square',
    ]);
    expect(records.every((r) => r.status === 'active')).toBe(true);

    const cache = await queryRows<{state: string; record_count: number}>(
      `SELECT state, record_count FROM cartridge_install_cache
        WHERE cartridge_id = $1`,
      [cartridgeId],
    );
    expect(cache[0]?.state).toBe('ready'); // not default cartridge
    expect(Number(cache[0]?.record_count)).toBe(2);

    const scoped = await queryRows<{key: string}>(
      `SELECT key FROM cartridge_meta_scoped
        WHERE cartridge_id = $1 ORDER BY key`,
      [cartridgeId],
    );
    expect(scoped.map((r) => r.key)).toContain('cartridge_id');
    expect(scoped.map((r) => r.key)).toContain('cartridge_version');
  });

  it('materializes authored first-entry bubbles into runtime intro rows', async () => {
    const cartridgeId = 'cart-apply-test-first-entry';
    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:first-entry:port',
          kind: 'location',
          slug: 'greenhaven-port',
          canonicalName: 'Greenhaven Port',
          extra: {
            first_entry_bubble:
              'Sunlit sails snap overhead as Greenhaven Port opens around you.',
          },
        },
      ],
    });
    const preview = await previewToReady(fixture);
    const applied = (await CartridgeImportApplyService.apply({
      jobId: preview.jobId,
    })) as unknown as ImportJobView;
    expect(applied.status).toBe('applied');

    const rows = await queryRows<{
      lang: string;
      bubble_text: string;
      source: string;
    }>(
      `SELECT b.lang, b.bubble_text, b.source
         FROM location_intro_bubbles b
         JOIN cartridge_records cr
           ON cr.imported_entity_id = b.location_entity_id
        WHERE cr.cartridge_id = $1
          AND cr.slug = 'greenhaven-port'
        ORDER BY b.lang`,
      [cartridgeId],
    );
    expect(rows).toEqual([
      {
        lang: 'en',
        bubble_text:
          'Sunlit sails snap overhead as Greenhaven Port opens around you.',
        source: 'cartridge_apply:first_entry_bubble',
      },
    ]);
  });

  it('materializes available visual assets into profile URLs and portrait_set', async () => {
    const cartridgeId = 'cart-apply-test-visual-profile';
    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:visual-profile:tamara',
          kind: 'person',
          slug: 'tamara-vey',
          canonicalName: 'Tamara Vey',
        },
        {
          recordId: 'rec:visual-profile:port',
          kind: 'location',
          slug: 'greenhaven-port',
          canonicalName: 'Greenhaven Port',
        },
      ],
    });
    const portraitPath =
      'GreenHavenWorld/Locations/@City/@Port/npc/@Tamara Vey/portraits/default.png';
    const locationPath =
      'GreenHavenWorld/Locations/@City/@Port/images/establishing.png';
    await mkdir(path.join(fixture, path.dirname(portraitPath)), {
      recursive: true,
    });
    await mkdir(path.join(fixture, path.dirname(locationPath)), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture, portraitPath),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await writeFile(
      path.join(fixture, locationPath),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]),
    );
    await mkdir(path.join(fixture, 'audit'), {recursive: true});
    await writeFile(
      path.join(fixture, 'audit', 'visual-assets.jsonl'),
      [
        JSON.stringify({
          kind: 'person',
          slug: 'tamara-vey',
          role: 'portrait',
          mention: '@Tamara Vey',
          path: portraitPath,
        }),
        JSON.stringify({
          kind: 'location',
          slug: 'greenhaven-port',
          role: 'location_view',
          mention: '@Greenhaven Port',
          path: locationPath,
        }),
      ].join('\n') + '\n',
    );

    const preview = await previewToReady(fixture);
    const applied = (await CartridgeImportApplyService.apply({
      jobId: preview.jobId,
    })) as unknown as ImportJobView;
    expect(applied.status).toBe('applied');

    const rows = await queryRows<{
      kind: string;
      slug: string;
      profile: Record<string, unknown>;
    }>(
      `SELECT cr.kind, cr.slug, e.profile
         FROM cartridge_records cr
         JOIN entities e ON e.id = cr.imported_entity_id
        WHERE cr.cartridge_id = $1
          AND cr.slug IN ('tamara-vey', 'greenhaven-port')
        ORDER BY cr.slug`,
      [cartridgeId],
    );
    const tamara = rows.find((row) => row.slug === 'tamara-vey');
    const port = rows.find((row) => row.slug === 'greenhaven-port');
    expect(tamara?.profile['portrait_set']).toEqual({
      default:
        '/api/assets/cartridges/cart-apply-test-visual-profile/world/person/tamara-vey/portrait',
    });
    expect(tamara?.profile['visual_asset_urls']).toMatchObject({
      portrait:
        '/api/assets/cartridges/cart-apply-test-visual-profile/world/person/tamara-vey/portrait',
    });
    expect(port?.profile['visual_asset_urls']).toMatchObject({
      location_view:
        '/api/assets/cartridges/cart-apply-test-visual-profile/world/location/greenhaven-port/location_view',
    });
  });

  it('removes stale first-entry bubble rows when a reimport omits them', async () => {
    const cartridgeId = 'cart-apply-test-first-entry-removal';
    const v1 = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:first-entry-removal:port',
          kind: 'location',
          slug: 'greenhaven-port',
          canonicalName: 'Greenhaven Port',
          extra: {
            first_entry_bubble:
              'The old intro should not survive a cartridge rewrite.',
          },
        },
      ],
    });
    const preview1 = await previewToReady(v1);
    await CartridgeImportApplyService.apply({jobId: preview1.jobId});

    const v2 = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:first-entry-removal:port',
          kind: 'location',
          slug: 'greenhaven-port',
          canonicalName: 'Greenhaven Port',
          extra: {
            location_canon: 'Same port, but no authored first-entry bubble.',
          },
        },
      ],
    });
    const preview2 = await previewToReady(v2);
    const applied = (await CartridgeImportApplyService.apply({
      jobId: preview2.jobId,
    })) as unknown as ImportJobView;
    expect(applied.status).toBe('applied');

    const rows = await queryRows<{count: string}>(
      `SELECT count(*)::text AS count
         FROM location_intro_bubbles b
         JOIN cartridge_records cr
           ON cr.imported_entity_id = b.location_entity_id
        WHERE cr.cartridge_id = $1
          AND cr.slug = 'greenhaven-port'
          AND b.source = 'cartridge_apply:first_entry_bubble'`,
      [cartridgeId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('resolves Obsidian slug links into runtime ids for exits, NPC presence, scenes, and quest givers', async () => {
    const cartridgeId = 'cart-apply-test-slug-links';
    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:slug:city',
          kind: 'location',
          slug: 'sun-city',
          canonicalName: 'Sun City',
          extra: {
            child_location_slugs: ['greenhaven-port'],
          },
        },
        {
          recordId: 'rec:slug:port',
          kind: 'location',
          slug: 'greenhaven-port',
          canonicalName: 'Greenhaven Port',
          extra: {
            parent_slug: 'sun-city',
            exits: ['harbor-street'],
            resident_npc_slugs: ['tessa-wrenlight'],
            scene_slugs: ['first-word-on-the-pier'],
            quest_slugs: ['watch-the-sunwake-pier'],
          },
        },
        {
          recordId: 'rec:slug:street',
          kind: 'location',
          slug: 'harbor-street',
          canonicalName: 'Harbor Street',
          extra: {
            parent_slug: 'sun-city',
            exits: ['greenhaven-port'],
          },
        },
        {
          recordId: 'rec:slug:tessa',
          kind: 'person',
          slug: 'tessa-wrenlight',
          canonicalName: 'Tessa Wrenlight',
          extra: {
            home_slug: 'greenhaven-port',
          },
        },
        {
          recordId: 'rec:slug:scene',
          kind: 'scene',
          slug: 'first-word-on-the-pier',
          canonicalName: 'First Word On The Pier',
          extra: {
            location_slug: 'greenhaven-port',
            owner_npc_slug: 'tessa-wrenlight',
            participant_slugs: ['tessa-wrenlight'],
          },
        },
        {
          recordId: 'rec:slug:quest',
          kind: 'quest',
          slug: 'watch-the-sunwake-pier',
          canonicalName: 'Watch The Sunwake Pier',
          extra: {
            start_location_slug: 'greenhaven-port',
            giver_slug: 'tessa-wrenlight',
          },
        },
      ],
    });
    const preview = await previewToReady(fixture);
    expect(preview.status).toBe('ready');
    await CartridgeImportApplyService.apply({jobId: preview.jobId});

    const rows = await queryRows<{
      id: number;
      kind: string;
      display_name: string;
      slug: string;
      profile: Record<string, unknown>;
      topology_parent_id: number | null;
    }>(
      `SELECT e.id,
              e.kind,
              e.display_name,
              cr.slug,
              e.profile,
              e.topology_parent_id
         FROM entities e
         JOIN cartridge_records cr ON cr.imported_entity_id = e.id
        WHERE cr.cartridge_id = $1
        ORDER BY cr.slug`,
      [cartridgeId],
    );
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const city = bySlug.get('sun-city')!;
    const port = bySlug.get('greenhaven-port')!;
    const street = bySlug.get('harbor-street')!;
    const tessa = bySlug.get('tessa-wrenlight')!;
    const scene = bySlug.get('first-word-on-the-pier')!;
    const quest = bySlug.get('watch-the-sunwake-pier')!;

    expect(port.topology_parent_id).toBe(city.id);
    expect(street.topology_parent_id).toBe(city.id);
    expect(port.profile['exits']).toEqual([street.id]);
    expect(port.profile['exit_slugs']).toEqual(['harbor-street']);
    expect(tessa.profile['home_id']).toBe(port.id);
    expect(scene.profile['location_id']).toBe(port.id);
    expect(scene.profile['owner_entity_id']).toBe(tessa.id);
    expect(scene.profile['participant_entity_ids']).toEqual([tessa.id]);
    expect(quest.profile['location_id']).toBe(port.id);
    expect(quest.profile['giver_entity_id']).toBe(tessa.id);
    expect(quest.profile['source_entity_id']).toBe(tessa.id);

    const density = port.profile['local_density'] as Record<string, unknown>;
    expect(density['npc_ids']).toContain(tessa.id);
    expect(density['child_location_ids']).toEqual([]);
    expect(density['scene_ids']).toContain(scene.id);
    expect(density['quest_ids']).toContain(quest.id);

    const worldMeta = await queryRows<{key: string; value: number | string}>(
      `SELECT key, value
         FROM cartridge_meta_scoped
        WHERE cartridge_id = $1
          AND key IN ('world_entity_id', 'world_entity_slug')
        ORDER BY key`,
      [cartridgeId],
    );
    expect(worldMeta).toEqual([
      {key: 'world_entity_id', value: city.id},
      {key: 'world_entity_slug', value: 'sun-city'},
    ]);
    const clockFields = await queryRows<{
      field_key: string;
      default_value: unknown;
      value: unknown;
    }>(
      `SELECT rf.field_key, rf.default_value, rv.value
         FROM runtime_fields rf
         LEFT JOIN runtime_values rv ON rv.field_id = rf.id
        WHERE rf.owner_entity_id = $1
          AND rf.field_key IN ('time_of_day', 'weather', 'world_time_minutes')
        ORDER BY rf.field_key`,
      [city.id],
    );
    expect(clockFields.map((row) => row.field_key)).toEqual([
      'time_of_day',
      'weather',
      'world_time_minutes',
    ]);
    expect(clockFields.find((row) => row.field_key === 'time_of_day')?.value)
      .toBe('morning');
    expect(clockFields.find((row) => row.field_key === 'weather')?.value)
      .toBe('clear');
    expect(
      Number(
        clockFields.find((row) => row.field_key === 'world_time_minutes')
          ?.value,
      ),
    ).toBe(450);
  });

  it('does not materialize stale fallback scene participants absent from source markdown', async () => {
    const cartridgeId = 'cart-apply-test-scene-participant-guard';
    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:location:lab',
          kind: 'location',
          slug: 'iron-row-district',
          canonicalName: 'Iron Row District',
        },
        {
          recordId: 'rec:person:harrow',
          kind: 'person',
          slug: 'captain-harrow',
          canonicalName: 'Captain Harrow',
          extra: {
            home_slug: 'greenhaven-police-department',
          },
        },
        {
          recordId: 'rec:scene:computer',
          kind: 'scene',
          slug: 'inspecting-voss-lab-computer',
          canonicalName: 'Inspecting Voss Lab Computer',
          extra: {
            location_slug: 'iron-row-district',
            participant_slugs: ['captain-harrow'],
            source_markdown:
              '# Inspecting Voss Lab Computer\n\nThe old computer waits. No one is physically here.',
          },
        },
      ],
    });
    const preview = await previewToReady(fixture);
    expect(preview.status).toBe('ready');
    await CartridgeImportApplyService.apply({jobId: preview.jobId});

    const rows = await queryRows<{profile: Record<string, unknown>}>(
      `SELECT e.profile
         FROM entities e
         JOIN cartridge_records cr ON cr.imported_entity_id = e.id
        WHERE cr.cartridge_id = $1
          AND cr.slug = 'inspecting-voss-lab-computer'`,
      [cartridgeId],
    );

    expect(rows[0]?.profile['participant_entity_ids']).toEqual([]);
  });

  it('reimport produces real changed/unchanged counts via per-record content hashes', async () => {
    const cartridgeId = 'cart-apply-test-reimport';
    const v1 = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:v1:a',
          kind: 'location',
          slug: 'a',
          canonicalName: 'Loc A v1',
        },
        {
          recordId: 'rec:v1:b',
          kind: 'location',
          slug: 'b',
          canonicalName: 'Loc B v1',
        },
      ],
    });
    const previewA = await previewToReady(v1);
    await CartridgeImportApplyService.apply({jobId: previewA.jobId});

    // v2: edit Loc A, keep Loc B identical, add Loc C, drop nothing.
    const v2 = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:v1:a',
          kind: 'location',
          slug: 'a',
          canonicalName: 'Loc A v2', // CHANGED
        },
        {
          recordId: 'rec:v1:b',
          kind: 'location',
          slug: 'b',
          canonicalName: 'Loc B v1', // unchanged
        },
        {
          recordId: 'rec:v2:c',
          kind: 'location',
          slug: 'c',
          canonicalName: 'Loc C v2', // new
        },
      ],
    });
    const previewB = await previewToReady(v2);
    const applied = (await CartridgeImportApplyService.apply({
      jobId: previewB.jobId,
    })) as unknown as ImportJobView;
    expect(applied.result?.applyResult?.diff).toEqual({
      new: 1,
      changed: 1,
      unchanged: 1,
      deprecated: 0,
      blocked: 0,
    });
    // Reverse: drop A, keep B, add D.
    const v3 = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:v1:b',
          kind: 'location',
          slug: 'b',
          canonicalName: 'Loc B v1',
        },
        {
          recordId: 'rec:v3:d',
          kind: 'location',
          slug: 'd',
          canonicalName: 'Loc D v3',
        },
      ],
    });
    const previewC = await previewToReady(v3);
    const applied3 = (await CartridgeImportApplyService.apply({
      jobId: previewC.jobId,
    })) as unknown as ImportJobView;
    expect(applied3.result?.applyResult?.diff.deprecated).toBe(2);
    expect(applied3.result?.applyResult?.deprecatedRecordIds.sort()).toEqual(
      ['rec:v1:a', 'rec:v2:c'].sort(),
    );
    const records = await queryRows<{record_id: string; status: string}>(
      `SELECT record_id, status FROM cartridge_records
        WHERE cartridge_id = $1 ORDER BY record_id`,
      [cartridgeId],
    );
    const deprecatedRow = records.find((r) => r.record_id === 'rec:v1:a');
    expect(deprecatedRow?.status).toBe('deprecated');
  });

  it('refuses to overwrite a dynamic_origin entity — records it as blocked', async () => {
    const cartridgeId = 'cart-apply-test-blocked';
    // Pre-seed the target cartridge with a dynamic_origin = true
    // entity so the bootstrap match path finds it.
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, 'Blocked Test', '0.1', '1', 'forge_project',
               'sha256:placeholder')
       ON CONFLICT (id) DO NOTHING`,
      [cartridgeId],
    );
    const seeded = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, profile, tags,
                              cartridge_id, dynamic_origin)
       VALUES ('person', 'Runtime NPC', '{}'::jsonb, ARRAY['person']::text[],
               $1, true)
       RETURNING id`,
      [cartridgeId],
    );
    const dynamicId = Number(seeded[0]?.id);
    expect(dynamicId).toBeGreaterThan(0);

    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:blocked:runtime',
          kind: 'person',
          slug: 'runtime-npc',
          canonicalName: 'Runtime NPC',
        },
        {
          recordId: 'rec:blocked:fresh',
          kind: 'person',
          slug: 'fresh-npc',
          canonicalName: 'Fresh NPC',
        },
      ],
    });
    const preview = await previewToReady(fixture);
    const applied = (await CartridgeImportApplyService.apply({
      jobId: preview.jobId,
    })) as unknown as ImportJobView;
    expect(applied.result?.applyResult?.diff.blocked).toBe(1);
    expect(applied.result?.applyResult?.blockedRecordIds).toEqual([
      'rec:blocked:runtime',
    ]);
    // Dynamic entity must NOT be overwritten.
    const after = await queryRows<{display_name: string; dynamic_origin: boolean}>(
      `SELECT display_name, dynamic_origin FROM entities WHERE id = $1`,
      [dynamicId],
    );
    expect(after[0]?.display_name).toBe('Runtime NPC');
    expect(after[0]?.dynamic_origin).toBe(true);
    // The blocked record row exists with status='blocked'.
    const blocked = await queryRows<{status: string}>(
      `SELECT status FROM cartridge_records
        WHERE cartridge_id = $1 AND record_id = $2`,
      [cartridgeId, 'rec:blocked:runtime'],
    );
    expect(blocked[0]?.status).toBe('blocked');
  });

  it('rejects apply on a non-ready job', async () => {
    await expect(
      CartridgeImportApplyService.apply({jobId: 'definitely-not-a-job'}),
    ).rejects.toMatchObject({code: 'unknown_job'});
  });

  it('validation_errors is NEVER bypassed by acceptWarnings (FEAT-CART-LIB-3 corrective)', async () => {
    const cartridgeId = 'cart-apply-test-validation-errors';
    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:val:a',
          kind: 'location',
          slug: 'a',
          canonicalName: 'OK',
        },
      ],
    });
    const preview = await previewToReady(fixture);
    // Hand-poison the validation count so the guard fires. Real
    // preview validation is wired in FEAT-CART-LIB-2; here we pin
    // the gate semantics.
    await queryRows(
      `UPDATE cartridge_import_preview_jobs
          SET result = jsonb_set(
            jsonb_set(result, '{validation,errors}', to_jsonb(3::int)),
            '{validation,warnings}',
            to_jsonb(0::int)
          )
        WHERE job_id = $1`,
      [preview.jobId],
    );
    // Without acceptWarnings → rejects.
    await expect(
      CartridgeImportApplyService.apply({jobId: preview.jobId}),
    ).rejects.toMatchObject({code: 'validation_errors'});
    // With acceptWarnings=true → STILL rejects (errors are terminal).
    await expect(
      CartridgeImportApplyService.apply({
        jobId: preview.jobId,
        acceptWarnings: true,
      }),
    ).rejects.toMatchObject({code: 'validation_errors'});
    // Nothing should have been written to install_cache.
    const cache = await queryRows<{cartridge_id: string}>(
      `SELECT cartridge_id FROM cartridge_install_cache
        WHERE cartridge_id = $1`,
      [cartridgeId],
    );
    expect(cache.length).toBe(0);
  });

  it('warning-only previews require acceptWarnings (FEAT-CART-LIB-3 corrective)', async () => {
    const cartridgeId = 'cart-apply-test-validation-warnings';
    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:warn:a',
          kind: 'location',
          slug: 'a',
          canonicalName: 'OK',
        },
      ],
    });
    const preview = await previewToReady(fixture);
    await queryRows(
      `UPDATE cartridge_import_preview_jobs
          SET result = jsonb_set(
            jsonb_set(result, '{validation,errors}', to_jsonb(0::int)),
            '{validation,warnings}',
            to_jsonb(2::int)
          )
        WHERE job_id = $1`,
      [preview.jobId],
    );
    // Without acceptWarnings → rejects with validation_warnings.
    await expect(
      CartridgeImportApplyService.apply({jobId: preview.jobId}),
    ).rejects.toMatchObject({code: 'validation_warnings'});
    // With acceptWarnings=true → applies cleanly.
    const applied = (await CartridgeImportApplyService.apply({
      jobId: preview.jobId,
      acceptWarnings: true,
    })) as unknown as ImportJobView;
    expect(applied.status).toBe('applied');
  });

  it('expected cartridge mismatch rejects pre-commit with no writes (FEAT-CART-LIB-3 corrective)', async () => {
    const cartridgeId = 'cart-apply-test-expected-id';
    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:exp:a',
          kind: 'location',
          slug: 'a',
          canonicalName: 'Locale A',
        },
      ],
    });
    const preview = await previewToReady(fixture);
    expect(preview.status).toBe('ready');
    await expect(
      CartridgeImportApplyService.apply({
        jobId: preview.jobId,
        expectedCartridgeId: 'cart-apply-test-some-other-id',
      }),
    ).rejects.toMatchObject({code: 'cartridge_id_mismatch'});
    // Pre-flight reject — nothing should have been written.
    const cart = await queryRows<{id: string}>(
      `SELECT id FROM cartridges WHERE id = $1`,
      [cartridgeId],
    );
    expect(cart.length).toBe(0);
    const cache = await queryRows<{cartridge_id: string}>(
      `SELECT cartridge_id FROM cartridge_install_cache
        WHERE cartridge_id = $1`,
      [cartridgeId],
    );
    expect(cache.length).toBe(0);
    // Job stays `ready` so the caller can retry with the right URL.
    const stillReady = await queryRows<{status: string}>(
      `SELECT status FROM cartridge_import_preview_jobs
        WHERE job_id = $1`,
      [preview.jobId],
    );
    expect(stillReady[0]?.status).toBe('ready');
    // Apply with the correct expected id should succeed.
    const applied = (await CartridgeImportApplyService.apply({
      jobId: preview.jobId,
      expectedCartridgeId: cartridgeId,
    })) as unknown as ImportJobView;
    expect(applied.status).toBe('applied');
  });

  it('reuses entity when record_id drifts but (kind, slug) stays stable (FEAT-CART-LIB-3 corrective)', async () => {
    const cartridgeId = 'cart-apply-test-record-id-drift';
    // v1 — write the original mapping.
    const v1 = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:writer-pass-1',
          kind: 'location',
          slug: 'forge',
          canonicalName: 'The Forge',
        },
      ],
    });
    const previewA = await previewToReady(v1);
    await CartridgeImportApplyService.apply({jobId: previewA.jobId});
    const before = await queryRows<{
      record_id: string;
      imported_entity_id: number;
    }>(
      `SELECT record_id, imported_entity_id
         FROM cartridge_records
        WHERE cartridge_id = $1`,
      [cartridgeId],
    );
    expect(before.length).toBe(1);
    const originalEntityId = before[0]?.imported_entity_id ?? null;

    // v2 — same kind+slug, NEW record_id (writer renamed the
    // record but the logical entity is the same).
    const v2 = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:writer-pass-2',
          kind: 'location',
          slug: 'forge',
          canonicalName: 'The Forge (updated)',
        },
      ],
    });
    const previewB = await previewToReady(v2);
    const applied = (await CartridgeImportApplyService.apply({
      jobId: previewB.jobId,
    })) as unknown as ImportJobView;
    expect(applied.status).toBe('applied');

    // The result: ONE active cartridge_records row pointing at the
    // SAME entity_id; no deprecate row for the old record_id.
    const after = await queryRows<{
      record_id: string;
      status: string;
      imported_entity_id: number;
    }>(
      `SELECT record_id, status, imported_entity_id
         FROM cartridge_records
        WHERE cartridge_id = $1
        ORDER BY record_id`,
      [cartridgeId],
    );
    expect(after.length).toBe(1);
    expect(after[0]?.record_id).toBe('rec:writer-pass-2');
    expect(after[0]?.status).toBe('active');
    expect(after[0]?.imported_entity_id).toBe(originalEntityId);
    expect(applied.result?.applyResult?.diff.deprecated).toBe(0);
    expect(applied.result?.applyResult?.deprecatedRecordIds).toEqual([]);
  });

  it('bootstrap prefers entities by profile.source_slug (FEAT-CART-LIB-3 corrective)', async () => {
    const cartridgeId = 'cart-apply-test-source-slug';
    // Pre-seed the cartridge + an entity with profile.source_slug
    // set. cartridge_records is empty so this is a bootstrap path.
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, 'Source Slug Bootstrap', '0.1', '1',
               'forge_project', 'sha256:placeholder')
       ON CONFLICT (id) DO NOTHING`,
      [cartridgeId],
    );
    const seeded = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, profile, tags,
                              cartridge_id, dynamic_origin)
       VALUES ('person',
               'Old Display Name',
               $1::jsonb,
               ARRAY['person']::text[],
               $2,
               false)
       RETURNING id`,
      [JSON.stringify({source_slug: 'mira'}), cartridgeId],
    );
    const seededId = Number(seeded[0]?.id);
    expect(seededId).toBeGreaterThan(0);

    const fixture = await makeForgeProject({
      cartridgeId,
      records: [
        {
          recordId: 'rec:src:mira',
          kind: 'person',
          slug: 'mira', // matches profile.source_slug
          canonicalName: 'Mira (Updated)',
        },
      ],
    });
    const preview = await previewToReady(fixture);
    const applied = (await CartridgeImportApplyService.apply({
      jobId: preview.jobId,
    })) as unknown as ImportJobView;
    expect(applied.status).toBe('applied');

    // The seeded entity should have been REUSED (display_name now
    // updated) — NOT duplicated.
    const ents = await queryRows<{
      id: number;
      display_name: string;
      dynamic_origin: boolean;
    }>(
      `SELECT id, display_name, dynamic_origin
         FROM entities
        WHERE cartridge_id = $1
        ORDER BY id`,
      [cartridgeId],
    );
    expect(ents.length).toBe(1);
    expect(ents[0]?.id).toBe(seededId);
    expect(ents[0]?.display_name).toBe('Mira (Updated)');
    // cartridge_records row points back at the same entity.
    const records = await queryRows<{
      record_id: string;
      imported_entity_id: number;
    }>(
      `SELECT record_id, imported_entity_id
         FROM cartridge_records
        WHERE cartridge_id = $1`,
      [cartridgeId],
    );
    expect(records[0]?.record_id).toBe('rec:src:mira');
    expect(records[0]?.imported_entity_id).toBe(seededId);
  });

  // ──────────────────────────────────────────────────────────────
  // FEAT-ENGINE-BASELINE-5 corrective — scoped asset manifest must
  // be authoritative across reimports, including the zero-asset
  // case. A reimport that removes every asset (or omits
  // `audit/visual-assets.jsonl`) replaces the previous manifest
  // with an empty v1 row so the runtime route stops resolving the
  // removed entries.
  // ──────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────
  // FEAT-ENGINE-BASELINE-6 corrective — scoped starting-location
  // cleanup. A reimport whose manifest no longer declares
  // `starting_location_slug` must drop both the scoped slug and
  // resolved id rows. A reimport whose slug doesn't resolve against
  // the imported cartridge_records must keep the slug row but drop
  // the stale id so playthrough preview returns
  // `no_starting_location` rather than launching at a wrong entity.
  // ──────────────────────────────────────────────────────────────

  describe('starting-location scoped cleanup (FEAT-ENGINE-BASELINE-6 corrective)', () => {
    async function makeForgeProjectWithStart(opts: {
      cartridgeId: string;
      startingLocationSlug: string | null;
      records: Array<{
        recordId: string;
        kind: string;
        slug: string;
        canonicalName: string;
      }>;
    }): Promise<string> {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'cart-apply-start-'));
      TMP_FIXTURES.push(dir);
      await mkdir(path.join(dir, 'records'), {recursive: true});
      const project: Record<string, unknown> = {
        schema_version: 'greenhaven.cartridge_forge_project.v1',
        project_slug: opts.cartridgeId,
        pack_slug: opts.cartridgeId,
        target_cartridge_id: opts.cartridgeId,
        title: `Start Test ${opts.cartridgeId}`,
        version: '0.1.0',
      };
      if (opts.startingLocationSlug) {
        project['starting_location_slug'] = opts.startingLocationSlug;
      }
      await writeFile(
        path.join(dir, 'forge.project.json'),
        JSON.stringify(project),
      );
      const byKind = new Map<string, string[]>();
      for (const r of opts.records) {
        const row = JSON.stringify({
          record_id: r.recordId,
          kind: r.kind,
          slug: r.slug,
          canonical_name: r.canonicalName,
          summary: '',
          tags: [r.kind],
          payload: {canonical_mention: '@' + r.canonicalName},
        });
        const list = byKind.get(r.kind) ?? [];
        list.push(row);
        byKind.set(r.kind, list);
      }
      for (const [kind, lines] of byKind) {
        await writeFile(
          path.join(dir, 'records', `${kind}s.jsonl`),
          lines.join('\n') + '\n',
        );
      }
      return dir;
    }

    it('reimport with no starting_location_slug clears both scoped start rows', async () => {
      const cartridgeId = 'cart-apply-test-start-removal';
      // v1 — manifest declares `town-square`; apply resolves it to an
      // entity id and writes both scoped rows.
      const v1 = await makeForgeProjectWithStart({
        cartridgeId,
        startingLocationSlug: 'town-square',
        records: [
          {
            recordId: 'rec:start:square',
            kind: 'location',
            slug: 'town-square',
            canonicalName: 'Town Square',
          },
        ],
      });
      const previewA = await previewToReady(v1);
      const appliedA = (await CartridgeImportApplyService.apply({
        jobId: previewA.jobId,
      })) as unknown as ImportJobView;
      expect(appliedA.status).toBe('applied');
      const afterV1 = await queryRows<{key: string; value: unknown}>(
        `SELECT key, value FROM cartridge_meta_scoped
          WHERE cartridge_id = $1
            AND key IN ('starting_location_slug', 'starting_location_id')
          ORDER BY key`,
        [cartridgeId],
      );
      expect(afterV1.map((r) => r.key)).toEqual([
        'starting_location_id',
        'starting_location_slug',
      ]);

      // v2 — manifest no longer declares a starting location. Apply
      // must DELETE both scoped rows so a stale launch anchor can't
      // survive.
      const v2 = await makeForgeProjectWithStart({
        cartridgeId,
        startingLocationSlug: null,
        records: [
          {
            recordId: 'rec:start:square',
            kind: 'location',
            slug: 'town-square',
            canonicalName: 'Town Square',
          },
        ],
      });
      const previewB = await previewToReady(v2);
      const appliedB = (await CartridgeImportApplyService.apply({
        jobId: previewB.jobId,
      })) as unknown as ImportJobView;
      expect(appliedB.status).toBe('applied');
      const afterV2 = await queryRows<{key: string}>(
        `SELECT key FROM cartridge_meta_scoped
          WHERE cartridge_id = $1
            AND key IN ('starting_location_slug', 'starting_location_id')`,
        [cartridgeId],
      );
      expect(afterV2.length).toBe(0);
    });

    it('reimport with unresolved starting_location_slug keeps the slug row but deletes the stale id', async () => {
      const cartridgeId = 'cart-apply-test-start-unresolved';
      // v1 — manifest + record agree on `forge` slug.
      const v1 = await makeForgeProjectWithStart({
        cartridgeId,
        startingLocationSlug: 'forge',
        records: [
          {
            recordId: 'rec:start:forge',
            kind: 'location',
            slug: 'forge',
            canonicalName: 'The Forge',
          },
        ],
      });
      const previewA = await previewToReady(v1);
      const appliedA = (await CartridgeImportApplyService.apply({
        jobId: previewA.jobId,
      })) as unknown as ImportJobView;
      expect(appliedA.status).toBe('applied');
      const afterV1 = await queryRows<{key: string}>(
        `SELECT key FROM cartridge_meta_scoped
          WHERE cartridge_id = $1
            AND key IN ('starting_location_slug', 'starting_location_id')
          ORDER BY key`,
        [cartridgeId],
      );
      expect(afterV1.map((r) => r.key)).toEqual([
        'starting_location_id',
        'starting_location_slug',
      ]);

      // v2 — the writer renamed the location's slug but the manifest
      // still points at the old name. The id row must be deleted; the
      // slug row stays so the GUI can surface the missing target.
      const v2 = await makeForgeProjectWithStart({
        cartridgeId,
        startingLocationSlug: 'forge',
        records: [
          {
            recordId: 'rec:start:forge',
            kind: 'location',
            slug: 'foundry', // renamed
            canonicalName: 'The Foundry',
          },
        ],
      });
      const previewB = await previewToReady(v2);
      const appliedB = (await CartridgeImportApplyService.apply({
        jobId: previewB.jobId,
      })) as unknown as ImportJobView;
      expect(appliedB.status).toBe('applied');
      const afterV2 = await queryRows<{key: string; value: unknown}>(
        `SELECT key, value FROM cartridge_meta_scoped
          WHERE cartridge_id = $1
            AND key IN ('starting_location_slug', 'starting_location_id')
          ORDER BY key`,
        [cartridgeId],
      );
      // Only the slug row should remain — id was deleted because the
      // declared slug no longer resolves.
      expect(afterV2.length).toBe(1);
      expect(afterV2[0]?.key).toBe('starting_location_slug');
      // The slug value is preserved verbatim so the GUI repair gate
      // can display "starts at forge (missing)".
      const slugValue = (afterV2[0]?.value as unknown as string) ?? '';
      // PGlite returns jsonb scalars decoded; the helper stores via
      // `to_jsonb($2::text)` so the round-trip is a plain string.
      expect(typeof slugValue === 'string' ? slugValue : '').toBe('forge');
    });
  });

  describe('forge_visual_assets manifest reimport (FEAT-ENGINE-BASELINE-5 corrective)', () => {
    it('zero-asset reimport replaces a non-empty scoped manifest with an empty v1 row', async () => {
      const cartridgeId = 'cart-apply-test-asset-zeroize';

      // Pre-seed a stale non-empty manifest as if a prior apply had
      // landed three assets. We also need a cartridges row so the
      // FK on `cartridge_meta_scoped.cartridge_id` is satisfied.
      await queryRows(
        `INSERT INTO cartridges (
           id, title, version, schema_version, source_kind,
           content_hash, manifest, validation_report, status
         )
         VALUES ($1, $1, '0.1.0', '1', 'forge_project',
                 'sha256:pre-existing', '{}'::jsonb, '{}'::jsonb,
                 'installed')
         ON CONFLICT (id) DO NOTHING`,
        [cartridgeId],
      );
      const stale = {
        schema_version: 'greenhaven.cartridge_assets.v1',
        cartridge_id: cartridgeId,
        cache_root: `cartridges/${cartridgeId}/assets`,
        source_path: '',
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: {
          total: 3,
          available: 3,
          missing: 0,
          unsupported_extension: 0,
        },
        rows: [
          {
            asset_id: 'stale-1',
            kind: 'item',
            slug: 'ghost-coin',
            role: 'item_icon',
            mention: '@GhostCoin',
            source_path: 'GreenHavenWorld/Items/@GhostCoin/.../icon.png',
            content_hash: 'aaaa',
            cache_path: 'aaaa.png',
            content_type: 'image/png',
            extension: '.png',
            status: 'available',
          },
          {
            asset_id: 'stale-2',
            kind: 'item',
            slug: 'ghost-relic',
            role: 'item_icon',
            mention: '@GhostRelic',
            source_path: 'GreenHavenWorld/Items/@GhostRelic/.../icon.png',
            content_hash: 'bbbb',
            cache_path: 'bbbb.png',
            content_type: 'image/png',
            extension: '.png',
            status: 'available',
          },
          {
            asset_id: 'stale-3',
            kind: 'item',
            slug: 'ghost-token',
            role: 'item_icon',
            mention: '@GhostToken',
            source_path: 'GreenHavenWorld/Items/@GhostToken/.../icon.png',
            content_hash: 'cccc',
            cache_path: 'cccc.png',
            content_type: 'image/png',
            extension: '.png',
            status: 'available',
          },
        ],
      };
      await queryRows(
        `INSERT INTO cartridge_meta_scoped
           (cartridge_id, key, value, description)
         VALUES ($1, 'forge_visual_assets', $2::jsonb, $3)
         ON CONFLICT (cartridge_id, key) DO UPDATE SET
           value = EXCLUDED.value`,
        [cartridgeId, JSON.stringify(stale), 'stale-fixture'],
      );

      // Reimport the cartridge from a forge project that ships NO
      // `audit/visual-assets.jsonl`. The asset-manifest builder
      // returns an empty v1 manifest and the apply step must
      // replace the stale row with it.
      const fixture = await makeForgeProject({
        cartridgeId,
        records: [
          {
            recordId: 'rec:zero:plaza',
            kind: 'location',
            slug: 'plaza',
            canonicalName: 'Empty Plaza',
          },
        ],
      });
      const preview = await previewToReady(fixture);
      const applied = (await CartridgeImportApplyService.apply({
        jobId: preview.jobId,
      })) as unknown as ImportJobView;
      expect(applied.status).toBe('applied');

      const after = await queryRows<{value: Record<string, unknown>}>(
        `SELECT value FROM cartridge_meta_scoped
          WHERE cartridge_id = $1 AND key = 'forge_visual_assets'`,
        [cartridgeId],
      );
      expect(after.length).toBe(1);
      const value = after[0]?.value as {
        schema_version: string;
        counts: {total: number; available: number};
        rows: unknown[];
      };
      expect(value.schema_version).toBe('greenhaven.cartridge_assets.v1');
      expect(value.counts.total).toBe(0);
      expect(value.counts.available).toBe(0);
      expect(value.rows).toEqual([]);
    });
  });
});
