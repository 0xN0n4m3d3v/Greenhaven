/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-playerId token-bucket rate limit. In-memory; sweep every minute.
// Tier 2 will swap to Redis-backed via env flag — not in v1.

import type {Context, MiddlewareHandler} from 'hono';
import {config} from '../config.js';
import {authenticatedPlayerId} from './auth.js';

interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  updatedAt: number;
  // DEEP-2 follow-up — minimum idle time before this bucket may be
  // swept. Computed at construction time as
  // `max(DEFAULT_BUCKET_MAX_IDLE_MS, fullRefillMs(capacity, refillPerMin))`
  // so a limiter that intends "N attempts per 15 minutes" cannot have
  // its drained bucket deleted at 5 minutes idle and reset to full
  // capacity ahead of schedule. The default keeps the turn / SSE
  // limiters at their existing 5-minute cleanup.
  sweepAfterMs: number;
}

const buckets = new Map<string, Bucket>();
const DEFAULT_BUCKET_MAX_IDLE_MS = 5 * 60_000;

function fullRefillMs(capacity: number, refillPerMin: number): number {
  if (!Number.isFinite(refillPerMin) || refillPerMin <= 0) return 0;
  return (capacity / refillPerMin) * 60_000;
}

function bucketSweepAfterMs(capacity: number, refillPerMin: number): number {
  return Math.max(
    DEFAULT_BUCKET_MAX_IDLE_MS,
    fullRefillMs(capacity, refillPerMin),
  );
}

const sweep = setInterval(() => {
  sweepRateLimitBuckets();
}, 60_000);
sweep.unref?.();

export function sweepRateLimitBuckets(
  now = Date.now(),
  maxIdleMs?: number,
): number {
  let deleted = 0;
  for (const [key, bucket] of buckets) {
    // Per-bucket `sweepAfterMs` is the authoritative idle threshold.
    // The optional `maxIdleMs` override exists so a caller (typically
    // a test) can force a more aggressive sweep without touching the
    // bucket map directly. We treat it as a floor — never sweep
    // sooner than the bucket's own full-refill window.
    const sweepAfter =
      typeof maxIdleMs === 'number'
        ? Math.max(maxIdleMs, bucket.sweepAfterMs)
        : bucket.sweepAfterMs;
    if (bucket.updatedAt < now - sweepAfter) {
      buckets.delete(key);
      deleted += 1;
    }
  }
  return deleted;
}

function take(key: string, capacity: number, refillPerMin: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = {
      tokens: capacity,
      capacity,
      refillPerMs: refillPerMin / 60_000,
      updatedAt: now,
      sweepAfterMs: bucketSweepAfterMs(capacity, refillPerMin),
    };
    buckets.set(key, b);
  }
  const elapsed = now - b.updatedAt;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
  b.updatedAt = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * Rate-limit POST /turn at 10 burst, 30 per minute steady-state per
 * authenticated player. Returns 429 with `retryAfter` when exceeded.
 * Unauthenticated requests pass through (the upstream auth middleware
 * already 401s them).
 */
export function rateLimitTurns(): MiddlewareHandler {
  return async (c, next) => {
    const playerId = (c.var as {playerId?: number}).playerId ?? 0;
    if (!playerId) return next();
    const key = `turn:${playerId}`;
    if (!take(key, 10, 30)) {
      return c.json({error: 'rate_limited', retryAfter: 2}, 429);
    }
    return next();
  };
}

/**
 * Rate-limit GET /stream at 10 burst, 100 per minute. SSE re-connects
 * are cheap server-side but a misbehaving client can hammer the endpoint
 * during a partial-network condition; this caps the damage.
 */
export function rateLimitSse(): MiddlewareHandler {
  return async (c, next) => {
    const playerId = (c.var as {playerId?: number}).playerId ?? 0;
    if (!playerId) return next();
    const key = `sse:${playerId}`;
    if (!take(key, 10, 100)) {
      return c.json({error: 'rate_limited'}, 429);
    }
    return next();
  };
}

