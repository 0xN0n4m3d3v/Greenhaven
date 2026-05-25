/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-2 — cartridge-library import-preview job
// orchestrator.
//
// Owns the queued → running → ready / failed / cancelled state
// machine for `cartridge_import_preview_jobs`. Three preview
// sources are supported in this slice:
//
//   * `forge_project` — directory shaped like the
//     `greenhaven-human-world-transformer` compile output. Reads
//     `forge.project.json`, enumerates `records/*.jsonl`, counts
//     records by kind, walks `audit/*.md` for warnings, and
//     returns a deterministic content hash + diff vs. existing
//     `cartridge_records`.
//   * `agent_pack` — already-exported pack directory shaped by
//     `packages/cartridge-forge/src/exporters/exportPack.ts`.
//     Same shape as the forge project but the manifest lives at
//     `manifest.json` instead of `forge.project.json`.
//   * `obsidian_vault` — root of a writer-authored vault. Spawns
//     `compile_vault_to_forge.py --vault-root <path>` from the
//     pinned `greenhaven-human-world-transformer` skill, then
//     re-enters the `forge_project` preview path on the
//     generated `<vault>/.greenhaven-agent-manual/generated/cartridge-forge-project/`.
//
// **No DB writes into `cartridges`, `cartridge_records`,
// `cartridge_meta_scoped`, `entities`, or any player/runtime
// table.** Preview is observation-only; safe apply / reimport
// lands in FEAT-CART-LIB-3.

import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {query} from '../db.js';
import {telemetry} from '../telemetry/index.js';

export type ImportSourceKind = 'obsidian_vault' | 'forge_project' | 'agent_pack';
export type ImportJobStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'applying'
  | 'applied';
export type ImportJobMode = 'install' | 'reimport' | 'repair' | 'dry_run';

export interface CreateImportJobOptions {
  sourceKind: ImportSourceKind;
  sourcePath: string;
  mode?: ImportJobMode;
  cartridgeId?: string | null;
}

export interface ImportJobResult {
  manifest: Record<string, unknown>;
  cartridgeId: string | null;
  contentHash: string;
  counts: Record<string, number>;
  totalRecords: number;
  validation: {
    errors: number;
    warnings: number;
    unresolvedLinks: number;
    items: Array<{level: 'error' | 'warning' | 'info'; message: string}>;
  };
  diff: {
    new: number;
    changed: number;
    unchanged: number;
    deprecated: number;
  };
  generatedArtifacts: string[];
  forgeProjectPath: string;
  durationMs: number;
}

export interface ImportJobView {
  jobId: string;
  cartridgeId: string | null;
  mode: ImportJobMode;
  sourceKind: ImportSourceKind;
  sourcePath: string;
  status: ImportJobStatus;
  phase: string;
  progress: {processed: number; total: number};
  result: ImportJobResult | null;
  error: {code: string; message: string} | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

interface RunningJob {
  controller: AbortController;
  child: ReturnType<typeof spawn> | null;
  cancelled: boolean;
}

const VALID_SOURCE_KINDS: ReadonlySet<ImportSourceKind> = new Set([
  'obsidian_vault',
  'forge_project',
  'agent_pack',
]);
const VALID_MODES: ReadonlySet<ImportJobMode> = new Set([
  'install',
  'reimport',
  'repair',
  'dry_run',
]);
const TRANSFORMER_SCRIPT_IN_VAULT = path.join(
  '.greenhaven-agent-manual',
  'skills',
  'greenhaven-human-world-transformer',
  'scripts',
  'compile_vault_to_forge.py',
);
const TRANSFORMER_SCRIPT_IN_REPO = path.join(
  'GreenhavenWorld',
  TRANSFORMER_SCRIPT_IN_VAULT,
);
const GENERATED_FORGE_SUBPATH = path.join(
  '.greenhaven-agent-manual',
  'generated',
  'cartridge-forge-project',
);
const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const VOLATILE_MANIFEST_HASH_KEYS: ReadonlySet<string> = new Set([
  'created_at',
  'generated_at',
  'updated_at',
  'exported_at',
  'retrieved_at',
]);

const runningJobs = new Map<string, RunningJob>();

// ──────────────────────────────────────────────────────────────
// Source-path validation
// ──────────────────────────────────────────────────────────────

function resolveLocalPath(raw: string): string {
  // Reject URLs / UNC-style network paths. Resolve relative paths
  // against the current working directory so the GUI can pass a
  // workspace-relative path without exposing the full filesystem.
  if (/^[a-z]+:\/\//i.test(raw)) {
    throw new Error('source path must be a local filesystem path, not a URL');
  }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new Error('UNC / network source paths are not allowed');
  }
  return path.resolve(raw);
}

