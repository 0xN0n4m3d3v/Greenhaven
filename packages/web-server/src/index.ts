/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Web server entry point. Mounts routes, starts Hono on PORT (default 7777).
//
// Architecture:
//   - SessionManager holds ONE session (Config + GeminiClient + Scheduler).
//     Single-user / single-session for now (per design — see docs/cli/INTERNALS.md).
//   - Routes under /api/session/:id/* are thin: they pull session from the
//     manager, dispatch into the runtime objects, and forward results to SSE.
//   - SSE stream lives at /api/session/:id/stream — the canonical channel
//     for everything streamed from the model + scheduler events.
//
// Cwd-as-workspace: process.cwd() at server startup is the workspace root.
// Restarting in a different directory = different workspace.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { closeDb } from './db.js';
import { loadMechanicI18n } from './mechanicI18n.js';
import { runMigrations } from './migrate.js';
import { characterRoutes } from './routes/character.js';
import { characterStateRoutes } from './routes/characterState.js';
import { adventureRoutes } from './routes/adventures.js';
import { audioRoutes } from './routes/audio.js';
import { visualAssetRoutes } from './routes/visualAssets.js';

import { examinerRoutes } from './routes/examiner.js';
import { debugDiagnosticsRoutes } from './routes/debugDiagnostics.js';
import { mechanicI18nRoutes } from './routes/mechanicI18nRoute.js';
import { cartridgeLibraryRoutes } from './routes/cartridges.js';
import { noticeRoutes } from './routes/notices.js';
import { playerRoutes } from './routes/player.js';
import { profileRoutes } from './routes/profile.js';
import { questRoutes } from './routes/quests.js';
import { quotesRoutes } from './routes/quotes.js';
import { savesRoutes } from './routes/saves.js';
import { sessionBargainRoutes } from './routes/sessionBargain.js';
import { sessionRoutes } from './routes/session.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { recoverAbandonedMaterializingAdventures } from './domain/adventure/index.js';
import {
  ensureDefaultCartridgeInstalled,
  relocateDefaultCartridgeInstall,
} from './services/DefaultCartridgeBootstrapService.js';
import { recoverAbandonedRunningTurns } from './turnIngressQueue.js';
import { installGameplayProcessLoggers } from './gameplayLog.js';
import { installDebugAppGlobal } from './debugAppGlobal.js';
import { errorResponse } from './httpErrors.js';
import { requireAuth } from './middleware/auth.js';
import { createDebugRouteGuardMiddleware } from './middleware/debugRouteGuard.js';
import { createHttpTelemetryMiddleware } from './middleware/httpTelemetry.js';
import { createLoopbackGuardMiddleware } from './middleware/loopbackGuard.js';
import { ownsPlayer } from './middleware/ownsPlayer.js';
import { rateLimitStateChanges } from './middleware/rateLimit.js';
import { telemetry } from './telemetry/index.js';
// Side-effect import — registers all tools into the central registry.
import './tools/index.js';

const PORT = config().port;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_UI_DIST = path.resolve(
  __dirname,
  '..',
  '..',
  'web-ui',
  'dist',
);

installGameplayProcessLoggers();

const app = new Hono();
// SEC-8 — only expose the live Hono app on
// `globalThis.__greenhavenApp` when the operator has explicitly
// opted into the debug surface AND configured a debug key (same
// two-flag gate `SEC-4`'s `createDebugRouteGuardMiddleware`
// enforces on the HTTP debug routes). Default / dev / test /
// production-without-debug deploys leave the global slot
// undefined so no caller can pull the entire app out of process
// state and dispatch arbitrary requests without passing through
// the loopback / origin / debug-key gates.
installDebugAppGlobal(app);

// SEC-3 / DEEP-7 — generic global error handler. The body never
// carries `err.message`, `String(err)`, or stack-derived text; the
// client gets `{error: 'internal_error', correlation_id: <uuid>}`
// and operators correlate via the gameplay-channel `http.error`
// telemetry event (which still carries the original error +
// method/path/status/code for triage).
app.onError((err, c) =>
  errorResponse(c, 500, 'internal_error', {internal: err}),
);

// DEEP-16 — loopback Host/Origin guard. Mounted first so a
// DNS-rebinding or misrouted public-internet request is rejected
// (421 / 403) before route handlers, static serving, debug routes,
// or HTTP telemetry see it. The backend always listens on
// 127.0.0.1; anything claiming a different Host header is hostile
// or misconfigured.
app.use('*', createLoopbackGuardMiddleware());

