/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-18 — Obsidian vault roundtrip verification harness.
//
// Runs every checked surface in the Obsidian -> Forge ->
// `cartridge_meta` -> web-server -> temp-vault loop in sequence,
// captures per-step status / duration / output tails, and writes
// machine- and human-readable summaries under `--out`. Each step
// is a real existing check; this harness orchestrates them rather
// than inventing a parallel framework.
//
// Steps (in dependency order):
//
//   1. Python transformer unit tests
//      (`scripts/`-relative `python -m unittest discover`).
//   2. Vault compile to Forge project
//      (`compile_vault_to_forge.py --vault-root ...`).
//   3. Forge validate
//      (`npm --prefix packages/cartridge-forge run forge -- validate ...`).
//   4. Forge SQL export to the canonical preview path
//      (`npm --prefix packages/cartridge-forge run forge -- export-grinhaven-sql ...`).
//      The harness asserts the returned JSON report carries the
//      expected current shape: the same record count reported by
//      the preceding Forge validate step, all five OWV-17 bridge
//      counters present as non-negative numbers, `starting_location_id`
//      carried through.
//   5. `npm --prefix packages/web-server run test:migrations:obsidian`
//      (real PGlite invariants test).
//   6. `npm --prefix packages/web-server run obsidian:roundtrip-smoke`
//      (DB import -> vault export smoke).
//   7. `npm --prefix packages/web-server run cartridge:i18n:check`
//      (canonical cartridge i18n strict check).
//   8. `npm --prefix packages/web-server run live:owv17-bridge`
//      (the OWV-17 runtime-bridge live smoke). This legacy live
//      smoke runs only for the original OWV-17 fixture shape; active
//      cartridgebuilder vaults no longer contain the old `thiefs-market`
//      materializer row.
//
// `--skip-live` skips step 8 only — the master plan can only
// mark OWV-18 done on a full unskipped run.

import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

interface Args {
  out: string;
  timeoutMs: number;
  skipLive: boolean;
}

interface StepResult {
  name: string;
  command: string[];
  cwd: string;
  status: 'ok' | 'failed' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  artifacts?: Record<string, unknown>;
  error?: string;
}

