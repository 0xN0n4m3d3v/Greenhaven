export {};

import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

interface Args {
  outDir: string;
  allowFindings: boolean;
  marathonArgs: string[];
}

interface Diagnosis {
  slug: string;
  severity: 'P0' | 'P1' | 'P2' | 'INFO';
  owner: string;
  rootCause: string;
  confidence: string;
  evidence?: string[];
  fixPath?: string[];
  rerun?: string[];
}

interface RootCauseReport {
  diagnoses?: Diagnosis[];
}

const args = parseArgs(process.argv.slice(2));
await fs.mkdir(args.outDir, {recursive: true});

const marathon = await runNpmScript(
  'live:marathon',
  [...args.marathonArgs, '--out', args.outDir],
  'cycle-marathon',
);
const summary = await readJsonOptional<JsonRecord>(
  path.join(args.outDir, 'SUMMARY.json'),
);

const diagnose = summary
  ? await runNpmScript(
      'live:diagnose',
      ['--run', args.outDir],
      'cycle-diagnose',
    )
  : {
      ok: false,
      code: 1,
      stdout: '',
      stderr: 'SUMMARY.json missing; diagnosis skipped.',
    };

const rootCause = await readJsonOptional<RootCauseReport>(
  path.join(args.outDir, 'ROOT_CAUSE_REPORT.json'),
);
const diagnoses = rootCause?.diagnoses ?? [];

await fs.writeFile(
  path.join(args.outDir, 'CYCLE_REPORT.md'),
  renderCycleReport({
    outDir: args.outDir,
    marathon,
    diagnose,
    summary,
    diagnoses,
  }),
  'utf8',
);
await fs.writeFile(
  path.join(args.outDir, 'GEMINI_REVIEW_PROMPT.md'),
  renderGeminiPrompt(args.outDir, diagnoses),
  'utf8',
);

const blocking = diagnoses.filter(d => d.severity === 'P0' || d.severity === 'P1');
const ok =
  marathon.ok &&
  diagnose.ok &&
  (args.allowFindings || blocking.length === 0);

process.stdout.write(
  `${JSON.stringify(
    {
      ok,
      outDir: args.outDir,
      marathonOk: marathon.ok,
      diagnoseOk: diagnose.ok,
      diagnoses: diagnoses.length,
      p0: diagnoses.filter(d => d.severity === 'P0').length,
      p1: diagnoses.filter(d => d.severity === 'P1').length,
      cycleReport: path.join(args.outDir, 'CYCLE_REPORT.md'),
      geminiPrompt: path.join(args.outDir, 'GEMINI_REVIEW_PROMPT.md'),
    },
    null,
    2,
  )}\n`,
);
if (!ok) process.exitCode = 1;

async function runNpmScript(
  script: string,
  extraArgs: string[],
  logPrefix: string,
): Promise<{ok: boolean; code: number; stdout: string; stderr: string}> {
  const commandArgs = [
    '--prefix',
    'packages/web-server',
    'run',
    script,
    '--',
    ...extraArgs,
  ];
  const result = await runCommand('npm', commandArgs, repoRootFromCwd());
  await fs.writeFile(
    path.join(args.outDir, `${logPrefix}.stdout.log`),
    result.stdout,
    'utf8',
  );
  await fs.writeFile(
    path.join(args.outDir, `${logPrefix}.stderr.log`),
    result.stderr,
    'utf8',
  );
  return result;
}

function runCommand(
  command: string,
  commandArgs: string[],
  cwd: string,
): Promise<{ok: boolean; code: number; stdout: string; stderr: string}> {
  return new Promise(resolve => {
    const spawnCommand = process.platform === 'win32' ? 'cmd.exe' : command;
    const spawnArgs =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', [command, ...commandArgs].map(quoteWinArg).join(' ')]
        : commandArgs;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', err => {
      resolve({ok: false, code: 1, stdout, stderr: `${stderr}${err.message}`});
    });
    child.on('close', code => {
      resolve({ok: code === 0, code: code ?? 1, stdout, stderr});
    });
  });
}