// ARCH-15 — request-vs-SSE telemetry split lives in
// `middleware/httpTelemetry.ts`. Normal requests still record
// `http.request` / `http.request.error`; SSE long-poll connections
// record `sse.opened` + `sse.closed` so their multi-minute durations
// no longer skew normal HTTP latency dashboards.
app.use('*', createHttpTelemetryMiddleware(telemetry));

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function safeStaticPath(root: string, requestPath: string): string | null {
  const normalizedRoot = path.resolve(root);
  const decodedPath = decodeURIComponent(requestPath.split('?')[0] ?? '/');
  const relativePath =
    decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const resolved = path.resolve(normalizedRoot, relativePath);
  const rootKey = normalizedRoot.toLowerCase();
  const resolvedKey = resolved.toLowerCase();
  if (
    resolvedKey !== rootKey &&
    !resolvedKey.startsWith(`${rootKey}${path.sep}`)
  ) {
    return null;
  }
  return resolved;
}

let mountedStaticDir: string | null = null;

function mountWebUiStatic(staticDir: string | null | undefined): void {
  if (!staticDir || mountedStaticDir) return;
  mountedStaticDir = path.resolve(staticDir);
  app.get('*', async (c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      return c.notFound();
    }
    const filePath = safeStaticPath(mountedStaticDir!, c.req.path);
    if (!filePath) return c.notFound();
    let finalPath = filePath;
    try {
      const info = await stat(finalPath);
      if (info.isDirectory()) {
        finalPath = path.join(finalPath, 'index.html');
      }
      const data = await readFile(finalPath);
      return new Response(data, {
        headers: { 'content-type': contentTypeFor(finalPath) },
      });
    } catch {
      const indexPath = path.join(mountedStaticDir!, 'index.html');
      try {
        const data = await readFile(indexPath);
        return new Response(data, {
          headers: { 'content-type': contentTypeFor(indexPath) },
        });
      } catch {
        return c.notFound();
      }
    }
  });
}

// SEC-4 — debug-route gate. The previous inline guard only hid
// debug routes in production; in dev / test / unset NODE_ENV the
// routes were available without any header when
// `GREENHAVEN_DEBUG_KEY` was missing. The middleware below now
// enforces the same contract regardless of env: disabled routes
// return 404, enabled-without-key returns 403, enabled-with-key
// requires an exact `x-debug-key` match. See
// `src/middleware/debugRouteGuard.ts` for the helper +
// `src/__tests__/middleware/debugRouteGuard.test.ts` for the
// pinned contract.
const debugRouteGuard = createDebugRouteGuardMiddleware();

app.use('/api/debug/*', debugRouteGuard);
app.use('/api/db/tables', debugRouteGuard);

// Health check — used by web-ui to detect "is the bridge up?" before the
// proper session handshake.
import { healthRoutes } from './routes/health.js';
import { worldRoutes } from './routes/world.js';
import { debugRoutes } from './routes/debug.js';
import { inventoryRoutes } from './routes/inventory.js';

app.route('/api', healthRoutes);
app.route('/api', worldRoutes);
app.route('/api', debugRoutes);

// Debug diagnostics, telemetry reports, and local admin usage reports.
app.route('/api', debugDiagnosticsRoutes);

// SEC-1 / SEC-2 / DEEP-4 / DEEP-5 / DEEP-6 — central player ownership
// guards. Each affected URL pattern is matched here BEFORE the
// corresponding `app.route(...)` mount below, so the guard runs on
// every method (GET/POST/PATCH/DELETE) the routers attach to that
// shape. The matched patterns intentionally stay exact: a wildcard
// like `/api/character/:id/*` would treat `sheet` in
// `/api/character/sheet/synthesize` as the player id and 403 every
// caller, so the `/:id/stats` and `/:id/skills` lines below are
// pinned literals. Public bootstrap surfaces (`/anonymous`,
// `/restore`, `/me`, `/character/meta|classes|origins|persons`,
// `/character/roll-stats`) are NOT matched here and remain
// unauthenticated by design.
app.use('/api/player/:id/profile', ownsPlayer());
app.use('/api/player/:id/strings/graph', ownsPlayer());
app.use('/api/player/:id/quests', ownsPlayer());
app.use('/api/player/:id/quest-dashboard', ownsPlayer());
app.use('/api/player/:id/notices', ownsPlayer());
app.use('/api/player/:id/character-state', ownsPlayer());
app.use('/api/player/:id/character-state/*', ownsPlayer());
app.use('/api/player/:id/adventures', ownsPlayer());
app.use('/api/player/:id/adventures/*', ownsPlayer());
app.use('/api/player/:id/saves', ownsPlayer());
app.use('/api/player/:id/saves/*', ownsPlayer());
app.use('/api/player/:id/inventory', ownsPlayer());
app.use('/api/player/:id/inventory/*', ownsPlayer());
app.use('/api/character/:id/stats', ownsPlayer());
app.use('/api/character/:id/skills', ownsPlayer());

