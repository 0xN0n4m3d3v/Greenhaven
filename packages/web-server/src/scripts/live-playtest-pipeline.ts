export {};

import { spawn, type ChildProcess } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configEnvSnapshot, rawConfigEnv } from '../config.js';

type JsonRecord = Record<string, unknown>;

interface Args {
  outDir: string;
  scenarios: string;
  server: string;
  language: string;
  timeoutMs: number;
}

interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

interface Diagnosis {
  slug?: string;
  severity?: 'P0' | 'P1' | 'P2' | 'INFO';
  owner?: string;
  rootCause?: string;
  evidence?: string[];
  rerun?: string[];
}

const args = parseArgs(process.argv.slice(2));
await fs.mkdir(args.outDir, { recursive: true });

let serverProcess: ChildProcess | null = null;
let startedServer = false;
const results: Record<string, CommandResult> = {};

try {
  if (!(await isHealthy(args.server))) {
    serverProcess = await startIsolatedServer(args);
    startedServer = true;
    await waitForHealth(args.server, 90_000);
  }

  const cycleDir = path.join(args.outDir, 'cycle');
  await fs.mkdir(cycleDir, { recursive: true });
  results['live:cycle'] = await runLogged(
    'npm',
    [
      '--prefix',
      'packages/web-server',
      'run',
      'live:cycle',
      '--',
      '--allow-findings',
      '--server',
      args.server,
      '--language',
      args.language,
      '--timeout-ms',
      String(args.timeoutMs),
      '--scenarios',
      args.scenarios,
      '--out',
      cycleDir,
    ],
    args.outDir,
    '01-live-cycle',
  );

  results.typecheck = await runLogged(
    'npm',
    ['--prefix', 'packages/web-server', 'run', 'typecheck'],
    args.outDir,
    '02-typecheck',
  );
  results.build = await runLogged(
    'npm',
    ['--prefix', 'packages/web-server', 'run', 'build'],
    args.outDir,
    '03-build',
  );
  results['support-smoke'] = await runLogged(
    'npx',
    [
      'tsx',
      '--env-file=packages/web-server/.env',
      'packages/web-server/src/scripts/support-smoke.ts',
      '--fixture',
      'normal',
    ],
    args.outDir,
    '04-support-smoke',
  );

  const summary = await readJsonOptional<JsonRecord>(
    path.join(cycleDir, 'SUMMARY.json'),
  );
  const rootCause = await readJsonOptional<{ diagnoses?: Diagnosis[] }>(
    path.join(cycleDir, 'ROOT_CAUSE_REPORT.json'),
  );
  const diagnoses = rootCause?.diagnoses ?? [];
  const report = renderReport({
    args,
    startedServer,
    cycleDir,
    summary,
    diagnoses,
    results,
  });
  await fs.writeFile(
    path.join(args.outDir, 'PIPELINE_REPORT.md'),
    report,
    'utf8',
  );

  const blocking = diagnoses.filter(
    (d) => d.severity === 'P0' || d.severity === 'P1',
  );
  const verificationOk = Object.values(results).every((result) => result.ok);
  const ok = blocking.length === 0 && verificationOk;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        outDir: args.outDir,
        cycleDir,
        startedServer,
        diagnoses: diagnoses.length,
        p0: diagnoses.filter((d) => d.severity === 'P0').length,
        p1: diagnoses.filter((d) => d.severity === 'P1').length,
        p2: diagnoses.filter((d) => d.severity === 'P2').length,
        verificationOk,
        report: path.join(args.outDir, 'PIPELINE_REPORT.md'),
      },
      null,
      2,
    )}\n`,
  );
  if (!ok) process.exitCode = 1;
} finally {
  if (serverProcess) await stopProcessTree(serverProcess);
}

async function startIsolatedServer(args: Args): Promise<ChildProcess> {
  const pgdata = path.join(args.outDir, 'pgdata');
  await fs.mkdir(pgdata, { recursive: true });
  const stdout = fsSync.createWriteStream(
    path.join(args.outDir, '00-server.stdout.log'),
  );
  const stderr = fsSync.createWriteStream(
    path.join(args.outDir, '00-server.stderr.log'),
  );
  const invocation = commandInvocation('npm', [
    '--prefix',
    'packages/web-server',
    'run',
    'start',
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repoRootFromCwd(),
    env: cleanEnv({
      ...configEnvSnapshot(),
      GEMINI_WEB_PORT: serverPort(args.server),
      PGLITE_DATA_DIR: pgdata,
      GREENHAVEN_TURN_WATCHDOG_MS:
        rawConfigEnv('GREENHAVEN_TURN_WATCHDOG_MS') ?? String(args.timeoutMs),
    }),
    windowsHide: true,
  });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  child.once('exit', (code) => {
    if (code != null && code !== 0) {
      process.stderr.write(
        `[live:pipeline] isolated server exited with ${code}\n`,
      );
    }
  });
  return child;
}

async function waitForHealth(server: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isHealthy(server)) return;
    await sleep(1_000);
  }
  throw new Error(`backend did not become healthy within ${timeoutMs}ms`);
}

async function isHealthy(server: string): Promise<boolean> {
  try {
    const response = await fetch(`${server.replace(/\/$/, '')}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function runLogged(
  command: string,
  commandArgs: string[],
  outDir: string,
  prefix: string,
): Promise<CommandResult> {
  const result = await runCommand(command, commandArgs);
  await fs.writeFile(
    path.join(outDir, `${prefix}.stdout.log`),
    result.stdout,
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, `${prefix}.stderr.log`),
    result.stderr,
    'utf8',
  );
  return result;
}

