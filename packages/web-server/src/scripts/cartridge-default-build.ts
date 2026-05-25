/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-4 — repeatable default-cartridge build.
//
// Drives the existing Obsidian transformer +
// `@greenhaven/cartridge-forge validate` so the default
// `grinhaven-full` cartridge can be regenerated from the human vault
// selected by `GreenhavenWorld/WORLD_MANIFEST.md`. No DB writes happen here —
// this script only emits the Forge project artifacts. Use
// `cartridge:default:install-smoke` to install the produced
// cartridge through the FEAT-CART-LIB preview/apply pipeline.
//
// Usage:
//
//   npm --prefix packages/web-server run cartridge:default:build
//
// Optional flags:
//
//   --vault-root <path>          override `C:/Greenhaven/GreenhavenWorld`
//   --forge-project <path>       override the generated Forge project
//                                output dir (default:
//                                `<vault>/.greenhaven-agent-manual/generated/cartridge-forge-project`).
//   --skip-compile               skip the python compile step (use the
//                                existing generated project as-is).
//   --skip-validate              skip the `forge validate` step.
//   --no-fail-on-warnings        accept validation warnings (errors
//                                still fail the script).
//   --out <dir>                  write the build report JSON here.

import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const DEFAULT_VAULT = path.join(REPO_ROOT, 'GreenhavenWorld');
const DEFAULT_GENERATED = path.join(
  DEFAULT_VAULT,
  '.greenhaven-agent-manual',
  'generated',
  'cartridge-forge-project',
);
const DEFAULT_OUT_DIR = path.join(
  REPO_ROOT,
  '.codex',
  'run-logs',
  'cartridge-default-build',
);
const TRANSFORMER_SCRIPT = path.join(
  'GreenhavenWorld',
  '.greenhaven-agent-manual',
  'skills',
  'greenhaven-human-world-transformer',
  'scripts',
  'compile_vault_to_forge.py',
);
const CARTRIDGE_FORGE_DIR = path.join(REPO_ROOT, 'packages', 'cartridge-forge');

interface Args {
  vaultRoot: string;
  forgeProject: string;
  outDir: string;
  skipCompile: boolean;
  skipValidate: boolean;
  failOnWarnings: boolean;
}

function parseArgs(argv: string[]): Args {
  let vaultRoot = DEFAULT_VAULT;
  let forgeProject = DEFAULT_GENERATED;
  let outDir = DEFAULT_OUT_DIR;
  let skipCompile = false;
  let skipValidate = false;
  let failOnWarnings = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--vault-root') {
      vaultRoot = argv[++i] ?? vaultRoot;
    } else if (arg === '--forge-project') {
      forgeProject = argv[++i] ?? forgeProject;
    } else if (arg === '--out') {
      outDir = argv[++i] ?? outDir;
    } else if (arg === '--skip-compile') {
      skipCompile = true;
    } else if (arg === '--skip-validate') {
      skipValidate = true;
    } else if (arg === '--no-fail-on-warnings') {
      failOnWarnings = false;
    }
  }
  return {vaultRoot, forgeProject, outDir, skipCompile, skipValidate, failOnWarnings};
}

interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runProc(
  cmd: string,
  argv: string[],
  cwd: string,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {cwd, shell: process.platform === 'win32'});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      process.stderr.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      process.stderr.write(text);
    });
    child.on('close', (code) => {
      resolve({exitCode: code ?? 1, stdout, stderr});
    });
  });
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  await mkdir(args.outDir, {recursive: true});

  const log = (m: string): void => {
    process.stderr.write(`[cartridge-default-build] ${m}\n`);
  };

  const blockers: string[] = [];
  let compile: ProcResult | null = null;
  let validate: ProcResult | null = null;

  if (!args.skipCompile) {
    log(`compile vault=${args.vaultRoot}`);
    compile = await runProc(
      'python',
      [TRANSFORMER_SCRIPT, '--vault-root', args.vaultRoot],
      REPO_ROOT,
    );
    if (compile.exitCode !== 0) {
      blockers.push(`compile exit=${compile.exitCode}`);
    }
  } else {
    log('compile: skipped');
  }

  if (!existsSync(args.forgeProject)) {
    blockers.push(`forge project missing at ${args.forgeProject}`);
  } else if (!args.skipValidate) {
    log(`validate ${args.forgeProject}`);
    validate = await runProc(
      'npm',
      ['run', 'forge', '--', 'validate', args.forgeProject],
      CARTRIDGE_FORGE_DIR,
    );
    if (validate.exitCode !== 0) {
      const failure = parseValidatorSummary(validate.stdout + validate.stderr);
      if (failure.errors > 0) {
        blockers.push(
          `validate failed errors=${failure.errors} warnings=${failure.warnings}`,
        );
      } else if (args.failOnWarnings && failure.warnings > 0) {
        blockers.push(
          `validate warnings=${failure.warnings} (use --no-fail-on-warnings to accept)`,
        );
      }
    }
  } else {
    log('validate: skipped');
  }

  const summary = validate
    ? parseValidatorSummary(validate.stdout + validate.stderr)
    : {errors: 0, warnings: 0, info: 0};

  const finishedAt = new Date();
  const report = {
    passed: blockers.length === 0,
    blockers,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    vaultRoot: args.vaultRoot,
    forgeProject: args.forgeProject,
    compile: compile ? {exitCode: compile.exitCode} : {skipped: true},
    validate: validate
      ? {exitCode: validate.exitCode, summary}
      : {skipped: true},
  };
  const reportPath = path.join(args.outDir, 'result.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  if (report.passed) {
    log(`PASS — report=${reportPath}`);
    return 0;
  }
  log(`FAIL — blockers: ${JSON.stringify(blockers)}`);
  return 1;
}

function parseValidatorSummary(
  text: string,
): {errors: number; warnings: number; info: number} {
  // The forge CLI emits a JSON payload of the shape
  // `{"ok": bool, "errors": [...], "warnings": [...], "counts": ...}`
  // intermixed with npm wrapper lines. Extract the first balanced
  // JSON object and count entries; fall back to zero on parse
  // failure so the script's pass/fail decision still relies on the
  // child process exit code.
  const out = {errors: 0, warnings: 0, info: 0};
  const startIdx = text.indexOf('{');
  const endIdx = text.lastIndexOf('}');
  if (startIdx < 0 || endIdx <= startIdx) return out;
  try {
    const parsed = JSON.parse(text.slice(startIdx, endIdx + 1)) as {
      errors?: unknown[];
      warnings?: unknown[];
    };
    if (Array.isArray(parsed.errors)) out.errors = parsed.errors.length;
    if (Array.isArray(parsed.warnings)) out.warnings = parsed.warnings.length;
  } catch {
    // best-effort; exit code is the source of truth
  }
  return out;
}

const isDirect = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(FILE)
  : false;
if (isDirect) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error('[cartridge-default-build] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runCartridgeDefaultBuild, DEFAULT_VAULT, DEFAULT_GENERATED};
