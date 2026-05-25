/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-3 stable apply smoke.
//
// 1. Boots a temp PGlite + full migration chain.
// 2. Drives `CartridgeImportPreviewService` to a `ready` job for
//    the supplied `--source-kind` + `--source-path`.
// 3. Drives `CartridgeImportApplyService.apply(jobId)`.
// 4. Asserts the install-cache row + cartridge_records rows +
//    job status / diff counts and writes `result.json`.
//
// Usage:
//
//   npm --prefix packages/web-server exec -- tsx
//     packages/web-server/src/scripts/cartridge-import-apply-smoke.ts
//     --source-kind forge_project
//     --source-path C:/Greenhaven/GreenhavenWorld/.greenhaven-agent-manual/generated/cartridge-forge-project

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
  acceptWarnings: boolean;
}

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  '.codex',
  'run-logs',
  'live-playtest',
  'cartridge-import-apply-smoke',
);

function parseArgs(argv: string[]): Args {
  let sourceKind: ImportSourceKind | null = null;
  let sourcePath = '';
  let outDir = DEFAULT_OUT;
  let timeoutMs = 240_000;
  let keepTemp = false;
  let acceptWarnings = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source-kind') {
      const v = argv[++i] ?? '';
      if (
        v !== 'obsidian_vault' &&
        v !== 'forge_project' &&
        v !== 'agent_pack'
      ) {
        throw new Error(`--source-kind invalid: ${v}`);
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
    } else if (arg === '--accept-warnings') {
      acceptWarnings = true;
    }
  }
  if (!sourceKind) throw new Error('--source-kind is required');
  if (!sourcePath) throw new Error('--source-path is required');
  return {sourceKind, sourcePath, outDir, timeoutMs, keepTemp, acceptWarnings};
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  await mkdir(args.outDir, {recursive: true});
  const dbDir = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-apply-smoke-'));
  process.env.PGLITE_DATA_DIR = dbDir;
  process.env.AUTH_SECRET ??= 'cartridge-import-apply-smoke-secret-32-bytes';
  process.env.FEATHERLESS_API_KEY ??= 'smoke-not-real-key';
  process.env.NODE_ENV ??= 'development';

  const {runMigrations} = await import('../migrate.js');
  const {closeDb, query} = await import('../db.js');
  await runMigrations();

  const {CartridgeImportPreviewService} = await import(
    '../services/CartridgeImportPreviewService.js'
  );
  const {CartridgeImportApplyService} = await import(
    '../services/CartridgeImportApplyService.js'
  );

  const log = (msg: string): void => {
    process.stderr.write(`[cart-lib-apply-smoke] ${msg}\n`);
  };
  log(
    `preview source=${args.sourceKind} path=${args.sourcePath} timeout=${args.timeoutMs}ms`,
  );

  let passed = false;
  let finalView: ImportJobView | null = null;
  const blockers: string[] = [];
  let installCache: Record<string, unknown> | null = null;
  let recordRows: Array<Record<string, unknown>> = [];
  try {
    const created = await CartridgeImportPreviewService.createJob({
      sourceKind: args.sourceKind,
      sourcePath: args.sourcePath,
      mode: 'install',
    });
    log(`preview job=${created.jobId}`);
    const deadline = Date.now() + args.timeoutMs;
    let last = created;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const next = await CartridgeImportPreviewService.getJob(created.jobId);
      if (!next) {
        blockers.push('preview job vanished');
        break;
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
    if (last.status !== 'ready') {
      blockers.push(`preview ended with status=${last.status}`);
    } else {
      log(
        `preview ready records=${last.result?.totalRecords} cartridge=${last.result?.cartridgeId}`,
      );
      const applied = await CartridgeImportApplyService.apply({
        jobId: created.jobId,
        acceptWarnings: args.acceptWarnings,
      });
      finalView = applied;
      if (applied.status !== 'applied') {
        blockers.push(`apply ended with status=${applied.status}`);
      } else {
        const appliedResult = (applied.result as unknown as {
          applyResult?: Record<string, unknown>;
        })?.applyResult;
        log(`apply ok diff=${JSON.stringify(appliedResult?.['diff'])}`);

        const cartridgeId = applied.result?.cartridgeId ?? '';
        const cacheRow = await query<Record<string, unknown>>(
          `SELECT cartridge_id, state, content_hash, record_count,
                  applied_at::text AS applied_at,
                  applied_job_id
             FROM cartridge_install_cache
            WHERE cartridge_id = $1`,
          [cartridgeId],
        );
        installCache = cacheRow.rows[0] ?? null;
        if (!installCache) {
          blockers.push('install_cache row missing after apply');
        }
        const records = await query<Record<string, unknown>>(
          `SELECT record_id, kind, slug, status, imported_entity_id
             FROM cartridge_records
            WHERE cartridge_id = $1
            ORDER BY record_id ASC
            LIMIT 5`,
          [cartridgeId],
        );
        recordRows = records.rows;
        if (recordRows.length === 0) {
          blockers.push('no cartridge_records rows after apply');
        }
        passed = blockers.length === 0;
      }
    }
  } catch (err) {
    blockers.push(
      `unexpected: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await closeDb().catch(() => {});
    if (!args.keepTemp) {
      await rm(dbDir, {recursive: true, force: true}).catch(() => {});
    }
  }

  const finishedAt = new Date();
  const out = {
    passed,
    blockers,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    sourceKind: args.sourceKind,
    sourcePath: args.sourcePath,
    finalView,
    installCache,
    recordSample: recordRows,
  };
  writeFileSync(
    path.join(args.outDir, 'result.json'),
    JSON.stringify(out, null, 2),
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
      console.error('[cart-lib-apply-smoke] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runCartridgeImportApplySmoke};
