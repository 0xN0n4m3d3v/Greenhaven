/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 + FEAT-ENGINE-BASELINE-5 — visual-asset serving route.
//
// Two URL surfaces share the same resolver/streaming code:
//
//   `GET /api/assets/cartridges/:cartridgeId/world/:kind/:slug/:role?`
//     The cartridge-scoped surface. Reads
//     `cartridge_meta_scoped.forge_visual_assets` for that
//     cartridge, resolves `(kind, slug, role?)` against the scoped
//     manifest, and streams bytes from the installed cartridge
//     asset cache (`<data-dir>/cartridges/<cartridge-id>/assets/`).
//
//   `GET /api/assets/world/:kind/:slug/:role?`
//     Backwards-compatible default-cartridge surface. Resolves the
//     active default cartridge (via `getDefaultCartridgeId()`); if
//     it has a scoped manifest, the request is served from cache.
//     Otherwise the OWV-17 vault-bridge fallback streams the
//     authored vault file via `VisualAssetBridgeService`.
//
// The route refuses unknown rows, missing files, traversal
// attempts, and unsupported file extensions before any read so it
// can never be coerced into reading authored Markdown or arbitrary
// repo files. SVGs are sandboxed with a strict CSP + `nosniff`
// header to neutralise inline scripts.

import {Hono, type Context} from 'hono';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from '../config.js';
import {query} from '../db.js';
import {
  ASSET_MANIFEST_META_KEY,
  getCartridgeAssetCacheRoot,
  parseScopedManifestPayload,
  resolveScopedAssetFromManifest,
  type CartridgeAssetManifest,
} from '../services/CartridgeAssetManifestService.js';
import {resolveVisualAsset} from '../services/VisualAssetBridgeService.js';

export const visualAssetRoutes = new Hono();

visualAssetRoutes.get(
  '/cartridges/:cartridgeId/world/:kind/:slug/:role?',
  async (c) => {
    const cartridgeId = c.req.param('cartridgeId');
    const kindRaw = c.req.param('kind');
    const slugRaw = c.req.param('slug');
    const roleRaw = c.req.param('role');
    if (!isSafeCartridgeId(cartridgeId)) {
      return c.json({error: 'invalid_cartridge_id'}, 400);
    }
    if (!isSafeSegment(kindRaw) || !isSafeSegment(slugRaw)) {
      return c.json({error: 'invalid_asset_key'}, 400);
    }
    if (roleRaw && !isSafeSegment(roleRaw)) {
      return c.json({error: 'invalid_asset_role'}, 400);
    }
    const manifest = await loadScopedManifest(cartridgeId);
    if (!manifest) return c.json({error: 'unknown_cartridge_manifest'}, 404);
    const resp = await resolveAndStream(c, manifest, {
      kind: kindRaw,
      slug: slugRaw,
      role: roleRaw ?? undefined,
    });
    return resp ?? c.json({error: 'unknown_asset'}, 404);
  },
);

visualAssetRoutes.get('/world/:kind/:slug/:role?', async (c) => {
  const kindRaw = c.req.param('kind');
  const slugRaw = c.req.param('slug');
  const roleRaw = c.req.param('role');
  if (!isSafeSegment(kindRaw) || !isSafeSegment(slugRaw)) {
    return c.json({error: 'invalid_asset_key'}, 400);
  }
  if (roleRaw && !isSafeSegment(roleRaw)) {
    return c.json({error: 'invalid_asset_role'}, 400);
  }

  // FEAT-ENGINE-BASELINE-5 — when the active default cartridge has
  // a scoped manifest, that manifest is authoritative for asset
  // resolution. We MUST NOT fall back to the legacy vault bridge on
  // `unknown_entry` because a reimport that removed an asset would
  // otherwise still serve the stale vault file. The vault bridge
  // fallback applies only when no scoped manifest exists (legacy /
  // dev paths without an installed cartridge).
  const defaultCartridge = await resolveDefaultCartridgeId();
  if (defaultCartridge && isSafeCartridgeId(defaultCartridge)) {
    const manifest = await loadScopedManifest(defaultCartridge);
    if (manifest) {
      const scoped = await resolveAndStream(c, manifest, {
        kind: kindRaw,
        slug: slugRaw,
        role: roleRaw ?? undefined,
      });
      return scoped ?? c.json({error: 'unknown_asset'}, 404);
    }
  }

  return serveFromVaultBridge(c, kindRaw, slugRaw, roleRaw ?? undefined, defaultCartridge);
});

/** Resolve the active default cartridge id from
 *  `cartridge_meta.cartridge_id` (legacy global). Returns null when
 *  no default is recorded — fresh baselines without an installed
 *  cartridge fall back to the vault bridge. */
