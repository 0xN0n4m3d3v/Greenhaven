/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-1 — read-only cartridge library routes.
//
//   GET /api/cartridges          — installed-cartridge list
//   GET /api/cartridges/:id      — detail view (manifest, scoped
//                                  meta key list, recent imports)
//   GET /api/heroes              — created-hero list with per-
//                                  cartridge state summaries
//   GET /api/playthroughs        — flat per-(hero, cartridge) rows
//
// This slice is intentionally read-only. Import preview/apply,
// hero create/clone, and playthrough preview/launch belong to
// FEAT-CART-LIB-2/3/4. Mutation routes are added in those slices.
//
// No `ownsPlayer` middleware here: the local-only Greenhaven
// install has a single operator, and the library view is the
// authority on "who can play this hero in this world" — it must
// be readable before a player has picked one. SEC-1 ownership
// stays on the per-player gameplay routes (`/api/player/:id/*`).

import {Hono, type Context} from 'hono';
import {readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {authenticatedPlayerId, issueCookie} from '../middleware/auth.js';
import {createAnonymousPlayer} from '../playerService.js';
import {CartridgeLibraryService} from '../services/CartridgeLibraryService.js';
import {
  CartridgeImportPreviewService,
  type CreateImportJobOptions,
  type ImportJobMode,
  type ImportSourceKind,
} from '../services/CartridgeImportPreviewService.js';
import {
  ApplyServiceError,
  CartridgeImportApplyService,
} from '../services/CartridgeImportApplyService.js';
import {
  CartridgePlaythroughService,
  PlaythroughServiceError,
} from '../services/CartridgePlaythroughService.js';

export const cartridgeLibraryRoutes = new Hono();

const VALID_SOURCE_KINDS: ReadonlySet<ImportSourceKind> = new Set([
  'obsidian_vault',
  'forge_project',
  'agent_pack',
]);
const VALID_MODES: ReadonlySet<ImportJobMode> = new Set([
  'install',
  'reimport',
  'repair',
  'dry_run',
]);
const MAX_FILESYSTEM_BROWSER_ENTRIES = 400;

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function directoryHints(target: string): Promise<{
  obsidianVault: boolean;
  forgeProject: boolean;
  agentManual: boolean;
}> {
  const [obsidianDir, manifest, locationsDir, forgeManifest, agentManual] =
    await Promise.all([
      pathExists(path.join(target, '.obsidian')),
      pathExists(path.join(target, 'WORLD_MANIFEST.md')),
      pathExists(path.join(target, 'Locations')),
      pathExists(path.join(target, 'forge.project.json')),
      pathExists(path.join(target, '.greenhaven-agent-manual')),
    ]);
  return {
    obsidianVault: obsidianDir || manifest || locationsDir || agentManual,
    forgeProject: forgeManifest,
    agentManual,
  };
}

function defaultBrowsePath(): string {
  const worldRoot = process.env['GREENHAVEN_WORLD_ROOT'];
  if (worldRoot && worldRoot.trim().length > 0) return path.resolve(worldRoot);
  return process.cwd();
}

function parentPathOf(target: string): string | null {
  const parsed = path.parse(target);
  const parent = path.dirname(target);
  if (parent === target || target === parsed.root) return null;
  return parent;
}

function isLocalDatabaseUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /PGlite failed to initialize|database.*failed|pgdata|Aborted\(\)/i.test(
    message,
  );
}

function localDatabaseUnavailableBody(): {error: string; message: string} {
  return {
    error: 'local_database_unavailable',
    message:
      'Local game database is unavailable. Restart the backend with a clean local database and try again.',
  };
}

cartridgeLibraryRoutes.get('/cartridges', async (c) => {
  const entries = await CartridgeLibraryService.listCartridges();
  return c.json({cartridges: entries});
});

