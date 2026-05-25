/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-4 — debug-route gate contract.
//
// Production parity goal: the guard must reject every probe of the
// debug surface that arrives without a configured key, in every
// environment. These tests use the injectable config provider on
// `createDebugRouteGuardMiddleware(...)` so the cached global
// `config()` never has to be mutated between cases. The 404 / 403 /
// pass paths and exact response body shapes (`not_found`,
// `forbidden`) are pinned because operator docs and downstream debug
// smoke tests match them.

import {Hono} from 'hono';
import {describe, expect, it} from 'vitest';
import {
  createDebugRouteGuardMiddleware,
  evaluateDebugAccess,
  type DebugRouteGuardConfig,
} from '../../middleware/debugRouteGuard.js';

function makeApp(conf: DebugRouteGuardConfig): Hono {
  const guard = createDebugRouteGuardMiddleware(() => conf);
  const app = new Hono();
  app.use('/api/debug/*', guard);
  app.use('/api/db/tables', guard);
  app.get('/api/debug/ping', (c) => c.json({ok: true}));
  app.get('/api/db/tables', (c) => c.json({ok: true}));
  app.get('/api/health', (c) => c.json({ok: true}));
  return app;
}

describe('evaluateDebugAccess', () => {
  it('returns not_found when debug routes are disabled', () => {
    expect(
      evaluateDebugAccess({
        enabled: false,
        expectedKey: null,
        providedKey: undefined,
      }),
    ).toBe('not_found');
    // Even with a configured key, disabled means hidden.
    expect(
      evaluateDebugAccess({
        enabled: false,
        expectedKey: 'sek',
        providedKey: 'sek',
      }),
    ).toBe('not_found');
  });

  it('returns forbidden when enabled but no key is configured', () => {
    expect(
      evaluateDebugAccess({
        enabled: true,
        expectedKey: null,
        providedKey: undefined,
      }),
    ).toBe('forbidden');
    expect(
      evaluateDebugAccess({
        enabled: true,
        expectedKey: '',
        providedKey: 'whatever',
      }),
    ).toBe('forbidden');
  });

  it('returns forbidden when the provided key does not match', () => {
    expect(
      evaluateDebugAccess({
        enabled: true,
        expectedKey: 'sek',
        providedKey: undefined,
      }),
    ).toBe('forbidden');
    expect(
      evaluateDebugAccess({
        enabled: true,
        expectedKey: 'sek',
        providedKey: '',
      }),
    ).toBe('forbidden');
    expect(
      evaluateDebugAccess({
        enabled: true,
        expectedKey: 'sek',
        providedKey: 'nope',
      }),
    ).toBe('forbidden');
    // Case-sensitive comparison — important for shared-secret keys.
    expect(
      evaluateDebugAccess({
        enabled: true,
        expectedKey: 'SeK',
        providedKey: 'sek',
      }),
    ).toBe('forbidden');
  });

  it('returns ok when the provided key matches exactly', () => {
    expect(
      evaluateDebugAccess({
        enabled: true,
        expectedKey: 'sek',
        providedKey: 'sek',
      }),
    ).toBe('ok');
  });
});

describe('createDebugRouteGuardMiddleware', () => {
  it('returns 404 not_found when debug routes are disabled (no env bypass)', async () => {
    const app = makeApp({debugRoutesEnabled: false, debugKey: null});
    const res = await app.request('http://127.0.0.1:7777/api/debug/ping', {
      method: 'GET',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({error: 'not_found'});
  });

  it('returns 404 not_found even with a valid header when disabled', async () => {
    // Configured key + matching header must NOT defeat the disable
    // switch — the gate hides the surface entirely until
    // GREENHAVEN_DEBUG_ROUTES is set.
    const app = makeApp({debugRoutesEnabled: false, debugKey: 'sek'});
    const res = await app.request('http://127.0.0.1:7777/api/debug/ping', {
      method: 'GET',
      headers: {'x-debug-key': 'sek'},
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({error: 'not_found'});
  });

  it('returns 403 forbidden when enabled but no key is configured', async () => {
    // Closing the historical dev bypass: enabling the routes without
    // a key was previously a free pass on the dev box.
    const app = makeApp({debugRoutesEnabled: true, debugKey: null});
    const res = await app.request('http://127.0.0.1:7777/api/debug/ping', {
      method: 'GET',
      headers: {'x-debug-key': 'anything'},
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'forbidden'});
  });

  it('returns 403 forbidden when enabled, key configured, header missing', async () => {
    const app = makeApp({debugRoutesEnabled: true, debugKey: 'sek'});
    const res = await app.request('http://127.0.0.1:7777/api/debug/ping', {
      method: 'GET',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'forbidden'});
  });

  it('returns 403 forbidden when enabled, key configured, header mismatched', async () => {
    const app = makeApp({debugRoutesEnabled: true, debugKey: 'sek'});
    const res = await app.request('http://127.0.0.1:7777/api/debug/ping', {
      method: 'GET',
      headers: {'x-debug-key': 'wrong'},
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'forbidden'});
  });

  it('passes when enabled, key configured, header matches exactly', async () => {
    const app = makeApp({debugRoutesEnabled: true, debugKey: 'sek'});
    const res = await app.request('http://127.0.0.1:7777/api/debug/ping', {
      method: 'GET',
      headers: {'x-debug-key': 'sek'},
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
  });

  it('also protects /api/db/tables', async () => {
    const app = makeApp({debugRoutesEnabled: true, debugKey: 'sek'});
    const blocked = await app.request('http://127.0.0.1:7777/api/db/tables', {
      method: 'GET',
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({error: 'forbidden'});
    const allowed = await app.request('http://127.0.0.1:7777/api/db/tables', {
      method: 'GET',
      headers: {'x-debug-key': 'sek'},
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ok: true});
  });

  it('does not gate routes outside the protected prefixes', async () => {
    const app = makeApp({debugRoutesEnabled: false, debugKey: null});
    const res = await app.request('http://127.0.0.1:7777/api/health', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
  });
});
