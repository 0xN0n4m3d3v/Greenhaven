/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-3 / DEEP-10 — rate limits on unauthenticated public mutation
// endpoints: `POST /api/player/anonymous` (signup) and
// `POST /api/telemetry/{frontend,desktop}` (ingestion).
//
// The contract:
//
//   * `rateLimitAnonymousPlayer()`:
//     - Non-desktop: 5 accepted signups per 15 minutes per source.
//       The sixth attempt within the window returns
//       `429 {error: 'rate_limited'}`.
//     - Desktop: bypassed entirely (renderer is loopback-only;
//       first-launch must not 429).
//
//   * `rateLimitTelemetryIngest(source)`:
//     - Non-desktop: 60 events per minute per source IP. The 61st
//       inside the window returns `429 {error: 'rate_limited'}`.
//     - `'frontend'` and `'desktop'` keep independent buckets so a
//       desktop bootstrap dump cannot starve the browser channel
//       (and vice versa).
//     - Desktop: bypassed entirely.
//
//   * `publicSourceKey(c)` trust order:
//       `x-forwarded-for` first token → `Host` → `'global'`.
//
// The tests drive the middleware with a synthetic Hono context so
// they stay hermetic and do not boot the full Hono app stack.

import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Context} from 'hono';

// Stub `config()` so the limiters can read `isDesktop` without the
// real schema validating `AUTH_SECRET` etc., and so the
// desktop-bypass case can be toggled per test (the real `config()`
// caches on first read and refuses subsequent env mutations).
const configMock = vi.hoisted(() => ({isDesktop: false}));
vi.mock('../../config.js', () => ({
  config: () => configMock,
}));

import {
  publicSourceKey,
  rateLimitAnonymousPlayer,
  rateLimitTelemetryIngest,
  rateLimitTestHooks,
} from '../../middleware/rateLimit.js';

interface FakeCtxOptions {
  headers?: Record<string, string>;
}

interface JsonCall {
  body: unknown;
  status: number;
}

function makeContext(opts: FakeCtxOptions = {}): {
  ctx: Context;
  jsonCalls: JsonCall[];
} {
  const headers = opts.headers ?? {};
  const jsonCalls: JsonCall[] = [];
  const ctx = {
    req: {
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    },
    json(body: unknown, status: number) {
      jsonCalls.push({body, status});
      return {body, status};
    },
  } as unknown as Context;
  return {ctx, jsonCalls};
}

describe('publicSourceKey (DEEP-3 / DEEP-10)', () => {
  function ctxWith(headers: Record<string, string>): Context {
    return {
      req: {
        header(name: string) {
          return headers[name.toLowerCase()];
        },
      },
    } as unknown as Context;
  }

  it('prefers x-forwarded-for first token', () => {
    expect(
      publicSourceKey(
        ctxWith({'x-forwarded-for': '203.0.113.1, 10.0.0.1, 192.168.1.1'}),
      ),
    ).toBe('203.0.113.1');
  });

  it('falls back to Host header when x-forwarded-for is absent', () => {
    expect(publicSourceKey(ctxWith({host: '127.0.0.1:7777'}))).toBe(
      '127.0.0.1:7777',
    );
  });

  it('returns the global sentinel when no key headers are present', () => {
    expect(publicSourceKey(ctxWith({}))).toBe('global');
  });

  it('ignores x-real-ip / cf-connecting-ip (not part of this contract)', () => {
    // Distinct from `recoveryRestoreIpKey` — these headers must not
    // promote a stranger into their own bucket on the public
    // endpoints (the spec only trusts xff and Host).
    expect(
      publicSourceKey(
        ctxWith({
          'x-real-ip': '203.0.113.7',
          'cf-connecting-ip': '203.0.113.8',
          host: '127.0.0.1:7777',
        }),
      ),
    ).toBe('127.0.0.1:7777');
    expect(
      publicSourceKey(
        ctxWith({
          'x-real-ip': '203.0.113.7',
          'cf-connecting-ip': '203.0.113.8',
        }),
      ),
    ).toBe('global');
  });

  it('skips an empty x-forwarded-for first token', () => {
    // `", 10.0.0.1"` is the wrong but observable shape produced by
    // some proxies; the empty first segment must not become the key.
    expect(
      publicSourceKey(ctxWith({'x-forwarded-for': ', 10.0.0.1'})),
    ).toBe('global');
  });
});