// FEAT-ENGINE-BASELINE-6 — first-run / boot-time library status. The
// GUI calls this BEFORE bootstrapping a player so it can decide
// whether to launch gameplay or strongly route into Worlds & Heroes
// (and surface a one-click import for the default generated Forge
// project). Read-only; no player identity required.
cartridgeLibraryRoutes.get('/cartridges/library/status', async (c) => {
  try {
    const status = await CartridgeLibraryService.getLibraryStatus();
    return c.json(status);
  } catch (err) {
    if (isLocalDatabaseUnavailable(err)) {
      return c.json(localDatabaseUnavailableBody(), 503);
    }
    throw err;
  }
});

// Local operator convenience for the Worlds & Heroes import wizard. Browsers
// cannot expose an absolute folder path through <input type=file>, so dev/web
// mode needs a server-side directory browser. It returns directories only.
cartridgeLibraryRoutes.get('/filesystem/directories', async (c) => {
  const requested = c.req.query('path');
  const target = path.resolve(
    requested && requested.trim().length > 0 ? requested : defaultBrowsePath(),
  );
  let info;
  try {
    info = await stat(target);
  } catch (err) {
    return c.json(
      {
        error: 'invalid_path',
        message: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }
  if (!info.isDirectory()) {
    return c.json(
      {error: 'not_a_directory', message: 'path must point to a directory'},
      400,
    );
  }

  let dirents;
  try {
    dirents = await readdir(target, {withFileTypes: true});
  } catch (err) {
    return c.json(
      {
        error: 'directory_unreadable',
        message: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }

  const directories = dirents
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
  const visible = directories.slice(0, MAX_FILESYSTEM_BROWSER_ENTRIES);
  const entries = await Promise.all(
    visible.map(async (entry) => {
      const fullPath = path.join(target, entry.name);
      return {
        name: entry.name,
        path: fullPath,
        ...(await directoryHints(fullPath)),
      };
    }),
  );

  return c.json({
    currentPath: target,
    parentPath: parentPathOf(target),
    truncated: directories.length > visible.length,
    entries,
    ...(await directoryHints(target)),
  });
});

cartridgeLibraryRoutes.get('/cartridges/:id', async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 256) {
    return c.json({error: 'invalid cartridge id'}, 400);
  }
  const detail = await CartridgeLibraryService.getCartridge(id);
  if (!detail) return c.json({error: 'unknown_cartridge'}, 404);
  return c.json(detail);
});

cartridgeLibraryRoutes.post('/cartridges/:id/reset', async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 256) {
    return c.json({error: 'invalid_cartridge_id'}, 400);
  }
  const result = await CartridgeLibraryService.resetCartridge(id);
  if (!result) return c.json({error: 'unknown_cartridge'}, 404);
  return c.json({
    ...result,
    clearClientCache: {
      keys: ['greenhaven.sessionId'],
    },
  });
});

cartridgeLibraryRoutes.delete('/cartridges/:id', async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 256) {
    return c.json({error: 'invalid_cartridge_id'}, 400);
  }
  const result = await CartridgeLibraryService.deleteCartridge(id);
  if (!result) return c.json({error: 'unknown_cartridge'}, 404);
  return c.json({
    ...result,
    clearClientCache: {
      keys: ['greenhaven.sessionId'],
    },
  });
});

cartridgeLibraryRoutes.get('/heroes', async (c) => {
  const heroes = await CartridgeLibraryService.listHeroes();
  return c.json({heroes});
});

// FEAT-CART-LIB-5 — Worlds & Heroes "Create Hero" entry point. Mints
// a fresh anonymous player, issues a fresh auth cookie, and returns
// the player payload plus the same `clearClientCache` hint shape the
// playthrough launch contract uses so the bridge can clear stale
// session keys + reset the bootstrap memo. Never deletes or
// overwrites any existing hero — `createAnonymousPlayer` inserts a
// new (entity, player) row.
cartridgeLibraryRoutes.post('/heroes', async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    /* empty body is fine — display name is optional */
  }
  const displayNameRaw =
    (body as {displayName?: unknown; display_name?: unknown}).displayName ??
    (body as {displayName?: unknown; display_name?: unknown}).display_name;
  const displayName =
    typeof displayNameRaw === 'string' && displayNameRaw.trim().length > 0
      ? displayNameRaw.trim()
      : undefined;
  try {
    const player = await createAnonymousPlayer(displayName);
    await issueCookie(c, player.entity_id);
    return c.json({
      player,
      clearClientCache: {
        keys: ['greenhaven.sessionId', 'greenhaven.playerPublicId'],
        playerPublicId: player.public_id,
      },
    });
  } catch (err) {
    const dbUnavailable = isLocalDatabaseUnavailable(err);
    return c.json(
      {
        error: dbUnavailable
          ? 'local_database_unavailable'
          : 'create_hero_failed',
        message: dbUnavailable
          ? localDatabaseUnavailableBody().message
          : 'Could not create hero.',
      },
      dbUnavailable ? 503 : 400,
    );
  }
});

