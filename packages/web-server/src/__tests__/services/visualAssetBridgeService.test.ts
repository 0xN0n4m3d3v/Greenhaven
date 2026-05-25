/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `VisualAssetBridgeService` contract.
//
//   * the bridge is unavailable until the meta row is seeded;
//   * a wrong `schema_version` is a defensive no-op;
//   * `findVisualAssetEntry` resolves by `(kind, slug)` and by
//     `(kind, slug, role)`;
//   * `resolveVisualAsset` rejects traversal/absolute paths and
//     unsupported extensions before any filesystem read;
//   * a happy-path lookup returns the absolute path + image MIME
//     type when the file is present under the configured root.

import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

let VisualAssetBridgeService: typeof import('../../services/VisualAssetBridgeService.js');
let cartridgeCache: typeof import('../../cartridge.js');

beforeAll(async () => {
  await setupTurnTestEnvironment();
  VisualAssetBridgeService = await import(
    '../../services/VisualAssetBridgeService.js'
  );
  cartridgeCache = await import('../../cartridge.js');
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  // Migration 0122 seeds canonical `forge_visual_assets` into every
  // fresh-migration fixture. Clear it before each case so the
  // `bridge missing` assertions are deterministic; seeded happy-path
  // tests re-insert their own meta row with `ON CONFLICT DO UPDATE`.
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_visual_assets'`,
  );
  cartridgeCache.clearMetaCache();
  VisualAssetBridgeService.clearVisualAssetBridgeCache();
});

afterEach(async () => {
  cartridgeCache.clearMetaCache();
  VisualAssetBridgeService.clearVisualAssetBridgeCache();
  VisualAssetBridgeService.setVaultRootsForTests(null);
  await queryRows(
    `DELETE FROM cartridge_meta WHERE key = 'forge_visual_assets'`,
  );
});

async function seedVisualAssetsBridge(rows: unknown[]): Promise<void> {
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('forge_visual_assets', $1::jsonb, 'OWV-17 visual-assets test seed')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        schema_version: 'greenhaven.visual_assets.v1',
        source_project: 'owv17-test',
        rows,
      }),
    ],
  );
  cartridgeCache.clearMetaCache();
  VisualAssetBridgeService.clearVisualAssetBridgeCache();
}

async function makeTempVaultRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'owv17-visual-vault-'));
}

async function writeAssetFile(
  vaultRoot: string,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = path.join(vaultRoot, relPath);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, bytes);
}

