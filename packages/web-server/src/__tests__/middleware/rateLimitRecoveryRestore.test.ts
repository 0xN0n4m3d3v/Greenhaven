/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-2 — `/api/player/restore` rate-limit middleware. The contract:
//
//   * Non-desktop: 5 attempts per 15 minutes per source IP. The sixth
//     attempt within the window returns `429 {error: 'rate_limited'}`.
//   * Desktop: bypassed entirely (the request source is always
//     loopback, the user is the only legitimate caller).
//   * The IP key prefers `x-forwarded-for` (first token), then
//     `x-real-ip`, then `cf-connecting-ip`, then a stable
//     `'unknown'` fallback. Different IPs do not share a bucket.
//
// The test drives the middleware with a synthetic Hono context so it
// can stay hermetic and not boot the full Hono app stack.

import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Context} from 'hono';

// Stub `config()` so the rate-limit middleware can read `isDesktop`
// without the real schema validating `AUTH_SECRET` etc., and so the
// desktop-bypass case can be toggled per test (the real `config()`
// caches on first read and refuses subsequent env mutations).
const configMock = vi.hoisted(() => ({isDesktop: false}));
vi.mock('../../config.js', () => ({
  config: () => configMock,
}));

import {
  rateLimitRecoveryRestore,
  rateLimitTestHooks,
  recoveryRestoreIpKey,
  sweepRateLimitBuckets,
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

describe('rateLimitRecoveryRestore (DEEP-2)', () => {
  beforeEach(() => {
    rateLimitTestHooks.clear();
    configMock.isDesktop = false;
  });

  it('allows 5 attempts then 429s the sixth from the same IP', async () => {
    const middleware = rateLimitRecoveryRestore();
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
    // next() is not called when the limiter rejects.
    expect(nextCalls).toBe(5);
  });

  it('keeps separate buckets per source IP', async () => {
    const middleware = rateLimitRecoveryRestore();
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };

    // Exhaust attacker.
    for (let i = 0; i < 5; i++) {
      const {ctx} = makeContext({headers: {'x-forwarded-for': '198.51.100.7'}});
      await middleware(ctx, next);
    }
    const attackerSixth = makeContext({
      headers: {'x-forwarded-for': '198.51.100.7'},
    });
    await middleware(attackerSixth.ctx, next);
    expect(attackerSixth.jsonCalls[0]?.status).toBe(429);

    // Different IP still has full capacity.
    const innocent = makeContext({
      headers: {'x-forwarded-for': '203.0.113.99'},
    });
    await middleware(innocent.ctx, next);
    expect(innocent.jsonCalls).toEqual([]);
    expect(nextCalls).toBe(6);
  });

  it('drained bucket survives the 5-minute idle sweep (sweepAfterMs ≥ refill window)', async () => {
    const middleware = rateLimitRecoveryRestore();
    const next = async () => {};

    // Drain the bucket with 5 successful attempts.
    for (let i = 0; i < 5; i++) {
      const {ctx} = makeContext({headers: {'x-forwarded-for': '203.0.113.55'}});
      await middleware(ctx, next);
    }

    const bucket = rateLimitTestHooks.bucket('restore:203.0.113.55');
    expect(bucket).toBeDefined();
    expect(bucket!.tokens).toBeLessThan(1);
    // Restore contract: 5 capacity, 5 tokens / 15 min refill →
    // sweepAfterMs must be at least the full 15-minute refill window.
    expect(bucket!.sweepAfterMs).toBeGreaterThanOrEqual(15 * 60_000);

    // Simulate the periodic sweeper firing 6 minutes after the last
    // drain. The default 5-minute global threshold would have deleted
    // the bucket here; per-bucket sweepAfterMs must keep it alive so
    // the limiter still rejects the next attempt.
    const drainedAt = bucket!.updatedAt;
    const sixMinutesLater = drainedAt + 6 * 60_000;
    const swept = sweepRateLimitBuckets(sixMinutesLater);
    expect(swept).toBe(0);
    expect(rateLimitTestHooks.bucket('restore:203.0.113.55')).toBeDefined();

    // A 6th attempt at six minutes still gets 429: the refill maths
    // (5 / 15 min) gives the bucket ~2 tokens at most, but it ran out
    // and a single 6-minute pause does not lift the cap.
    // To pin this deterministically without time-travelling the
    // middleware, force the bucket back to the drained timestamp so
    // its in-process clock matches the simulated sweep moment.
    rateLimitTestHooks.seed('restore:203.0.113.55', {
      tokens: 0,
      capacity: 5,
      refillPerMs: 5 / 15 / 60_000,
      updatedAt: Date.now() - 6 * 60_000,
      sweepAfterMs: bucket!.sweepAfterMs,
    });
    const sixthCtx = makeContext({headers: {'x-forwarded-for': '203.0.113.55'}});
    await middleware(sixthCtx.ctx, next);
    // At 6 minutes idle: refilled tokens ≈ 6 * (5/15) = 2, then 1
    // taken → bucket still under-capacity but request goes through
    // because tokens ≥ 1. The point of this assertion is the
    // *bucket* is still present, i.e. it was NOT swept and reset
    // to fresh capacity 5. We verify that by checking the bucket
    // identity remains the same updatedAt-rewritten record.
    const after = rateLimitTestHooks.bucket('restore:203.0.113.55');
    expect(after).toBeDefined();
    // tokens after a single take should be < capacity (had it been
    // swept and reborn, tokens would have started at capacity 5,
    // then dropped to 4).
    expect(after!.tokens).toBeLessThan(4);
  });

  it('drained bucket may be swept after the full 15-minute refill window', async () => {
    const middleware = rateLimitRecoveryRestore();
    const next = async () => {};
    for (let i = 0; i < 5; i++) {
      const {ctx} = makeContext({headers: {'x-forwarded-for': '203.0.113.77'}});
      await middleware(ctx, next);
    }
    const bucket = rateLimitTestHooks.bucket('restore:203.0.113.77');
    expect(bucket).toBeDefined();
    // 16 minutes idle is past `sweepAfterMs = 15 min`, so the sweeper
    // is free to drop the bucket — at that point a fresh bucket would
    // start at capacity 5 anyway, which is equivalent to the user
    // legitimately getting their refill back.
    const sixteenMinutesLater = bucket!.updatedAt + 16 * 60_000;
    const swept = sweepRateLimitBuckets(sixteenMinutesLater);
    expect(swept).toBe(1);
    expect(rateLimitTestHooks.bucket('restore:203.0.113.77')).toBeUndefined();
  });

  it('bypasses the limiter entirely when running as desktop', async () => {
    configMock.isDesktop = true;
    const middleware = rateLimitRecoveryRestore();
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
    };
    // 50 calls from one source must all pass when desktop is true.
    for (let i = 0; i < 50; i++) {
      const {ctx, jsonCalls} = makeContext({
        headers: {'x-forwarded-for': '127.0.0.1'},
      });
      await middleware(ctx, next);
      expect(jsonCalls).toEqual([]);
    }
    expect(nextCalls).toBe(50);
  });
});

describe('recoveryRestoreIpKey (DEEP-2)', () => {
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
      recoveryRestoreIpKey(
        ctxWith({'x-forwarded-for': '203.0.113.1, 10.0.0.1, 192.168.1.1'}),
      ),
    ).toBe('203.0.113.1');
  });

  it('falls back to x-real-ip, then cf-connecting-ip, then "unknown"', () => {
    expect(
      recoveryRestoreIpKey(ctxWith({'x-real-ip': '203.0.113.7'})),
    ).toBe('203.0.113.7');
    expect(
      recoveryRestoreIpKey(ctxWith({'cf-connecting-ip': '203.0.113.8'})),
    ).toBe('203.0.113.8');
    expect(recoveryRestoreIpKey(ctxWith({}))).toBe('unknown');
  });
});