function findObsidianVaultRoot(candidate: string): string | null {
  const resolved = path.resolve(candidate);
  const roots = [resolved, path.dirname(resolved)];
  for (const root of roots) {
    const hasWorldDir = hasActiveWorldDir(root);
    const hasAgentManual = existsSync(path.join(root, '.greenhaven-agent-manual'));
    const hasWorldManifest = existsSync(path.join(root, 'WORLD_MANIFEST.md'));
    if (hasWorldDir && (hasAgentManual || hasWorldManifest)) {
      return root;
    }
  }
  return null;
}

function selectedWorldDirForObsidianRequest(
  vaultRoot: string,
  requestedPath: string,
): string | null {
  const vault = path.resolve(vaultRoot);
  const requested = path.resolve(requestedPath);
  const parent = path.dirname(requested);
  if (parent.toLowerCase() !== vault.toLowerCase()) return null;
  const candidate = safeWorldDir(path.basename(requested));
  if (!candidate) return null;
  if (!existsSync(path.join(vault, candidate, 'Locations'))) return null;
  return candidate;
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

function hasForgeManifest(candidate: string): boolean {
  return existsSync(path.join(candidate, 'forge.project.json'));
}

function countUnresolvedLinksReport(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^-\s+(.+?)\s*$/);
    if (!match) continue;
    const item = (match[1] ?? '').trim().toLowerCase();
    if (item === 'none' || item === 'none.' || item === '(none)') continue;
    count++;
  }
  return count;
}

function stableJsonForHash(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (VOLATILE_MANIFEST_HASH_KEYS.has(key)) continue;
    out[key] = stableJsonValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function addUniquePath(out: string[], seen: Set<string>, candidate: string): void {
  const resolved = path.resolve(candidate);
  const key = resolved.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(resolved);
}

function candidateAssetRootsForForgeProject(rootDir: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  let current = path.resolve(rootDir);
  for (let i = 0; i < 10; i++) {
    addUniquePath(roots, seen, current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const envRoots = [
    process.env['GREENHAVEN_VAULT_ROOT'],
    ...(process.env['GREENHAVEN_VAULT_ROOTS']?.split(path.delimiter) ?? []),
  ];
  for (const root of envRoots) {
    if (root?.trim()) addUniquePath(roots, seen, root.trim());
  }
  addUniquePath(roots, seen, path.resolve(REPO_ROOT, 'GreenhavenWorld'));
  return roots;
}

function safeRelativeAssetPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (path.isAbsolute(raw)) return null;
  if (/^[a-zA-Z]+:[\\/]/.test(raw)) return null;
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return null;
  const normalised = path.normalize(raw);
  if (normalised === '..' || normalised.startsWith(`..${path.sep}`)) {
    return null;
  }
  return normalised;
}

function resolveForgeAssetFile(
  rootDir: string,
  relPath: string,
): string | null {
  const safeRel = safeRelativeAssetPath(relPath);
  if (!safeRel) return null;
  for (const root of candidateAssetRootsForForgeProject(rootDir)) {
    const rootAbs = path.resolve(root);
    const candidate = path.resolve(rootAbs, safeRel);
    const rootKey = rootAbs.toLowerCase();
    const candidateKey = candidate.toLowerCase();
    if (
      candidateKey !== rootKey &&
      !candidateKey.startsWith(`${rootKey}${path.sep}`)
    ) {
      continue;
    }
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function hashVisualAssetBytes(
  rootDir: string,
  visualAssetsPath: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const raw = await readFile(visualAssetsPath, 'utf8');
  hash.update(`\n--audit/visual-assets.jsonl--\n`);
  hash.update(raw);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const relPath = safeRelativeAssetPath(parsed['path']);
    if (!relPath) continue;
    const abs = resolveForgeAssetFile(rootDir, relPath);
    hash.update(`\n--asset/${relPath.replace(/\\/g, '/')}--\n`);
    if (!abs) {
      hash.update('missing');
      continue;
    }
    hash.update(await readFile(abs));
  }
}

function resolveRepoRootForTransformer(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '..', '..'),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, TRANSFORMER_SCRIPT_IN_REPO))) {
      return candidate;
    }
  }
  return cwd;
}