// LLM-costing character-assist endpoints. These don't have a
// player id in the URL, so the gate is just "must be authed" —
// no ownership comparison — which closes the historical
// unauthenticated cost surface (anyone with the URL could spend
// our broker / examiner model budget).
app.use('/api/character/suggest-appearance', requireAuth);
app.use('/api/character/suggest-background', requireAuth);
app.use('/api/character/polish-description', requireAuth);
app.use('/api/character/polish-history', requireAuth);
app.use('/api/character/suggest-skills', requireAuth);
app.use('/api/character/parse-freeform', requireAuth);
app.use('/api/character/sheet/synthesize', requireAuth);

// SEC-5 — per-player 30/min ceiling on state-changing endpoints.
// Mounted AFTER the SEC-1 ownership / auth guards above so that an
// unauthenticated request still gets 401 (auth-shaped), a wrong-
// player request still gets 403 (ownership-shaped), and an
// invalid-id request still gets 400 — only an authed-but-spammy
// caller sees 429. Specialized limiters that already cover their
// surface are NOT shadowed here:
//   * `/api/session/:id/turn` keeps `rateLimitTurns()` (10 burst,
//     30/min in `session.ts`); SEC-5 sits one layer down at the
//     session router so both apply.
//   * `/api/session/:id/stream` keeps `rateLimitSse()` (GET, so
//     SEC-5 passes through by method anyway).
//   * `/api/player/anonymous` keeps `rateLimitAnonymousPlayer()`;
//     SEC-5 not mounted on that path.
//   * `/api/player/restore` keeps `rateLimitRecoveryRestore()`;
//     SEC-5 not mounted on that path.
//   * `/api/telemetry/{frontend,desktop}` keep their per-source
//     `rateLimitTelemetryIngest()` policies; SEC-5 not mounted.
//   * `/api/debug/*`, `/api/db/tables`, `/api/admin/usage` are
//     covered by the SEC-4 debug-route key gate + admin-key flow.
//     Documenting these as an intentional SEC-5 exclusion: they
//     are reachable only by operators with credentials, and the
//     existing diagnostic-noise budget is incompatible with a
//     30/min cap.
app.use('/api/player/:id/profile', rateLimitStateChanges());
app.use('/api/player/:id/saves', rateLimitStateChanges());
app.use('/api/player/:id/saves/*', rateLimitStateChanges());
app.use('/api/player/:id/adventures', rateLimitStateChanges());
app.use('/api/player/:id/adventures/*', rateLimitStateChanges());
app.use('/api/player/:id/inventory/*', rateLimitStateChanges());
app.use('/api/player/:id/character-state/*', rateLimitStateChanges());
app.use('/api/character/:id/stats', rateLimitStateChanges());
app.use('/api/character/:id/skills', rateLimitStateChanges());

app.use('/api/character/suggest-appearance', rateLimitStateChanges());
app.use('/api/character/suggest-background', rateLimitStateChanges());
app.use('/api/character/polish-description', rateLimitStateChanges());
app.use('/api/character/polish-history', rateLimitStateChanges());
app.use('/api/character/suggest-skills', rateLimitStateChanges());
app.use('/api/character/parse-freeform', rateLimitStateChanges());
app.use('/api/character/sheet/synthesize', rateLimitStateChanges());

// `/api/player/reset-local-game` is also covered by SEC-5, but its
// limiter is chained INSIDE `routes/player.ts` after the route-local
// auth gate. An app-level mount here would run before the handler's
// auth decision and let an unauthenticated attacker exhaust the
// per-source bucket, returning 429 from the 31st probe instead of
// the 401 the auth check would emit. See `playerRoutes.post(
// '/reset-local-game', requireResetAuth, rateLimitStateChanges(),
// ...)` for the corrected ordering.

// Player identity (anonymous + recovery flow).
app.route('/api/player', playerRoutes);

// Spec 23 — quest log endpoint (per-player active/completed/failed).
app.route('/api/player', questRoutes);
app.route('/api/player', adventureRoutes);

