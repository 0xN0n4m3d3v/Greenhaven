/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-8 — conditional `globalThis.__greenhavenApp` exposure.
//
// Pins the contract:
//   * `GREENHAVEN_DEBUG_ROUTES` off (default) →
//     `installDebugAppGlobal(app)` is a no-op AND defensively
//     clears any value the slot may have already held.
//   * `GREENHAVEN_DEBUG_ROUTES=1` with `GREENHAVEN_DEBUG_KEY`
//     unset / empty → still no-op + defensive clear (matches the
//     `SEC-4` HTTP guard: enabled-without-key is treated as a
//     misconfiguration and the HTTP guard returns 403, so the
//     same gate applies to the global handle).
//   * `GREENHAVEN_DEBUG_ROUTES=1` AND a non-empty
//     `GREENHAVEN_DEBUG_KEY` → install the app onto the global
//     slot so `/api/debug/verify-specialists` can resolve a
//     same-process fetch handle.
//
// `DebugService.resolveAppFetch` reads through `getDebugAppGlobal`
// so it picks up exactly what the installer wrote. The
// route-provided fetch always wins over the global fallback —
// the test pins that precedence too.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const DEBUG_APP_GLOBAL_KEY = '__greenhavenApp';

const configMock = vi.hoisted(() => ({
  debugRoutesEnabled: false as boolean,
  debugKey: null as string | null,
}));

// `installDebugAppGlobal` reads `config()` via the default
// provider; mocking the module gives us a deterministic seam.
vi.mock('../config.js', () => ({
  config: () => configMock,
}));

import {
  clearDebugAppGlobal,
  getDebugAppGlobal,
  installDebugAppGlobal,
} from '../debugAppGlobal.js';
import {DebugService} from '../services/DebugService.js';

function slot(): unknown {
  return (globalThis as Record<string, unknown>)[DEBUG_APP_GLOBAL_KEY];
}

function fakeApp(): {fetch: (req: Request) => Promise<Response>} {
  return {
    fetch: async (_req: Request) =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
  };
}

describe('installDebugAppGlobal (SEC-8)', () => {
  beforeEach(() => {
    clearDebugAppGlobal();
    configMock.debugRoutesEnabled = false;
    configMock.debugKey = null;
  });

  afterEach(() => {
    clearDebugAppGlobal();
  });

  it('does NOT populate the global with default config (debug routes off)', () => {
    installDebugAppGlobal(fakeApp() as never);
    expect(slot()).toBeUndefined();
    expect(getDebugAppGlobal()).toBeUndefined();
  });

  it('does NOT populate the global when debug routes are on but no key is configured', () => {
    configMock.debugRoutesEnabled = true;
    configMock.debugKey = null;
    installDebugAppGlobal(fakeApp() as never);
    expect(slot()).toBeUndefined();
  });

  it('does NOT populate the global when debug routes are on but the key is empty', () => {
    configMock.debugRoutesEnabled = true;
    configMock.debugKey = '';
    installDebugAppGlobal(fakeApp() as never);
    expect(slot()).toBeUndefined();
  });

  it('populates the global when debug routes ARE enabled with a non-empty key', () => {
    configMock.debugRoutesEnabled = true;
    configMock.debugKey = 'sek';
    const app = fakeApp();
    installDebugAppGlobal(app as never);
    expect(slot()).toBe(app);
    expect(getDebugAppGlobal()).toBe(app);
  });

  it('defensively CLEARS any prior value when called with the gate off', () => {
    // Simulate a stale value from an earlier test / boot.
    (globalThis as Record<string, unknown>)[DEBUG_APP_GLOBAL_KEY] = {stale: 1};
    configMock.debugRoutesEnabled = false;
    installDebugAppGlobal(fakeApp() as never);
    expect(slot()).toBeUndefined();
  });

  it('also clears when the gate goes from on → off across calls', () => {
    configMock.debugRoutesEnabled = true;
    configMock.debugKey = 'sek';
    const app = fakeApp();
    installDebugAppGlobal(app as never);
    expect(slot()).toBe(app);

    configMock.debugRoutesEnabled = false;
    configMock.debugKey = null;
    installDebugAppGlobal(app as never);
    expect(slot()).toBeUndefined();
  });

  it('accepts an injected `configProvider` (mirrors SEC-4 pattern)', () => {
    const app = fakeApp();
    installDebugAppGlobal(app as never, {
      configProvider: () => ({debugRoutesEnabled: true, debugKey: 'sek'}),
    });
    expect(slot()).toBe(app);

    installDebugAppGlobal(app as never, {
      configProvider: () => ({debugRoutesEnabled: false, debugKey: null}),
    });
    expect(slot()).toBeUndefined();
  });
});

describe('DebugService.resolveAppFetch (SEC-8 integration)', () => {
  beforeEach(() => {
    clearDebugAppGlobal();
    configMock.debugRoutesEnabled = false;
    configMock.debugKey = null;
  });

  afterEach(() => {
    clearDebugAppGlobal();
  });

  it('returns null when no route app is provided and the global is not installed', () => {
    expect(DebugService.resolveAppFetch()).toBeNull();
    expect(DebugService.resolveAppFetch({})).toBeNull();
  });

  it('prefers a route-provided fetch over the gated global fallback', () => {
    configMock.debugRoutesEnabled = true;
    configMock.debugKey = 'sek';
    const globalApp = fakeApp();
    installDebugAppGlobal(globalApp as never);
    expect(slot()).toBe(globalApp);

    const routeApp = fakeApp();
    const resolved = DebugService.resolveAppFetch(routeApp);
    expect(resolved).toBe(routeApp.fetch);
    expect(resolved).not.toBe(globalApp.fetch);
  });

  it('falls back to the gated global when no route app is supplied', () => {
    configMock.debugRoutesEnabled = true;
    configMock.debugKey = 'sek';
    const app = fakeApp();
    installDebugAppGlobal(app as never);
    expect(DebugService.resolveAppFetch()).toBe(app.fetch);
  });

  it('returns null even when route app is given without a fetch function', () => {
    // `routeApp?.fetch === 'function'` guard rejects this case.
    expect(DebugService.resolveAppFetch({} as never)).toBeNull();
  });
});
