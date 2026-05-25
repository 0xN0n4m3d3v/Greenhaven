/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-7 / DEEP-14 — `enforceFatalConfigGuards` contract.
//
// `AUTH_DISABLED=1` is a legitimate developer escape hatch on
// `NODE_ENV=development` / `NODE_ENV=test`, but combining it with
// `NODE_ENV=production` makes every request anonymous and silently
// turns the public deploy into an open-world identity-free endpoint.
// The historical mitigation was a once-per-minute warning in
// `requireAuth`, easy to lose in log noise; the new contract makes
// the misconfiguration fatal at config load time.
//
// These tests exercise both layers:
//
//   * The exported `enforceFatalConfigGuards(cfg)` helper, which is
//     the testable seam between schema parse and the cached return.
//   * The integrated `config()` path, which goes through `readEnv()`
//     so the production env shape that bootstraps the server is
//     pinned end-to-end.
//
// The config cache intentionally survives `process.env` mutations,
// so each integrated test uses `vi.resetModules()` + a fresh import
// to force a re-read. `process.exit` is mocked to throw so the
// assertion can observe the exit code without killing the runner.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const VALID_AUTH_SECRET = 'a'.repeat(48);

interface EnvSnapshot {
  AUTH_SECRET: string | undefined;
  AUTH_DISABLED: string | undefined;
  NODE_ENV: string | undefined;
}

function snapshotEnv(): EnvSnapshot {
  return {
    AUTH_SECRET: process.env['AUTH_SECRET'],
    AUTH_DISABLED: process.env['AUTH_DISABLED'],
    NODE_ENV: process.env['NODE_ENV'],
  };
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of ['AUTH_SECRET', 'AUTH_DISABLED', 'NODE_ENV'] as const) {
    const value = snap[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function applyEnv(overrides: Partial<EnvSnapshot>): void {
  for (const [key, value] of Object.entries(overrides) as Array<
    [keyof EnvSnapshot, string | undefined]
  >) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// `process.exit` is the explicit failure mode of `enforceFatal…` and
// the broader `readEnv()`. The mock throws a tagged sentinel so:
//   (a) the helper / `readEnv` halts at the exit call (vs. running
//       past it and returning a partial `Config`), mirroring
//       production behavior;
//   (b) the test can observe both the exit code and the
//       console.error line that preceded it.
class ProcessExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code ?? 0);
  }) as never);
}

describe('enforceFatalConfigGuards (SEC-7 / DEEP-14)', () => {
  let envSnap: EnvSnapshot;
  let exitSpy: ReturnType<typeof mockProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    exitSpy = mockProcessExit();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    restoreEnv(envSnap);
  });

  it('exits with code 1 when production + AUTH_DISABLED=1', async () => {
    vi.resetModules();
    const {enforceFatalConfigGuards} = await import('../config.js');
    expect(() =>
      enforceFatalConfigGuards({
        nodeEnv: 'production',
        authDisabled: true,
        // The helper only inspects nodeEnv + authDisabled. The rest of
        // the Config fields are unread but the helper accepts the
        // schema'd type, so we cast a minimal-but-typed fake here.
      } as never),
    ).toThrow(ProcessExitSignal);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[config] FATAL: AUTH_DISABLED=1 is forbidden in production.',
    );
  });

  it('allows production + AUTH_DISABLED unset/false', async () => {
    vi.resetModules();
    const {enforceFatalConfigGuards} = await import('../config.js');
    expect(() =>
      enforceFatalConfigGuards({
        nodeEnv: 'production',
        authDisabled: false,
      } as never),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('allows development + AUTH_DISABLED=1 (dev escape hatch preserved)', async () => {
    vi.resetModules();
    const {enforceFatalConfigGuards} = await import('../config.js');
    expect(() =>
      enforceFatalConfigGuards({
        nodeEnv: 'development',
        authDisabled: true,
      } as never),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('allows test + AUTH_DISABLED=1 (test escape hatch preserved)', async () => {
    vi.resetModules();
    const {enforceFatalConfigGuards} = await import('../config.js');
    expect(() =>
      enforceFatalConfigGuards({
        nodeEnv: 'test',
        authDisabled: true,
      } as never),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('config() integration (SEC-7 / DEEP-14)', () => {
  let envSnap: EnvSnapshot;
  let exitSpy: ReturnType<typeof mockProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    exitSpy = mockProcessExit();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    restoreEnv(envSnap);
  });

  it('fatals at config() time on production + AUTH_DISABLED=1', async () => {
    applyEnv({
      AUTH_SECRET: VALID_AUTH_SECRET,
      AUTH_DISABLED: '1',
      NODE_ENV: 'production',
    });
    vi.resetModules();
    const {config} = await import('../config.js');
    expect(() => config()).toThrow(ProcessExitSignal);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[config] FATAL: AUTH_DISABLED=1 is forbidden in production.',
    );
  });

  it('boots cleanly on production with AUTH_DISABLED unset', async () => {
    applyEnv({
      AUTH_SECRET: VALID_AUTH_SECRET,
      AUTH_DISABLED: undefined,
      NODE_ENV: 'production',
    });
    vi.resetModules();
    const {config} = await import('../config.js');
    const cfg = config();
    expect(cfg.nodeEnv).toBe('production');
    expect(cfg.authDisabled).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('boots cleanly on development with AUTH_DISABLED=1', async () => {
    applyEnv({
      AUTH_SECRET: VALID_AUTH_SECRET,
      AUTH_DISABLED: '1',
      NODE_ENV: 'development',
    });
    vi.resetModules();
    const {config} = await import('../config.js');
    const cfg = config();
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.authDisabled).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('boots cleanly on test with AUTH_DISABLED=1', async () => {
    applyEnv({
      AUTH_SECRET: VALID_AUTH_SECRET,
      AUTH_DISABLED: '1',
      NODE_ENV: 'test',
    });
    vi.resetModules();
    const {config} = await import('../config.js');
    const cfg = config();
    expect(cfg.nodeEnv).toBe('test');
    expect(cfg.authDisabled).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still exits on schema-invalid config (existing AUTH_SECRET-too-short behavior preserved)', async () => {
    applyEnv({
      AUTH_SECRET: 'too-short',
      AUTH_DISABLED: undefined,
      NODE_ENV: 'development',
    });
    vi.resetModules();
    const {config} = await import('../config.js');
    expect(() => config()).toThrow(ProcessExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The schema path logs `invalid configuration`, NOT the SEC-7
    // fatal line — pin the two failure modes so they don't collide.
    expect(errorSpy.mock.calls[0]![0]).toContain('invalid configuration');
  });
});
