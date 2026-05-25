/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Hono, type MiddlewareHandler } from 'hono';
import {
  authenticatedPlayerId,
  clearAuthCookie,
  issueCookie,
  requireAuth,
} from '../middleware/auth.js';
import {errorResponse} from '../httpErrors.js';
import {
  rateLimitAnonymousPlayer,
  rateLimitRecoveryRestore,
  rateLimitStateChanges,
} from '../middleware/rateLimit.js';
import {
  createAnonymousPlayer,
  findByPublicId,
  findLatestLocalPlayer,
  restoreByRecoveryCode,
} from '../playerService.js';
import { config } from '../config.js';
import { resetWorldState } from '../resetWorld.js';
import {PlayerIntroService} from '../services/PlayerIntroService.js';
import {PlayerStringsService} from '../services/PlayerStringsService.js';
import { getPlayerCurrencyCount } from '../tools/inventoryCommon.js';

export const playerRoutes = new Hono();

// POST /api/player/anonymous — fresh signup.
// Body (optional): { displayName: string }.
// Response: full player snapshot + recovery_code (shown once, never returned again).
// Side effect: sets the gh_player auth cookie so subsequent session
// routes can resolve the player without trusting body input.
// DEEP-3 — rate-limited to 5 accepted signups per 15 minutes per
// source IP on non-desktop builds. Desktop bypasses (the renderer
// is loopback-only; first-launch must never hit a 429).
playerRoutes.post('/anonymous', rateLimitAnonymousPlayer(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const displayName = (body as { displayName?: string }).displayName;
  if (
    config().isDesktop &&
    (typeof displayName !== 'string' || displayName.trim().length === 0)
  ) {
    const existing = await findLatestLocalPlayer({ preferCreated: true });
    if (existing) {
      await issueCookie(c, existing.entity_id);
      return c.json(existing);
    }
  }
  const player = await createAnonymousPlayer(displayName);
  await issueCookie(c, player.entity_id);
  return c.json(player);
});

// POST /api/player/restore — recover account by code.
// Body: { recovery_code: string }.
// Side effect: re-issues the gh_player auth cookie on success.
// DEEP-2 — rate-limited to 5 attempts per 15 minutes per source IP on
// non-desktop builds. Desktop bypasses (loopback-only caller).
playerRoutes.post('/restore', rateLimitRecoveryRestore(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = (body as { recovery_code?: string }).recovery_code;
  if (!code || typeof code !== 'string') {
    return c.json({ error: 'recovery_code required' }, 400);
  }
  const player = await restoreByRecoveryCode(code);
  if (!player) return c.json({ error: 'invalid_recovery_code' }, 401);
  await issueCookie(c, player.entity_id);
  return c.json(player);
});

// GET /api/player/me?id=<public_id> — snapshot for the UI's HUD.
// GET /api/player/currency - current currency count for the authenticated player.
// POST /api/player/reset-local-game - desktop/offline "new game" reset.
//
// Stronger than session reset: removes players, sessions, chat/tool/gui
// history, dynamic runtime entities, overlays, saves, and progression, then
// clears the auth cookie. The client must clear local storage and reload so
// next boot creates a fresh anonymous player and opens the character creator.
//
// Auth contract:
//   * Desktop (`config().isDesktop`) — no cookie required; the local
//     renderer is the only legitimate caller.
//   * `AUTH_DISABLED=1` — bypassed (dev/test escape hatch; SEC-7 /
//     DEEP-14 makes the combo fatal in production).
//   * Otherwise — a valid auth cookie is required; the route emits
//     `401 {error:'unauthenticated'}` for missing cookies.
//
// SEC-5 follow-up — the auth gate runs as a route-local middleware
// BEFORE `rateLimitStateChanges()` so an unauthenticated probe
// always emits 401, no matter how many times it is repeated from
// the same source. The previous app-level mount in `index.ts` ran
// the limiter first and could exhaust a per-source bucket before
// the auth check fired, returning 429 from the 31st probe.
const requireResetAuth: MiddlewareHandler = async (c, next) => {
  const playerId = await authenticatedPlayerId(c);
  const isDesktop = config().isDesktop;
  const authDisabled = config().authDisabled;
  if (!isDesktop && !authDisabled && playerId == null) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  if (playerId != null) c.set('playerId', playerId);
  return next();
};

playerRoutes.post(
  '/reset-local-game',
  requireResetAuth,
  rateLimitStateChanges(),
  async (c) => {
    const playerIdVar = (c.var as { playerId?: number }).playerId;
    const playerId =
      typeof playerIdVar === 'number' && playerIdVar > 0 ? playerIdVar : null;
    try {
      const result = await resetWorldState();
      await clearAuthCookie(c);
      return c.json({ ok: true, playerId, ...result });
    } catch (err) {
      // SEC-3 / DEEP-7 — opaque body + correlation id; full error
      // captured via `http.error` telemetry + console.error.
      return errorResponse(c, 500, 'reset_local_game_failed', {internal: err});
    }
  },
);

playerRoutes.get('/currency', requireAuth, async (c) => {
  const fromCookie = (c.var as { playerId?: number })?.playerId;
  let playerId =
    typeof fromCookie === 'number' && fromCookie > 0 ? fromCookie : null;
  if (playerId == null && config().authDisabled) {
    const n = Number(c.req.query('playerId'));
    if (Number.isInteger(n) && n > 0) playerId = n;
  }
  if (playerId == null) return c.json({ error: 'playerId_required' }, 400);
  return c.json({
    playerId,
    count: await getPlayerCurrencyCount(playerId),
  });
});

playerRoutes.get('/:id/strings/graph', requireAuth, async (c) => {
  const playerId = Number(c.req.param('id'));
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return c.json({ error: 'invalid_player_id' }, 400);
  }
  const authedId = (c.var as { playerId?: number })?.playerId;
  if (
    !config().authDisabled &&
    (typeof authedId !== 'number' || authedId !== playerId)
  ) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const graph = await PlayerStringsService.graph(
    playerId,
    c.req.query('language') ?? null,
  );
  if (!graph) return c.json({ error: 'unknown_player' }, 404);
  return c.json(graph);
});

playerRoutes.get('/me', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id query param required' }, 400);
  const preferCreated = c.req.query('preferCreated') === '1';
  const player = await findByPublicId(id, { preferCreated });
  if (!player) return c.json({ error: 'unknown_player' }, 404);
  if (c.req.query('includeIntro') === '1' && player.profile_created === true) {
    const language = c.req.query('language') ?? undefined;
    const intro = await PlayerIntroService.bootstrapIntroFor(player, language);
    if (intro) return c.json({...player, ...intro});
  }
  return c.json(player);
});