cartridgeLibraryRoutes.delete('/heroes/:id', async (c) => {
  const raw = c.req.param('id');
  const playerId = Number(raw);
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return c.json({error: 'invalid_player_id'}, 400);
  }
  const result = await CartridgeLibraryService.deleteHero(playerId);
  if (!result) return c.json({error: 'unknown_player'}, 404);
  return c.json({
    ...result,
    clearClientCache: {
      keys: ['greenhaven.sessionId', 'greenhaven.playerPublicId'],
    },
  });
});

cartridgeLibraryRoutes.get('/playthroughs', async (c) => {
  const playthroughs = await CartridgeLibraryService.listPlaythroughs();
  return c.json({playthroughs});
});

// ── FEAT-CART-LIB-2 — import-preview jobs ──────────────────────

cartridgeLibraryRoutes.post('/cartridges/import/jobs', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({error: 'invalid_json', message: 'request body must be JSON'}, 400);
  }
  const sourceKindRaw = body['sourceKind'] ?? body['source_kind'];
  const sourcePathRaw = body['sourcePath'] ?? body['source_path'];
  const modeRaw = body['mode'];
  const cartridgeIdRaw = body['cartridgeId'] ?? body['cartridge_id'];
  if (
    typeof sourceKindRaw !== 'string' ||
    !VALID_SOURCE_KINDS.has(sourceKindRaw as ImportSourceKind)
  ) {
    return c.json(
      {
        error: 'invalid_source_kind',
        message: `sourceKind must be one of obsidian_vault | forge_project | agent_pack; got ${JSON.stringify(sourceKindRaw)}`,
      },
      400,
    );
  }
  if (typeof sourcePathRaw !== 'string' || sourcePathRaw.trim() === '') {
    return c.json(
      {
        error: 'invalid_source_path',
        message: 'sourcePath is required and must be a non-empty string',
      },
      400,
    );
  }
  let mode: ImportJobMode | undefined;
  if (modeRaw != null) {
    if (typeof modeRaw !== 'string' || !VALID_MODES.has(modeRaw as ImportJobMode)) {
      return c.json(
        {
          error: 'invalid_mode',
          message: `mode must be one of install | reimport | repair | dry_run`,
        },
        400,
      );
    }
    mode = modeRaw as ImportJobMode;
  }
  const opts: CreateImportJobOptions = {
    sourceKind: sourceKindRaw as ImportSourceKind,
    sourcePath: sourcePathRaw,
    ...(mode ? {mode} : {}),
    ...(typeof cartridgeIdRaw === 'string' ? {cartridgeId: cartridgeIdRaw} : {}),
  };
  try {
    const view = await CartridgeImportPreviewService.createJob(opts);
    return c.json(view, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isLocalDatabaseUnavailable(err)) {
      return c.json(localDatabaseUnavailableBody(), 503);
    }
    const code =
      err instanceof Error && 'code' in err && typeof (err as {code: unknown}).code === 'string'
        ? ((err as {code: string}).code)
        : 'unexpected';
    return c.json({error: code, message}, 400);
  }
});

cartridgeLibraryRoutes.get('/cartridges/import/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  if (!jobId || jobId.length > 64) {
    return c.json({error: 'invalid_job_id'}, 400);
  }
  const view = await CartridgeImportPreviewService.getJob(jobId);
  if (!view) return c.json({error: 'unknown_job'}, 404);
  return c.json(view);
});