describe('VisualAssetBridgeService (OWV-17)', () => {
  it('reports no entries when the bridge meta is missing', async () => {
    expect(
      await VisualAssetBridgeService.isVisualAssetBridgeAvailable(),
    ).toBe(false);
    expect(
      await VisualAssetBridgeService.listVisualAssetEntries(),
    ).toEqual([]);
    expect(
      await VisualAssetBridgeService.findVisualAssetEntry({
        kind: 'item',
        slug: 'nothing',
      }),
    ).toBeNull();
  });

  it('skips rows with a wrong schema_version', async () => {
    await queryRows(
      `INSERT INTO cartridge_meta (key, value, description) VALUES
         ('forge_visual_assets', $1::jsonb, 'OWV-17 schema guard')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          schema_version: 'unknown.future.v999',
          source_project: 'owv17-test',
          rows: [{kind: 'item', slug: 'will-skip', role: 'item_icon', path: 'a.png'}],
        }),
      ],
    );
    cartridgeCache.clearMetaCache();
    VisualAssetBridgeService.clearVisualAssetBridgeCache();
    expect(
      await VisualAssetBridgeService.isVisualAssetBridgeAvailable(),
    ).toBe(false);
    expect(
      await VisualAssetBridgeService.listVisualAssetEntries(),
    ).toEqual([]);
  });

  it('resolves by kind+slug+role and by kind+slug alone', async () => {
    await seedVisualAssetsBridge([
      {
        kind: 'item',
        slug: 'copper-coin',
        mention: '@Copper coin',
        role: 'item_icon',
        path: 'GreenHavenWorld/Economy/items/@Copper coin/images/icon.png',
        source_path: 'x.md',
      },
      {
        kind: 'person',
        slug: 'mikka',
        mention: '@Mikka',
        role: 'portrait',
        path: 'GreenHavenWorld/Locations/@City of Greenhaven/@Town square/npc/@Mikka/images/portrait.png',
        source_path: 'y.md',
      },
    ]);
    const triple = await VisualAssetBridgeService.findVisualAssetEntry({
      kind: 'item',
      slug: 'copper-coin',
      role: 'item_icon',
    });
    expect(triple).not.toBeNull();
    expect(triple!.path).toMatch(/Copper coin\/images\/icon\.png$/);
    const fallback = await VisualAssetBridgeService.findVisualAssetEntry({
      kind: 'person',
      slug: 'mikka',
    });
    expect(fallback).not.toBeNull();
    expect(fallback!.role).toBe('portrait');
    const missing = await VisualAssetBridgeService.findVisualAssetEntry({
      kind: 'item',
      slug: 'copper-coin',
      role: 'portrait',
    });
    expect(missing).toBeNull();
  });

  it('resolveVisualAsset returns ok with absolute path + content-type for a present file', async () => {
    const vaultRoot = await makeTempVaultRoot();
    const relPath = 'GreenHavenWorld/items/@Test/images/icon.png';
    await writeAssetFile(vaultRoot, relPath, new Uint8Array([1, 2, 3, 4]));
    VisualAssetBridgeService.setVaultRootsForTests([vaultRoot]);
    await seedVisualAssetsBridge([
      {
        kind: 'item',
        slug: 'test-item',
        mention: '@Test',
        role: 'item_icon',
        path: relPath,
        source_path: 'x.md',
      },
    ]);
    const result = await VisualAssetBridgeService.resolveVisualAsset({
      kind: 'item',
      slug: 'test-item',
      role: 'item_icon',
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.resolved.contentType).toBe('image/png');
      expect(result.resolved.absolutePath).toBe(
        path.resolve(vaultRoot, relPath),
      );
    }
  });

  it('refuses unsupported file extensions before any read', async () => {
    const vaultRoot = await makeTempVaultRoot();
    VisualAssetBridgeService.setVaultRootsForTests([vaultRoot]);
    await seedVisualAssetsBridge([
      {
        kind: 'item',
        slug: 'unsafe-md',
        mention: '@MD',
        role: 'item_icon',
        path: 'GreenHavenWorld/items/@MD/notes.md',
        source_path: 'x.md',
      },
    ]);
    const result = await VisualAssetBridgeService.resolveVisualAsset({
      kind: 'item',
      slug: 'unsafe-md',
      role: 'item_icon',
    });
    expect(result.status).toBe('unsupported_extension');
  });

  it('refuses absolute-path escapes in the asset path', async () => {
    const vaultRoot = await makeTempVaultRoot();
    VisualAssetBridgeService.setVaultRootsForTests([vaultRoot]);
    await seedVisualAssetsBridge([
      {
        kind: 'item',
        slug: 'unsafe-abs',
        mention: '@ABS',
        role: 'item_icon',
        path: '/etc/passwd.png',
        source_path: 'x.md',
      },
    ]);
    const result = await VisualAssetBridgeService.resolveVisualAsset({
      kind: 'item',
      slug: 'unsafe-abs',
      role: 'item_icon',
    });
    expect(result.status).toBe('path_escape');
  });

  it('refuses traversal escapes that would leave the root', async () => {
    const vaultRoot = await makeTempVaultRoot();
    VisualAssetBridgeService.setVaultRootsForTests([vaultRoot]);
    await seedVisualAssetsBridge([
      {
        kind: 'item',
        slug: 'unsafe-traversal',
        mention: '@T',
        role: 'item_icon',
        path: '../../../../etc/passwd.png',
        source_path: 'x.md',
      },
    ]);
    const result = await VisualAssetBridgeService.resolveVisualAsset({
      kind: 'item',
      slug: 'unsafe-traversal',
      role: 'item_icon',
    });
    expect(result.status).toBe('path_escape');
  });

  it('reports file_missing when the path is safe but no file exists on disk', async () => {
    const vaultRoot = await makeTempVaultRoot();
    VisualAssetBridgeService.setVaultRootsForTests([vaultRoot]);
    await seedVisualAssetsBridge([
      {
        kind: 'item',
        slug: 'ghost',
        mention: '@G',
        role: 'item_icon',
        path: 'GreenHavenWorld/items/@G/images/icon.png',
        source_path: 'x.md',
      },
    ]);
    const result = await VisualAssetBridgeService.resolveVisualAsset({
      kind: 'item',
      slug: 'ghost',
      role: 'item_icon',
    });
    expect(result.status).toBe('file_missing');
  });
});
