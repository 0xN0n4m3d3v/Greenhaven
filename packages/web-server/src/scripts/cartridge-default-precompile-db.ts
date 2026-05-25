/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Build-time default-world database precompiler.
//
// Input: a validated Cartridge Forge project generated from the
// active human-authored Obsidian world tree selected by WORLD_MANIFEST.md.
// Output: a ready local data template containing:
//
//   <out-data-dir>/pgdata                         PGlite database
//   <out-data-dir>/cartridges/<id>/assets         visual asset cache
//   <out-data-dir>/default-cartridge-precompile-result.json
//
// The desktop packager copies this template into packaged assets.
// On first run Electron copies it into the user's data directory
// before the backend opens PGlite, so the default world is already
// installed and does not need preview/apply during startup.

import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ImportJobView} from '../services/CartridgeImportPreviewService.js';

interface Args {
  forgeProject: string;
  sourceRoot: string;
  worldDir: string;
  outDataDir: string;
  reportFile: string;
  portableSourceRoot: string;
  portableForgeProject: string;
  timeoutMs: number;
  acceptWarnings: boolean;
  append: boolean;
}

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const DEFAULT_SOURCE_ROOT = path.join(REPO_ROOT, 'GreenhavenWorld');
const DEFAULT_WORLD_DIR = 'GreenhavenNoir';
const DEFAULT_FORGE_PROJECT = path.join(
  DEFAULT_SOURCE_ROOT,
  '.greenhaven-agent-manual',
  'generated',
  'cartridge-forge-project',
);
const DEFAULT_OUT_DATA_DIR = path.join(
  REPO_ROOT,
  'packages',
  'desktop-electron',
  'web-server',
  'default-cartridge',
  'data-template',
);
const PORTABLE_DEFAULT_SOURCE_ROOT = 'greenhaven://default-cartridge/source';
const PORTABLE_DEFAULT_FORGE_PROJECT =
  `${PORTABLE_DEFAULT_SOURCE_ROOT}/.greenhaven-agent-manual/generated/cartridge-forge-project`;

function parseArgs(argv: string[]): Args {
  let forgeProject = DEFAULT_FORGE_PROJECT;
  let sourceRoot = DEFAULT_SOURCE_ROOT;
  let worldDir: string | null =
    process.env['GREENHAVEN_DEFAULT_WORLD_DIR'] ?? null;
  let outDataDir = DEFAULT_OUT_DATA_DIR;
  let reportFile: string | null = null;
  let portableSourceRoot = PORTABLE_DEFAULT_SOURCE_ROOT;
  let portableForgeProject = PORTABLE_DEFAULT_FORGE_PROJECT;
  let timeoutMs = 240_000;
  let acceptWarnings = true;
  let append = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--forge-project') {
      forgeProject = argv[++i] ?? forgeProject;
    } else if (arg === '--source-root') {
      sourceRoot = argv[++i] ?? sourceRoot;
    } else if (arg === '--world-dir') {
      worldDir = argv[++i] ?? worldDir;
    } else if (arg === '--out-data-dir') {
      outDataDir = argv[++i] ?? outDataDir;
    } else if (arg === '--report-file') {
      reportFile = argv[++i] ?? reportFile;
    } else if (arg === '--portable-source-root') {
      portableSourceRoot = argv[++i] ?? portableSourceRoot;
    } else if (arg === '--portable-forge-project') {
      portableForgeProject = argv[++i] ?? portableForgeProject;
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number(argv[++i] ?? timeoutMs) || timeoutMs;
    } else if (arg === '--no-accept-warnings') {
      acceptWarnings = false;
    } else if (arg === '--accept-warnings') {
      acceptWarnings = true;
    } else if (arg === '--append') {
      append = true;
    }
  }
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedOutDataDir = path.resolve(outDataDir);
  return {
    forgeProject: path.resolve(forgeProject),
    sourceRoot: resolvedSourceRoot,
    worldDir: safeWorldDir(worldDir ?? activeWorldDir(resolvedSourceRoot)),
    outDataDir: resolvedOutDataDir,
    reportFile: path.resolve(
      reportFile ?? path.join(resolvedOutDataDir, 'default-cartridge-precompile-result.json'),
    ),
    portableSourceRoot,
    portableForgeProject,
    timeoutMs,
    acceptWarnings,
    append,
  };
}

function safeWorldDir(value: string): string {
  const cleaned = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    !cleaned ||
    cleaned.startsWith('/') ||
    cleaned.includes(':') ||
    cleaned === '..' ||
    cleaned.startsWith('../') ||
    cleaned.includes('/../') ||
    cleaned.includes('/')
  ) {
    throw new Error(`unsafe world dir: ${value}`);
  }
  return cleaned;
}

function safeWorldDirCandidate(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  try {
    return safeWorldDir(value);
  } catch {
    return null;
  }
}