cartridgeLibraryRoutes.post(
  '/cartridges/import/jobs/:jobId/cancel',
  async (c) => {
    const jobId = c.req.param('jobId');
    if (!jobId || jobId.length > 64) {
      return c.json({error: 'invalid_job_id'}, 400);
    }
    const view = await CartridgeImportPreviewService.cancelJob(jobId);
    if (!view) return c.json({error: 'unknown_job'}, 404);
    return c.json(view);
  },
);

// ── FEAT-CART-LIB-3 — apply / reimport ────────────────────────

async function readApplyBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readJobIdFromBody(
  body: Record<string, unknown>,
): string | null {
  const v = body['jobId'] ?? body['job_id'];
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null;
}

function readAcceptWarnings(body: Record<string, unknown>): boolean {
  const v = body['acceptWarnings'] ?? body['accept_warnings'];
  return v === true;
}

async function runApply(
  jobId: string,
  acceptWarnings: boolean,
  expectedCartridgeId?: string,
): Promise<{status: number; body: Record<string, unknown>}> {
  try {
    const view = await CartridgeImportApplyService.apply({
      jobId,
      acceptWarnings,
      ...(expectedCartridgeId ? {expectedCartridgeId} : {}),
    });
    return {status: 200, body: view as unknown as Record<string, unknown>};
  } catch (err) {
    if (err instanceof ApplyServiceError) {
      // 404 — preview job genuinely missing.
      // 409 — preflight gate (not ready / mismatch / validation
      //       errors or warnings) so the caller can retry once the
      //       precondition is satisfied.
      // 400 — any other typed shape (input validation, source
      //       drift, etc.).
      const status =
        err.code === 'unknown_job'
          ? 404
          : err.code === 'job_not_ready' ||
              err.code === 'validation_errors' ||
              err.code === 'validation_warnings' ||
              err.code === 'cartridge_id_mismatch'
            ? 409
            : 400;
      return {status, body: {error: err.code, message: err.message}};
    }
    const message = err instanceof Error ? err.message : String(err);
    return {status: 500, body: {error: 'apply_failed', message}};
  }
}

cartridgeLibraryRoutes.post(
  '/cartridges/import/jobs/:jobId/apply',
  async (c) => {
    const jobId = c.req.param('jobId');
    if (!jobId || jobId.length > 64) {
      return c.json({error: 'invalid_job_id'}, 400);
    }
    const body = await readApplyBody(c);
    const {status, body: out} = await runApply(jobId, readAcceptWarnings(body));
    return c.json(out, status as 200 | 400 | 404 | 409 | 500);
  },
);

cartridgeLibraryRoutes.post('/cartridges/import/apply', async (c) => {
  const body = await readApplyBody(c);
  const jobId = readJobIdFromBody(body);
  if (!jobId) {
    return c.json(
      {
        error: 'invalid_job_id',
        message: 'request body must include `jobId` (string ≤ 64 chars)',
      },
      400,
    );
  }
  const {status, body: out} = await runApply(jobId, readAcceptWarnings(body));
  return c.json(out, status as 200 | 400 | 404 | 409 | 500);
});

cartridgeLibraryRoutes.post('/cartridges/:id/reimport/apply', async (c) => {
  const cartridgeId = c.req.param('id');
  if (!cartridgeId || cartridgeId.length > 256) {
    return c.json({error: 'invalid_cartridge_id'}, 400);
  }
  const body = await readApplyBody(c);
  const jobId = readJobIdFromBody(body);
  if (!jobId) {
    return c.json(
      {
        error: 'invalid_job_id',
        message:
          'request body must include `jobId` (reimport reuses the same preview-job pipeline)',
      },
      400,
    );
  }
  // FEAT-CART-LIB-3 corrective: hand the URL cartridge id to the
  // service as `expectedCartridgeId` so a mismatched preview job is
  // rejected BEFORE any write or status flip. Post-commit detection
  // would have already mutated the wrong cartridge.
  const {status, body: out} = await runApply(
    jobId,
    readAcceptWarnings(body),
    cartridgeId,
  );
  return c.json(out, status as 200 | 400 | 404 | 409 | 500);
});

