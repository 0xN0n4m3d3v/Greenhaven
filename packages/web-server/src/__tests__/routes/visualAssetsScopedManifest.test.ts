/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-5 corrective — scoped-manifest authority
// for `/api/assets/world/:kind/:slug/:role?`.
//
// When an installed cartridge has a `cartridge_meta_scoped.forge_visual_assets`
// row, that scoped manifest is authoritative: the legacy OWV-17
// vault bridge MUST NOT be consulted on `unknown_entry`. Otherwise
// a reimport that removed an asset would still serve the stale
// vault file.
//
// This suite drives the route against a real PGlite (so the
// `loadScopedManifest` SQL path executes) and uses a vi.mock to
// observe whether `resolveVisualAsset` is reached.

import {Hono} from 'hono';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

const pgdataDir = process.cwd().endsWith('web-server')
  ? path.resolve(process.cwd(), 'pgdata')
  : path.resolve(process.cwd(), 'packages', 'web-server', 'pgdata');

const vaultBridgeState = vi.hoisted(() => ({
  calls: 0,
}));

vi.mock('../../services/VisualAssetBridgeService.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import(
    '../../services/VisualAssetBridgeService.js'
  );
  return {
    ...actual,
    resolveVisualAsset: vi.fn(async () => {
      vaultBridgeState.calls += 1;
      // The fallback path should never be reached when the default
      // cartridge has a scoped manifest. Returning `unknown_entry`
      // keeps the contract honest if a future regression DOES reach
      // it (the test asserts the fallback was not called).
      return {status: 'unknown_entry' as const};
    }),
  };
});

const CARTRIDGE_ID = 'cart-scoped-route-test';

let visualAssetRoutes: typeof import('../../routes/visualAssets.js').visualAssetRoutes;
let app: Hono;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({visualAssetRoutes} = await import('../../routes/visualAssets.js'));
  app = new Hono();
  app.route('/api/assets', visualAssetRoutes);
}, 60_000);

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  vaultBridgeState.calls = 0;
  // Clear any meta the previous test installed.
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE cartridge_id = $1`,
    [CARTRIDGE_ID],
  );
  await queryRows(
    `DELETE FROM cartridges WHERE id = $1`,
    [CARTRIDGE_ID],
  );
  // Default cartridge pointer for the legacy /api/assets/world/... route.
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description)
     VALUES ('cartridge_id', to_jsonb($1::text), 'test')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [CARTRIDGE_ID],
  );
  await queryRows(
    `INSERT INTO cartridges (
       id, title, version, schema_version, source_kind,
       content_hash, manifest, validation_report, status
     )
     VALUES ($1, $1, '0.1.0', '1', 'forge_project',
             'sha256:test', '{}'::jsonb, '{}'::jsonb, 'installed')
     ON CONFLICT (id) DO NOTHING`,
    [CARTRIDGE_ID],
  );
});

async function seedScopedManifest(rows: Array<{
  asset_id: string;
  kind: string;
  slug: string;
  role: string;
  cache_path: string;
  content_type?: string;
  extension?: string;
  status?: 'available' | 'missing' | 'unsupported_extension';
}>): Promise<void> {
  const value = {
    schema_version: 'greenhaven.cartridge_assets.v1',
    cartridge_id: CARTRIDGE_ID,
    cache_root: `cartridges/${CARTRIDGE_ID}/assets`,
    source_path: '',
    generated_at: new Date().toISOString(),
    counts: {
      total: rows.length,
      available: rows.filter((r) => (r.status ?? 'available') === 'available')
        .length,
      missing: rows.filter((r) => r.status === 'missing').length,
      unsupported_extension: rows.filter(
        (r) => r.status === 'unsupported_extension',
      ).length,
    },
    rows: rows.map((r) => ({
      asset_id: r.asset_id,
      kind: r.kind,
      slug: r.slug,
      role: r.role,
      mention: '@' + r.slug,
      source_path: '',
      content_hash: r.asset_id,
      cache_path: r.cache_path,
      content_type: r.content_type ?? 'image/png',
      extension: r.extension ?? '.png',
      status: r.status ?? 'available',
    })),
  };
  await queryRows(
    `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
     VALUES ($1, 'forge_visual_assets', $2::jsonb, 'test')
     ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [CARTRIDGE_ID, JSON.stringify(value)],
  );
}

describe('default /api/assets/world route — scoped manifest authority (FEAT-ENGINE-BASELINE-5 corrective)', () => {
  it('returns 404 unknown_asset (and DOES NOT consult the vault bridge) when the scoped manifest exists but the asset is unknown', async () => {
    // Cartridge has a manifest with `coin`, but the request asks
    // for an unrelated `ghost`. Pre-cutover, the route would fall
    // back to `resolveVisualAsset()` and possibly stream a stale
    // vault file; post-cutover it must 404 immediately.
    const cachePath = path.join(
      pgdataDir,
      'cartridges',
      CARTRIDGE_ID,
      'assets',
    );
    await mkdir(cachePath, {recursive: true}).catch(() => {});
    await writeFile(
      path.join(cachePath, 'coin.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ).catch(() => {});
    await seedScopedManifest([
      {
        asset_id: 'coin',
        kind: 'item',
        slug: 'coin',
        role: 'item_icon',
        cache_path: 'coin.png',
      },
    ]);

    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/ghost/item_icon'),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as {error: string};
    expect(body.error).toBe('unknown_asset');
    expect(vaultBridgeState.calls).toBe(0);
  });

  it('falls back to the vault bridge ONLY when no scoped manifest row exists for the active default cartridge', async () => {
    // Clear scoped manifest so the route enters the legacy bridge
    // branch. The vault bridge is mocked to return `unknown_entry`,
    // so the route still 404s, but we confirm `resolveVisualAsset`
    // was reached.
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/coin/item_icon'),
    );
    expect(res.status).toBe(404);
    expect(vaultBridgeState.calls).toBe(1);
  });

  it('serves the asset from the cache when the scoped manifest matches and the cache file exists', async () => {
    const cachePath = path.join(
      pgdataDir,
      'cartridges',
      CARTRIDGE_ID,
      'assets',
    );
    await mkdir(cachePath, {recursive: true}).catch(() => {});
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(path.join(cachePath, 'live.png'), png);
    await seedScopedManifest([
      {
        asset_id: 'live',
        kind: 'item',
        slug: 'live',
        role: 'item_icon',
        cache_path: 'live.png',
      },
    ]);

    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/live/item_icon'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(vaultBridgeState.calls).toBe(0);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
  });

  it('serves cartridge boot video from the scoped cache with video content type', async () => {
    const cachePath = path.join(
      pgdataDir,
      'cartridges',
      CARTRIDGE_ID,
      'assets',
    );
    await mkdir(cachePath, {recursive: true}).catch(() => {});
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    await writeFile(path.join(cachePath, 'boot.mp4'), mp4);
    await seedScopedManifest([
      {
        asset_id: 'boot-video',
        kind: 'cartridge',
        slug: 'boot',
        role: 'boot_video_01',
        cache_path: 'boot.mp4',
        content_type: 'video/mp4',
        extension: '.mp4',
      },
    ]);

    const res = await app.fetch(
      new Request(
        `http://test/api/assets/cartridges/${CARTRIDGE_ID}/world/cartridge/boot/boot_video_01`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[4]).toBe(0x66);
    expect(buf[5]).toBe(0x74);
  });
});
