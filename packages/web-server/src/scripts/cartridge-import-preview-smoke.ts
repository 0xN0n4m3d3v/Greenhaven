/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-2 stable preview smoke.
//
// Drives `CartridgeImportPreviewService` end-to-end against a
// local source path. Designed for fast iteration; no Hono server,
// no browser, no full migration chain. Uses a temp PGlite so the
// preview job rows have somewhere to live.
//
// Usage:
//
//   npm --prefix packages/web-server exec -- tsx
//     src/scripts/cartridge-import-preview-smoke.ts
//     --source-kind forge_project
//     --source-path C:\Greenhaven\GreenhavenWorld\.greenhaven-agent-manual\generated\cartridge-forge-project
//
// CLI flags:
//   --source-kind <obsidian_vault|forge_project|agent_pack>
//   --source-path <abs path>
//   --out <result dir>      Where to write `result.json`. Default:
//                           `.codex/run-logs/live-playtest/cartridge-import-preview-smoke`.
//   --timeout-ms <n>        Hard ceiling per job. Default 180000.
//   --keep-temp             Don't delete the temp PGlite dir.
//
// Exits 0 on PASS (preview reached `ready`), 1 otherwise.

import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ImportJobView, ImportSourceKind} from '../services/CartridgeImportPreviewService.js';

interface Args {
  sourceKind: ImportSourceKind;
  sourcePath: string;
  outDir: string;
  timeoutMs: number;
  keepTemp: boolean;
}

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  '.codex',
  'run-logs',
  'live-playtest',
  'cartridge-import-preview-smoke',
);

function parseArgs(argv: string[]): Args {
  let sourceKind: ImportSourceKind | null = null;
  let sourcePath = '';
  let outDir = DEFAULT_OUT;
  let timeoutMs = 180_000;
  let keepTemp = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source-kind') {
      const v = argv[++i] ?? '';
      if (
        v !== 'obsidian_vault' &&
        v !== 'forge_project' &&
        v !== 'agent_pack'
      ) {
        throw new Error(
          `--source-kind must be one of obsidian_vault | forge_project | agent_pack, got '${v}'`,
        );
      }
      sourceKind = v;
    } else if (arg === '--source-path') {
      sourcePath = argv[++i] ?? '';
    } else if (arg === '--out') {
      outDir = argv[++i] ?? outDir;
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number(argv[++i] ?? timeoutMs) || timeoutMs;
    } else if (arg === '--keep-temp') {
      keepTemp = true;
    }
  }
  if (!sourceKind) {
    throw new Error('--source-kind is required');
  }
  if (!sourcePath) {
    throw new Error('--source-path is required');
  }
  return {sourceKind, sourcePath, outDir, timeoutMs, keepTemp};
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  await mkdir(args.outDir, {recursive: true});

  const dbDir = await mkdtemp(
    path.join(os.tmpdir(), 'cart-lib-preview-smoke-'),
  );
  process.env.PGLITE_DATA_DIR = dbDir;
  process.env.AUTH_SECRET ??= 'cartridge-import-preview-smoke-secret-32-bytes';
  process.env.FEATHERLESS_API_KEY ??= 'smoke-not-real-key';
  process.env.NODE_ENV ??= 'development';

  // Apply the full migration chain so cartridge_import_preview_jobs +
  // cartridges + cartridge_install_cache exist. We don't need a
  // running Hono server.
  const {runMigrations} = await import('../migrate.js');
  const {closeDb} = await import('../db.js');
  await runMigrations();

  const {CartridgeImportPreviewService} = await import(
    '../services/CartridgeImportPreviewService.js'
  );

  const log = (msg: string): void => {
    process.stderr.write(`[cart-lib-preview-smoke] ${msg}\n`);
  };
  log(
    `preview source=${args.sourceKind} path=${args.sourcePath} timeout=${args.timeoutMs}ms`,
  );

  let passed = false;
  let finalView: ImportJobView | null = null;
  const blockers: string[] = [];
  try {
    const created = await CartridgeImportPreviewService.createJob({
      sourceKind: args.sourceKind,
      sourcePath: args.sourcePath,
      mode: 'dry_run',
    });
    log(`created job=${created.jobId} status=${created.status}`);
    const deadline = Date.now() + args.timeoutMs;
    let last = created;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const next = await CartridgeImportPreviewService.getJob(created.jobId);
      if (!next) {
        blockers.push('job vanished from DB before reaching ready');
        break;
      }
      if (next.status !== last.status || next.phase !== last.phase) {
        log(`status=${next.status} phase=${next.phase}`);
      }
      last = next;
      if (
        next.status === 'ready' ||
        next.status === 'failed' ||
        next.status === 'cancelled'
      ) {
        break;
      }
    }
    finalView = last;
    if (last.status === 'ready') {
      passed = true;
      log(
        `PASS records=${last.result?.totalRecords} cartridge=${last.result?.cartridgeId} hash=${last.result?.contentHash?.slice(0, 20)}...`,
      );
    } else {
      blockers.push(
        `preview ended with status=${last.status} error=${JSON.stringify(last.error)}`,
      );
    }
  } catch (err) {
    blockers.push(
      `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await closeDb().catch(() => {});
    if (!args.keepTemp) {
      await rm(dbDir, {recursive: true, force: true}).catch(() => {});
    }
  }

  const finishedAt = new Date();
  const result = {
    passed,
    blockers,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    sourceKind: args.sourceKind,
    sourcePath: args.sourcePath,
    finalView,
  };
  writeFileSync(
    path.join(args.outDir, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  if (passed) {
    log(`PASS — result.json written to ${args.outDir}`);
    return 0;
  }
  log(`FAIL — blockers: ${JSON.stringify(blockers)}`);
  return 1;
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(FILE)
  : false;

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error('[cart-lib-preview-smoke] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runCartridgeImportPreviewSmoke};
