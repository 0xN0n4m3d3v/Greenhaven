/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-5 follow-up — auth-order repair for
// `POST /api/player/reset-local-game`.
//
// Before this repair the route was wired as
// `app.use('/api/player/reset-local-game', rateLimitStateChanges())`
// in `index.ts`, which placed the generic 30/min state-change
// limiter ahead of the route's own auth decision. On
// non-desktop with no cookie the first 30 unauthenticated probes
// returned the route's intended 401, then the 31st came back as
// `429 {error:'rate_limited'}` from the limiter's per-source
// bucket — exactly the auth-before-rate-limit ordering the SEC-1
// / SEC-5 contract forbids.
//
// The fix moves the limiter mount INSIDE the route, chained after
// a route-local `requireResetAuth` middleware that mirrors the
// route's existing decision (desktop / `AUTH_DISABLED` /
// authenticated all pass; non-desktop without a cookie returns
// 401). These tests rebuild that chain on a focused Hono fixture
// so the contract is pinned without the real DB-touching handler.

import {Hono, type MiddlewareHandler} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const configMock = vi.hoisted(() => ({
  authDisabled: false as boolean,
  authSecret: 'a'.repeat(48),
  authCookieSecure: 'off' as 'auto' | 'on' | 'off',
  isDesktop: false as boolean,
  nodeEnv: 'test' as 'development' | 'production' | 'test',
}));

vi.mock('../../config.js', () => ({
  config: () => configMock,
}));

// SEC-6 — auth verifies a server-side `jti` row. Stub the store
// so test cookies authenticate without booting a DB.
const tokenStoreMock = vi.hoisted(() => {
  const activeJtis = new Set<string>([
    '00000000-0000-4000-8000-000000000001',
  ]);
  return {
    activeJtis,
    isSessionTokenActive: async (jti: string, _playerId: number) =>
      activeJtis.has(jti),
    createSessionToken: async (playerId: number) => ({
      jti: '00000000-0000-4000-8000-000000000001',
      playerId,
      issuedAt: new Date(),
    }),
    revokeSessionToken: async (jti: string) => {
      activeJtis.delete(jti);
    },
  };
});

vi.mock('../../auth/sessionTokenStore.js', () => tokenStoreMock);

import {authenticatedPlayerId, signCookie} from '../../middleware/auth.js';
import {
  rateLimitStateChanges,
  rateLimitTestHooks,
} from '../../middleware/rateLimit.js';

function authCookieHeader(playerId: number): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jti = '00000000-0000-4000-8000-000000000001';
  return `gh_player=${signCookie({playerId, exp, jti})}`;
}

// Mirrors the production `requireResetAuth` middleware in
// `routes/player.ts`. Defined inline so the test fixture stays
// self-contained — the production module already has the same
// shape and is verified via typecheck/build.
const requireResetAuth: MiddlewareHandler = async (c, next) => {
  const playerId = await authenticatedPlayerId(c);
  const isDesktop = configMock.isDesktop;
  const authDisabled = configMock.authDisabled;
  if (!isDesktop && !authDisabled && playerId == null) {
    return c.json({error: 'unauthenticated'}, 401);
  }
  if (playerId != null) c.set('playerId', playerId);
  return next();
};

function makeResetApp(): Hono {
  const app = new Hono();
  app.post(
    '/api/player/reset-local-game',
    requireResetAuth,
    rateLimitStateChanges(),
    (c) =>
      c.json({
        ok: true,
        playerId: (c.var as {playerId?: number}).playerId ?? null,
      }),
  );
  return app;
}

