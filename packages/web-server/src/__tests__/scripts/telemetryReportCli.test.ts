/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Regression coverage for the `telemetry-report` CLI helpers
// extracted into `src/scripts/telemetry-report-cli.ts`. The previous
// slice added `--pgdata <dir>` / `--fixture-mode temp` env redirect,
// the `coerceErrorMessage` PGlite-throw fallback, and the
// `readinessReportFallback` that preserves the `narrate-sanitiser`
// JSON shape on DB-init failure. These tests pin all three so the
// N-2 telemetry gate can't silently regress.
//
// The helpers stay pure (no `db.js` / `migrate.js` imports), so the
// suite runs without booting PGlite. `setConfigEnv` from `config.ts`
// asserts the config is uncached, so each test cleans `process.env`
// afterwards.

import {mkdtemp, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  coerceErrorMessage,
  maybeRedirectPglite,
  parseTelemetryReportArgs,
  readinessReportFallback,
  type TelemetryReportArgs,
} from '../../scripts/telemetry-report-cli.js';

const ENV_KEYS = ['PGLITE_DATA_DIR', 'DATABASE_URL', 'GREENHAVEN_DEVTOOLS_TMP'];
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] == null) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

describe('parseTelemetryReportArgs', () => {
  it('defaults to summary with 60-minute window when no args supplied', () => {
    const args = parseTelemetryReportArgs([]);
    expect(args.command).toBe('summary');
    expect(args.minutes).toBe(60);
    expect(args.limit).toBe(30);
    expect(args.pgdata).toBeUndefined();
    expect(args.fixtureMode).toBeUndefined();
  });

  it('routes the narrate-sanitiser positional command through to the readiness gate', () => {
    const args = parseTelemetryReportArgs([
      'narrate-sanitiser',
      '--minutes',
      '1440',
      '--limit',
      '100',
    ]);
    expect(args.command).toBe('narrate-sanitiser');
    expect(args.minutes).toBe(1440);
    expect(args.limit).toBe(100);
  });

  it('parses --pgdata <dir> and keeps it in the structured args', () => {
    const args = parseTelemetryReportArgs([
      'narrate-sanitiser',
      '--pgdata',
      '/tmp/fresh-pgdata',
    ]);
    expect(args.pgdata).toBe('/tmp/fresh-pgdata');
    expect(args.fixtureMode).toBeUndefined();
  });

  it('parses --fixture-mode temp and rejects any other value', () => {
    expect(
      parseTelemetryReportArgs(['narrate-sanitiser', '--fixture-mode', 'temp'])
        .fixtureMode,
    ).toBe('temp');
    expect(
      parseTelemetryReportArgs([
        'narrate-sanitiser',
        '--fixture-mode',
        'existing',
      ]).fixtureMode,
    ).toBe('existing');
    expect(() =>
      parseTelemetryReportArgs([
        'narrate-sanitiser',
        '--fixture-mode',
        'wat',
      ]),
    ).toThrow(/--fixture-mode must be temp or existing/);
  });

  it('rejects an unknown command with the usage error', () => {
    expect(() => parseTelemetryReportArgs(['banana'])).toThrow(
      /usage: telemetry-report/,
    );
  });

  it('rejects an unknown --option flag', () => {
    expect(() =>
      parseTelemetryReportArgs(['summary', '--bogus', 'value']),
    ).toThrow(/unknown option --bogus/);
  });

  it('rejects --trace / --turn without an id', () => {
    expect(() => parseTelemetryReportArgs(['trace'])).toThrow(
      /trace id required/,
    );
    expect(() => parseTelemetryReportArgs(['turn'])).toThrow(
      /turn id required/,
    );
  });

  it('clamps a non-positive --minutes to the 60-minute default', () => {
    const negative = parseTelemetryReportArgs(['summary', '--minutes', '-5']);
    expect(negative.minutes).toBe(60);
    const zero = parseTelemetryReportArgs(['summary', '--minutes', '0']);
    expect(zero.minutes).toBe(60);
  });
});