// Spec 36 §4 — save slots (GET / POST / restore / delete).
app.route('/api/player', savesRoutes);

// FEAT-INV-1 — GET /api/player/:id/inventory (read-only snapshot).
app.route('/api/player', inventoryRoutes);

// FEAT-NOTICE-1 — GET /api/player/:id/notices durable Notice Journal.
app.route('/api/player', noticeRoutes);

// FEAT-STATE-1 — GET /api/player/:id/character-state typed sheet.
app.route('/api/player', characterStateRoutes);

// Spec 37 §3 — ambient bed config lookup (client useAmbientBed hook).
app.route('/api/audio', audioRoutes);

// OWV-17 — visual-asset serving route. Resolves authored bridge
// rows (`forge_visual_assets`) to safe filesystem paths under
// configured vault roots and streams the image bytes. Refuses
// traversal / unknown rows / unsupported extensions with non-500
// responses.
app.route('/api/assets', visualAssetRoutes);

// Spec 37 §8 — Pillars-style mid-load quote pool.
app.route('/api', quotesRoutes);

// Spec 36 §1 carried-over — mechanic-vocabulary i18n lookup.
app.route('/api/i18n', mechanicI18nRoutes);

// Spec 26 — player profile GET/PATCH (under /api/player/:id/profile)
// AND AI-assist character endpoints (under /api/character/*). Mounting
// the same router on two prefixes keeps the URL surface tidy.
app.route('/api/player', profileRoutes);
app.route('/api', profileRoutes);

// Spec 27 — character meta + stats/skills endpoints used by the
// wizard. /api/character/meta, /classes, /roll-stats, /:id/stats,
// /:id/skills.
app.route('/api/character', characterRoutes);

// Spec 99 — sheet-based character creator synthesis endpoint
// (/api/character/sheet/synthesize). Takes the player-authored
// name/description/history sheet and returns the full character card.
app.route('/api', examinerRoutes);

// FEAT-CART-LIB-1 — read-only cartridge library + hero + play-
// through surfaces backing the Worlds & Heroes GUI. Mutation
// (import preview/apply, reimport, launch) lands in FEAT-CART-
// LIB-2 onward; this slice only exposes registry/hero summaries.
app.route('/api', cartridgeLibraryRoutes);

// Session lifecycle, turns, SSE, confirmations, cancel.
app.route('/api/session', sessionRoutes);
app.route('/api/telemetry', telemetryRoutes);

// Spec 19 — Devil's Bargain accept/reject route group, mounted on the
// same /api/session path so the cookie auth + per-session id resolution
// flow identically to the rest of the session-scoped routes.
app.route('/api/session', sessionBargainRoutes);

