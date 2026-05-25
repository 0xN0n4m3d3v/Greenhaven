/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-8 — conditional `globalThis.__greenhavenApp` exposure.
//
// Before SEC-8 `packages/web-server/src/index.ts` unconditionally
// wrote the live Hono app onto `globalThis.__greenhavenApp` at
// module load so the `/api/debug/verify-specialists` smoke matrix
// could resolve a same-process `fetch` handle. That global was
// process-wide and present in every deploy regardless of whether
// the debug surface was enabled — any code path (or accidentally
// loaded test fixture) could pull the entire app out of the
// global and dispatch arbitrary requests through it without
// passing through the loopback / origin / debug-key gates.
//
// The new contract: the global is only installed when the operator
// has explicitly opted into the debug surface AND configured a
// debug key — the same two-flag gate `SEC-4`'s
// `createDebugRouteGuardMiddleware` enforces on the HTTP debug
// routes. When the gate is off (default, dev, test, production
// without `GREENHAVEN_DEBUG_ROUTES`), `installDebugAppGlobal(app)`
// is a no-op AND defensively `clearDebugAppGlobal()` is called to
// drop any stale value a previous test import might have left
// behind. The helpers expose `DEBUG_APP_GLOBAL_KEY` so
// `DebugService.resolveAppFetch` reads from the exact same slot.

import type {Hono} from 'hono';
import {config} from './config.js';

export const DEBUG_APP_GLOBAL_KEY = '__greenhavenApp';

interface DebugAppGlobalConfig {
  debugRoutesEnabled: boolean;
  debugKey: string | null;
}

/**
 * Read just the two SEC-8 flags off `config()` so the helper has
 * a stable, narrow seam for tests to drive (each
 * `installDebugAppGlobal(app, {config: configMock})` call reads a
 * fresh snapshot, mirroring how `SEC-4`'s
 * `createDebugRouteGuardMiddleware` accepts a `configProvider`).
 */
function defaultConfigProvider(): DebugAppGlobalConfig {
  const c = config();
  return {
    debugRoutesEnabled: c.debugRoutesEnabled,
    debugKey: c.debugKey,
  };
}

function debugSurfaceEnabled(cfg: DebugAppGlobalConfig): boolean {
  // Mirror the `SEC-4` enabled-AND-keyed contract exactly. If the
  // surface is enabled but no key is configured, the HTTP guard
  // returns `403 forbidden` and there is no legitimate caller — so
  // the global handle has no audience either.
  return cfg.debugRoutesEnabled && (cfg.debugKey?.length ?? 0) > 0;
}

/**
 * Install the live Hono app on `globalThis.__greenhavenApp` ONLY
 * when the debug surface is enabled + keyed. When the gate is off,
 * unconditionally remove any value already on the slot — covers
 * the test-runtime case where an earlier import set it under
 * different config.
 */
export function installDebugAppGlobal(
  app: Hono,
  opts: {configProvider?: () => DebugAppGlobalConfig} = {},
): void {
  const provider = opts.configProvider ?? defaultConfigProvider;
  const cfg = provider();
  const slot = globalThis as Record<string, unknown>;
  if (debugSurfaceEnabled(cfg)) {
    slot[DEBUG_APP_GLOBAL_KEY] = app;
  } else {
    delete slot[DEBUG_APP_GLOBAL_KEY];
  }
}

/**
 * Remove any in-process app handle from the global slot. Used by
 * tests that want to assert the "not installed" state without
 * relying on `installDebugAppGlobal` being called with an
 * explicit off-state config.
 */
export function clearDebugAppGlobal(): void {
  const slot = globalThis as Record<string, unknown>;
  delete slot[DEBUG_APP_GLOBAL_KEY];
}

/**
 * Read the current global app handle, if any. Returns `undefined`
 * when the surface is gated off. `DebugService.resolveAppFetch`
 * delegates here so the read uses the same key constant the
 * installer wrote against.
 */
export function getDebugAppGlobal(): unknown {
  const slot = globalThis as Record<string, unknown>;
  return slot[DEBUG_APP_GLOBAL_KEY];
}