function activeWorldDir(sourceRoot: string): string {
  const manifestPath = path.join(sourceRoot, 'WORLD_MANIFEST.md');
  if (existsSync(manifestPath)) {
    try {
      const text = readFileSync(manifestPath, 'utf8');
      const match = text.match(
        /^##\s+Active World Root\s*([\s\S]*?)(?=^##\s+|$)/im,
      );
      if (match) {
        const block = match[1] ?? '';
        const code = block.match(
          /```(?:text|md|markdown)?\s*([\s\S]*?)\s*```/i,
        );
        const candidates = [code?.[1], ...block.split(/\r?\n/)];
        for (const candidate of candidates) {
          const dir = safeWorldDirCandidate(candidate);
          if (dir && existsSync(path.join(sourceRoot, dir))) return dir;
        }
      }
    } catch {
      // Fall back below.
    }
  }
  if (existsSync(path.join(sourceRoot, DEFAULT_WORLD_DIR))) {
    return DEFAULT_WORLD_DIR;
  }
  if (existsSync(path.join(sourceRoot, 'GreenHavenWorld'))) {
    return 'GreenHavenWorld';
  }
  try {
    const candidates = readdirSync(sourceRoot, {withFileTypes: true})
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          existsSync(path.join(sourceRoot, entry.name, 'Locations')),
      )
      .map((entry) => entry.name);
    if (candidates.length === 1) return candidates[0]!;
  } catch {
    // Fall back below.
  }
  return DEFAULT_WORLD_DIR;
}

async function readTargetCartridgeId(forgeProject: string): Promise<string> {
  const manifestPath = path.join(forgeProject, 'forge.project.json');
  const raw = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const id = parsed['target_cartridge_id'];
  if (typeof id === 'string' && id.trim()) return id.trim();
  const pack = parsed['pack_slug'];
  if (typeof pack === 'string' && pack.trim()) return pack.trim();
  return 'greenhaven-world';
}