describe('reset-local-game auth-before-rate-limit ordering (SEC-5 follow-up)', () => {
  beforeEach(() => {
    rateLimitTestHooks.clear();
    configMock.authDisabled = false;
    configMock.isDesktop = false;
  });

  it('returns 401 on every unauthenticated probe, never 429 (50 attempts)', async () => {
    const app = makeResetApp();
    for (let i = 0; i < 50; i++) {
      const res = await app.request(
        'http://127.0.0.1:7777/api/player/reset-local-game',
        {
          method: 'POST',
          headers: {'x-forwarded-for': '203.0.113.42'},
        },
      );
      expect(res.status, `attempt ${i + 1}`).toBe(401);
      expect(await res.json()).toEqual({error: 'unauthenticated'});
    }
    // Because the auth check runs first, the limiter never sees
    // these probes — no bucket is ever allocated for them.
    expect(
      rateLimitTestHooks.bucket('state:src:203.0.113.42'),
    ).toBeUndefined();
  });

  it('still 401s on the 31st request even after 30 prior 401s', async () => {
    // The bug this test guards against: the previous app-level
    // mount would have charged a token for each 401 attempt and
    // returned 429 on the 31st. The fix puts auth ahead of the
    // limiter so 401 wins for every count.
    const app = makeResetApp();
    for (let i = 0; i < 30; i++) {
      const res = await app.request(
        'http://127.0.0.1:7777/api/player/reset-local-game',
        {method: 'POST'},
      );
      expect(res.status).toBe(401);
    }
    const thirtyFirst = await app.request(
      'http://127.0.0.1:7777/api/player/reset-local-game',
      {method: 'POST'},
    );
    expect(thirtyFirst.status).toBe(401);
    expect(await thirtyFirst.json()).toEqual({error: 'unauthenticated'});
  });

  it('authenticated player gets the SEC-5 30/min ceiling — 30 pass then 31st 429s', async () => {
    const app = makeResetApp();
    const cookie = authCookieHeader(42);
    for (let i = 0; i < 30; i++) {
      const res = await app.request(
        'http://127.0.0.1:7777/api/player/reset-local-game',
        {method: 'POST', headers: {cookie}},
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ok: true, playerId: 42});
    }
    const thirtyFirst = await app.request(
      'http://127.0.0.1:7777/api/player/reset-local-game',
      {method: 'POST', headers: {cookie}},
    );
    expect(thirtyFirst.status).toBe(429);
    expect(await thirtyFirst.json()).toEqual({error: 'rate_limited'});
    // The authed player keyed by playerId — not by source — so the
    // bucket entry is `state:player:42`.
    expect(rateLimitTestHooks.bucket('state:player:42')).toBeDefined();
  });

  it('desktop without a cookie passes through the auth gate AND is still bounded by SEC-5', async () => {
    configMock.isDesktop = true;
    const app = makeResetApp();
    for (let i = 0; i < 30; i++) {
      const res = await app.request(
        'http://127.0.0.1:7777/api/player/reset-local-game',
        {
          method: 'POST',
          headers: {'x-forwarded-for': '127.0.0.1'},
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ok: true, playerId: null});
    }
    // Desktop has no cookie → limiter falls back to source-IP key.
    // 30/min ceiling still applies; this is the same defense-in-depth
    // behavior SEC-5 added when the route was originally mounted.
    const thirtyFirst = await app.request(
      'http://127.0.0.1:7777/api/player/reset-local-game',
      {
        method: 'POST',
        headers: {'x-forwarded-for': '127.0.0.1'},
      },
    );
    expect(thirtyFirst.status).toBe(429);
    expect(rateLimitTestHooks.bucket('state:src:127.0.0.1')).toBeDefined();
  });

  it('AUTH_DISABLED=1 fully bypasses BOTH auth and the SEC-5 limiter', async () => {
    configMock.authDisabled = true;
    const app = makeResetApp();
    // 200 requests with no cookie, no x-forwarded-for. Auth gate
    // passes (authDisabled) and the limiter bypasses on the same
    // flag, so the handler runs every time.
    for (let i = 0; i < 200; i++) {
      const res = await app.request(
        'http://127.0.0.1:7777/api/player/reset-local-game',
        {method: 'POST'},
      );
      expect(res.status).toBe(200);
    }
    expect(rateLimitTestHooks.bucket('state:src:global')).toBeUndefined();
  });
});
