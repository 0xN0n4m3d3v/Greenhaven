/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `GET /api/assets/world/:kind/:slug/:role?` route
// contract.
//
// The route stays thin: it validates URL segments, calls
// `resolveVisualAsset`, and turns the discriminated result into a
// status code. The service is mocked so each branch can be
// exercised without a PGlite fixture and without writing image
// bytes for every case.
//
//   * unknown_entry        → 404 unknown_asset
//   * unsupported_extension → 415 unsupported_extension
//   * path_escape          → 400 asset_path_rejected
//   * file_missing         → 404 asset_file_missing
//   * ok                   → 200 with image bytes + content-type
//
// URL-level safety guard ALSO rejects traversal-shaped segments
// before reaching the service.

import {Hono} from 'hono';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

type Lookup =
  import('../../services/VisualAssetBridgeService.js').VisualAssetLookup;
type VisualAssetEntry =
  import('../../services/VisualAssetBridgeService.js').VisualAssetEntry;

const serviceState = vi.hoisted(() => ({
  next: undefined as Lookup | undefined,
  lastArgs: undefined as undefined | {kind: string; slug: string; role?: string; cartridgeId?: string | null},
}));

vi.mock('../../services/VisualAssetBridgeService.js', () => ({
  resolveVisualAsset: vi.fn(async (opts: {kind: string; slug: string; role?: string; cartridgeId?: string | null}) => {
    serviceState.lastArgs = opts;
    if (!serviceState.next) {
      return {status: 'unknown_entry'} satisfies Lookup;
    }
    return serviceState.next;
  }),
}));

let visualAssetRoutes: typeof import('../../routes/visualAssets.js').visualAssetRoutes;
let app: Hono;
let tempDir = '';

beforeAll(async () => {
  ({visualAssetRoutes} = await import('../../routes/visualAssets.js'));
  app = new Hono();
  app.route('/api/assets', visualAssetRoutes);
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'owv17-visual-route-'));
});

afterAll(async () => {
  await rm(tempDir, {recursive: true, force: true});
});

beforeEach(() => {
  serviceState.next = undefined;
  serviceState.lastArgs = undefined;
});

function makeEntry(overrides: Partial<VisualAssetEntry> = {}): VisualAssetEntry {
  return {
    kind: 'item',
    slug: 'demo-item',
    mention: '@Demo',
    role: 'item_icon',
    path: 'GreenHavenWorld/items/@Demo/images/icon.png',
    sourcePath: 'x.md',
    ...overrides,
  };
}

describe('visualAssetRoutes (OWV-17)', () => {
  it('returns 200 + image bytes + content-type when the asset is present', async () => {
    const filePath = path.join(tempDir, 'icon.png');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, bytes);
    serviceState.next = {
      status: 'ok',
      resolved: {
        entry: makeEntry(),
        absolutePath: filePath,
        contentType: 'image/png',
      },
    };
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/demo-item/item_icon'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(bytes);
    expect(serviceState.lastArgs).toEqual({
      kind: 'item',
      slug: 'demo-item',
      role: 'item_icon',
      cartridgeId: null,
    });
  });

  it('returns 404 unknown_asset when the bridge has no row', async () => {
    serviceState.next = {status: 'unknown_entry'};
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/missing-item'),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unknown_asset');
  });

  it('returns 415 unsupported_extension for non-image authored paths', async () => {
    serviceState.next = {status: 'unsupported_extension', extension: '.md'};
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/markdown-item/item_icon'),
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unsupported_extension');
    expect(body.extension).toBe('.md');
  });

  it('returns 400 asset_path_rejected when the bridge path tries to escape the vault root', async () => {
    serviceState.next = {status: 'path_escape'};
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/escape-item/item_icon'),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('asset_path_rejected');
  });

  it('returns 404 asset_file_missing when the catalog points at a non-existent file', async () => {
    serviceState.next = {status: 'file_missing', absolutePath: '/nope'};
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/ghost/item_icon'),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('asset_file_missing');
  });

  it('rejects traversal-shaped URL segments before reaching the service', async () => {
    // The Hono router rejects `..` inside a URL segment before the
    // handler runs (the segment matches `/:slug` literally, so `..`
    // arrives as the slug value). The route's `isSafeSegment` guard
    // catches it. Service must not be invoked.
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/..%2Fevil/item_icon'),
    );
    expect(res.status).toBe(400);
    expect(serviceState.lastArgs).toBeUndefined();
  });

  it('rejects URL segments containing slashes or drive letters', async () => {
    const driveRes = await app.fetch(
      new Request('http://test/api/assets/world/item/c:bad/item_icon'),
    );
    expect(driveRes.status).toBe(400);
    expect(serviceState.lastArgs).toBeUndefined();
  });

  it('serves SVG with strict CSP + nosniff active-content headers', async () => {
    const filePath = path.join(tempDir, 'icon.svg');
    const bytes = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, bytes);
    serviceState.next = {
      status: 'ok',
      resolved: {
        entry: makeEntry({path: 'GreenHavenWorld/items/@Demo/images/icon.svg'}),
        absolutePath: filePath,
        contentType: 'image/svg+xml',
      },
    };
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/demo-item/item_icon'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp!).toContain("default-src 'none'");
    expect(csp!).toContain('sandbox');
  });

  it('does not attach SVG-only CSP to non-SVG image responses', async () => {
    const filePath = path.join(tempDir, 'plain.png');
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    serviceState.next = {
      status: 'ok',
      resolved: {
        entry: makeEntry(),
        absolutePath: filePath,
        contentType: 'image/png',
      },
    };
    const res = await app.fetch(
      new Request('http://test/api/assets/world/item/demo-item/item_icon'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});