// ── FEAT-CART-LIB-4 — playthrough preview / launch / new-game ──────

interface PlaythroughBody {
  playerId?: unknown;
  player_id?: unknown;
  cartridgeId?: unknown;
  cartridge_id?: unknown;
}

function readPlaythroughBody(
  body: Record<string, unknown>,
): {playerId: number | null; cartridgeId: string | null} {
  const pid =
    (body as PlaythroughBody).playerId ?? (body as PlaythroughBody).player_id;
  const cid =
    (body as PlaythroughBody).cartridgeId ??
    (body as PlaythroughBody).cartridge_id;
  const playerId =
    typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  const cartridgeId =
    typeof cid === 'string' && cid.length > 0 && cid.length <= 256
      ? cid
      : null;
  return {playerId, cartridgeId};
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapPlaythroughError(err: unknown): {
  status: 400 | 404 | 409 | 500;
  body: Record<string, unknown>;
} {
  if (err instanceof PlaythroughServiceError) {
    const status: 400 | 404 | 409 | 500 =
      err.code === 'unknown_player' || err.code === 'unknown_cartridge'
        ? 404
        : err.code === 'repair_required' || err.code === 'no_starting_location'
          ? 409
          : 400;
    return {status, body: {error: err.code, message: err.message}};
  }
  const message = err instanceof Error ? err.message : String(err);
  return {status: 500, body: {error: 'playthrough_failed', message}};
}

cartridgeLibraryRoutes.post('/playthroughs/preview', async (c) => {
  const body = await readJsonBody(c);
  const {playerId, cartridgeId} = readPlaythroughBody(body);
  if (playerId == null) {
    return c.json({error: 'invalid_player_id'}, 400);
  }
  if (cartridgeId == null) {
    return c.json({error: 'invalid_cartridge_id'}, 400);
  }
  try {
    const preview = await CartridgePlaythroughService.preview({
      playerId,
      cartridgeId,
    });
    return c.json(preview);
  } catch (err) {
    const {status, body: out} = mapPlaythroughError(err);
    return c.json(out, status);
  }
});

cartridgeLibraryRoutes.post('/playthroughs/launch', async (c) => {
  const body = await readJsonBody(c);
  const {playerId, cartridgeId} = readPlaythroughBody(body);
  if (playerId == null) {
    return c.json({error: 'invalid_player_id'}, 400);
  }
  if (cartridgeId == null) {
    return c.json({error: 'invalid_cartridge_id'}, 400);
  }
  const cookiePlayerId = await authenticatedPlayerId(c);
  try {
    const result = await CartridgePlaythroughService.launch({
      playerId,
      cartridgeId,
      authenticatedPlayerId: cookiePlayerId,
    });
    // Server is authoritative on hero identity — refresh the auth
    // cookie so the newly-launched hero is what subsequent gameplay
    // requests authenticate as.
    await issueCookie(c, playerId);
    return c.json(result);
  } catch (err) {
    const {status, body: out} = mapPlaythroughError(err);
    return c.json(out, status);
  }
});

cartridgeLibraryRoutes.post('/playthroughs/new-game', async (c) => {
  const body = await readJsonBody(c);
  const {playerId, cartridgeId} = readPlaythroughBody(body);
  if (playerId == null) {
    return c.json({error: 'invalid_player_id'}, 400);
  }
  if (cartridgeId == null) {
    return c.json({error: 'invalid_cartridge_id'}, 400);
  }
  const cookiePlayerId = await authenticatedPlayerId(c);
  try {
    const result = await CartridgePlaythroughService.newGame({
      playerId,
      cartridgeId,
      authenticatedPlayerId: cookiePlayerId,
    });
    await issueCookie(c, playerId);
    return c.json(result);
  } catch (err) {
    const {status, body: out} = mapPlaythroughError(err);
    return c.json(out, status);
  }
});