function quoteWinArg(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

function parseArgs(argv: string[]): Args {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outRaw =
    stringArg(argv, 'out') ??
    `.codex/run-logs/live-playtest/${stamp}-cycle`;
  const stripped = stripCycleOnlyArgs(argv);
  return {
    outDir: resolveInputPath(outRaw),
    allowFindings: flagArg(argv, 'allow-findings'),
    marathonArgs: stripped,
  };
}

function stripCycleOnlyArgs(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--allow-findings') continue;
    if (arg === '--out') {
      i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function renderCycleReport(args: {
  outDir: string;
  marathon: {ok: boolean; code: number};
  diagnose: {ok: boolean; code: number};
  summary: JsonRecord | null;
  diagnoses: Diagnosis[];
}): string {
  const lines = [
    '# Live Playtest Cycle Report',
    '',
    `- Run: ${args.outDir}`,
    `- Marathon: ${args.marathon.ok ? 'ok' : `failed (${args.marathon.code})`}`,
    `- Diagnose: ${args.diagnose.ok ? 'ok' : `failed (${args.diagnose.code})`}`,
    `- Player/session: ${String(args.summary?.['playerId'] ?? 'unknown')} / ${String(args.summary?.['sessionId'] ?? 'unknown')}`,
    `- Diagnoses: ${args.diagnoses.length}`,
    '',
  ];
  if (args.diagnoses.length === 0) {
    lines.push('No automatic diagnoses. Continue broader exploratory playtests.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('## Fix Queue');
  for (const diagnosis of sortDiagnoses(args.diagnoses)) {
    lines.push('');
    lines.push(`### ${diagnosis.severity} - ${diagnosis.slug}`);
    lines.push(`- Owner: ${diagnosis.owner}`);
    lines.push(`- Root cause: ${diagnosis.rootCause}`);
    lines.push(`- Confidence: ${diagnosis.confidence}`);
    lines.push(`- First fix: ${diagnosis.fixPath?.[0] ?? 'Manual review required.'}`);
    lines.push(`- Rerun: ${diagnosis.rerun?.[0] ?? 'Rerun scenario manually.'}`);
  }
  lines.push('');
  lines.push('## Agent Routing');
  lines.push('- `backend-*`: Codex fixes server/runtime/prompts/tools/docs.');
  lines.push('- `frontend-handoff`: Codex writes a frontend spec; Claude implements UI.');
  lines.push('- `manual-review`, `infrastructure`, `model-provider`: Codex verifies logs before changing code.');
  return `${lines.join('\n')}\n`;
}

function renderGeminiPrompt(outDir: string, diagnoses: Diagnosis[]): string {
  const top = diagnoses
    .filter(d => d.severity !== 'INFO')
    .map(d => `- ${d.severity} ${d.slug}: ${d.owner}/${d.rootCause}`)
    .join('\n') || '- No automatic findings; hunt for missed contradictions.';
  return `You are an independent read-only reviewer auditing Greenhaven as a hacker-perfectionist QA agent.

Do not edit files. Do not call write_file. Do not create a report file. Return
the report in stdout only. Read AGENTS.md, docs/ops/greenhaven-mission.md,
docs/ops/continuous-playtest-system.md, docs/ops/live-playtest-grimoire.md,
the run artifacts under ${outDir}, and the relevant backend/frontend source.

Focus on contradictions between docs, code, persisted state, SSE replay,
localization, prompts, and runtime logs. Check whether the root-cause report
missed any smaller bug. For each finding, give severity, owner, exact evidence,
suspected root cause, and a minimal verification or rerun.

Known automatic findings:
${top}
`;
}

function sortDiagnoses(diagnoses: Diagnosis[]): Diagnosis[] {
  const rank = new Map([
    ['P0', 0],
    ['P1', 1],
    ['P2', 2],
    ['INFO', 3],
  ]);
  return [...diagnoses].sort(
    (a, b) => (rank.get(a.severity) ?? 9) - (rank.get(b.severity) ?? 9),
  );
}

async function readJsonOptional<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    const code = (err as {code?: unknown}).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

function stringArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

function flagArg(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
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