describe('rateLimitAnonymousPlayer (DEEP-3)', () => {
  beforeEach(() => {
    rateLimitTestHooks.clear();
    configMock.isDesktop = false;
  });

  it('allows 5 signups then 429s the sixth from the same source IP', async () => {
    const middleware = rateLimitAnonymousPlayer();
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };

    for (let i = 0; i < 5; i++) {
      const {ctx, jsonCalls} = makeContext({
        headers: {'x-forwarded-for': '203.0.113.42'},
      });
      await middleware(ctx, next);
      expect(jsonCalls).toEqual([]);
    }
    expect(nextCalls).toBe(5);

    const {ctx, jsonCalls} = makeContext({
      headers: {'x-forwarded-for': '203.0.113.42'},
    });
    await middleware(ctx, next);
    expect(jsonCalls).toEqual([
      {body: {error: 'rate_limited'}, status: 429},
    ]);
    expect(nextCalls).toBe(5);
  });

  it('keeps separate buckets per source IP', async () => {
    const middleware = rateLimitAnonymousPlayer();
    const next = async () => {};

    for (let i = 0; i < 5; i++) {
      const {ctx} = makeContext({headers: {'x-forwarded-for': '198.51.100.7'}});
      await middleware(ctx, next);
    }
    const attackerSixth = makeContext({
      headers: {'x-forwarded-for': '198.51.100.7'},
    });
    await middleware(attackerSixth.ctx, next);
    expect(attackerSixth.jsonCalls[0]?.status).toBe(429);

    const innocent = makeContext({
      headers: {'x-forwarded-for': '203.0.113.99'},
    });
    await middleware(innocent.ctx, next);
    expect(innocent.jsonCalls).toEqual([]);
  });

  it('falls back to Host when no x-forwarded-for is present', async () => {
    const middleware = rateLimitAnonymousPlayer();
    const next = async () => {};

    for (let i = 0; i < 5; i++) {
      const {ctx} = makeContext({headers: {host: '203.0.113.5:7777'}});
      await middleware(ctx, next);
    }
    const sixth = makeContext({headers: {host: '203.0.113.5:7777'}});
    await middleware(sixth.ctx, next);
    expect(sixth.jsonCalls[0]?.status).toBe(429);
  });

  it('shares one bucket when no source key headers are present', async () => {
    const middleware = rateLimitAnonymousPlayer();
    const next = async () => {};

    // Five unkeyed callers exhaust the shared `global` bucket so a
    // header-less probe cannot mint unbounded signups.
    for (let i = 0; i < 5; i++) {
      const {ctx} = makeContext();
      await middleware(ctx, next);
    }
    const sixth = makeContext();
    await middleware(sixth.ctx, next);
    expect(sixth.jsonCalls[0]?.status).toBe(429);
  });

  it('bypasses entirely when running as desktop', async () => {
    configMock.isDesktop = true;
    const middleware = rateLimitAnonymousPlayer();
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };
    for (let i = 0; i < 50; i++) {
      const {ctx, jsonCalls} = makeContext({
        headers: {'x-forwarded-for': '127.0.0.1'},
      });
      await middleware(ctx, next);
      expect(jsonCalls).toEqual([]);
    }
    expect(nextCalls).toBe(50);
  });

  it('keeps the bucket alive past the 5-minute default sweep', async () => {
    const middleware = rateLimitAnonymousPlayer();
    const next = async () => {};
    for (let i = 0; i < 5; i++) {
      const {ctx} = makeContext({headers: {'x-forwarded-for': '203.0.113.55'}});
      await middleware(ctx, next);
    }
    const bucket = rateLimitTestHooks.bucket('anon:203.0.113.55');
    expect(bucket).toBeDefined();
    // Anonymous signup contract matches restore (5 / 15 min), so
    // `sweepAfterMs` must be at least the full 15-minute window —
    // otherwise the default 5-minute sweeper would drop the drained
    // bucket and let an attacker reset to capacity 5 ahead of
    // schedule.
    expect(bucket!.sweepAfterMs).toBeGreaterThanOrEqual(15 * 60_000);
  });
});