// DEEP-2 — IP key for `/api/player/restore`. Trust order:
// `x-forwarded-for` first token (the originating client behind a
// reverse proxy), then `x-real-ip`, then `cf-connecting-ip`. Falls
// back to a stable `unknown` token so requests without any header
// still share one bucket rather than minting infinite free attempts.
// The restore endpoint must never key off `playerId`: the attacker
// does not have one until they succeed, and we don't want a
// successful authorised attacker to acquire a per-id bucket either.
export function recoveryRestoreIpKey(c: Context): string {
  const xff = c.req.header('x-forwarded-for') ?? '';
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  return 'unknown';
}

/**
 * DEEP-2 — rate-limit POST `/api/player/restore` at 5 attempts per 15
 * minutes per source IP. Desktop builds bypass entirely (the request
 * source is always loopback, and the user is the only legitimate
 * caller). Returns `429 {error: 'rate_limited'}` when exhausted.
 */
export function rateLimitRecoveryRestore(): MiddlewareHandler {
  return async (c, next) => {
    if (config().isDesktop) return next();
    const key = `restore:${recoveryRestoreIpKey(c)}`;
    // capacity = 5 burst; refill = 5 tokens per 15 minutes = 1/3 token/min.
    if (!take(key, 5, 5 / 15)) {
      return c.json({error: 'rate_limited'}, 429);
    }
    return next();
  };
}

// DEEP-3 / DEEP-10 — source key for unauthenticated public endpoints
// (`POST /api/player/anonymous`, `POST /api/telemetry/{frontend,desktop}`).
// Trust order: `x-forwarded-for` first token (the originating client
// behind a reverse proxy), else the inbound `Host` header (still a
// stable shared key when the listener is exposed without XFF), else a
// `'global'` sentinel so every keyless request still shares one
// bucket rather than minting unbounded free attempts. Distinct from
// `recoveryRestoreIpKey` because the spec for these endpoints is
// explicit about Host being the second-stage fallback, not
// `x-real-ip` / `cf-connecting-ip`.
export function publicSourceKey(c: Context): string {
  const xff = c.req.header('x-forwarded-for') ?? '';
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const host = c.req.header('host')?.trim();
  if (host) return host;
  return 'global';
}

/**
 * DEEP-3 — rate-limit `POST /api/player/anonymous` at 5 accepted
 * signups per 15 minutes per source. Desktop builds bypass entirely:
 * the only caller is the local renderer on loopback, and the
 * "boot a fresh anonymous player on first launch" path must never
 * hit a 429. Returns `429 {error: 'rate_limited'}` when exhausted.
 *
 * Capacity / refill match the restore limiter (5 / 15 min) — both
 * gate account-shaped creation events that an attacker would
 * otherwise spray. Source-key formula is `publicSourceKey(c)`.
 */
export function rateLimitAnonymousPlayer(): MiddlewareHandler {
  return async (c, next) => {
    if (config().isDesktop) return next();
    const key = `anon:${publicSourceKey(c)}`;
    // capacity = 5 burst; refill = 5 tokens per 15 minutes = 1/3 token/min.
    if (!take(key, 5, 5 / 15)) {
      return c.json({error: 'rate_limited'}, 429);
    }
    return next();
  };
}

