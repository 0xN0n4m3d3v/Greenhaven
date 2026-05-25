/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — visual-assets runtime read layer.
//
// Bridges the generated `forge_visual_assets` cartridge_meta
// document with the on-disk Greenhaven vault. The runtime resolves
// a `(kind, slug, role?)` triple to one asset entry, then maps the
// authored vault-relative path to an absolute filesystem path that
// lives inside an allowlisted vault root. Path resolution refuses
// traversal, absolute paths, and unsupported file extensions; the
// HTTP route on top reads the bytes and streams the response.
//
// The bridge meta is the only canonical source — production code
// must never read `audit/visual-assets.jsonl` directly at runtime.

import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { bridgeCacheKey, readScopedBridgeMeta } from './scopedBridgeMeta.js';

const BRIDGE_META_KEY = 'forge_visual_assets';
const BRIDGE_SCHEMA_VERSION = 'greenhaven.visual_assets.v1';

/** Allowlisted media extensions for the visual-asset serving route.
 *  The legacy key is still named `forge_visual_assets`, but the same
 *  safe bridge now serves card videos and cartridge music too. */
export const VISUAL_ASSET_ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.mp3',
  '.ogg',
  '.m4a',
  '.wav',
  '.mp4',
  '.webm',
]);

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export interface VisualAssetEntry {
  kind: string;
  slug: string;
  mention: string;
  role: string;
  /** Vault-relative path (forward slashes; starts with the inner
   *  vault dir, e.g. `GreenHavenWorld/...`). */
  path: string;
  sourcePath: string;
}

interface BuiltCatalog {
  rows: VisualAssetEntry[];
  /** Lookup index keyed as `${kind}|${slug}|${role}`. */
  byTriple: Map<string, VisualAssetEntry>;
  /** Secondary index keyed as `${kind}|${slug}` → first entry, so
   *  callers without an explicit role still get a deterministic
   *  asset back. */
  byKindSlug: Map<string, VisualAssetEntry>;
  /** Index keyed by raw vault path (forward slashes). Lets a
   *  scene-instruction renderer match its authored
   *  `visual_asset.path` to a bridge row when it needs the API URL.
   */
  byPath: Map<string, VisualAssetEntry>;
  bridgeAvailable: boolean;
}

interface RawBridgeMeta {
  schema_version?: unknown;
  source_project?: unknown;
  rows?: unknown;
}

export interface VisualAssetBridgeOptions {
  /** Active cartridge id. When omitted (or empty), the reader
   *  uses the legacy global `cartridge_meta` path only. */
  cartridgeId?: string | null;
}

const cachedCatalogByScope = new Map<string, Promise<BuiltCatalog>>();
let cachedRoots: string[] | null = null;

export function clearVisualAssetBridgeCache(): void {
  // Only the catalog (the cartridge_meta-derived rows) is dropped
  // here. The vault-roots cache is a separate concern — it tracks
  // env/test overrides for the on-disk read side — and must
  // survive cache flushes triggered by re-seeding the bridge.
  // Tests clear roots explicitly via `setVaultRootsForTests(null)`.
  cachedCatalogByScope.clear();
}

export async function isVisualAssetBridgeAvailable(
  opts?: VisualAssetBridgeOptions,
): Promise<boolean> {
  return (await getCatalog(opts)).bridgeAvailable;
}

export async function listVisualAssetEntries(
  opts?: VisualAssetBridgeOptions,
): Promise<VisualAssetEntry[]> {
  return (await getCatalog(opts)).rows;
}

/** Resolve one authored visual asset. When `role` is omitted, the
 *  catalog returns the first entry for the `(kind, slug)` pair in
 *  the sorted bridge order. */
export async function findVisualAssetEntry(opts: {
  kind: string;
  slug: string;
  role?: string;
  cartridgeId?: string | null;
}): Promise<VisualAssetEntry | null> {
  const catalog = await getCatalog({ cartridgeId: opts.cartridgeId });
  const kind = opts.kind.trim().toLowerCase();
  const slug = opts.slug.trim().toLowerCase();
  if (!kind || !slug) return null;
  if (opts.role && opts.role.trim()) {
    const role = opts.role.trim().toLowerCase();
    return catalog.byTriple.get(`${kind}|${slug}|${role}`) ?? null;
  }
  return catalog.byKindSlug.get(`${kind}|${slug}`) ?? null;
}

