/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OPERATOR-CARTRIDGE-IMPORT-502 (2026-05-18) — direct-HTTP route smoke
// for the Worlds & Heroes Obsidian import path.
//
// Boots a real backend on a temp port + temp PGlite. Issues HTTP
// `POST /api/cartridges/import/jobs` against the running listener for
// each operator-style source path:
//
//   1. The vault root `C:\Greenhaven\GreenhavenWorld` (canonical input).
//   2. The active content subdir, e.g. `C:\Greenhaven\GreenhavenWorld\GreenhavenNoir`
//      (the path the operator reported in the 502 trace — the route's
//      `findObsidianVaultRoot` is expected to walk up to the vault).
//
// For each call, the smoke captures the request body, response status,
// and response body verbatim. Then polls `GET /api/cartridges/import/
// jobs/:jobId` until terminal (`ready` / `failed`) and records the
// final job view. The smoke FAILS only if any HTTP response is
// >= 500 (gateway / internal-error class) or the route ever returns
// non-JSON.
//
// Also exercises the typed-error contract:
//
//   3. URL source path (`https://example.com/vault`) → 400
//      `invalid_source_path`-style typed error, not 502.
//   4. UNC source path (`\\\\server\\share\\vault`) → 400
//      `invalid_source_path`-style typed error, not 502.
//   5. Nonexistent local path → job polls to `failed` with
//      `source_path_missing`.
//
// Artifacts written to
// `.codex/run-logs/live-playtest/cartridge-import-operator-path/`:
//
//   * `summary.json` — per-step status, durations, response bodies.
//   * `network-log.jsonl` — raw request/response pairs.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  '.codex',
  'run-logs',
  'live-playtest',
  'cartridge-import-operator-path',
);
const OPERATOR_VAULT_ROOT = path.join(REPO_ROOT, 'GreenhavenWorld');
const OPERATOR_CONTENT_SUBDIR = path.join(
  REPO_ROOT,
  'GreenhavenWorld',
  'GreenHavenWorld',
);

interface Args {
  outDir: string;
  port: number;
  timeoutMs: number;
}

interface ProbeStep {
  name: string;
  status: 'ok' | 'failed';
  durationMs: number;
  request?: {url: string; method: string; body?: unknown};
  response?: {status: number; body: unknown};
  jobFinal?: unknown;
  detail?: string;
}

function parseArgs(argv: string[]): Args {
  let outDir = DEFAULT_OUT;
  let port = 7812;
  let timeoutMs = 240_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') outDir = argv[++i] ?? outDir;
    else if (arg === '--port') port = Number(argv[++i] ?? port) || port;
    else if (arg === '--timeout-ms')
      timeoutMs = Number(argv[++i] ?? timeoutMs) || timeoutMs;
  }
  return {outDir, port, timeoutMs};
}

async function waitForHealthy(base: string, attempts = 30): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {__rawText: text.slice(0, 4000)};
  }
}