describe('rateLimitTelemetryIngest (DEEP-10)', () => {
  beforeEach(() => {
    rateLimitTestHooks.clear();
    configMock.isDesktop = false;
  });

  it('allows 60 events then 429s the 61st from the same IP', async () => {
    const middleware = rateLimitTelemetryIngest('frontend');
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };

    for (let i = 0; i < 60; i++) {
      const {ctx, jsonCalls} = makeContext({
        headers: {'x-forwarded-for': '203.0.113.42'},
      });
      await middleware(ctx, next);
      expect(jsonCalls).toEqual([]);
    }
    expect(nextCalls).toBe(60);

    const {ctx, jsonCalls} = makeContext({
      headers: {'x-forwarded-for': '203.0.113.42'},
    });
    await middleware(ctx, next);
    expect(jsonCalls).toEqual([
      {body: {error: 'rate_limited'}, status: 429},
    ]);
    expect(nextCalls).toBe(60);
  });

  it('keeps frontend and desktop buckets fully independent', async () => {
    const frontend = rateLimitTelemetryIngest('frontend');
    const desktop = rateLimitTelemetryIngest('desktop');
    const next = async () => {};

    // Exhaust frontend bucket for an IP.
    for (let i = 0; i < 60; i++) {
      const {ctx} = makeContext({headers: {'x-forwarded-for': '203.0.113.42'}});
      await frontend(ctx, next);
    }
    const frontend61 = makeContext({
      headers: {'x-forwarded-for': '203.0.113.42'},
    });
    await frontend(frontend61.ctx, next);
    expect(frontend61.jsonCalls[0]?.status).toBe(429);

    // The same IP's desktop bucket is untouched.
    const desktopFirst = makeContext({
      headers: {'x-forwarded-for': '203.0.113.42'},
    });
    await desktop(desktopFirst.ctx, next);
    expect(desktopFirst.jsonCalls).toEqual([]);

    // And bucket keys are tagged by source so the maps stay
    // separate even at the storage layer.
    expect(rateLimitTestHooks.bucket('telemetry:frontend:203.0.113.42'))
      .toBeDefined();
    expect(rateLimitTestHooks.bucket('telemetry:desktop:203.0.113.42'))
      .toBeDefined();
  });

  it('keeps separate buckets per source IP within one channel', async () => {
    const middleware = rateLimitTelemetryIngest('frontend');
    const next = async () => {};

    for (let i = 0; i < 60; i++) {
      const {ctx} = makeContext({headers: {'x-forwarded-for': '198.51.100.7'}});
      await middleware(ctx, next);
    }
    const attacker = makeContext({
      headers: {'x-forwarded-for': '198.51.100.7'},
    });
    await middleware(attacker.ctx, next);
    expect(attacker.jsonCalls[0]?.status).toBe(429);

    const innocent = makeContext({
      headers: {'x-forwarded-for': '203.0.113.99'},
    });
    await middleware(innocent.ctx, next);
    expect(innocent.jsonCalls).toEqual([]);
  });

  it('bypasses entirely when running as desktop', async () => {
    configMock.isDesktop = true;
    const frontend = rateLimitTelemetryIngest('frontend');
    const desktop = rateLimitTelemetryIngest('desktop');
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };
    for (let i = 0; i < 200; i++) {
      const a = makeContext({headers: {'x-forwarded-for': '127.0.0.1'}});
      await frontend(a.ctx, next);
      const b = makeContext({headers: {'x-forwarded-for': '127.0.0.1'}});
      await desktop(b.ctx, next);
      expect(a.jsonCalls).toEqual([]);
      expect(b.jsonCalls).toEqual([]);
    }
    expect(nextCalls).toBe(400);
  });
});
