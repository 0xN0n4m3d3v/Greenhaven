/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-4 — Debug route gate.
//
// Before SEC-4 the inline `debugRouteGuard` in `index.ts` only hid
// debug routes in production. When `NODE_ENV` was anything else (dev,
// test, missing) the routes were available without any header — a
// fresh `GREENHAVEN_DEBUG_KEY=` checkout exposed `/api/debug/*` and
// `/api/db/tables` to anyone who could reach the local port. That
// shape conflicts with the loopback guard story (DEEP-16) because
// any DNS-rebinding bypass or local-malware probe could read the
// debug surface without a credential.
//
// The new contract, regardless of `NODE_ENV`:
//
//   - `GREENHAVEN_DEBUG_ROUTES` off (default) →
//       `404 {error: 'not_found'}`. The routes are completely
//       invisible.
//   - `GREENHAVEN_DEBUG_ROUTES=1`, `GREENHAVEN_DEBUG_KEY` unset or
//       empty → `403 {error: 'forbidden'}`. Enabling debug surface
//       without a credential is treated as misconfiguration.
//   - `GREENHAVEN_DEBUG_ROUTES=1`, `GREENHAVEN_DEBUG_KEY=<v>` and
//       missing or mismatched `x-debug-key` →
//       `403 {error: 'forbidden'}`.
//   - `GREENHAVEN_DEBUG_ROUTES=1`, key configured, and the inbound
//       `x-debug-key` exactly matches → handler runs.
//
// The body strings (`not_found`, `forbidden`) and status codes are
// load-bearing — the previous inline guard used the same shapes, so
// existing operator-doc snippets and the debug-route smoke tests
// keep matching the wire output.

import type {MiddlewareHandler} from 'hono';
import {config} from '../config.js';

export interface DebugRouteGuardConfig {
  /** True when `GREENHAVEN_DEBUG_ROUTES` is set. */
  debugRoutesEnabled: boolean;
  /** The shared secret to compare against the `x-debug-key` header. */
  debugKey: string | null;
}

export type DebugAccessOutcome = 'not_found' | 'forbidden' | 'ok';

/**
 * Pure decision helper for the gate. Exposed so unit tests can pin
 * the contract without spinning up a Hono request — the middleware
 * below is a thin wrapper that maps each outcome to the right
 * response shape.
 */
export function evaluateDebugAccess(input: {
  enabled: boolean;
  expectedKey: string | null;
  providedKey: string | undefined;
}): DebugAccessOutcome {
  if (!input.enabled) return 'not_found';
  const expected = input.expectedKey;
  if (!expected) return 'forbidden';
  if (input.providedKey !== expected) return 'forbidden';
  return 'ok';
}

const defaultConfigProvider = (): DebugRouteGuardConfig => {
  const c = config();
  return {
    debugRoutesEnabled: c.debugRoutesEnabled,
    debugKey: c.debugKey,
  };
};

/**
 * Hono middleware factory. Tests pass a `configProvider` returning
 * a frozen `{debugRoutesEnabled, debugKey}` snapshot so the cached
 * global config does not have to be mutated between cases.
 */
export function createDebugRouteGuardMiddleware(
  configProvider: () => DebugRouteGuardConfig = defaultConfigProvider,
): MiddlewareHandler {
  return async (c, next) => {
    const conf = configProvider();
    const outcome = evaluateDebugAccess({
      enabled: conf.debugRoutesEnabled,
      expectedKey: conf.debugKey,
      providedKey: c.req.header('x-debug-key'),
    });
    if (outcome === 'not_found') {
      return c.json({error: 'not_found'}, 404);
    }
    if (outcome === 'forbidden') {
      return c.json({error: 'forbidden'}, 403);
    }
    await next();
  };
}
