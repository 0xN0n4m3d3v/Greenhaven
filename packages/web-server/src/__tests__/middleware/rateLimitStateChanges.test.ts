/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-5 — generic per-player rate limit for authenticated state-
// changing endpoints. The middleware was added to cover the long
// tail of `POST` / `PATCH` / `DELETE` routes the SEC-1 ownership
// slice left auth-protected but otherwise unbounded.
//
// Contract:
//
//   * Non-mutating methods (`GET`, `HEAD`, `OPTIONS`) pass
//     through (router-level mount is safe).
//   * `config().authDisabled` → pass through (dev/test escape
//     hatch; SEC-7 / DEEP-14 makes the production combo fatal).
//   * Key by `c.var.playerId` if set; else re-read the cookie;
//     else fall back to `publicSourceKey(c)`.
//   * Capacity = 30 burst, refill = 30 / min. Returns
//     `429 {error: 'rate_limited'}` when exhausted.
//   * Mount order: must run AFTER auth/ownership so an
//     unauthenticated request still emits 401 (not 429).
//
// These tests drive the middleware with a synthetic Hono context
// so the suite stays hermetic and doesn't boot the Hono app
// stack. The `publicSourceKey` and `take(...)` interactions are
// already covered by their own suites; this file pins SEC-5
// behavior specifically.

import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Context} from 'hono';

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

// SEC-6 — auth now verifies a server-side `jti` row. Stub the
// store so the test's signed cookies authenticate without
// booting a database.
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

import {signCookie} from '../../middleware/auth.js';
import {
  rateLimitStateChanges,
  rateLimitTestHooks,
} from '../../middleware/rateLimit.js';

interface FakeCtxOptions {
  method?: string;
  headers?: Record<string, string>;
  varPlayerId?: number;
}

interface JsonCall {
  body: unknown;
  status: number;
}

function makeContext(opts: FakeCtxOptions = {}): {
  ctx: Context;
  jsonCalls: JsonCall[];
  vars: Record<string, unknown>;
} {
  const method = opts.method ?? 'POST';
  const headers = opts.headers ?? {};
  const vars: Record<string, unknown> = {};
  if (opts.varPlayerId != null) vars['playerId'] = opts.varPlayerId;
  const jsonCalls: JsonCall[] = [];
  // Hono's `getCookie(c, name)` reads `c.req.raw.headers.get('Cookie')`.
  // Faking `raw.headers` with a case-insensitive lookup so the auth
  // middleware can read the synthetic test cookies.
  const rawHeaders = {
    get(name: string): string | null {
      const key = name.toLowerCase();
      const value = headers[key];
      return value ?? null;
    },
  };
  const ctx = {
    req: {
      method,
      raw: {headers: rawHeaders},
      header(name: string) {
        const key = name.toLowerCase();
        return headers[key];
      },
    },
    get var() {
      return vars;
    },
    json(body: unknown, status: number) {
      jsonCalls.push({body, status});
      return {body, status};
    },
  } as unknown as Context;
  return {ctx, jsonCalls, vars};
}

function authCookieHeader(playerId: number): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jti = '00000000-0000-4000-8000-000000000001';
  return `gh_player=${signCookie({playerId, exp, jti})}`;
}