function runCommand(
  command: string,
  commandArgs: string[],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const invocation = commandInvocation(command, commandArgs);
    const child = spawn(invocation.command, invocation.args, {
      cwd: repoRootFromCwd(),
      env: cleanEnv(process.env),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', (err) => {
      resolve({
        ok: false,
        code: 1,
        stdout,
        stderr: `${stderr}${err.message}`,
      });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code: code ?? 1, stdout, stderr });
    });
  });
}

async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || !child.pid) return;
  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(
      () => ({
        ok: false,
        code: 1,
        stdout: '',
        stderr: '',
      }),
    );
    return;
  }
  child.kill('SIGTERM');
}

function renderReport(input: {
  args: Args;
  startedServer: boolean;
  cycleDir: string;
  summary: JsonRecord | null;
  diagnoses: Diagnosis[];
  results: Record<string, CommandResult>;
}): string {
  const p0 = input.diagnoses.filter((d) => d.severity === 'P0');
  const p1 = input.diagnoses.filter((d) => d.severity === 'P1');
  const p2 = input.diagnoses.filter((d) => d.severity === 'P2');
  const lines = [
    '# Greenhaven Victory Pipeline Report',
    '',
    `- Run: ${input.args.outDir}`,
    `- Scenario pack: ${input.args.scenarios}`,
    `- Backend: ${input.startedServer ? 'isolated server started' : 'existing healthy server used'}`,
    `- Cycle: ${input.cycleDir}`,
    `- Player/session: ${String(input.summary?.['playerId'] ?? 'unknown')} / ${String(input.summary?.['sessionId'] ?? 'unknown')}`,
    `- Diagnoses: P0=${p0.length}, P1=${p1.length}, P2=${p2.length}`,
    '',
    '## Verification',
  ];
  for (const [name, result] of Object.entries(input.results)) {
    lines.push(`- ${name}: ${result.ok ? 'ok' : `failed (${result.code})`}`);
  }
  lines.push('');
  if (input.diagnoses.length === 0) {
    lines.push('## Findings');
    lines.push('No automatic findings. Continue broader exploratory packs.');
  } else {
    lines.push('## Findings');
    for (const diagnosis of sortDiagnoses(input.diagnoses)) {
      lines.push('');
      lines.push(
        `### ${diagnosis.severity ?? 'INFO'} - ${diagnosis.slug ?? 'unknown'}`,
      );
      lines.push(`- Owner: ${diagnosis.owner ?? 'unknown'}`);
      lines.push(`- Root cause: ${diagnosis.rootCause ?? 'unknown'}`);
      const evidence = diagnosis.evidence ?? [];
      if (evidence.length > 0) {
        lines.push(`- Evidence: ${evidence.slice(0, 6).join('; ')}`);
      }
      const rerun = diagnosis.rerun?.[0];
      if (rerun) lines.push(`- Rerun: ${rerun}`);
    }
  }
  lines.push('');
  lines.push('## Loop Rule');
  lines.push(
    'Fix the first P0/P1 root cause, rerun that scenario, then rerun this pack. P2 budget findings remain open until measured under threshold or explained by bounded tool-loop variance.',
  );
  return `${lines.join('\n')}\n`;
}

function sortDiagnoses(diagnoses: Diagnosis[]): Diagnosis[] {
  const rank = new Map([
    ['P0', 0],
    ['P1', 1],
    ['P2', 2],
    ['INFO', 3],
  ]);
  return [...diagnoses].sort(
    (a, b) =>
      (rank.get(a.severity ?? 'INFO') ?? 9) -
      (rank.get(b.severity ?? 'INFO') ?? 9),
  );
}

function parseArgs(argv: string[]): Args {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outRaw =
    stringArg(argv, 'out') ??
    `.codex/run-logs/live-playtest/${stamp}-victory-pipeline`;
  return {
    outDir: resolveInputPath(outRaw),
    scenarios: stringArg(argv, 'scenarios') ?? 'greenhaven-victory-pipeline',
    server: (stringArg(argv, 'server') ?? 'http://127.0.0.1:7777').replace(
      /\/$/,
      '',
    ),
    language: stringArg(argv, 'language') ?? 'ru',
    timeoutMs: positiveIntArg(argv, 'timeout-ms') ?? 180_000,
  };
}

function commandInvocation(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args };
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].map(quoteWinArg).join(' ')],
  };
}

function quoteWinArg(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function serverPort(server: string): string {
  try {
    return new URL(server).port || '7777';
  } catch {
    return '7777';
  }
}

async function readJsonOptional<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null;
    throw err;
  }
}

function resolveInputPath(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(repoRootFromCwd(), raw);
}

function repoRootFromCwd(): string {
  const cwd = process.cwd();
  if (
    path.basename(cwd).toLowerCase() === 'web-server' &&
    path.basename(path.dirname(cwd)).toLowerCase() === 'packages'
  ) {
    return path.resolve(cwd, '..', '..');
  }
  return cwd;
}

function stringArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

function positiveIntArg(argv: string[], name: string): number | undefined {
  const raw = stringArg(argv, name);
  const n = raw == null ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