async function runStartupTasks(): Promise<void> {
  // Try to apply migrations at boot. We DON'T crash if Postgres is
  // unreachable — the server still serves /api/health and the UI can
  // surface a "DB offline" badge. Database-backed routes will return
  // 503 / error responses instead of taking down the whole process.
  try {
    const { applied, skipped } = await runMigrations();
    if (applied.length > 0) {
      console.log(`[gemini-web] applied migrations: ${applied.join(', ')}`);
    }
    if (skipped.length > 0) {
      console.log(
        `[gemini-web] migrations already in place: ${skipped.length}`,
      );
    }
    try {
      const relocated = await relocateDefaultCartridgeInstall();
      if (relocated.rowsTouched > 0) {
        console.log(
          `[gemini-web] relocated default cartridge ${relocated.cartridgeId} to ${relocated.forgeProject} (${relocated.rowsTouched} row(s))`,
        );
      }
    } catch (err) {
      // CATCH-WARN-OK: a stale source-path repair should not block
      // boot. The runtime can still use the installed cartridge cache,
      // and manual import/repair remains available in Worlds & Heroes.
      console.warn(
        `[gemini-web] default cartridge relocation failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      const defaultCartridge = await ensureDefaultCartridgeInstalled();
      if (defaultCartridge.status === 'installed') {
        console.log(
          `[gemini-web] installed default cartridge ${defaultCartridge.cartridgeId} from ${defaultCartridge.forgeProject}`,
        );
      } else if (defaultCartridge.status === 'updated') {
        console.log(
          `[gemini-web] updated default cartridge ${defaultCartridge.cartridgeId} from ${defaultCartridge.forgeProject}`,
        );
      } else if (defaultCartridge.status === 'unavailable') {
        console.warn(
          `[gemini-web] default cartridge unavailable at ${defaultCartridge.forgeProject}`,
        );
      }
    } catch (err) {
      // CATCH-WARN-OK: the default cartridge is a boot convenience,
      // not the database schema. Worlds & Heroes still lets the
      // operator import/repair manually when this path fails.
      console.warn(
        `[gemini-web] default cartridge bootstrap failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
    const recoveredTurns = await recoverAbandonedRunningTurns({
      reason: 'turn abandoned: server restarted',
    });
    if (recoveredTurns > 0) {
      console.warn(
        `[gemini-web] recovered abandoned running turns: ${recoveredTurns}`,
      );
    }
    const recoveredAdventures = await recoverAbandonedMaterializingAdventures({
      reason: 'adventure materializer abandoned: server restarted',
      olderThanMs: 30_000,
    });
    if (recoveredAdventures > 0) {
      console.warn(
        `[gemini-web] recovered abandoned materializing adventures: ${recoveredAdventures}`,
      );
    }
    // Cartridge translations now ship via SQL migrations (0023+0024+0025).
    // The JS seeder that used to run here is gone — DB is the source of truth.
    //
    // Spec 36 §1 — load mechanical-vocabulary translations into the
    // in-memory cache. Requires migration 0040 to have applied.
    try {
      await loadMechanicI18n();
    } catch (err) {
      // CATCH-WARN-OK: bootstrap-time DB read for cartridge mechanical-vocabulary cache. Runs during server startup before the telemetry facade's downstream sinks (`performance_events` / gameplay log file) are guaranteed to be writable; recording a `telemetry.record(...)` event here during a startup-DB-unreachable scenario could itself fail or deadlock the same boot pipeline. Non-fatal — the mechanic-i18n cache remains empty and falls back to canonical English at read time.
      console.warn(
        `[gemini-web] mechanic-i18n load failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
  } catch (err) {
    // CATCH-WARN-OK: outermost bootstrap-time `runMigrations()` catch. By definition the DB itself is unreachable here (that's the only failure mode the comment names); any `telemetry.record(...)` call would re-attempt the same broken DB write and surface a second confusing error. Operator visibility via stderr is the only useful signal during a boot-time DB-unreachable scenario.
    console.warn(
      `[gemini-web] migrations skipped — db unreachable? ${err instanceof Error ? err.message : err}`,
    );
  }
}

export interface StartGreenhavenServerOptions {
  port?: number;
  hostname?: string;
  staticDir?: string | null;
}

export type StartedGreenhavenServer = ReturnType<typeof serve> & {
  hostname: string;
  port: number;
  url: string;
};

export async function startGreenhavenServer(
  options: StartGreenhavenServerOptions = {},
): Promise<StartedGreenhavenServer> {
  const staticDir =
    options.staticDir ??
    config().webUiDist ??
    (config().nodeEnv === 'production' ? DEFAULT_WEB_UI_DIST : null);
  mountWebUiStatic(staticDir);
  await runStartupTasks();
  const hostname = options.hostname ?? '127.0.0.1';
  const port = typeof options.port === 'number' ? options.port : PORT;

  let server: ReturnType<typeof serve> | null = null;
  return await new Promise<StartedGreenhavenServer>((resolve) => {
    server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      const started = server as StartedGreenhavenServer;
      started.hostname = info.address;
      started.port = info.port;
      started.url = `http://${info.address}:${info.port}`;
      console.log(`[gemini-web] listening on ${started.url}`);
      console.log(`[gemini-web] workspace: ${process.cwd()}`);
      resolve(started);
    });
  });
}

export async function stopGreenhavenServer(
  server: StartedGreenhavenServer,
): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // Drain any pending fire-and-forget `telemetry.record(...)` writes
  // (e.g. the N-2 gameplay-mirror branch) before the DB connection
  // closes. Without this drain, packaged desktop shutdowns can lose
  // the last narrate-sanitiser inspected/fired rows because the
  // telemetry facade never awaits its dispatch promises at the
  // caller's edge.
  try {
    await telemetry.flush();
  } catch (err) {
    // CATCH-WARN-OK: surface flush failure without blocking shutdown.
    console.warn(
      '[gemini-web] telemetry.flush during shutdown failed:',
      err instanceof Error ? err.message : err,
    );
  }
  await closeDb();
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  const server = await startGreenhavenServer();
  // Graceful shutdown — give SSE clients a chance to close cleanly.
  const shutdown = (signal: string) => {
    console.log(`[gemini-web] received ${signal}, shutting down`);
    void stopGreenhavenServer(server).then(
      () => process.exit(0),
      () => process.exit(1),
    );
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
