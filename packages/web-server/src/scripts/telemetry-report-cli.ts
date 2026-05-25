/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure CLI helpers extracted from `telemetry-report.ts` so they can
// be unit-tested without executing the script's top-level
// runtime. The script imports these and wires them around its outer
// try/catch + dynamic DB imports.
//
// Anything here must stay free of `db.js` / `migrate.js` imports —
// those force-load the PGlite stack and would make these helpers
// untestable in isolation. Only `config.ts` is imported (for the
// `setConfigEnv` / `clearConfigEnv` / `rawConfigEnv` env-redirect
// surface, which is pure side-effect on `process.env`).

import {mkdir, mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {clearConfigEnv, rawConfigEnv, setConfigEnv} from '../config.js';

export type TelemetryReportCommand =
  | 'summary'
  | 'trace'
  | 'turn'
  | 'errors'
  | 'quality'
  | 'bundle'
  | 'retention'
  | 'export'
  | 'narrate-sanitiser';

export interface TelemetryReportArgs {
  command: TelemetryReportCommand;
  id?: string;
  minutes: number;
  since?: string;
  limit: number;
  traceLimit: number;
  write: boolean;
  dryRun: boolean;
  safeDays?: number;
  debugDays?: number;
  sensitiveDays?: number;
  artifactDays?: number;
  maxArtifactBytes?: number;
  formats?: Array<'jsonl' | 'otlp'>;
  postOtlp: boolean;
  otlpEndpoint?: string;
  allowRemote: boolean;
  pgdata?: string;
  fixtureMode?: 'temp' | 'existing';
}

export interface NarrateSanitiserReadinessFallback {
  since: string;
  total_events: 0;
  /** N-2 Phase 3 readiness — inspected (per-call) liveness count.
   *  Zero here means the sanitizer code path was not observably
   *  reached in the queried window, which keeps `ready_for_phase3`
   *  false. */
  inspected_events: 0;
  patterns_fired: Record<string, never>;
  phase3_blockers: {
    analysis_heading: 0;
    stanislavski_label_bold: 0;
    stanislavski_label_plain: 0;
    bracket_meta: 0;
  };
  phase3_total: 0;
  ready_for_phase3: false;
  sample: never[];
  error: string;
}

// PGlite's WASM layer occasionally throws a bare object whose default
// `String(...)` is `[object Object]`. Walk through likely shapes so
// the structured payload carries something diagnostic instead.
export function coerceErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err == null) return 'unknown error';
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj['message'] === 'string') return obj['message'];
    if (typeof obj['error'] === 'string') return obj['error'];
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

// When the user asked for `narrate-sanitiser` and we crashed before
// the helper got a chance to return its own structured "not ready"
// payload (e.g. PGlite WASM `Aborted()` while opening a locked or
// corrupt pgdata, or any other init failure), synthesise the same
// readiness-report shape so the consumer's JSON contract stays
// stable. `ready_for_phase3: false` is the safe default; the `error`
// field carries the underlying message so the caller can distinguish
// "telemetry unavailable" from "zero firings observed". Other
// commands keep the historical `{ok:false, error}` shape (caller is
// responsible for that branch).
export function readinessReportFallback(
  args: TelemetryReportArgs | null,
  message: string,
): NarrateSanitiserReadinessFallback | null {
  if (!args || args.command !== 'narrate-sanitiser') return null;
  const minutes =
    Number.isFinite(args.minutes) && args.minutes > 0 ? args.minutes : 60;
  const since =
    args.since ??
    new Date(
      Date.now() - Math.min(7 * 24 * 60, minutes) * 60_000,
    ).toISOString();
  return {
    since,
    total_events: 0,
    inspected_events: 0,
    patterns_fired: {},
    phase3_blockers: {
      analysis_heading: 0,
      stanislavski_label_bold: 0,
      stanislavski_label_plain: 0,
      bracket_meta: 0,
    },
    phase3_total: 0,
    ready_for_phase3: false,
    sample: [],
    error: message,
  };
}

// `--pgdata <dir>` (or `--fixture-mode temp`) is honoured before any
// DB module loads. `setConfigEnv` asserts the config is uncached, so
// this must run before the first `config()` call inside `db.js` /
// `migrate.js`. Matches the canonical pattern in `cartridge-i18n.ts`.
export async function maybeRedirectPglite(
  args: TelemetryReportArgs,
): Promise<void> {
  if (args.pgdata) {
    clearConfigEnv('DATABASE_URL');
    setConfigEnv('PGLITE_DATA_DIR', path.resolve(args.pgdata));
    return;
  }
  if (args.fixtureMode === 'temp') {
    clearConfigEnv('DATABASE_URL');
    const base =
      rawConfigEnv('GREENHAVEN_DEVTOOLS_TMP') ??
      (process.platform === 'win32' ? 'C:\\tmp' : '/tmp');
    await mkdir(base, {recursive: true});
    const dir = await mkdtemp(path.join(base, 'greenhaven-telemetry-report-'));
    setConfigEnv('PGLITE_DATA_DIR', dir);
  }
}