describe('coerceErrorMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(coerceErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('passes strings through verbatim', () => {
    expect(coerceErrorMessage('plain failure')).toBe('plain failure');
  });

  it('extracts {message: string} from a plain object before falling back to JSON', () => {
    expect(coerceErrorMessage({message: 'inner message', extra: 1})).toBe(
      'inner message',
    );
  });

  it('extracts {error: string} when message is absent', () => {
    expect(coerceErrorMessage({error: 'inner error'})).toBe('inner error');
  });

  it('JSON-encodes the PGlite-shaped bare ErrnoError object (no message/error keys)', () => {
    // The PGlite WASM layer throws `{name: 'ErrnoError', errno: 54}`
    // for "path is a file, not a directory". Without the coercion
    // helper this surfaces as `[object Object]`.
    expect(coerceErrorMessage({name: 'ErrnoError', errno: 54})).toBe(
      '{"name":"ErrnoError","errno":54}',
    );
  });

  it('handles null and undefined without throwing', () => {
    expect(coerceErrorMessage(null)).toBe('unknown error');
    expect(coerceErrorMessage(undefined)).toBe('unknown error');
  });

  it('falls back to Object.prototype.toString for objects whose JSON.stringify throws', () => {
    const circular: Record<string, unknown> = {name: 'cycle'};
    circular['self'] = circular;
    expect(coerceErrorMessage(circular)).toBe('[object Object]');
  });

  it('stringifies numbers / booleans via String(...)', () => {
    expect(coerceErrorMessage(42)).toBe('42');
    expect(coerceErrorMessage(false)).toBe('false');
  });
});

describe('readinessReportFallback', () => {
  function buildArgs(
    overrides: Partial<TelemetryReportArgs> = {},
  ): TelemetryReportArgs {
    return {
      command: 'narrate-sanitiser',
      minutes: 1440,
      limit: 100,
      traceLimit: 5,
      write: false,
      dryRun: false,
      postOtlp: false,
      allowRemote: false,
      ...overrides,
    };
  }

  it('emits the readiness-report shape with ready_for_phase3:false and an error string', () => {
    const result = readinessReportFallback(buildArgs(), 'pgdata locked');
    expect(result).not.toBeNull();
    expect(result!.ready_for_phase3).toBe(false);
    expect(result!.total_events).toBe(0);
    expect(result!.inspected_events).toBe(0);
    expect(result!.patterns_fired).toEqual({});
    expect(result!.phase3_blockers).toEqual({
      analysis_heading: 0,
      stanislavski_label_bold: 0,
      stanislavski_label_plain: 0,
      bracket_meta: 0,
    });
    expect(result!.phase3_total).toBe(0);
    expect(result!.sample).toEqual([]);
    expect(result!.error).toBe('pgdata locked');
  });

  it('uses the args.since field verbatim when provided', () => {
    const since = '2026-05-10T12:00:00.000Z';
    const result = readinessReportFallback(buildArgs({since}), 'oops');
    expect(result!.since).toBe(since);
  });

  it('derives since from minutes when args.since is absent, clamped to 7 days', () => {
    const before = Date.now();
    const result = readinessReportFallback(
      buildArgs({minutes: 60_000, since: undefined}),
      'oops',
    );
    const after = Date.now();
    const sinceMs = Date.parse(result!.since);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Window cannot exceed 7 days even when the user requests longer.
    expect(before - sinceMs).toBeGreaterThanOrEqual(sevenDaysMs - 5_000);
    expect(after - sinceMs).toBeLessThanOrEqual(sevenDaysMs + 5_000);
  });

  it('returns null for every non-narrate-sanitiser command, so other commands keep {ok:false,error}', () => {
    for (const command of [
      'summary',
      'trace',
      'turn',
      'errors',
      'quality',
      'bundle',
      'retention',
      'export',
    ] as const) {
      expect(readinessReportFallback(buildArgs({command}), 'msg')).toBeNull();
    }
  });

  it('returns null when args is null (parse-args failures before command resolution)', () => {
    expect(readinessReportFallback(null, 'parse exploded')).toBeNull();
  });
});