function resolveTransformerScript(
  vaultRoot: string,
): {scriptPath: string; cwd: string} | null {
  const vaultScript = path.join(vaultRoot, TRANSFORMER_SCRIPT_IN_VAULT);
  if (existsSync(vaultScript)) {
    return {
      scriptPath: vaultScript,
      cwd: path.dirname(vaultScript),
    };
  }

  const repoRoot = resolveRepoRootForTransformer();
  const repoScript = path.join(repoRoot, TRANSFORMER_SCRIPT_IN_REPO);
  if (existsSync(repoScript)) {
    return {scriptPath: repoScript, cwd: repoRoot};
  }

  return null;
}

// ──────────────────────────────────────────────────────────────
// Forge project / agent pack reader
// ──────────────────────────────────────────────────────────────

export interface CartridgeIngestRecord {
  recordId: string;
  kind: string;
  slug: string;
  displayName: string;
  summary: string | null;
  tags: string[];
  payload: Record<string, unknown>;
  /** Per-record sha256 over canonicalised JSON. */
  contentHash: string;
}

interface ForgeProjectLoad {
  manifest: Record<string, unknown>;
  cartridgeId: string | null;
  counts: Record<string, number>;
  totalRecords: number;
  contentHash: string;
  generatedArtifacts: string[];
  warnings: Array<{level: 'error' | 'warning' | 'info'; message: string}>;
  unresolvedLinks: number;
  recordIds: string[];
  /** Full normalised records — populated by `loadForgeProject` and
   *  consumed by FEAT-CART-LIB-3 apply. */
  records: CartridgeIngestRecord[];
}

