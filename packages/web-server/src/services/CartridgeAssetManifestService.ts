/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-5 — cartridge asset contract.
//
// Reads the generated `audit/visual-assets.jsonl` catalog from a
// Forge project (or any source that ships a compatible JSONL list),
// resolves each row to a real file under the allowlisted vault
// roots, copies the bytes into a deterministic per-cartridge asset
// cache under `<data-dir>/cartridges/<cartridge-id>/assets/<hash>.<ext>`,
// and returns a manifest that the apply pipeline persists into
// `cartridge_meta_scoped.forge_visual_assets`. Despite the legacy
// key name, this manifest also carries cartridge boot media
// (`media/boot/*.mp3`, `*.mp4`, etc.) because the cache + serving
// contract is the same: safe row, hash, content type, cached bytes.
//
// At runtime the visual-asset serving route resolves
// `(cartridge_id, kind, slug, role?)` against this scoped manifest
// and streams bytes from the cache. The legacy global
// `cartridge_meta.forge_visual_assets` remains for OWV-17 dev paths
// and tests; the installed cartridge path uses scoped meta + cache.

import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {copyFile, mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from '../config.js';

export const ASSET_MANIFEST_SCHEMA_VERSION =
  'greenhaven.cartridge_assets.v1';
export const ASSET_MANIFEST_META_KEY = 'forge_visual_assets';

const ALLOWED_EXTENSIONS = new Set([
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

export interface CartridgeAssetEntry {
  asset_id: string;
  kind: string;
  slug: string;
  role: string;
  mention: string;
  source_path: string;
  content_hash: string;
  /** Relative path under the cartridge cache root
   *  (`<data-dir>/cartridges/<cartridge-id>/assets/`). */
  cache_path: string;
  content_type: string;
  extension: string;
  /** `available` — file present in cache.
   *  `missing` — source file did not resolve under any vault root.
   *  `unsupported_extension` — file extension not in the allowlist. */
  status: 'available' | 'missing' | 'unsupported_extension';
}

export interface CartridgeAssetManifest {
  schema_version: typeof ASSET_MANIFEST_SCHEMA_VERSION;
  cartridge_id: string;
  cache_root: string;
  source_path: string;
  generated_at: string;
  counts: {
    total: number;
    available: number;
    missing: number;
    unsupported_extension: number;
  };
  rows: CartridgeAssetEntry[];
}

export interface BuildManifestOptions {
  cartridgeId: string;
  /** Path to the Forge project / agent pack root. The manifest
   *  service looks for `audit/visual-assets.jsonl` underneath. */
  sourcePath: string;
  /** Override the data-dir used to compute the cache root. When
   *  omitted, the config-resolved data dir is used (or a repo-
   *  relative `pgdata`/`assets` fallback). */
  dataDirOverride?: string;
  /** Override the vault roots used to locate authored asset files.
   *  When omitted, the resolver consults `GREENHAVEN_VAULT_ROOTS` /
   *  `GREENHAVEN_VAULT_ROOT` env vars and falls back to the
   *  repo-relative `GreenhavenWorld/` directory. */
  vaultRootsOverride?: string[];
}

export interface BuildManifestResult {
  manifest: CartridgeAssetManifest;
  /** Absolute path to the cache root (created if missing). */
  cacheRootAbs: string;
  /** Number of files actually copied (`<= counts.available`). */
  filesCopied: number;
  /** Source file paths that did not resolve under any vault root. */
  missingPaths: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function resolveDataDir(override?: string): string {
  if (override && override.trim().length > 0) return path.resolve(override);
  const cfg = config();
  if (cfg.dataDir && cfg.dataDir.trim().length > 0) {
    return path.resolve(cfg.dataDir);
  }
  return path.resolve(REPO_ROOT, 'packages', 'web-server', 'pgdata');
}

function resolveVaultRoots(override?: string[], sourcePath?: string): string[] {
  const collected: string[] = [];
  if (override && override.length > 0) {
    for (const seg of override) {
      if (typeof seg === 'string' && seg.trim()) collected.push(seg.trim());
    }
  } else {
    const fromEnvMulti = process.env['GREENHAVEN_VAULT_ROOTS'];
    const fromEnvSingle = process.env['GREENHAVEN_VAULT_ROOT'];
    if (fromEnvMulti) {
      for (const seg of fromEnvMulti.split(path.delimiter)) {
        const trimmed = seg.trim();
        if (trimmed) collected.push(trimmed);
      }
    }
    if (fromEnvSingle && fromEnvSingle.trim()) {
      collected.push(fromEnvSingle.trim());
    }
    collected.push(path.resolve(REPO_ROOT, 'GreenhavenWorld'));
  }
  for (const root of deriveVaultRootsFromSourcePath(sourcePath)) {
    collected.push(root);
  }
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
  return out;
}

function deriveVaultRootsFromSourcePath(sourcePath?: string): string[] {
  if (!sourcePath || !sourcePath.trim()) return [];
  const out: string[] = [];
  let cursor = path.resolve(sourcePath);
  for (let i = 0; i < 12; i++) {
    if (hasActiveWorldDir(cursor)) {
      out.push(cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return out;
}

function safeWorldDir(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/`/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    !cleaned ||
    cleaned.startsWith('/') ||
    cleaned.includes(':') ||
    cleaned === '..' ||
    cleaned.startsWith('../') ||
    cleaned.includes('/../') ||
    cleaned.includes('/')
  ) {
    return null;
  }
  return cleaned;
}

function activeWorldDirFromManifest(root: string): string | null {
  const manifest = path.join(root, 'WORLD_MANIFEST.md');
  if (!existsSync(manifest)) return null;
  try {
    const text = readFileSync(manifest, 'utf8');
    const match = text.match(/^##\s+Active World Root\s*([\s\S]*?)(?=^##\s+|$)/im);
    if (!match) return null;
    const block = match[1] ?? '';
    const code = block.match(/```(?:text|md|markdown)?\s*([\s\S]*?)\s*```/i);
    const candidates = [code?.[1], ...block.split(/\r?\n/)];
    for (const candidate of candidates) {
      const dir = safeWorldDir(candidate);
      if (dir && existsSync(path.join(root, dir))) return dir;
    }
  } catch {
    return null;
  }
  return null;
}

function hasActiveWorldDir(root: string): boolean {
  const active = activeWorldDirFromManifest(root);
  if (active && existsSync(path.join(root, active))) return true;
  if (existsSync(path.join(root, 'GreenHavenWorld'))) return true;
  try {
    return readdirSync(root, {withFileTypes: true}).some(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        existsSync(path.join(root, entry.name, 'Locations')),
    );
  } catch {
    return false;
  }
}

function resolveUnderRoot(root: string, rel: string): string | null {
  if (!root) return null;
  if (path.isAbsolute(rel)) return null;
  if (/^[a-zA-Z]+:[\\/]/.test(rel)) return null;
  if (/^\\\\/.test(rel)) return null;
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

function resolveSourceFile(
  vaultRoots: string[],
  rel: string,
): string | null {
  for (const root of vaultRoots) {
    const candidate = resolveUnderRoot(root, rel);
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface RawVisualAssetRow {
  kind?: unknown;
  slug?: unknown;
  role?: unknown;
  mention?: unknown;
  path?: unknown;
  source_path?: unknown;
}

function parseJsonlRows(raw: string): RawVisualAssetRow[] {
  const out: RawVisualAssetRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RawVisualAssetRow;
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // Skip malformed lines; the validator already flagged them.
    }
  }
  return out;
}

function makeAssetId(kind: string, slug: string, role: string): string {
  const triple = `${kind.toLowerCase()}|${slug.toLowerCase()}|${role.toLowerCase()}`;
  return createHash('sha256').update(triple).digest('hex').slice(0, 16);
}

export function getCartridgeAssetCacheRoot(
  dataDir: string,
  cartridgeId: string,
): string {
  return path.join(
    path.resolve(dataDir),
    'cartridges',
    cartridgeId,
    'assets',
  );
}

export async function buildCartridgeAssetManifest(
  opts: BuildManifestOptions,
): Promise<BuildManifestResult> {
  const generatedAt = new Date().toISOString();
  const dataDir = resolveDataDir(opts.dataDirOverride);
  const cacheRootAbs = getCartridgeAssetCacheRoot(dataDir, opts.cartridgeId);
  await mkdir(cacheRootAbs, {recursive: true});

  const jsonlPath = path.join(opts.sourcePath, 'audit', 'visual-assets.jsonl');
  const rows: CartridgeAssetEntry[] = [];
  let filesCopied = 0;
  const missingPaths: string[] = [];
  let availableCount = 0;
  let missingCount = 0;
  let unsupportedCount = 0;

  if (existsSync(jsonlPath)) {
    const raw = await readFile(jsonlPath, 'utf8');
    const parsed = parseJsonlRows(raw);
    const vaultRoots = resolveVaultRoots(opts.vaultRootsOverride, opts.sourcePath);

    for (const r of parsed) {
      const kind = typeof r.kind === 'string' ? r.kind.trim().toLowerCase() : '';
      const slug = typeof r.slug === 'string' ? r.slug.trim().toLowerCase() : '';
      const role = typeof r.role === 'string' ? r.role.trim().toLowerCase() : '';
      const relPath = typeof r.path === 'string' ? r.path.trim() : '';
      if (!kind || !slug || !role || !relPath) continue;
      const mention =
        typeof r.mention === 'string' && r.mention.trim()
          ? r.mention.trim()
          : `@${slug}`;
      const sourcePath = typeof r.source_path === 'string' ? r.source_path : '';

      const ext = path.extname(relPath).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        rows.push({
          asset_id: makeAssetId(kind, slug, role),
          kind,
          slug,
          role,
          mention,
          source_path: relPath,
          content_hash: '',
          cache_path: '',
          content_type: 'application/octet-stream',
          extension: ext,
          status: 'unsupported_extension',
        });
        unsupportedCount += 1;
        continue;
      }

      const abs = resolveSourceFile(vaultRoots, relPath);
      if (!abs) {
        rows.push({
          asset_id: makeAssetId(kind, slug, role),
          kind,
          slug,
          role,
          mention,
          source_path: relPath,
          content_hash: '',
          cache_path: '',
          content_type: CONTENT_TYPE_BY_EXTENSION[ext] ?? 'application/octet-stream',
          extension: ext,
          status: 'missing',
        });
        missingCount += 1;
        missingPaths.push(relPath);
        continue;
      }

      const bytes = await readFile(abs);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const cacheFilename = `${hash}${ext}`;
      const cacheAbs = path.join(cacheRootAbs, cacheFilename);
      if (!existsSync(cacheAbs)) {
        await copyFile(abs, cacheAbs);
        filesCopied += 1;
      }
      rows.push({
        asset_id: makeAssetId(kind, slug, role),
        kind,
        slug,
        role,
        mention,
        source_path: sourcePath || relPath,
        content_hash: hash,
        cache_path: cacheFilename,
        content_type:
          CONTENT_TYPE_BY_EXTENSION[ext] ?? 'application/octet-stream',
        extension: ext,
        status: 'available',
      });
      availableCount += 1;
    }
  }

  const manifest: CartridgeAssetManifest = {
    schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
    cartridge_id: opts.cartridgeId,
    cache_root: path
      .relative(dataDir, cacheRootAbs)
      .replace(/\\/g, '/'),
    source_path: opts.sourcePath,
    generated_at: generatedAt,
    counts: {
      total: rows.length,
      available: availableCount,
      missing: missingCount,
      unsupported_extension: unsupportedCount,
    },
    rows,
  };

  return {manifest, cacheRootAbs, filesCopied, missingPaths};
}

export interface ResolveScopedAssetResult {
  entry: CartridgeAssetEntry;
  cacheAbsolutePath: string;
  cacheRoot: string;
}

export type ResolveScopedAssetLookup =
  | {status: 'ok'; resolved: ResolveScopedAssetResult}
  | {status: 'unknown_entry'}
  | {status: 'unsupported_extension'; extension: string}
  | {status: 'file_missing'; cacheAbsolutePath: string};

export function resolveScopedAssetFromManifest(
  manifest: CartridgeAssetManifest,
  opts: {kind: string; slug: string; role?: string; dataDir: string},
): ResolveScopedAssetLookup {
  const kind = opts.kind.trim().toLowerCase();
  const slug = opts.slug.trim().toLowerCase();
  const role = opts.role ? opts.role.trim().toLowerCase() : '';
  if (!kind || !slug) return {status: 'unknown_entry'};

  let match: CartridgeAssetEntry | null = null;
  if (role) {
    for (const row of manifest.rows) {
      if (row.kind === kind && row.slug === slug && row.role === role) {
        match = row;
        break;
      }
    }
  }
  if (!match) {
    for (const row of manifest.rows) {
      if (row.kind === kind && row.slug === slug) {
        match = row;
        break;
      }
    }
  }
  if (!match) return {status: 'unknown_entry'};
  if (match.status === 'unsupported_extension') {
    return {
      status: 'unsupported_extension',
      extension: match.extension,
    };
  }
  const cacheRoot = getCartridgeAssetCacheRoot(opts.dataDir, manifest.cartridge_id);
  if (match.status !== 'available' || !match.cache_path) {
    return {
      status: 'file_missing',
      cacheAbsolutePath: path.join(cacheRoot, match.cache_path || ''),
    };
  }
  const cacheAbs = path.join(cacheRoot, match.cache_path);
  if (!existsSync(cacheAbs)) {
    return {status: 'file_missing', cacheAbsolutePath: cacheAbs};
  }
  return {
    status: 'ok',
    resolved: {entry: match, cacheAbsolutePath: cacheAbs, cacheRoot},
  };
}

export function parseScopedManifestPayload(
  raw: unknown,
): CartridgeAssetManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj['schema_version'] !== ASSET_MANIFEST_SCHEMA_VERSION) return null;
  const rowsRaw = obj['rows'];
  if (!Array.isArray(rowsRaw)) return null;
  const rows: CartridgeAssetEntry[] = [];
  for (const r of rowsRaw) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const status = row['status'];
    if (
      status !== 'available' &&
      status !== 'missing' &&
      status !== 'unsupported_extension'
    ) {
      continue;
    }
    rows.push({
      asset_id: String(row['asset_id'] ?? ''),
      kind: String(row['kind'] ?? '').toLowerCase(),
      slug: String(row['slug'] ?? '').toLowerCase(),
      role: String(row['role'] ?? '').toLowerCase(),
      mention: String(row['mention'] ?? ''),
      source_path: String(row['source_path'] ?? ''),
      content_hash: String(row['content_hash'] ?? ''),
      cache_path: String(row['cache_path'] ?? ''),
      content_type: String(row['content_type'] ?? 'application/octet-stream'),
      extension: String(row['extension'] ?? ''),
      status,
    });
  }
  const counts = (obj['counts'] as Record<string, unknown> | undefined) ?? {};
  return {
    schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
    cartridge_id: String(obj['cartridge_id'] ?? ''),
    cache_root: String(obj['cache_root'] ?? ''),
    source_path: String(obj['source_path'] ?? ''),
    generated_at: String(obj['generated_at'] ?? ''),
    counts: {
      total: Number(counts['total'] ?? rows.length),
      available: Number(counts['available'] ?? 0),
      missing: Number(counts['missing'] ?? 0),
      unsupported_extension: Number(counts['unsupported_extension'] ?? 0),
    },
    rows,
  };
}

export const __testing = {
  resolveSourceFile,
  resolveVaultRoots,
  resolveDataDir,
};