describe('maybeRedirectPglite', () => {
  function buildArgs(
    overrides: Partial<TelemetryReportArgs> = {},
  ): TelemetryReportArgs {
    return {
      command: 'narrate-sanitiser',
      minutes: 60,
      limit: 30,
      traceLimit: 5,
      write: false,
      dryRun: false,
      postOtlp: false,
      allowRemote: false,
      ...overrides,
    };
  }

  it('is a no-op when neither --pgdata nor --fixture-mode is supplied', async () => {
    delete process.env['PGLITE_DATA_DIR'];
    process.env['DATABASE_URL'] = 'postgres://stays-put';
    await maybeRedirectPglite(buildArgs());
    expect(process.env['PGLITE_DATA_DIR']).toBeUndefined();
    expect(process.env['DATABASE_URL']).toBe('postgres://stays-put');
  });

  it('--pgdata <dir> sets PGLITE_DATA_DIR to the resolved absolute path and clears DATABASE_URL', async () => {
    process.env['DATABASE_URL'] = 'postgres://should-be-cleared';
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'gh-tel-test-pgdata-'));
    try {
      await maybeRedirectPglite(buildArgs({pgdata: tmp}));
      expect(process.env['PGLITE_DATA_DIR']).toBe(path.resolve(tmp));
      expect(process.env['DATABASE_URL']).toBeUndefined();
    } finally {
      // PGLITE_DATA_DIR + DATABASE_URL are restored by the
      // afterEach. The dir itself can stay; the OS reaps tmp.
    }
  });

  it('--pgdata resolves relative paths to absolute before writing the env', async () => {
    process.env['DATABASE_URL'] = 'postgres://drop-me';
    await maybeRedirectPglite(buildArgs({pgdata: './relative/path'}));
    const expected = path.resolve('./relative/path');
    expect(process.env['PGLITE_DATA_DIR']).toBe(expected);
    expect(path.isAbsolute(process.env['PGLITE_DATA_DIR']!)).toBe(true);
  });

  it('--fixture-mode temp mkdtemps a fresh dir under GREENHAVEN_DEVTOOLS_TMP and exports PGLITE_DATA_DIR', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'gh-tel-test-base-'));
    process.env['GREENHAVEN_DEVTOOLS_TMP'] = base;
    process.env['DATABASE_URL'] = 'postgres://locked-dev-host';

    await maybeRedirectPglite(buildArgs({fixtureMode: 'temp'}));

    const setPath = process.env['PGLITE_DATA_DIR'];
    expect(setPath).toBeDefined();
    expect(path.dirname(setPath!)).toBe(base);
    expect(path.basename(setPath!)).toMatch(/^greenhaven-telemetry-report-/);
    expect(process.env['DATABASE_URL']).toBeUndefined();

    const dirStat = await stat(setPath!);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it('--fixture-mode existing does not touch PGLITE_DATA_DIR or DATABASE_URL', async () => {
    process.env['DATABASE_URL'] = 'postgres://existing-db';
    delete process.env['PGLITE_DATA_DIR'];
    await maybeRedirectPglite(buildArgs({fixtureMode: 'existing'}));
    expect(process.env['DATABASE_URL']).toBe('postgres://existing-db');
    expect(process.env['PGLITE_DATA_DIR']).toBeUndefined();
  });

  it('--pgdata is honoured before --fixture-mode temp when both are supplied', async () => {
    const explicit = await mkdtemp(
      path.join(os.tmpdir(), 'gh-tel-test-explicit-'),
    );
    const base = await mkdtemp(path.join(os.tmpdir(), 'gh-tel-test-base2-'));
    process.env['GREENHAVEN_DEVTOOLS_TMP'] = base;

    await maybeRedirectPglite(
      buildArgs({pgdata: explicit, fixtureMode: 'temp'}),
    );

    expect(process.env['PGLITE_DATA_DIR']).toBe(path.resolve(explicit));
    // The fixture-mode branch never ran, so `base` is empty.
    // (We don't strictly assert that — the resolved path winning is
    // the binding contract; assert only the env that the DB layer
    // would consume.)
  });

  it('redirect runs BEFORE any DB import — `process.env.PGLITE_DATA_DIR` is observable by a follow-up import', async () => {
    // We can't import db.js / migrate.js inside this test because
    // they'd actually boot PGlite. Instead pin the load order
    // contract: maybeRedirectPglite must finish (returning a
    // resolved Promise) before the caller dynamic-imports the DB
    // modules. We assert that by awaiting the redirect first and
    // sampling the env afterwards — there is no "DB import" between
    // the two reads in the script either.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'gh-tel-test-order-'));
    const sentinel = path.join(tmp, '.greenhaven-test-sentinel');
    await writeFile(sentinel, 'present', 'utf8');
    await maybeRedirectPglite(buildArgs({pgdata: tmp}));
    expect(process.env['PGLITE_DATA_DIR']).toBe(path.resolve(tmp));
    const sentinelStat = await stat(sentinel);
    expect(sentinelStat.isFile()).toBe(true);
  });
});