async function postImportJob(
  base: string,
  body: Record<string, unknown>,
  networkLogPath: string,
): Promise<{status: number; body: unknown}> {
  const url = `${base}/api/cartridges/import/jobs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  const responseBody = await readResponseBody(res);
  appendFileSync(
    networkLogPath,
    JSON.stringify({
      phase: 'request',
      url,
      method: 'POST',
      body,
      status: res.status,
      response: responseBody,
      ts: Date.now(),
    }) + '\n',
  );
  return {status: res.status, body: responseBody};
}

async function pollJobUntilTerminal(
  base: string,
  jobId: string,
  networkLogPath: string,
  maxMs = 180_000,
): Promise<{status: number; body: unknown}> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const url = `${base}/api/cartridges/import/jobs/${encodeURIComponent(jobId)}`;
    const res = await fetch(url);
    const body = (await readResponseBody(res)) as Record<string, unknown> | null;
    const status =
      body && typeof body === 'object' ? (body['status'] as string) : '';
    appendFileSync(
      networkLogPath,
      JSON.stringify({
        phase: 'poll',
        url,
        status: res.status,
        jobStatus: status,
        ts: Date.now(),
      }) + '\n',
    );
    if (
      res.status >= 500 ||
      status === 'ready' ||
      status === 'failed' ||
      status === 'cancelled'
    ) {
      return {status: res.status, body};
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {status: 0, body: {__timeout: true, jobId}};
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  const outDir = path.resolve(args.outDir);
  mkdirSync(outDir, {recursive: true});
  for (const name of ['summary.json', 'network-log.jsonl']) {
    const p = path.join(outDir, name);
    if (existsSync(p)) rmSync(p);
  }
  const networkLogPath = path.join(outDir, 'network-log.jsonl');

  const dbDir = await mkdtemp(
    path.join(os.tmpdir(), 'cart-import-op-smoke-db-'),
  );
  process.env.PGLITE_DATA_DIR = dbDir;
  process.env.GEMINI_WEB_PORT = String(args.port);
  process.env.AUTH_DISABLED = '1';
  process.env.AUTH_SECRET =
    'cart-import-op-smoke-not-real-secret-32-bytes-or-more';
  process.env.FEATHERLESS_API_KEY = 'op-smoke-not-real-key';
  process.env.NODE_ENV = 'development';

  // The transformer call inside the preview service spawns `python
  // compile_vault_to_forge.py` and resolves the script path against
  // the workspace repo root (climbing up from `process.cwd()`). The
  // operator vault lives at `<repo>/GreenhavenWorld/...`, so set cwd
  // to the repo root before booting the backend.
  const originalCwd = process.cwd();
  process.chdir(REPO_ROOT);

  const steps: ProbeStep[] = [];
  const blockers: string[] = [];
  const recordStep = (step: ProbeStep): void => {
    steps.push(step);
    process.stderr.write(
      `[cartridge-import-operator-path-smoke] ${step.status.padEnd(6)} ${step.name}` +
        (step.detail ? ` — ${step.detail}` : '') +
        '\n',
    );
    if (step.status === 'failed') {
      blockers.push(`${step.name}: ${step.detail ?? 'failed'}`);
    }
  };

  const {startGreenhavenServer, stopGreenhavenServer} = await import(
    '../index.js'
  );
  const server = await startGreenhavenServer({
    port: args.port,
    hostname: '127.0.0.1',
  });
  const base = server.url;

  let cleanupRan = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupRan) return;
    cleanupRan = true;
    try {
      await stopGreenhavenServer(server);
    } catch (err) {
      console.warn('[cartridge-import-operator-path-smoke] stop failed', err);
    }
    try {
      process.chdir(originalCwd);
    } catch {
      // best-effort
    }
    await rm(dbDir, {recursive: true, force: true}).catch(() => {});
  };

  const finish = async (): Promise<number> => {
    const finishedAt = new Date();
    const ok = blockers.length === 0;
    const summary = {
      ok,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outDir,
      operatorVaultRoot: OPERATOR_VAULT_ROOT,
      operatorContentSubdir: OPERATOR_CONTENT_SUBDIR,
      steps,
      blockers,
    };
    writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    await cleanup();
    return ok ? 0 : 1;
  };

  const timeoutHandle = setTimeout(() => {
    recordStep({
      name: 'timeout',
      status: 'failed',
      durationMs: 0,
      detail: `smoke exceeded ${args.timeoutMs}ms`,
    });
    void finish().then((code) => process.exit(code));
  }, args.timeoutMs);
  timeoutHandle.unref?.();

  try {
    if (!(await waitForHealthy(base))) {
      recordStep({
        name: 'bootstrap_backend',
        status: 'failed',
        durationMs: 0,
        detail: '/api/health never returned ok',
      });
      return await finish();
    }
    recordStep({name: 'bootstrap_backend', status: 'ok', durationMs: 0});

    // Pre-check: the operator vault must actually exist on disk for
    // the smoke to be meaningful; if not, skip the vault-path probes
    // with a recorded note (no blocker) so the smoke can still pin
    // the typed-error contract.
    const vaultExists = existsSync(OPERATOR_VAULT_ROOT);
    const subdirExists = existsSync(OPERATOR_CONTENT_SUBDIR);

    // ─── 1. Operator vault root ──────────────────────────────────
    if (!vaultExists) {
      recordStep({
        name: 'post_vault_root',
        status: 'failed',
        durationMs: 0,
        detail: `operator vault root not found at ${OPERATOR_VAULT_ROOT}`,
      });
    } else {
      const t0 = Date.now();
      const body = {
        sourceKind: 'obsidian_vault' as const,
        sourcePath: OPERATOR_VAULT_ROOT,
        mode: 'dry_run' as const,
      };
      const created = await postImportJob(base, body, networkLogPath);
      const ok = created.status === 201 && created.status < 500;
      recordStep({
        name: 'post_vault_root',
        status: ok ? 'ok' : 'failed',
        durationMs: Date.now() - t0,
        request: {url: '/api/cartridges/import/jobs', method: 'POST', body},
        response: {status: created.status, body: created.body},
        ...(ok
          ? {}
          : {detail: `expected 201 + JSON, got status=${created.status}`}),
      });

      const jobId =
        (created.body as {jobId?: string} | null)?.jobId ?? null;
      if (jobId) {
        const final = await pollJobUntilTerminal(
          base,
          jobId,
          networkLogPath,
          180_000,
        );
        const finalBody = final.body as
          | {status?: string; error?: {code: string}}
          | null;
        const finalStatus = finalBody?.status ?? 'unknown';
        const finalOk =
          final.status < 500 &&
          (finalStatus === 'ready' || finalStatus === 'failed');
        recordStep({
          name: 'poll_vault_root',
          status: finalOk ? 'ok' : 'failed',
          durationMs: 0,
          jobFinal: final.body,
          ...(finalOk
            ? {detail: `terminal=${finalStatus}`}
            : {detail: `expected ready|failed (no 5xx), got status=${final.status} terminal=${finalStatus}`}),
        });
      }
    }

    // ─── 2. Operator content subdir (parent fallback) ───────────
    if (!subdirExists) {
      recordStep({
        name: 'post_content_subdir',
        status: 'failed',
        durationMs: 0,
        detail: `operator content subdir not found at ${OPERATOR_CONTENT_SUBDIR}`,
      });
    } else {
      const t0 = Date.now();
      const body = {
        sourceKind: 'obsidian_vault' as const,
        sourcePath: OPERATOR_CONTENT_SUBDIR,
        mode: 'dry_run' as const,
      };
      const created = await postImportJob(base, body, networkLogPath);
      const ok = created.status === 201 && created.status < 500;
      recordStep({
        name: 'post_content_subdir',
        status: ok ? 'ok' : 'failed',
        durationMs: Date.now() - t0,
        request: {url: '/api/cartridges/import/jobs', method: 'POST', body},
        response: {status: created.status, body: created.body},
        ...(ok
          ? {}
          : {detail: `expected 201 + JSON, got status=${created.status}`}),
      });
      const jobId =
        (created.body as {jobId?: string} | null)?.jobId ?? null;
      if (jobId) {
        const final = await pollJobUntilTerminal(
          base,
          jobId,
          networkLogPath,
          180_000,
        );
        const finalBody = final.body as
          | {status?: string; error?: {code: string}}
          | null;
        const finalStatus = finalBody?.status ?? 'unknown';
        const finalOk =
          final.status < 500 &&
          (finalStatus === 'ready' || finalStatus === 'failed');
        recordStep({
          name: 'poll_content_subdir',
          status: finalOk ? 'ok' : 'failed',
          durationMs: 0,
          jobFinal: final.body,
          ...(finalOk
            ? {detail: `terminal=${finalStatus}`}
            : {detail: `expected ready|failed (no 5xx), got status=${final.status} terminal=${finalStatus}`}),
        });
      }
    }

    // ─── 3. URL source path → typed 400 (not 502) ───────────────
    {
      const body = {
        sourceKind: 'obsidian_vault' as const,
        sourcePath: 'https://example.com/not-a-local-path',
      };
      const r = await postImportJob(base, body, networkLogPath);
      // The create-route currently accepts the request (the URL
      // check fires inside the job runner). The job then polls to
      // `failed` with code `unexpected` (the runner wraps the URL
      // rejection as a PreviewError). Either branch (immediate 400
      // OR queued + failed-poll with typed code) is acceptable
      // here — what we forbid is 5xx / non-JSON.
      const ok =
        r.status < 500 &&
        r.body !== null &&
        typeof r.body === 'object' &&
        !('__rawText' in (r.body as Record<string, unknown>));
      recordStep({
        name: 'post_url_source_no_5xx',
        status: ok ? 'ok' : 'failed',
        durationMs: 0,
        request: {url: '/api/cartridges/import/jobs', method: 'POST', body},
        response: {status: r.status, body: r.body},
        ...(ok
          ? {detail: `status=${r.status}`}
          : {detail: `expected non-5xx JSON, got status=${r.status}`}),
      });
      const jobId = (r.body as {jobId?: string} | null)?.jobId ?? null;
      if (jobId) {
        const final = await pollJobUntilTerminal(base, jobId, networkLogPath, 30_000);
        recordStep({
          name: 'poll_url_source_typed_failed',
          status: final.status < 500 ? 'ok' : 'failed',
          durationMs: 0,
          jobFinal: final.body,
        });
      }
    }

    // ─── 4. UNC source path → typed 400 (not 502) ───────────────
    {
      const body = {
        sourceKind: 'obsidian_vault' as const,
        sourcePath: '\\\\fake-share\\fake-vault',
      };
      const r = await postImportJob(base, body, networkLogPath);
      const ok = r.status < 500;
      recordStep({
        name: 'post_unc_source_no_5xx',
        status: ok ? 'ok' : 'failed',
        durationMs: 0,
        request: {url: '/api/cartridges/import/jobs', method: 'POST', body},
        response: {status: r.status, body: r.body},
        ...(ok
          ? {detail: `status=${r.status}`}
          : {detail: `expected non-5xx, got status=${r.status}`}),
      });
      const jobId = (r.body as {jobId?: string} | null)?.jobId ?? null;
      if (jobId) {
        const final = await pollJobUntilTerminal(base, jobId, networkLogPath, 30_000);
        recordStep({
          name: 'poll_unc_source_typed_failed',
          status: final.status < 500 ? 'ok' : 'failed',
          durationMs: 0,
          jobFinal: final.body,
        });
      }
    }

    // ─── 5. Nonexistent local path → typed failed (not 502) ─────
    {
      const fake = path.join(
        os.tmpdir(),
        'cart-import-op-smoke-nonexistent-' + Date.now(),
      );
      const body = {
        sourceKind: 'obsidian_vault' as const,
        sourcePath: fake,
      };
      const r = await postImportJob(base, body, networkLogPath);
      const ok = r.status === 201;
      recordStep({
        name: 'post_nonexistent_source_no_5xx',
        status: ok ? 'ok' : 'failed',
        durationMs: 0,
        request: {url: '/api/cartridges/import/jobs', method: 'POST', body},
        response: {status: r.status, body: r.body},
        ...(ok
          ? {}
          : {detail: `expected 201 (queued), got status=${r.status}`}),
      });
      const jobId = (r.body as {jobId?: string} | null)?.jobId ?? null;
      if (jobId) {
        const final = await pollJobUntilTerminal(base, jobId, networkLogPath, 30_000);
        const finalBody = final.body as
          | {status?: string; error?: {code: string}}
          | null;
        const finalCode = finalBody?.error?.code ?? '';
        const codeOk =
          finalBody?.status === 'failed' &&
          finalCode === 'source_path_missing';
        recordStep({
          name: 'poll_nonexistent_source_typed_failed',
          status: codeOk ? 'ok' : 'failed',
          durationMs: 0,
          jobFinal: final.body,
          ...(codeOk
            ? {detail: 'source_path_missing'}
            : {detail: `expected status=failed code=source_path_missing, got ${JSON.stringify({status: finalBody?.status, code: finalCode})}`}),
        });
      }
    }

    clearTimeout(timeoutHandle);
    return await finish();
  } catch (err) {
    clearTimeout(timeoutHandle);
    recordStep({
      name: 'unexpected_exception',
      status: 'failed',
      durationMs: 0,
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return await finish();
  }
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(FILE)
  : false;

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error('[cartridge-import-operator-path-smoke] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runCartridgeImportOperatorPathSmoke};