/** Match a vault-relative path back to an authored visual-asset
 *  row. Used by future broker renderers that want to turn a
 *  scene-instruction `visual_asset.path` into the safe API URL. */
export async function findVisualAssetByPath(
  rawPath: string,
  opts?: VisualAssetBridgeOptions,
): Promise<VisualAssetEntry | null> {
  const catalog = await getCatalog(opts);
  return catalog.byPath.get(normalizePath(rawPath)) ?? null;
}

export interface ResolvedVisualAsset {
  entry: VisualAssetEntry;
  absolutePath: string;
  contentType: string;
}

/** Resolve `(kind, slug, role?)` into an on-disk absolute path,
 *  enforcing the allowlist and verifying the file exists. Returns
 *  `{kind: 'not-found' | ...}` for non-200 cases so the HTTP route
 *  can pick the right status code without thrown errors. */
export type VisualAssetLookup =
  | {status: 'ok'; resolved: ResolvedVisualAsset}
  | {status: 'unknown_entry'}
  | {status: 'unsupported_extension'; extension: string}
  | {status: 'path_escape'}
  | {status: 'file_missing'; absolutePath: string};

export async function resolveVisualAsset(opts: {
  kind: string;
  slug: string;
  role?: string;
  cartridgeId?: string | null;
}): Promise<VisualAssetLookup> {
  const entry = await findVisualAssetEntry(opts);
  if (!entry) return {status: 'unknown_entry'};
  const ext = path.extname(entry.path).toLowerCase();
  if (!VISUAL_ASSET_ALLOWED_EXTENSIONS.has(ext)) {
    return {status: 'unsupported_extension', extension: ext};
  }
  const roots = getVaultRoots();
  for (const root of roots) {
    const candidate = resolveUnderRoot(root, entry.path);
    if (!candidate) continue;
    if (existsSync(candidate)) {
      return {
        status: 'ok',
        resolved: {
          entry,
          absolutePath: candidate,
          contentType: CONTENT_TYPE_BY_EXTENSION[ext] ?? 'application/octet-stream',
        },
      };
    }
  }
  // No root resolved without traversal AND none contained the
  // file. Disambiguate: if every root rejected the path as escape,
  // surface `path_escape`; otherwise the file is simply absent.
  const anyAccepted = roots.some(root => resolveUnderRoot(root, entry.path) !== null);
  if (!anyAccepted) return {status: 'path_escape'};
  const sampleRoot = roots[0] ?? '';
  const sampleAbs = resolveUnderRoot(sampleRoot, entry.path) ?? '';
  return {status: 'file_missing', absolutePath: sampleAbs};
}

function resolveUnderRoot(root: string, rel: string): string | null {
  if (!root) return null;
  // Reject absolute and protocol-style asset paths defensively.
  if (path.isAbsolute(rel)) return null;
  if (/^[a-zA-Z]+:[\\/]/.test(rel)) return null; // drive letters
  if (/^\\\\/.test(rel)) return null; // UNC
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, rel);
  const rootKey = normalizedRoot.toLowerCase();
  const resolvedKey = resolved.toLowerCase();
  if (
    resolvedKey !== rootKey &&
    !resolvedKey.startsWith(`${rootKey}${path.sep}`)
  ) {
    return null;
  }
  return resolved;
}

function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').trim();
}

async function getCatalog(opts?: VisualAssetBridgeOptions): Promise<BuiltCatalog> {
  const cacheKey = bridgeCacheKey(opts?.cartridgeId);
  const existing = cachedCatalogByScope.get(cacheKey);
  if (existing) return existing;
  const promise = buildCatalog(opts?.cartridgeId ?? null).catch(err => {
    cachedCatalogByScope.delete(cacheKey);
    throw err;
  });
  cachedCatalogByScope.set(cacheKey, promise);
  return promise;
}