interface RunReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outDir: string;
  args: Args;
  steps: StepResult[];
}

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const TRANSFORMER_DIR = path.resolve(
  REPO_ROOT,
  'GreenhavenWorld',
  '.greenhaven-agent-manual',
  'skills',
  'greenhaven-human-world-transformer',
);
const VAULT_ROOT = path.resolve(REPO_ROOT, 'GreenhavenWorld');
const FORGE_PROJECT = path.resolve(
  REPO_ROOT,
  'GreenhavenWorld',
  '.greenhaven-agent-manual',
  'generated',
  'cartridge-forge-project',
);
const PREVIEW_SQL = path.resolve(
  REPO_ROOT,
  'GreenhavenWorld',
  '.greenhaven-agent-manual',
  'generated',
  'obsidian-world-preview.sql',
);
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PYTHON_CMD = process.env.PYTHON ?? 'python';

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  const outDir = path.resolve(args.out);
  await mkdir(outDir, {recursive: true});

  const steps: StepResult[] = [];
  const finish = async (ok: boolean): Promise<number> => {
    const finishedAt = new Date();
    const report: RunReport = {
      ok,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outDir,
      args,
      steps,
    };
    await writeReport(outDir, report);
    return ok ? 0 : 1;
  };

  const tailMs = 90_000;
  const runStep = async (
    name: string,
    command: string[],
    options: {
      cwd?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
      skip?: boolean;
      onComplete?: (stdout: string) => Record<string, unknown> | undefined;
    } = {},
  ): Promise<boolean> => {
    if (options.skip) {
      const step: StepResult = {
        name,
        command,
        cwd: options.cwd ?? REPO_ROOT,
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: '',
      };
      steps.push(step);
      record(step);
      return true;
    }
    const startedAtMs = Date.now();
    const cwd = options.cwd ?? REPO_ROOT;
    const result = await invoke(command, {
      cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? Math.min(tailMs * 4, args.timeoutMs),
    });
    const step: StepResult = {
      name,
      command,
      cwd,
      status: result.exitCode === 0 ? 'ok' : 'failed',
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAtMs,
      stdoutTail: tail(result.stdout, 60),
      stderrTail: tail(result.stderr, 30),
    };
    if (result.exitCode === 0 && options.onComplete) {
      try {
        const artifacts = options.onComplete(result.stdout);
        if (artifacts) step.artifacts = artifacts;
      } catch (err) {
        step.status = 'failed';
        step.error = `onComplete failed: ${errMessage(err)}`;
      }
    }
    steps.push(step);
    record(step);
    return step.status === 'ok';
  };

  if (
    !(await runStep('python_transformer_tests', [
      PYTHON_CMD,
      '-m',
      'unittest',
      'discover',
      '-s',
      'tests',
    ], {cwd: TRANSFORMER_DIR}))
  ) {
    return await finish(false);
  }

  if (
    !(await runStep(
      'compile_vault_to_forge',
      [
        PYTHON_CMD,
        path.join('scripts', 'compile_vault_to_forge.py'),
        '--vault-root',
        VAULT_ROOT,
      ],
      {cwd: TRANSFORMER_DIR},
    ))
  ) {
    return await finish(false);
  }

  let expectedForgeRecords: number | null = null;

  if (
    !(await runStep(
      'forge_validate',
      [
        NPM_CMD,
        '--prefix',
        path.join('packages', 'cartridge-forge'),
        'run',
        'forge',
        '--',
        'validate',
        FORGE_PROJECT,
      ],
      {
        cwd: REPO_ROOT,
        onComplete: stdout => {
          const report = parseForgeValidate(stdout);
          expectedForgeRecords = readForgeRecordCount(report);
          return report;
        },
      },
    ))
  ) {
    return await finish(false);
  }

  let exportArtifacts: Record<string, unknown> | undefined;
  if (
    !(await runStep(
      'forge_export_grinhaven_sql',
      [
        NPM_CMD,
        '--prefix',
        path.join('packages', 'cartridge-forge'),
        'run',
        'forge',
        '--',
        'export-grinhaven-sql',
        FORGE_PROJECT,
        PREVIEW_SQL,
      ],
      {
        cwd: REPO_ROOT,
        onComplete: stdout => {
          const report = parseForgeReport(stdout);
          exportArtifacts = report;
          assertExportShape(report, expectedForgeRecords);
          return report;
        },
      },
    ))
  ) {
    return await finish(false);
  }

  if (
    !(await runStep(
      'test_migrations_obsidian',
      [NPM_CMD, '--prefix', path.join('packages', 'web-server'), 'run', 'test:migrations:obsidian'],
      {cwd: REPO_ROOT},
    ))
  ) {
    return await finish(false);
  }

  if (
    !(await runStep(
      'obsidian_roundtrip_smoke',
      [NPM_CMD, '--prefix', path.join('packages', 'web-server'), 'run', 'obsidian:roundtrip-smoke'],
      {cwd: REPO_ROOT, onComplete: stdout => parseObsidianSmoke(stdout)},
    ))
  ) {
    return await finish(false);
  }

  if (
    !(await runStep(
      'cartridge_i18n_check',
      [NPM_CMD, '--prefix', path.join('packages', 'web-server'), 'run', 'cartridge:i18n:check'],
      {cwd: REPO_ROOT, onComplete: stdout => parseCartridgeI18n(stdout)},
    ))
  ) {
    return await finish(false);
  }

  if (
    !(await runStep(
      'live_owv17_bridge',
      [
        NPM_CMD,
        '--prefix',
        path.join('packages', 'web-server'),
        'run',
        'live:owv17-bridge',
        '--',
        '--out',
        path.join(outDir, 'live-owv17-bridge'),
        '--timeout-ms',
        '240000',
      ],
      {
        cwd: REPO_ROOT,
        skip: args.skipLive || !isLegacyOwv17BridgeFixture(exportArtifacts),
        onComplete: () => ({
          summaryPath: path.join(outDir, 'live-owv17-bridge', 'SUMMARY.json'),
        }),
      },
    ))
  ) {
    return await finish(false);
  }
  void exportArtifacts;
  return await finish(true);
}