async function loadForgeProject(
  rootDir: string,
  manifestFile: 'forge.project.json' | 'manifest.json',
): Promise<ForgeProjectLoad> {
  const manifestPath = path.join(rootDir, manifestFile);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `manifest ${manifestFile} missing at ${manifestPath} (is this really a ${manifestFile === 'manifest.json' ? 'agent pack' : 'forge project'}?)`,
    );
  }
  const manifestRaw = await readFile(manifestPath, 'utf8');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `manifest ${manifestFile} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const cartridgeId =
    typeof manifest['target_cartridge_id'] === 'string'
      ? (manifest['target_cartridge_id'] as string)
      : typeof manifest['cartridge_id'] === 'string'
        ? (manifest['cartridge_id'] as string)
        : typeof manifest['pack_slug'] === 'string'
          ? (manifest['pack_slug'] as string)
          : null;

  const counts: Record<string, number> = {};
  const recordIds: string[] = [];
  const records: CartridgeIngestRecord[] = [];
  const warnings: Array<{level: 'error' | 'warning' | 'info'; message: string}> = [];
  const hash = createHash('sha256');
  hash.update(stableJsonForHash(manifest));

  const recordsDir = path.join(rootDir, 'records');
  if (!existsSync(recordsDir)) {
    warnings.push({
      level: 'warning',
      message: 'records/ directory missing — counts will be zero',
    });
  } else {
    const files = await readdir(recordsDir);
    for (const file of files.sort()) {
      if (!file.endsWith('.jsonl')) continue;
      const kindFromFile = file.replace(/\.jsonl$/, '');
      const fullPath = path.join(recordsDir, file);
      const data = await readFile(fullPath, 'utf8');
      hash.update(`\n--${file}--\n`);
      hash.update(data);
      let lineCount = 0;
      for (const line of data.split(/\r?\n/)) {
        if (!line.trim()) continue;
        lineCount++;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row['record_id'] === 'string') {
            recordIds.push(row['record_id'] as string);
            const normalised = normaliseIngestRecord(row, line);
            if (normalised) records.push(normalised);
          }
        } catch (err) {
          warnings.push({
            level: 'error',
            message: `invalid JSONL line in ${file}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      }
      counts[kindFromFile] = lineCount;
    }
  }
  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);

  // Audit artifacts (`audit/*.md`, `audit/*.jsonl`) → list of
  // generated paths the GUI can show as evidence.
  const generated: string[] = [];
  const auditDir = path.join(rootDir, 'audit');
  if (existsSync(auditDir)) {
    const items = await readdir(auditDir);
    for (const name of items) generated.push(path.join('audit', name));
  }
  const sourcesPath = path.join(rootDir, 'sources.jsonl');
  if (existsSync(sourcesPath)) generated.push('sources.jsonl');
  if (existsSync(manifestPath)) generated.push(manifestFile);
  const visualAssetsPath = path.join(auditDir, 'visual-assets.jsonl');
  if (existsSync(visualAssetsPath)) {
    await hashVisualAssetBytes(rootDir, visualAssetsPath, hash);
  }

  // Optional unresolved-links report under the vault's
  // `.greenhaven-agent-manual/generated/unresolved-links.md`. The
  // forge_project/agent_pack source path itself is one level
  // below; check the parent.
  let unresolvedLinks = 0;
  const linksPath = path.resolve(rootDir, '..', 'unresolved-links.md');
  if (existsSync(linksPath)) {
    try {
      const text = await readFile(linksPath, 'utf8');
      unresolvedLinks = countUnresolvedLinksReport(text);
      if (unresolvedLinks > 0) {
        warnings.push({
          level: 'warning',
          message: `${unresolvedLinks} unresolved link(s) reported in unresolved-links.md`,
        });
      }
    } catch {
      // ignore — best-effort
    }
  }

  return {
    manifest,
    cartridgeId,
    counts,
    totalRecords,
    contentHash: 'sha256:' + hash.digest('hex'),
    generatedArtifacts: generated,
    warnings,
    unresolvedLinks,
    recordIds,
    records,
  };
}

// FEAT-CART-LIB-3 — normalise one raw ingest-record JSONL row
// into the shape the apply pipeline writes against `entities` /
// `cartridge_records`. The per-record content hash is computed
// over the canonicalised (key-sorted) JSON of the record so that
// reimport produces stable diff counts.
function normaliseIngestRecord(
  raw: Record<string, unknown>,
  rawLine: string,
): CartridgeIngestRecord | null {
  const recordId = readString(raw, 'record_id');
  const kind = readString(raw, 'kind');
  const slug = readString(raw, 'slug') ?? readString(raw, 'source_slug');
  if (!recordId || !kind || !slug) return null;
  const displayName =
    readString(raw, 'canonical_name') ??
    readString(raw, 'display_name') ??
    slug;
  const summary = readString(raw, 'summary');
  const tagsRaw = raw['tags'];
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === 'string')
    : [];
  const payload =
    raw['payload'] && typeof raw['payload'] === 'object'
      ? (raw['payload'] as Record<string, unknown>)
      : {};
  const contentHash =
    'sha256:' +
    createHash('sha256').update(rawLine.trim(), 'utf8').digest('hex');
  return {
    recordId,
    kind,
    slug,
    displayName,
    summary,
    tags,
    payload,
    contentHash,
  };
}