async function resolveDefaultCartridgeId(): Promise<string | null> {
  try {
    const r = await query<{value: string | null}>(
      `SELECT (value #>> '{}')::text AS value
         FROM cartridge_meta WHERE key = 'cartridge_id'`,
    );
    const v = r.rows[0]?.value;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function loadScopedManifest(
  cartridgeId: string,
): Promise<CartridgeAssetManifest | null> {
  try {
    const row = await query<{value: unknown}>(
      `SELECT value FROM cartridge_meta_scoped
        WHERE cartridge_id = $1 AND key = $2`,
      [cartridgeId, ASSET_MANIFEST_META_KEY],
    );
    if (!row.rows[0]) return null;
    return parseScopedManifestPayload(row.rows[0].value);
  } catch {
    return null;
  }
}

interface ResolveOpts {
  kind: string;
  slug: string;
  role?: string;
}

async function resolveAndStream(
  c: Context,
  manifest: CartridgeAssetManifest,
  opts: ResolveOpts,
): Promise<Response | null> {
  const dataDir = resolveDataDir();
  const lookup = resolveScopedAssetFromManifest(manifest, {
    kind: opts.kind,
    slug: opts.slug,
    role: opts.role,
    dataDir,
  });
  if (lookup.status === 'unknown_entry') {
    return c.json({error: 'unknown_asset'}, 404);
  }
  if (lookup.status === 'unsupported_extension') {
    return c.json(
      {error: 'unsupported_extension', extension: lookup.extension},
      415,
    );
  }
  if (lookup.status === 'file_missing') {
    return c.json({error: 'asset_file_missing'}, 404);
  }
  const {entry, cacheAbsolutePath, cacheRoot} = lookup.resolved;
  // Defensive containment check: the resolved cache path must live
  // under the cartridge cache root. The earlier validation already
  // ensures the cache_path is a single filename, but this catches
  // any future drift in the manifest shape.
  const cacheRootKey = path.resolve(cacheRoot).toLowerCase();
  const candidateKey = path.resolve(cacheAbsolutePath).toLowerCase();
  if (
    candidateKey !== cacheRootKey &&
    !candidateKey.startsWith(`${cacheRootKey}${path.sep}`)
  ) {
    return c.json({error: 'asset_path_rejected'}, 400);
  }
  try {
    const data = await readFile(cacheAbsolutePath);
    const headers: Record<string, string> = {
      'content-type': entry.content_type,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    };
    if (entry.content_type === 'image/svg+xml') {
      headers['content-security-policy'] =
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
    }
    return new Response(data, {headers});
  } catch {
    return c.json({error: 'asset_file_missing'}, 404);
  }
}

async function serveFromVaultBridge(
  c: Context,
  kind: string,
  slug: string,
  role: string | undefined,
  cartridgeId: string | null,
): Promise<Response> {
  const lookup = await resolveVisualAsset({kind, slug, role, cartridgeId});
  if (lookup.status === 'unknown_entry') {
    return c.json({error: 'unknown_asset'}, 404);
  }
  if (lookup.status === 'unsupported_extension') {
    return c.json(
      {error: 'unsupported_extension', extension: lookup.extension},
      415,
    );
  }
  if (lookup.status === 'path_escape') {
    return c.json({error: 'asset_path_rejected'}, 400);
  }
  if (lookup.status === 'file_missing') {
    return c.json({error: 'asset_file_missing'}, 404);
  }
  const {resolved} = lookup;
  try {
    const data = await readFile(resolved.absolutePath);
    const headers: Record<string, string> = {
      'content-type': resolved.contentType,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    };
    if (resolved.contentType === 'image/svg+xml') {
      headers['content-security-policy'] =
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
    }
    return new Response(data, {headers});
  } catch {
    return c.json({error: 'asset_file_missing'}, 404);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function resolveDataDir(): string {
  const cfg = config();
  if (cfg.dataDir && cfg.dataDir.trim().length > 0) {
    return path.resolve(cfg.dataDir);
  }
  return path.resolve(REPO_ROOT, 'packages', 'web-server', 'pgdata');
}

/** Cartridge ids are minted by the import pipeline. Accept ASCII
 *  alphanumeric + hyphen so the route can never read outside the
 *  intended cartridge cache directory. */
function isSafeCartridgeId(value: string | undefined | null): boolean {
  if (!value) return false;
  if (value.length > 64) return false;
  if (value.includes('..')) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value.startsWith('.')) return false;
  return getCartridgeAssetCacheRoot('', value) !== ''
    && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

/** Routing safety guard: only allow URL segments that look like
 *  vault slugs / kind tags. Refuses `..`, `/`, `\`, leading dots,
 *  drive letters, and percent-encoded escapes that survived the
 *  framework decoder. */
function isSafeSegment(value: string | undefined | null): boolean {
  if (!value) return false;
  if (value.length > 200) return false;
  if (value.includes('..')) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value.startsWith('.')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.includes('%')) return false;
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}