export function parseTelemetryReportArgs(argv: string[]): TelemetryReportArgs {
  const out: Partial<TelemetryReportArgs> = {
    command: 'summary',
    minutes: 60,
    limit: 30,
    traceLimit: 5,
    write: false,
    dryRun: false,
    postOtlp: false,
    allowRemote: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (arg === '--write' || arg === '--persist') {
      out.write = true;
      continue;
    }
    if (arg === '--dry-run' || arg === '--dry') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--post-otlp') {
      out.postOtlp = true;
      continue;
    }
    if (arg === '--allow-remote') {
      out.allowRemote = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`);
    }
    i += 1;
    if (arg === '--minutes') out.minutes = Number(value);
    else if (arg === '--since') out.since = value;
    else if (arg === '--limit') out.limit = Number(value);
    else if (arg === '--trace-limit') out.traceLimit = Number(value);
    else if (arg === '--safe-days') out.safeDays = Number(value);
    else if (arg === '--debug-days') out.debugDays = Number(value);
    else if (arg === '--sensitive-days') out.sensitiveDays = Number(value);
    else if (arg === '--artifact-days') out.artifactDays = Number(value);
    else if (arg === '--max-artifact-bytes') {
      out.maxArtifactBytes = Number(value);
    } else if (arg === '--format') {
      out.formats = value
        .split(',')
        .map(format => format.trim())
        .filter(
          (format): format is 'jsonl' | 'otlp' =>
            format === 'jsonl' || format === 'otlp',
        );
    } else if (arg === '--otlp-endpoint') out.otlpEndpoint = value;
    else if (arg === '--pgdata') out.pgdata = value;
    else if (arg === '--fixture-mode') {
      if (value !== 'temp' && value !== 'existing') {
        throw new Error('--fixture-mode must be temp or existing');
      }
      out.fixtureMode = value;
    } else if (arg === '--trace') {
      out.command = 'trace';
      out.id = value;
    } else if (arg === '--turn') {
      out.command = 'turn';
      out.id = value;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  const command = positional[0];
  if (
    command === 'summary' ||
    command === 'errors' ||
    command === 'quality' ||
    command === 'bundle' ||
    command === 'retention' ||
    command === 'export' ||
    command === 'narrate-sanitiser'
  ) {
    out.command = command;
  } else if (command === 'trace' || command === 'turn') {
    out.command = command;
    out.id = positional[1] ?? out.id;
  } else if (command != null) {
    throw new Error(
      'usage: telemetry-report [summary|errors|quality|bundle|retention|export|narrate-sanitiser|trace <id>|turn <id>] [--minutes 60] [--limit 30] [--trace-limit 5] [--write] [--dry-run] [--format jsonl,otlp] [--post-otlp] [--pgdata <dir>] [--fixture-mode temp|existing]',
    );
  }
  if ((out.command === 'trace' || out.command === 'turn') && !out.id) {
    throw new Error(`${out.command} id required`);
  }
  return {
    command: out.command ?? 'summary',
    id: out.id,
    minutes:
      Number.isFinite(out.minutes ?? NaN) && Number(out.minutes) > 0
        ? Number(out.minutes)
        : 60,
    since: out.since,
    limit:
      Number.isFinite(out.limit ?? NaN) && Number(out.limit) > 0
        ? Number(out.limit)
        : 30,
    traceLimit:
      Number.isFinite(out.traceLimit ?? NaN) && Number(out.traceLimit) >= 0
        ? Number(out.traceLimit)
        : 5,
    write: out.write === true,
    dryRun: out.dryRun === true,
    safeDays: validOptionalNumber(out.safeDays),
    debugDays: validOptionalNumber(out.debugDays),
    sensitiveDays: validOptionalNumber(out.sensitiveDays),
    artifactDays: validOptionalNumber(out.artifactDays),
    maxArtifactBytes: validOptionalNumber(out.maxArtifactBytes),
    formats: out.formats,
    postOtlp: out.postOtlp === true,
    otlpEndpoint: out.otlpEndpoint,
    allowRemote: out.allowRemote === true,
    pgdata: out.pgdata,
    fixtureMode: out.fixtureMode,
  };
}

function validOptionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
