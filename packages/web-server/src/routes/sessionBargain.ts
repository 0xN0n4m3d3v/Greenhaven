/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// POST /api/session/:id/bargain — Devil's Bargain accept/reject endpoint.
// Body: { accept: boolean, bargainId: string }
//
// Broker emits a 'devils_bargain' SSE event with {bargainId, text, dieDelta}
// before a high-stakes dice_check. The client surfaces an Accept/Reject
// prompt; this endpoint flows the choice back. The choice is stashed on
// session.activeTurn.pendingBargain so the broker can pick it up before
// the next dice_check (or before the next narrate handoff).

import { Hono, type Context } from 'hono';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitStateChanges } from '../middleware/rateLimit.js';
import {
  SessionOwnershipError,
  sessionManager,
  type Session,
} from '../sessionManager.js';

export const sessionBargainRoutes = new Hono();

sessionBargainRoutes.use('*', requireAuth);
// SEC-5 — per-player 30/min ceiling on the Devil's Bargain
// accept/reject POST. Mounted after `requireAuth` so 401 still
// wins for unauthenticated probes.
sessionBargainRoutes.use('*', rateLimitStateChanges());

function resolvePlayerId(
  c: Context,
  body: { playerId?: number },
): number | null {
  const fromCookie = (c.var as { playerId?: number })?.playerId;
  if (typeof fromCookie === 'number' && fromCookie > 0) return fromCookie;
  if (
    config().authDisabled &&
    Number.isInteger(body.playerId) &&
    Number(body.playerId) > 0
  ) {
    return Number(body.playerId);
  }
  return null;
}

sessionBargainRoutes.post('/:id/bargain', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    accept?: boolean;
    bargainId?: string;
    playerId?: number;
  };
  const playerId = resolvePlayerId(c, body);
  if (playerId == null) {
    return c.json({ error: 'playerId_required' }, 400);
  }
  let session: Session | undefined;
  try {
    session = await sessionManager.getOwned(c.req.param('id'), playerId);
  } catch (err) {
    if (err instanceof SessionOwnershipError) {
      return c.json({ error: 'session_forbidden' }, 403);
    }
    throw err;
  }
  if (!session) return c.json({ error: 'unknown_session' }, 404);
  if (typeof body.accept !== 'boolean' || !body.bargainId) {
    return c.json({ error: 'accept (bool) and bargainId required' }, 400);
  }
  if (session.activeTurn) {
    session.activeTurn.pendingBargain = {
      bargainId: body.bargainId,
      accepted: body.accept,
    };
  }
  // SSE-OK: emit outside tx (reason: turn-runtime banner that
  // forwards the player's bargain choice to the active turn;
  // there is no DB row written by this route — the bargain
  // resolution is recorded later when the turn runs).
  session.sse.emit('devils_bargain.resolved', {
    bargainId: body.bargainId,
    accepted: body.accept,
  });
  return c.json({ ok: true });
});