async function buildCatalog(cartridgeId: string | null): Promise<BuiltCatalog> {
  const meta = await readScopedBridgeMeta<RawBridgeMeta>(BRIDGE_META_KEY, {
    cartridgeId,
  });
  const rows = parseRows(meta);
  if (rows.length === 0) {
    return {
      rows: [],
      byTriple: new Map(),
      byKindSlug: new Map(),
      byPath: new Map(),
      bridgeAvailable: false,
    };
  }
  const byTriple = new Map<string, VisualAssetEntry>();
  const byKindSlug = new Map<string, VisualAssetEntry>();
  const byPath = new Map<string, VisualAssetEntry>();
  for (const row of rows) {
    const tripleKey = `${row.kind}|${row.slug}|${row.role}`;
    if (!byTriple.has(tripleKey)) byTriple.set(tripleKey, row);
    const kindSlugKey = `${row.kind}|${row.slug}`;
    if (!byKindSlug.has(kindSlugKey)) byKindSlug.set(kindSlugKey, row);
    const pathKey = normalizePath(row.path);
    if (!byPath.has(pathKey)) byPath.set(pathKey, row);
  }
  return {rows, byTriple, byKindSlug, byPath, bridgeAvailable: true};
}

function parseRows(meta: RawBridgeMeta | undefined): VisualAssetEntry[] {
  if (!meta || typeof meta !== 'object') return [];
  if (meta.schema_version !== BRIDGE_SCHEMA_VERSION) return [];
  if (!Array.isArray(meta.rows)) return [];
  const out: VisualAssetEntry[] = [];
  for (const raw of meta.rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const kind = typeof r.kind === 'string' ? r.kind.trim().toLowerCase() : '';
    const slug = typeof r.slug === 'string' ? r.slug.trim().toLowerCase() : '';
    const role = typeof r.role === 'string' ? r.role.trim().toLowerCase() : '';
    const filePath = typeof r.path === 'string' ? r.path.trim() : '';
    if (!kind || !slug || !role || !filePath) continue;
    out.push({
      kind,
      slug,
      mention: typeof r.mention === 'string' ? r.mention : `@${slug}`,
      role,
      path: filePath,
      sourcePath: typeof r.source_path === 'string' ? r.source_path : '',
    });
  }
  return out;
}

/** Vault roots used to resolve authored asset paths. The first
 *  root that holds the asset wins. Lookup precedence:
 *   1. `GREENHAVEN_VAULT_ROOTS` env (path-separator delimited).
 *   2. `GREENHAVEN_VAULT_ROOT` env (single root).
 *   3. Repo-relative `<repoRoot>/GreenhavenWorld/`.
 *  All roots are resolved to absolute paths and de-duplicated.
 */
function getVaultRoots(): string[] {
  if (cachedRoots) return cachedRoots;
  const fromEnvMulti = process.env.GREENHAVEN_VAULT_ROOTS;
  const fromEnvSingle = process.env.GREENHAVEN_VAULT_ROOT;
  const collected: string[] = [];
  if (fromEnvMulti) {
    for (const seg of fromEnvMulti.split(path.delimiter)) {
      const trimmed = seg.trim();
      if (trimmed) collected.push(trimmed);
    }
  }
  if (fromEnvSingle && fromEnvSingle.trim()) {
    collected.push(fromEnvSingle.trim());
  }
  const repoFallback = repoVaultRoot();
  if (repoFallback) collected.push(repoFallback);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of collected) {
    const abs = path.resolve(root);
    const key = abs.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(abs);
    }
  }
  cachedRoots = out;
  return out;
}

function repoVaultRoot(): string | null {
  // This module sits at packages/web-server/src/services/, four
  // segments up from the repo root.
  try {
    const here = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(here), '..', '..', '..', '..');
    return path.resolve(repoRoot, 'GreenhavenWorld');
  } catch {
    return null;
  }
}

/** Test seam: install an explicit list of vault roots (absolute
 *  paths). Pass `null` to revert to env/repo defaults. */
export function setVaultRootsForTests(roots: string[] | null): void {
  if (roots === null) {
    cachedRoots = null;
    return;
  }
  cachedRoots = roots.map(r => path.resolve(r));
}
