/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-5 — `CartridgeAssetManifestService` unit
// tests. The service is exercised end-to-end by the
// `cartridge:default:install-smoke` script; this suite locks down
// the per-row shape, hash determinism, fallback statuses
// (`missing`, `unsupported_extension`), and cache-path containment.

import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ASSET_MANIFEST_SCHEMA_VERSION,
  buildCartridgeAssetManifest,
  getCartridgeAssetCacheRoot,
  parseScopedManifestPayload,
  resolveScopedAssetFromManifest,
} from '../../services/CartridgeAssetManifestService.js';

let tempRoot: string | null = null;

beforeEach(async () => {
  tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'cartridge-asset-manifest-'),
  );
});

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, {recursive: true, force: true});
    tempRoot = null;
  }
});

async function writeVaultFile(
  vaultRoot: string,
  rel: string,
  bytes: Buffer | string,
): Promise<void> {
  const abs = path.join(vaultRoot, rel);
  await mkdir(path.dirname(abs), {recursive: true});
  await writeFile(abs, bytes);
}

async function writeJsonl(
  sourcePath: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const auditDir = path.join(sourcePath, 'audit');
  await mkdir(auditDir, {recursive: true});
  await writeFile(
    path.join(auditDir, 'visual-assets.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
}

describe('CartridgeAssetManifestService', () => {
  it('copies resolved files into the cache and reports counts', async () => {
    if (!tempRoot) throw new Error('no temp root');
    const dataDir = path.join(tempRoot, 'data');
    const sourcePath = path.join(tempRoot, 'forge');
    const vaultRoot = path.join(tempRoot, 'vault');
    await mkdir(sourcePath, {recursive: true});
    await mkdir(vaultRoot, {recursive: true});

    // PNG magic header so the bytes look real to consumers.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeVaultFile(
      vaultRoot,
      'GreenHavenWorld/Items/@Test/images/icon.png',
      png,
    );

    await writeJsonl(sourcePath, [
      {
        kind: 'item',
        slug: 'test',
        role: 'item_icon',
        mention: '@Test',
        path: 'GreenHavenWorld/Items/@Test/images/icon.png',
        source_path: 'GreenHavenWorld/Items/@Test/TestMind.md',
      },
    ]);

    const result = await buildCartridgeAssetManifest({
      cartridgeId: 'unit-cart',
      sourcePath,
      dataDirOverride: dataDir,
      vaultRootsOverride: [vaultRoot],
    });

    expect(result.manifest.schema_version).toBe(ASSET_MANIFEST_SCHEMA_VERSION);
    expect(result.manifest.counts).toEqual({
      total: 1,
      available: 1,
      missing: 0,
      unsupported_extension: 0,
    });
    expect(result.filesCopied).toBe(1);

    const row = result.manifest.rows[0];
    if (!row) throw new Error('expected one manifest row');
    expect(row.kind).toBe('item');
    expect(row.slug).toBe('test');
    expect(row.role).toBe('item_icon');
    expect(row.status).toBe('available');
    expect(row.cache_path).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(row.content_type).toBe('image/png');

    const cacheRoot = getCartridgeAssetCacheRoot(dataDir, 'unit-cart');
    const cacheAbs = path.join(cacheRoot, row.cache_path);
    expect(existsSync(cacheAbs)).toBe(true);
    const onDisk = readFileSync(cacheAbs);
    expect(Buffer.compare(onDisk, png)).toBe(0);
  });

  it('copies cartridge boot video and music with media content types', async () => {
    if (!tempRoot) throw new Error('no temp root');
    const dataDir = path.join(tempRoot, 'data');
    const sourcePath = path.join(tempRoot, 'forge');
    const vaultRoot = path.join(tempRoot, 'vault');
    await mkdir(sourcePath, {recursive: true});
    await mkdir(vaultRoot, {recursive: true});

    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04]);
    await writeVaultFile(vaultRoot, 'GreenHavenWorld/media/boot/01.mp4', mp4);
    await writeVaultFile(vaultRoot, 'GreenHavenWorld/media/boot/01.mp3', mp3);

    await writeJsonl(sourcePath, [
      {
        kind: 'cartridge',
        slug: 'boot',
        role: 'boot_video_01',
        mention: '@Boot 01',
        path: 'GreenHavenWorld/media/boot/01.mp4',
      },
      {
        kind: 'cartridge',
        slug: 'boot',
        role: 'boot_music_01',
        mention: '@Boot 01',
        path: 'GreenHavenWorld/media/boot/01.mp3',
      },
    ]);

    const result = await buildCartridgeAssetManifest({
      cartridgeId: 'boot-cart',
      sourcePath,
      dataDirOverride: dataDir,
      vaultRootsOverride: [vaultRoot],
    });

    expect(result.manifest.counts).toEqual({
      total: 2,
      available: 2,
      missing: 0,
      unsupported_extension: 0,
    });
    const video = result.manifest.rows.find(
      (row) => row.role === 'boot_video_01',
    );
    const music = result.manifest.rows.find(
      (row) => row.role === 'boot_music_01',
    );
    expect(video?.content_type).toBe('video/mp4');
    expect(video?.cache_path).toMatch(/^[0-9a-f]{64}\.mp4$/);
    expect(music?.content_type).toBe('audio/mpeg');
    expect(music?.cache_path).toMatch(/^[0-9a-f]{64}\.mp3$/);
  });

  it('is idempotent — a second run hits the cache and copies zero new files', async () => {
    if (!tempRoot) throw new Error('no temp root');
    const dataDir = path.join(tempRoot, 'data');
    const sourcePath = path.join(tempRoot, 'forge');
    const vaultRoot = path.join(tempRoot, 'vault');
    await mkdir(sourcePath, {recursive: true});
    await mkdir(vaultRoot, {recursive: true});
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeVaultFile(
      vaultRoot,
      'GreenHavenWorld/Items/@A/images/icon.png',
      png,
    );
    await writeJsonl(sourcePath, [
      {
        kind: 'item',
        slug: 'a',
        role: 'item_icon',
        path: 'GreenHavenWorld/Items/@A/images/icon.png',
      },
    ]);
    const first = await buildCartridgeAssetManifest({
      cartridgeId: 'idem',
      sourcePath,
      dataDirOverride: dataDir,
      vaultRootsOverride: [vaultRoot],
    });
    expect(first.filesCopied).toBe(1);

    const second = await buildCartridgeAssetManifest({
      cartridgeId: 'idem',
      sourcePath,
      dataDirOverride: dataDir,
      vaultRootsOverride: [vaultRoot],
    });
    expect(second.filesCopied).toBe(0);
    expect(second.manifest.rows[0]?.cache_path).toBe(
      first.manifest.rows[0]?.cache_path,
    );
  });

  it('reports missing source files as status=missing without throwing', async () => {
    if (!tempRoot) throw new Error('no temp root');
    const dataDir = path.join(tempRoot, 'data');
    const sourcePath = path.join(tempRoot, 'forge');
    const vaultRoot = path.join(tempRoot, 'vault');
    await mkdir(sourcePath, {recursive: true});
    await mkdir(vaultRoot, {recursive: true});
    await writeJsonl(sourcePath, [
      {
        kind: 'npc',
        slug: 'ghost',
        role: 'portrait',
        path: 'GreenHavenWorld/NPCs/@Ghost/images/portrait.png',
      },
    ]);
    const result = await buildCartridgeAssetManifest({
      cartridgeId: 'miss',
      sourcePath,
      dataDirOverride: dataDir,
      vaultRootsOverride: [vaultRoot],
    });
    expect(result.manifest.counts).toEqual({
      total: 1,
      available: 0,
      missing: 1,
      unsupported_extension: 0,
    });
    expect(result.manifest.rows[0]?.status).toBe('missing');
    expect(result.missingPaths).toContain(
      'GreenHavenWorld/NPCs/@Ghost/images/portrait.png',
    );
  });

  it('flags unsupported file extensions before attempting to read', async () => {
    if (!tempRoot) throw new Error('no temp root');
    const dataDir = path.join(tempRoot, 'data');
    const sourcePath = path.join(tempRoot, 'forge');
    const vaultRoot = path.join(tempRoot, 'vault');
    await mkdir(sourcePath, {recursive: true});
    await mkdir(vaultRoot, {recursive: true});
    await writeJsonl(sourcePath, [
      {
        kind: 'item',
        slug: 'oddball',
        role: 'item_icon',
        path: 'GreenHavenWorld/Items/@Oddball/data.bin',
      },
    ]);
    const result = await buildCartridgeAssetManifest({
      cartridgeId: 'ext',
      sourcePath,
      dataDirOverride: dataDir,
      vaultRootsOverride: [vaultRoot],
    });
    expect(result.manifest.counts.unsupported_extension).toBe(1);
    expect(result.manifest.rows[0]?.status).toBe('unsupported_extension');
  });

  it('returns an empty manifest when audit/visual-assets.jsonl is absent', async () => {
    if (!tempRoot) throw new Error('no temp root');
    const dataDir = path.join(tempRoot, 'data');
    const sourcePath = path.join(tempRoot, 'forge');
    const vaultRoot = path.join(tempRoot, 'vault');
    await mkdir(sourcePath, {recursive: true});
    await mkdir(vaultRoot, {recursive: true});
    const result = await buildCartridgeAssetManifest({
      cartridgeId: 'noop',
      sourcePath,
      dataDirOverride: dataDir,
      vaultRootsOverride: [vaultRoot],
    });
    expect(result.manifest.counts.total).toBe(0);
    expect(result.manifest.rows).toEqual([]);
  });

  it('resolveScopedAssetFromManifest matches by (kind, slug, role) and falls back to first kind-slug entry', async () => {
    const manifest = parseScopedManifestPayload({
      schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
      cartridge_id: 'lookup',
      cache_root: 'cartridges/lookup/assets',
      source_path: '',
      generated_at: '',
      counts: {total: 2, available: 2, missing: 0, unsupported_extension: 0},
      rows: [
        {
          asset_id: 'a1',
          kind: 'item',
          slug: 'lantern',
          role: 'item_icon',
          mention: '@Lantern',
          source_path: '',
          content_hash: 'hash-a',
          cache_path: 'hash-a.png',
          content_type: 'image/png',
          extension: '.png',
          status: 'available',
        },
        {
          asset_id: 'a2',
          kind: 'item',
          slug: 'lantern',
          role: 'item_hero',
          mention: '@Lantern',
          source_path: '',
          content_hash: 'hash-b',
          cache_path: 'hash-b.png',
          content_type: 'image/png',
          extension: '.png',
          status: 'available',
        },
      ],
    });
    if (!manifest) throw new Error('manifest parse failed');

    // Cache dir does not exist on disk; the lookup should still find
    // the entry by triple/kind-slug — `file_missing` is the post-
    // resolution status, not unknown_entry.
    if (!tempRoot) throw new Error('no temp root');
    const dataDir = path.join(tempRoot, 'data');

    const triple = resolveScopedAssetFromManifest(manifest, {
      kind: 'item',
      slug: 'lantern',
      role: 'item_hero',
      dataDir,
    });
    expect(triple.status).toBe('file_missing');
    if (triple.status === 'file_missing') {
      expect(triple.cacheAbsolutePath.endsWith('hash-b.png')).toBe(true);
    }

    const noRole = resolveScopedAssetFromManifest(manifest, {
      kind: 'item',
      slug: 'lantern',
      dataDir,
    });
    expect(noRole.status).toBe('file_missing');
    if (noRole.status === 'file_missing') {
      expect(noRole.cacheAbsolutePath.endsWith('hash-a.png')).toBe(true);
    }

    const unknown = resolveScopedAssetFromManifest(manifest, {
      kind: 'item',
      slug: 'nope',
      dataDir,
    });
    expect(unknown.status).toBe('unknown_entry');
  });

  it('parseScopedManifestPayload rejects schema-version mismatches', () => {
    const bad = parseScopedManifestPayload({
      schema_version: 'something.else.v1',
      rows: [],
    });
    expect(bad).toBeNull();
  });

  it('resolves packaged forge-project assets from the source root ancestor', async () => {
    if (!tempRoot) throw new Error('no temp root');
    const dataDir = path.join(tempRoot, 'data');
    const sourceRoot = path.join(tempRoot, 'packaged-source');
    const sourcePath = path.join(
      sourceRoot,
      '.greenhaven-agent-manual',
      'generated',
      'cartridge-forge-project',
    );
    await mkdir(sourcePath, {recursive: true});

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeVaultFile(
      sourceRoot,
      'GreenHavenWorld/Locations/@City/@Port/npc/@Tamara/portraits/default.png',
      png,
    );
    await writeJsonl(sourcePath, [
      {
        kind: 'person',
        slug: 'tamara',
        role: 'portrait',
        mention: '@Tamara',
        path: 'GreenHavenWorld/Locations/@City/@Port/npc/@Tamara/portraits/default.png',
      },
    ]);

    const result = await buildCartridgeAssetManifest({
      cartridgeId: 'packaged-assets',
      sourcePath,
      dataDirOverride: dataDir,
    });

    expect(result.manifest.counts).toEqual({
      total: 1,
      available: 1,
      missing: 0,
      unsupported_extension: 0,
    });
    expect(result.manifest.rows[0]?.status).toBe('available');
    expect(result.manifest.rows[0]?.cache_path).toMatch(/^[0-9a-f]{64}\.png$/);
  });
});