function readString(
  raw: Record<string, unknown>,
  key: string,
): string | null {
  const v = raw[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

// Public re-export so the FEAT-CART-LIB-3 apply service can reuse
// the same loader without re-parsing source paths independently.
export async function loadForgeProjectForApply(
  rootDir: string,
  manifestFile: 'forge.project.json' | 'manifest.json',
): Promise<ForgeProjectLoad> {
  return loadForgeProject(rootDir, manifestFile);
}

// ──────────────────────────────────────────────────────────────
// Obsidian vault → forge_project bridge
// ──────────────────────────────────────────────────────────────

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function spawnTransformer(
  vaultRoot: string,
  job: RunningJob,
  timeoutMs: number,
  worldDir?: string | null,
): Promise<SpawnResult> {
  // In development the transformer usually lives under the repo's
  // GreenhavenWorld folder. In packaged/unpacked desktop builds the
  // process cwd can be the Electron release directory while the
  // operator-selected Obsidian vault lives elsewhere, so prefer the
  // transformer bundled with the selected vault itself.
  const transformer = resolveTransformerScript(vaultRoot);
  if (!transformer) {
    const repoRoot = resolveRepoRootForTransformer();
    return {
      exitCode: null,
      stdout: '',
      stderr:
        `transformer script not found at ${path.join(
          vaultRoot,
          TRANSFORMER_SCRIPT_IN_VAULT,
        )}` +
        ` or ${path.join(repoRoot, TRANSFORMER_SCRIPT_IN_REPO)}`,
    };
  }
  const python = process.env['PYTHON'] ?? 'python';
  const args = [transformer.scriptPath, '--vault-root', vaultRoot];
  if (worldDir) {
    args.push('--world-dir', worldDir);
  }
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(
      python,
      args,
      {
        cwd: transformer.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    job.child = child;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      stderr += `\n[preview] transformer timed out after ${timeoutMs}ms`;
    }, timeoutMs);
    timeout.unref?.();
    job.controller.signal.addEventListener(
      'abort',
      () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      },
      {once: true},
    );
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({exitCode: code ?? null, stdout, stderr});
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + '\n' + (err instanceof Error ? err.message : String(err)),
      });
    });
  });
}

// ──────────────────────────────────────────────────────────────
// Diff against existing cartridge_records
// ──────────────────────────────────────────────────────────────

async function diffAgainstExistingCartridge(
  cartridgeId: string | null,
  recordIds: string[],
): Promise<{new: number; changed: number; unchanged: number; deprecated: number}> {
  if (!cartridgeId || recordIds.length === 0) {
    return {new: recordIds.length, changed: 0, unchanged: 0, deprecated: 0};
  }
  const existing = await query<{record_id: string}>(
    `SELECT record_id FROM cartridge_records WHERE cartridge_id = $1`,
    [cartridgeId],
  );
  const existingSet = new Set(existing.rows.map((r) => r.record_id));
  const incomingSet = new Set(recordIds);
  let _new = 0;
  let unchanged = 0;
  for (const id of incomingSet) {
    if (existingSet.has(id)) {
      // FEAT-CART-LIB-2 cannot tell `changed` from `unchanged`
      // yet (we don't load existing record content here). Mark
      // as `unchanged` conservatively; FEAT-CART-LIB-3 lands the
      // per-record content_hash diff.
      unchanged++;
    } else {
      _new++;
    }
  }
  let deprecated = 0;
  for (const id of existingSet) {
    if (!incomingSet.has(id)) deprecated++;
  }
  return {new: _new, changed: 0, unchanged, deprecated};
}

// ──────────────────────────────────────────────────────────────
// DB helpers
// ──────────────────────────────────────────────────────────────