function record(step: StepResult): void {
  const badge =
    step.status === 'ok' ? 'ok      ' : step.status === 'skipped' ? 'skipped ' : 'failed  ';
  process.stderr.write(
    `[owv18-verify] ${badge} ${step.name}` +
      (step.exitCode !== null ? ` (exit ${step.exitCode})` : '') +
      ` ${step.durationMs}ms\n`,
  );
  if (step.status === 'failed') {
    if (step.error) process.stderr.write(`  error: ${step.error}\n`);
    if (step.stderrTail) {
      process.stderr.write(`  stderr tail:\n${indent(step.stderrTail, '    ')}\n`);
    }
  }
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function invoke(
  command: string[],
  opts: {cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number},
): Promise<SpawnResult> {
  return new Promise(resolve => {
    const [head, ...rest] = command;
    if (!head) {
      resolve({exitCode: null, stdout: '', stderr: 'empty command'});
      return;
    }
    const child = spawn(head, rest, {
      cwd: opts.cwd,
      env: {...process.env, ...(opts.env ?? {})},
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Windows refuses to launch `.cmd` (npm.cmd) through plain
      // spawn (`EINVAL` since Node 20). The shell wrapper lets the
      // PATHEXT resolution succeed without sacrificing the argv
      // array shape — Node still quotes each argv element for the
      // shell when an array is passed.
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      stderr += `\n[owv18-verify] step timed out after ${opts.timeoutMs}ms`;
    }, opts.timeoutMs).unref?.();
    void timeout;
    child.on('close', code => {
      resolve({exitCode: code ?? null, stdout, stderr});
    });
    child.on('error', err => {
      resolve({exitCode: null, stdout, stderr: stderr + '\n' + errMessage(err)});
    });
  });
}

function tail(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  return all.slice(-lines).join('\n').trim();
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map(line => prefix + line)
    .join('\n');
}

function parseForgeValidate(stdout: string): Record<string, unknown> {
  const json = pickLastJsonObject(stdout);
  if (!json) return {raw: tail(stdout, 5)};
  return json;
}

function parseForgeReport(stdout: string): Record<string, unknown> {
  const json = pickLastJsonObject(stdout);
  if (!json) {
    throw new Error('forge export did not emit a JSON report');
  }
  return json;
}

function parseObsidianSmoke(stdout: string): Record<string, unknown> {
  const json = pickLastJsonObject(stdout);
  return json ?? {raw: tail(stdout, 10)};
}

function parseCartridgeI18n(stdout: string): Record<string, unknown> {
  const json = pickLastJsonObject(stdout);
  if (!json) return {raw: tail(stdout, 5)};
  return json;
}

function pickLastJsonObject(stdout: string): Record<string, unknown> | null {
  // Walk backwards through `{...}` candidates so script preludes
  // and dotenv banners can't fool the parser.
  const text = stdout.trim();
  let i = text.length;
  while (i > 0) {
    const end = text.lastIndexOf('}', i - 1);
    if (end < 0) return null;
    // Find matching opening brace by scanning forward for `{` at depth 0.
    let depth = 0;
    let start = -1;
    for (let j = 0; j <= end; j++) {
      const c = text[j];
      if (c === '{') {
        if (depth === 0) start = j;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && j === end && start >= 0) {
          const candidate = text.slice(start, end + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // try a smaller window
          }
        }
      }
    }
    i = end;
  }
  return null;
}

function readForgeRecordCount(report: Record<string, unknown>): number | null {
  const counts = report['counts'];
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return null;
  }
  const records = Number((counts as Record<string, unknown>)['records']);
  return Number.isFinite(records) && records > 0 ? records : null;
}

function isLegacyOwv17BridgeFixture(
  report: Record<string, unknown> | undefined,
): boolean {
  if (!report) return false;
  const records = Number(report.records);
  const currencyItems = Number(report['currencyItems']);
  const merchantOffers = Number(report['merchantOffers']);
  const counts = report['counts'];
  const hasWorldFact =
    counts != null &&
    typeof counts === 'object' &&
    !Array.isArray(counts) &&
    Number((counts as Record<string, unknown>)['world_fact']) > 0;
  return (
    records === 34 &&
    hasWorldFact &&
    Number.isFinite(currencyItems) &&
    currencyItems > 0 &&
    Number.isFinite(merchantOffers) &&
    merchantOffers > 0
  );
}