describe('rateLimitStateChanges (SEC-5)', () => {
  beforeEach(() => {
    rateLimitTestHooks.clear();
    configMock.authDisabled = false;
  });

  it('allows 30 mutations then 429s the 31st for the same player', async () => {
    const middleware = rateLimitStateChanges();
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };

    for (let i = 0; i < 30; i++) {
      const {ctx, jsonCalls} = makeContext({varPlayerId: 42});
      await middleware(ctx, next);
      expect(jsonCalls).toEqual([]);
    }
    expect(nextCalls).toBe(30);

    const {ctx, jsonCalls} = makeContext({varPlayerId: 42});
    await middleware(ctx, next);
    expect(jsonCalls).toEqual([{body: {error: 'rate_limited'}, status: 429}]);
    expect(nextCalls).toBe(30);
  });

  it('keeps per-player buckets fully isolated', async () => {
    const middleware = rateLimitStateChanges();
    const next = async () => {};

    for (let i = 0; i < 30; i++) {
      const {ctx} = makeContext({varPlayerId: 42});
      await middleware(ctx, next);
    }
    const attacker = makeContext({varPlayerId: 42});
    await middleware(attacker.ctx, next);
    expect(attacker.jsonCalls[0]?.status).toBe(429);

    // Player 7's bucket is untouched.
    const innocent = makeContext({varPlayerId: 7});
    await middleware(innocent.ctx, next);
    expect(innocent.jsonCalls).toEqual([]);
    expect(rateLimitTestHooks.bucket('state:player:42')).toBeDefined();
    expect(rateLimitTestHooks.bucket('state:player:7')).toBeDefined();
  });

  it('falls back to a cookie-derived player id when `c.var.playerId` is absent', async () => {
    const middleware = rateLimitStateChanges();
    const next = async () => {};

    // No var.playerId, but a valid cookie for player 9 — the
    // limiter should still key by player, not by source.
    for (let i = 0; i < 30; i++) {
      const {ctx} = makeContext({headers: {cookie: authCookieHeader(9)}});
      await middleware(ctx, next);
    }
    const exhausted = makeContext({headers: {cookie: authCookieHeader(9)}});
    await middleware(exhausted.ctx, next);
    expect(exhausted.jsonCalls[0]?.status).toBe(429);
    expect(rateLimitTestHooks.bucket('state:player:9')).toBeDefined();
  });

  it('falls back to a source-IP bucket when no auth context is available', async () => {
    const middleware = rateLimitStateChanges();
    const next = async () => {};

    // No var, no cookie — fall back to publicSourceKey via xff.
    for (let i = 0; i < 30; i++) {
      const {ctx} = makeContext({
        headers: {'x-forwarded-for': '203.0.113.42'},
      });
      await middleware(ctx, next);
    }
    const exhausted = makeContext({
      headers: {'x-forwarded-for': '203.0.113.42'},
    });
    await middleware(exhausted.ctx, next);
    expect(exhausted.jsonCalls[0]?.status).toBe(429);
    expect(
      rateLimitTestHooks.bucket('state:src:203.0.113.42'),
    ).toBeDefined();
  });

  it('passes through GET, HEAD, OPTIONS unchanged (router-level mount safe)', async () => {
    const middleware = rateLimitStateChanges();
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      for (let i = 0; i < 50; i++) {
        const {ctx, jsonCalls} = makeContext({method, varPlayerId: 42});
        await middleware(ctx, next);
        expect(jsonCalls).toEqual([]);
      }
    }
    expect(nextCalls).toBe(150);
    // No bucket allocated — the method filter short-circuits
    // before `take(...)` is touched.
    expect(rateLimitTestHooks.bucket('state:player:42')).toBeUndefined();
  });

  it('rejects 31st PATCH and DELETE in the same window as POST (all three mutating verbs share one bucket)', async () => {
    const middleware = rateLimitStateChanges();
    const next = async () => {};

    // 10 POSTs + 10 PATCHes + 10 DELETEs = 30 against one
    // shared per-player bucket.
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      for (let i = 0; i < 10; i++) {
        const {ctx} = makeContext({method, varPlayerId: 42});
        await middleware(ctx, next);
      }
    }
    // The 31st (any method) should 429.
    const exhausted = makeContext({method: 'DELETE', varPlayerId: 42});
    await middleware(exhausted.ctx, next);
    expect(exhausted.jsonCalls[0]?.status).toBe(429);
  });

  it('bypasses entirely when `AUTH_DISABLED=1` (dev/test escape hatch preserved)', async () => {
    configMock.authDisabled = true;
    const middleware = rateLimitStateChanges();
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };

    for (let i = 0; i < 200; i++) {
      const {ctx, jsonCalls} = makeContext({varPlayerId: 42});
      await middleware(ctx, next);
      expect(jsonCalls).toEqual([]);
    }
    expect(nextCalls).toBe(200);
    expect(rateLimitTestHooks.bucket('state:player:42')).toBeUndefined();
  });

  it('keys cookie-derived and var-derived player ids into the same bucket', async () => {
    // SEC-5's whole point is "30 / min per player no matter
    // which route". A player who has `var.playerId` set on the
    // ownership-protected `/api/player/:id/profile` patch and
    // a cookie-only path through `/api/character/sheet/synthesize`
    // must share one bucket — not two.
    const middleware = rateLimitStateChanges();
    const next = async () => {};

    for (let i = 0; i < 15; i++) {
      const {ctx} = makeContext({varPlayerId: 42});
      await middleware(ctx, next);
    }
    for (let i = 0; i < 15; i++) {
      const {ctx} = makeContext({headers: {cookie: authCookieHeader(42)}});
      await middleware(ctx, next);
    }
    const exhausted = makeContext({varPlayerId: 42});
    await middleware(exhausted.ctx, next);
    expect(exhausted.jsonCalls[0]?.status).toBe(429);
  });
});