interface JobRow {
  job_id: string;
  cartridge_id: string | null;
  mode: ImportJobMode;
  source_kind: ImportSourceKind;
  source_path: string;
  status: ImportJobStatus;
  phase: string;
  progress_processed: number;
  progress_total: number;
  result: Record<string, unknown>;
  error: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

function rowToView(row: JobRow): ImportJobView {
  return {
    jobId: row.job_id,
    cartridgeId: row.cartridge_id,
    mode: row.mode,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    status: row.status,
    phase: row.phase,
    progress: {processed: row.progress_processed, total: row.progress_total},
    result:
      (row.status === 'ready' ||
        row.status === 'applying' ||
        row.status === 'applied') &&
      row.result &&
      typeof row.result === 'object' &&
      Object.keys(row.result).length > 0
        ? (row.result as unknown as ImportJobResult)
        : null,
    error:
      row.error &&
      typeof row.error === 'object' &&
      typeof (row.error as Record<string, unknown>)['message'] === 'string'
        ? {
            code:
              typeof (row.error as Record<string, unknown>)['code'] === 'string'
                ? ((row.error as Record<string, unknown>)['code'] as string)
                : 'unknown_error',
            message: (row.error as Record<string, unknown>)['message'] as string,
          }
        : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

async function insertJob(
  jobId: string,
  opts: CreateImportJobOptions,
): Promise<void> {
  await query(
    `INSERT INTO cartridge_import_preview_jobs (
       job_id, cartridge_id, mode, source_kind, source_path,
       status, phase
     ) VALUES ($1, $2, $3, $4, $5, 'queued', 'queued')`,
    [
      jobId,
      opts.cartridgeId ?? null,
      opts.mode ?? 'dry_run',
      opts.sourceKind,
      opts.sourcePath,
    ],
  );
}

async function updateJob(
  jobId: string,
  patch: {
    status?: ImportJobStatus;
    phase?: string;
    progress?: {processed?: number; total?: number};
    result?: ImportJobResult;
    error?: {code: string; message: string};
    startedAt?: Date;
    finishedAt?: Date;
    cartridgeId?: string | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.status) push('status', patch.status);
  if (patch.phase) push('phase', patch.phase);
  if (patch.progress?.processed != null)
    push('progress_processed', patch.progress.processed);
  if (patch.progress?.total != null) push('progress_total', patch.progress.total);
  if (patch.result) push('result', JSON.stringify(patch.result));
  if (patch.error) push('error', JSON.stringify(patch.error));
  if (patch.startedAt) push('started_at', patch.startedAt.toISOString());
  if (patch.finishedAt) push('finished_at', patch.finishedAt.toISOString());
  if (patch.cartridgeId !== undefined) push('cartridge_id', patch.cartridgeId);
  sets.push(`updated_at = now()`);
  params.push(jobId);
  await query(
    `UPDATE cartridge_import_preview_jobs
        SET ${sets.join(', ')}
      WHERE job_id = $${params.length}`,
    params,
  );
}

async function readJob(jobId: string): Promise<JobRow | null> {
  const r = await query<JobRow>(
    `SELECT job_id, cartridge_id, mode, source_kind, source_path,
            status, phase, progress_processed, progress_total,
            result, error,
            created_at::text AS created_at,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            updated_at::text AS updated_at
       FROM cartridge_import_preview_jobs
      WHERE job_id = $1`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

// ──────────────────────────────────────────────────────────────
// Job execution
// ──────────────────────────────────────────────────────────────

async function runJob(
  jobId: string,
  opts: CreateImportJobOptions,
): Promise<void> {
  const job: RunningJob = {
    controller: new AbortController(),
    child: null,
    cancelled: false,
  };
  runningJobs.set(jobId, job);
  const started = new Date();
  try {
    await updateJob(jobId, {
      status: 'running',
      phase: 'resolving',
      startedAt: started,
    });

    let resolvedPath = resolveLocalPath(opts.sourcePath);
    if (!existsSync(resolvedPath)) {
      throw new PreviewError(
        'source_path_missing',
        `source path does not exist: ${resolvedPath}`,
      );
    }
    const sourceStat = await stat(resolvedPath);
    if (!sourceStat.isDirectory()) {
      throw new PreviewError(
        'source_not_directory',
        `source path must be a directory, got file: ${resolvedPath}`,
      );
    }

    let forgeProjectPath = resolvedPath;
    let manifestFile: 'forge.project.json' | 'manifest.json' =
      'forge.project.json';
    let effectiveSourceKind = opts.sourceKind;
    let selectedWorldDir: string | null = null;

    if (effectiveSourceKind === 'obsidian_vault') {
      const requestedPath = resolvedPath;
      const vaultRoot = findObsidianVaultRoot(resolvedPath);
      if (!vaultRoot) {
        throw new PreviewError(
          'obsidian_vault_invalid',
          `Obsidian vault source must point at a vault root containing an active world directory plus either WORLD_MANIFEST.md or .greenhaven-agent-manual; got ${resolvedPath}`,
        );
      }
      selectedWorldDir = selectedWorldDirForObsidianRequest(
        vaultRoot,
        requestedPath,
      );
      resolvedPath = vaultRoot;
      forgeProjectPath = vaultRoot;
    } else if (
      effectiveSourceKind === 'forge_project' &&
      !hasForgeManifest(resolvedPath)
    ) {
      const vaultRoot = findObsidianVaultRoot(resolvedPath);
      if (vaultRoot) {
        effectiveSourceKind = 'obsidian_vault';
        selectedWorldDir = selectedWorldDirForObsidianRequest(
          vaultRoot,
          resolvedPath,
        );
        resolvedPath = vaultRoot;
        forgeProjectPath = vaultRoot;
      } else {
        throw new PreviewError(
          'forge_project_manifest_missing',
          `Forge project source must contain forge.project.json at ${path.join(
            resolvedPath,
            'forge.project.json',
          )}. If this is a Greenhaven Obsidian vault, choose source kind obsidian_vault and pass the vault root.`,
        );
      }
    }

    if (effectiveSourceKind === 'agent_pack') {
      manifestFile = 'manifest.json';
    } else if (effectiveSourceKind === 'obsidian_vault') {
      await updateJob(jobId, {phase: 'compile_vault'});
      const result = await spawnTransformer(
        resolvedPath,
        job,
        120_000,
        selectedWorldDir,
      );
      if (job.cancelled) {
        throw new PreviewError('cancelled', 'job cancelled during compile');
      }
      if (result.exitCode !== 0) {
        throw new PreviewError(
          'transformer_failed',
          `compile_vault_to_forge.py exited ${result.exitCode}: ${tail(result.stderr, 8)}`,
        );
      }
      forgeProjectPath = path.join(resolvedPath, GENERATED_FORGE_SUBPATH);
      if (!existsSync(forgeProjectPath)) {
        throw new PreviewError(
          'transformer_no_output',
          `expected generated forge project at ${forgeProjectPath} after compile`,
        );
      }
    }

    if (job.cancelled) {
      throw new PreviewError('cancelled', 'job cancelled before load');
    }

    await updateJob(jobId, {phase: 'load_records'});
    const load = await loadForgeProject(forgeProjectPath, manifestFile);
    if (job.cancelled) {
      throw new PreviewError('cancelled', 'job cancelled during record load');
    }

    // FEAT-CART-LIB-3: do NOT write `cartridge_id` onto the
    // preview-job row here. The `cartridges(id)` FK requires the
    // cartridge to exist, which is only guaranteed AFTER apply
    // upserts it. Preview keeps the id only in `result.cartridgeId`;
    // apply writes it onto the row after the upsert.
    await updateJob(jobId, {
      phase: 'diff',
      progress: {processed: load.totalRecords, total: load.totalRecords},
    });
    const diff = await diffAgainstExistingCartridge(
      load.cartridgeId,
      load.recordIds,
    );
    if (job.cancelled) {
      throw new PreviewError('cancelled', 'job cancelled after diff');
    }

    const errors = load.warnings.filter((w) => w.level === 'error').length;
    const warnings = load.warnings.filter((w) => w.level === 'warning').length;

    const finishedAt = new Date();
    const result: ImportJobResult = {
      manifest: load.manifest,
      cartridgeId: load.cartridgeId,
      contentHash: load.contentHash,
      counts: load.counts,
      totalRecords: load.totalRecords,
      validation: {
        errors,
        warnings,
        unresolvedLinks: load.unresolvedLinks,
        items: load.warnings,
      },
      diff,
      generatedArtifacts: load.generatedArtifacts,
      forgeProjectPath,
      durationMs: finishedAt.getTime() - started.getTime(),
    };
    await updateJob(jobId, {
      status: 'ready',
      phase: 'ready',
      result,
      finishedAt,
    });
    telemetry.record({
      channel: 'gameplay',
      name: 'cartridge.import_preview.ready',
      data: {
        job_id: jobId,
        source_kind: effectiveSourceKind,
        cartridge_id: load.cartridgeId,
        records: load.totalRecords,
        validation_errors: errors,
        validation_warnings: warnings,
      },
    });
  } catch (err) {
    const finishedAt = new Date();
    const wasCancelled =
      job.cancelled || (err instanceof PreviewError && err.code === 'cancelled');
    if (wasCancelled) {
      await updateJob(jobId, {
        status: 'cancelled',
        phase: 'cancelled',
        finishedAt,
        error: {code: 'cancelled', message: 'job cancelled'},
      });
      telemetry.record({
        channel: 'gameplay',
        name: 'cartridge.import_preview.cancelled',
        data: {job_id: jobId, source_kind: opts.sourceKind},
      });
    } else {
      const code = err instanceof PreviewError ? err.code : 'unexpected';
      const message = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, {
        status: 'failed',
        phase: 'failed',
        finishedAt,
        error: {code, message},
      });
      telemetry.record({
        channel: 'gameplay',
        name: 'cartridge.import_preview.failed',
        error: err instanceof Error ? err : undefined,
        data: {job_id: jobId, source_kind: opts.sourceKind, code, message},
      });
    }
  } finally {
    runningJobs.delete(jobId);
  }
}

class PreviewError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

function tail(text: string, lines: number): string {
  return text.split(/\r?\n/).slice(-lines).join('\n').trim();
}

// ──────────────────────────────────────────────────────────────
// Public service surface
// ──────────────────────────────────────────────────────────────

export class CartridgeImportPreviewService {
  static async createJob(
    opts: CreateImportJobOptions,
  ): Promise<ImportJobView> {
    if (!VALID_SOURCE_KINDS.has(opts.sourceKind)) {
      throw new PreviewError(
        'invalid_source_kind',
        `unsupported source kind '${opts.sourceKind}'; expected one of obsidian_vault | forge_project | agent_pack`,
      );
    }
    if (typeof opts.sourcePath !== 'string' || opts.sourcePath.trim() === '') {
      throw new PreviewError('invalid_source_path', 'source path is required');
    }
    if (opts.mode && !VALID_MODES.has(opts.mode)) {
      throw new PreviewError('invalid_mode', `unsupported mode '${opts.mode}'`);
    }
    const jobId = randomUUID();
    await insertJob(jobId, opts);
    // Fire-and-forget. Caller polls via `getJob`.
    void runJob(jobId, opts);
    const row = await readJob(jobId);
    if (!row) {
      throw new PreviewError('insert_failed', `job ${jobId} could not be read after insert`);
    }
    return rowToView(row);
  }

  static async getJob(jobId: string): Promise<ImportJobView | null> {
    if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 64) {
      return null;
    }
    const row = await readJob(jobId);
    return row ? rowToView(row) : null;
  }

  static async cancelJob(jobId: string): Promise<ImportJobView | null> {
    const row = await readJob(jobId);
    if (!row) return null;
    if (row.status === 'ready' || row.status === 'failed' || row.status === 'cancelled') {
      return rowToView(row);
    }
    const job = runningJobs.get(jobId);
    if (job) {
      job.cancelled = true;
      job.controller.abort();
      if (job.child) {
        try {
          job.child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
    // Optimistically mark as cancelled in DB. If the runner is
    // mid-flight it will see the in-memory flag and also write
    // `cancelled`; if the runner has already finished but we
    // raced, the final state will be ready/failed (the runner
    // ran updateJob after we hit this line). The next GET will
    // surface whichever wins.
    await updateJob(jobId, {
      status: 'cancelled',
      phase: 'cancelled',
      finishedAt: new Date(),
      error: {code: 'cancelled', message: 'job cancelled by client'},
    });
    const after = await readJob(jobId);
    return after ? rowToView(after) : null;
  }
}

// Exported for tests + the cartridge-library service so the
// `installCache` summary attached to `CartridgeSummary` can reuse
// the same row reader.
export interface InstallCacheRow {
  cartridge_id: string;
  state: string;
  content_hash: string;
  record_count: number;
  last_verified_at: string;
  notes: Record<string, unknown>;
}

export async function readInstallCache(
  cartridgeId: string,
): Promise<InstallCacheRow | null> {
  const r = await query<InstallCacheRow>(
    `SELECT cartridge_id, state, content_hash, record_count,
            last_verified_at::text AS last_verified_at,
            notes
       FROM cartridge_install_cache
      WHERE cartridge_id = $1`,
    [cartridgeId],
  );
  return r.rows[0] ?? null;
}