/**
 * SEC-5 — blanket per-player rate limit on state-changing endpoints.
 *
 * Covers the long tail of `POST` / `PATCH` / `DELETE` routes that
 * the SEC-1 / SEC-2 / DEEP-4 / DEEP-5 / DEEP-6 ownership slice
 * left auth-protected but otherwise unbounded: profile patch,
 * saves create / restore / delete, adventure accept / ignore,
 * character stats / skills, character AI-assist, sheet
 * synthesis, session reset / cancel / dialogue / model swap,
 * Devil's Bargain choice, session delete, and the local-reset
 * endpoint. An authenticated player who scripted these routes
 * could pump model spend or trigger cascading server work
 * without any ceiling — DEEP-12's bucket sweeper was already in
 * place from the turn / SSE / restore limiters; SEC-5 just adds
 * the missing per-player wall.
 *
 * Contract:
 *   * Non-mutating methods (`GET`, `HEAD`, `OPTIONS`) pass
 *     through. Mounting this limiter at the router level
 *     (`sessionRoutes.use('*', ...)`) is safe because the
 *     method filter keeps it from charging the read-side
 *     surface.
 *   * `config().authDisabled` → pass through. The dev/test
 *     escape hatch was reaffirmed by SEC-7 / DEEP-14 (which
 *     makes the combo fatal in production); the limiter would
 *     otherwise force test fixtures that hammer one endpoint to
 *     track 30/min synthetically.
 *   * Key by `c.var.playerId` if a prior middleware has already
 *     established the authed identity (the SEC-1 `ownsPlayer`
 *     and the auth router-middleware both set it). Else
 *     re-read the cookie via `authenticatedPlayerId(c)`. Else
 *     fall back to `publicSourceKey(c)` so an unauthenticated
 *     probe that slips past a missing auth check still gets
 *     bucketed (defense in depth — every wired route in
 *     `index.ts` already pairs the SEC-5 limiter with an auth
 *     guard, so this fallback should be unreachable in
 *     production).
 *   * Capacity = 30 burst, refill = 30 / min steady-state.
 *     Returns `429 {error: 'rate_limited'}` when exhausted.
 *
 * Mount order matters: this middleware must run AFTER the
 * `requireAuth` / `ownsPlayer` guard that establishes the
 * 401 / 403 / 400 contract, so a missing cookie still emits
 * the auth-shaped failure rather than the rate-limit-shaped
 * one. The wiring in `src/index.ts` and the affected route
 * routers pins this order.
 */
export function rateLimitStateChanges(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
      return next();
    }
    if (config().authDisabled) return next();
    const ctxVar = (c.var as {playerId?: number}).playerId;
    const fromVar =
      typeof ctxVar === 'number' && ctxVar > 0 ? ctxVar : null;
    const playerId = fromVar ?? (await authenticatedPlayerId(c));
    const key =
      playerId != null
        ? `state:player:${playerId}`
        : `state:src:${publicSourceKey(c)}`;
    if (!take(key, 30, 30)) {
      return c.json({error: 'rate_limited'}, 429);
    }
    return next();
  };
}

/**
 * DEEP-10 — rate-limit telemetry ingestion endpoints at 60 events per
 * minute per source, with the `frontend` and `desktop` channels
 * keeping fully independent buckets (otherwise a desktop bootstrap
 * dump could starve the browser channel or vice versa). Desktop
 * builds bypass entirely: telemetry from the local renderer is
 * loopback-only, and dropping it on the floor would erase the only
 * signal an oncall has during a desktop incident.
 *
 * Capacity = 60 burst; refill = 60 tokens / minute. Returns
 * `429 {error: 'rate_limited'}` when exhausted.
 */
export function rateLimitTelemetryIngest(
  source: 'frontend' | 'desktop',
): MiddlewareHandler {
  return async (c, next) => {
    if (config().isDesktop) return next();
    const key = `telemetry:${source}:${publicSourceKey(c)}`;
    if (!take(key, 60, 60)) {
      return c.json({error: 'rate_limited'}, 429);
    }
    return next();
  };
}

export const rateLimitTestHooks = {
  clear(): void {
    buckets.clear();
  },
  seed(
    key: string,
    bucket: Partial<Bucket> & Pick<Bucket, 'updatedAt'>,
  ): void {
    // `sweepAfterMs` defaults to `DEFAULT_BUCKET_MAX_IDLE_MS` so
    // pre-DEEP-2-follow-up callers (e.g. the DEEP-12 stale-bucket
    // sweep test) keep their original 5-minute idle semantics.
    // Tests that want to exercise a longer-window limiter pass an
    // explicit `sweepAfterMs`.
    buckets.set(key, {
      tokens: bucket.tokens ?? 0,
      capacity: bucket.capacity ?? 10,
      refillPerMs: bucket.refillPerMs ?? 1 / 60_000,
      updatedAt: bucket.updatedAt,
      sweepAfterMs: bucket.sweepAfterMs ?? DEFAULT_BUCKET_MAX_IDLE_MS,
    });
  },
  bucket(key: string): Bucket | undefined {
    return buckets.get(key);
  },
  size(): number {
    return buckets.size;
  },
};