async function waitForPreviewReady(
  jobId: string,
  timeoutMs: number,
): Promise<ImportJobView> {
  const {CartridgeImportPreviewService} = await import(
    '../services/CartridgeImportPreviewService.js'
  );
  const deadline = Date.now() + timeoutMs;
  let last: ImportJobView | null = null;
  while (Date.now() <= deadline) {
    last = await CartridgeImportPreviewService.getJob(jobId);
    if (!last) throw new Error(`preview job disappeared: ${jobId}`);
    if (last.status === 'ready') return last;
    if (last.status === 'failed' || last.status === 'cancelled') {
      throw new Error(
        `preview ${last.status}: ${last.error?.message ?? last.phase}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `preview timed out after ${timeoutMs}ms; last status=${last?.status ?? 'unknown'}`,
  );
}

async function countRows(table: string): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`unsafe table name: ${table}`);
  }
  const {query} = await import('../db.js');
  const row = await query<{c: number | string}>(
    `SELECT COUNT(*)::int AS c FROM "${table}"`,
  );
  return Number(row.rows[0]?.c ?? 0);
}

async function makeTemplatePortable(
  cartridgeId: string,
  portableForgeProject: string,
): Promise<void> {
  const {query} = await import('../db.js');
  await query(
    `UPDATE cartridges
        SET source_path = $2
      WHERE id = $1`,
    [cartridgeId, portableForgeProject],
  );
  await query(
    `UPDATE cartridge_import_runs
        SET source_path = $2
      WHERE cartridge_id = $1
        AND source_kind = 'forge_project'`,
    [cartridgeId, portableForgeProject],
  );
  await query(
    `UPDATE cartridge_import_preview_jobs
        SET source_path = $2,
            result = CASE
              WHEN result IS NULL THEN result
              ELSE jsonb_set(
                jsonb_set(
                  result,
                  '{forgeProjectPath}',
                  to_jsonb($2::text),
                  true
                ),
                '{generatedArtifacts}',
                jsonb_build_array($2::text),
                true
              )
            END
      WHERE cartridge_id = $1
        AND source_kind = 'forge_project'`,
    [cartridgeId, portableForgeProject],
  );
  await query(
    `UPDATE cartridge_meta_scoped
        SET value = jsonb_set(value, '{source_path}', to_jsonb($2::text), true)
      WHERE cartridge_id = $1
        AND key = 'forge_visual_assets'
        AND jsonb_typeof(value) = 'object'`,
    [cartridgeId, portableForgeProject],
  );
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  const blockers: string[] = [];
  let cartridgeId: string | null = null;
  let finalView: ImportJobView | null = null;
  let migrationMode: string | null = null;
  const counts: Record<string, number> = {};

  const log = (message: string): void => {
    process.stderr.write(`[cartridge-default-precompile-db] ${message}\n`);
  };

  try {
    const manifestPath = path.join(args.forgeProject, 'forge.project.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`forge.project.json missing at ${manifestPath}`);
    }
    if (!existsSync(path.join(args.sourceRoot, args.worldDir))) {
      throw new Error(
        `source root must contain ${args.worldDir}: ${args.sourceRoot}`,
      );
    }

    if (!args.append) {
      await rm(args.outDataDir, {recursive: true, force: true});
    }
    await mkdir(args.outDataDir, {recursive: true});

    process.env['PGLITE_DATA_DIR'] = path.join(args.outDataDir, 'pgdata');
    process.env['GREENHAVEN_DATA_DIR'] = args.outDataDir;
    process.env['GREENHAVEN_VAULT_ROOTS'] = args.sourceRoot;
    process.env['GREENHAVEN_DEFAULT_WORLD_DIR'] = args.worldDir;
    process.env['AUTH_SECRET'] ??=
      'greenhaven-default-precompile-32-byte-secret';
    process.env['AUTH_DISABLED'] ??= '1';
    process.env['NODE_ENV'] ??= 'development';

    cartridgeId = await readTargetCartridgeId(args.forgeProject);
    log(`forge=${args.forgeProject}`);
    log(`source=${path.join(args.sourceRoot, args.worldDir)}`);
    log(`out=${args.outDataDir}`);
    log(`target=${cartridgeId}`);

    const {runMigrations} = await import('../migrate.js');
    const {closeDb, query} = await import('../db.js');
    const {CartridgeImportPreviewService} = await import(
      '../services/CartridgeImportPreviewService.js'
    );
    const {CartridgeImportApplyService} = await import(
      '../services/CartridgeImportApplyService.js'
    );

    const migrated = await runMigrations();
    migrationMode = migrated.mode;
    if (!args.append && migrationMode !== 'fresh-baseline') {
      blockers.push(`expected fresh-baseline, got ${migrationMode}`);
    }

    const created = await CartridgeImportPreviewService.createJob({
      sourceKind: 'forge_project',
      sourcePath: args.forgeProject,
      mode: 'install',
    });
    const ready = await waitForPreviewReady(created.jobId, args.timeoutMs);
    if (ready.result?.cartridgeId !== cartridgeId) {
      blockers.push(
        `preview cartridge mismatch: expected=${cartridgeId} actual=${ready.result?.cartridgeId ?? 'null'}`,
      );
    }
    finalView = await CartridgeImportApplyService.apply({
      jobId: created.jobId,
      acceptWarnings: args.acceptWarnings,
      expectedCartridgeId: cartridgeId,
    });
    if (finalView.status !== 'applied') {
      blockers.push(`apply ended with status=${finalView.status}`);
    }

    for (const table of [
      'entities',
      'cartridges',
      'cartridge_records',
      'cartridge_meta_scoped',
      'cartridge_install_cache',
      'cartridge_import_runs',
    ]) {
      counts[table] = await countRows(table);
    }
    if ((counts['cartridges'] ?? 0) < 1) blockers.push('no cartridge rows');
    if ((counts['entities'] ?? 0) < 1) blockers.push('no entity rows');
    if ((counts['cartridge_records'] ?? 0) < 1) {
      blockers.push('no cartridge_records rows');
    }

    const cache = await query<{state: string; record_count: number | string}>(
      `SELECT state, record_count
         FROM cartridge_install_cache
        WHERE cartridge_id = $1`,
      [cartridgeId],
    );
    if (cache.rows[0]?.state !== 'ready') {
      blockers.push(
        `install cache not ready: ${cache.rows[0]?.state ?? 'missing'}`,
      );
    }

    if (blockers.length === 0) {
      await makeTemplatePortable(cartridgeId, args.portableForgeProject);
    }

    await closeDb();
  } catch (err) {
    blockers.push(err instanceof Error ? err.message : String(err));
    try {
      const {closeDb} = await import('../db.js');
      await closeDb();
    } catch {
      // ignore cleanup failure
    }
  }

  const finishedAt = new Date();
  const report = {
    passed: blockers.length === 0,
    blockers,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    sourceRoot: args.portableSourceRoot,
    visibleWorldRoot: `${args.portableSourceRoot}/${args.worldDir}`,
    forgeProject: args.portableForgeProject,
    outDataDir: 'greenhaven://default-cartridge/data-template',
    pgdataDir: 'greenhaven://default-cartridge/data-template/pgdata',
    cartridgeAssetsDir: cartridgeId
      ? `greenhaven://default-cartridge/data-template/cartridges/${cartridgeId}/assets`
      : null,
    cartridgeId,
    migrationMode,
    counts,
    finalStatus: finalView?.status ?? null,
    finalJobId: finalView?.jobId ?? null,
  };
  await mkdir(path.dirname(args.reportFile), {recursive: true});
  await writeFile(args.reportFile, JSON.stringify(report, null, 2));

  if (report.passed) {
    log(`PASS result=${args.reportFile}`);
    return 0;
  }
  log(`FAIL blockers=${JSON.stringify(blockers)}`);
  return 1;
}

const isDirect = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(FILE)
  : false;
if (isDirect) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error('[cartridge-default-precompile-db] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runCartridgeDefaultPrecompileDb};