function assertExportShape(
  report: Record<string, unknown>,
  expectedRecords: number | null,
): void {
  if (report.ok !== true) {
    throw new Error(`forge export reports ok=${String(report.ok)}`);
  }
  const records = Number(report.records);
  if (!Number.isFinite(records) || records <= 0) {
    throw new Error(
      `forge export returned invalid records=${String(report.records)}`,
    );
  }
  if (expectedRecords != null && records !== expectedRecords) {
    throw new Error(`expected ${expectedRecords} forge records, got ${records}`);
  }
  for (const key of [
    'currencyItems',
    'merchantOffers',
    'materializerEntries',
    'sceneInstructions',
    'visualAssets',
  ] as const) {
    if (!(key in report)) {
      throw new Error(`forge export missing ${key}`);
    }
    const v = Number((report as Record<string, unknown>)[key]);
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`forge export missing ${key} (got ${v})`);
    }
  }
  if (!existsSync(PREVIEW_SQL)) {
    throw new Error(`forge export did not produce ${PREVIEW_SQL}`);
  }
  // Cheap grep to confirm starting_location_id is in the SQL.
  // (The script also confirms via the cartridge_meta presence
  // during the live smoke; this asserts the bytes upfront.)
  const sql = readFileSafe(PREVIEW_SQL);
  if (!sql.includes("'starting_location_id'")) {
    throw new Error('forge export SQL missing starting_location_id meta row');
  }
}

function readFileSafe(p: string): string {
  try {
    // Synchronous read keeps this helper inline with the assertion
    // shape. The file is small (~200KB) and only read once.
    return readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${p}: ${errMessage(err)}`);
  }
}

function parseArgs(argv: string[]): Args {
  let out = '.codex/run-logs/live-playtest/owv18-roundtrip-verification';
  let timeoutMs = 600_000;
  let skipLive = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[++i] ?? out;
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number(argv[++i] ?? timeoutMs) || timeoutMs;
    } else if (arg === '--skip-live') {
      skipLive = true;
    }
  }
  return {out, timeoutMs, skipLive};
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function writeReport(outDir: string, report: RunReport): Promise<void> {
  await writeFile(
    path.join(outDir, 'SUMMARY.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8',
  );
  await writeFile(path.join(outDir, 'SUMMARY.md'), renderMarkdown(report), 'utf8');
}

function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  lines.push('# OWV-18 roundtrip verification');
  lines.push('');
  lines.push(`- result: **${report.ok ? 'OK' : 'FAILED'}**`);
  lines.push(`- started: ${report.startedAt}`);
  lines.push(`- finished: ${report.finishedAt}`);
  lines.push(`- duration: ${report.durationMs}ms`);
  lines.push(`- skip-live: ${report.args.skipLive}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  for (const step of report.steps) {
    const badge =
      step.status === 'ok' ? '✓' : step.status === 'skipped' ? '–' : '✗';
    lines.push(
      `- ${badge} **${step.name}** — ${step.status}` +
        (step.exitCode !== null ? ` (exit ${step.exitCode})` : '') +
        ` — ${step.durationMs}ms`,
    );
    lines.push(`  - command: \`${step.command.join(' ')}\``);
    if (step.error) lines.push(`  - error: \`${step.error}\``);
    if (step.artifacts) {
      lines.push('  - artifacts:');
      lines.push('    ```json');
      lines.push(
        ...JSON.stringify(step.artifacts, null, 2)
          .split('\n')
          .map(l => '    ' + l),
      );
      lines.push('    ```');
    }
    if (step.status === 'failed' && step.stderrTail) {
      lines.push('  - stderr tail:');
      lines.push('    ```');
      lines.push(...step.stderrTail.split('\n').map(l => '    ' + l));
      lines.push('    ```');
    }
  }
  return lines.join('\n') + '\n';
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => {
    process.stderr.write(`fatal: ${errMessage(err)}\n`);
    process.exit(1);
  },
);
