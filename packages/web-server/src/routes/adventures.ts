/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {Hono, type Context} from 'hono';
import {config} from '../config.js';
import {errorResponse} from '../httpErrors.js';
import {requireAuth} from '../middleware/auth.js';
import {AdventureService} from '../domain/adventure/index.js';

export const adventureRoutes = new Hono();

adventureRoutes.use('*', requireAuth);

adventureRoutes.get('/:id/adventures', async c => {
  const resolved = resolveRoutePlayer(c);
  if ('response' in resolved) return resolved.response;
  try {
    const adventures = await AdventureService.listPlayerAdventures({
      playerId: resolved.playerId,
      sessionId: c.req.query('sessionId') ?? null,
      limit: Number(c.req.query('limit') ?? 50),
    });
    return c.json({adventures, count: adventures.length});
  } catch (err) {
    // SEC-3 / DEEP-7 — opaque body + correlation id; full error
    // captured via `http.error` telemetry + console.error.
    return errorResponse(c, 500, 'adventure_list_failed', {internal: err});
  }
});

adventureRoutes.post('/:id/adventures/:queueId/accept', async c => {
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: string;
    turnId?: string;
  };
  const resolved = resolveRoutePlayer(c);
  if ('response' in resolved) return resolved.response;
  const queueId = parsePositiveInt(c.req.param('queueId'));
  if (queueId == null) return c.json({error: 'invalid queue id'}, 400);
  const result = await AdventureService.acceptPlayerAdventure({
    playerId: resolved.playerId,
    queueId,
    sessionId: body.sessionId ?? null,
    turnId: body.turnId ?? null,
  });
  if (!result.ok) {
    return c.json(
      {
        error: result.reason ?? 'adventure_accept_failed',
        message: result.message,
        status: result.status,
      },
      result.reason === 'forbidden' ? 403 : 409,
    );
  }
  return c.json({
    ok: true,
    status: result.status,
    queueId,
    questResult: result.questResult ?? null,
    spawnResults: result.spawnResults ?? [],
    followup: result.followup ?? null,
  });
});

adventureRoutes.post('/:id/adventures/:queueId/ignore', async c => {
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: string;
    reason?: string;
  };
  const resolved = resolveRoutePlayer(c);
  if ('response' in resolved) return resolved.response;
  const queueId = parsePositiveInt(c.req.param('queueId'));
  if (queueId == null) return c.json({error: 'invalid queue id'}, 400);
  const result = await AdventureService.ignorePlayerAdventure({
    playerId: resolved.playerId,
    queueId,
    sessionId: body.sessionId ?? null,
    reason: body.reason,
  });
  if (!result.ok) {
    return c.json(
      {
        error: result.reason ?? 'adventure_ignore_failed',
        message: result.message,
        status: result.status,
      },
      result.reason === 'forbidden' ? 403 : 409,
    );
  }
  return c.json({
    ok: true,
    status: result.status,
    queueId,
    consequence: result.consequence ?? null,
  });
});

function resolveRoutePlayer(
  c: Context,
): {playerId: number} | {response: Response} {
  const routePlayerId = parsePositiveInt(c.req.param('id'));
  if (routePlayerId == null) {
    return {response: c.json({error: 'invalid player id'}, 400)};
  }
  const cookiePlayerId = (c.var as {playerId?: number})?.playerId;
  if (typeof cookiePlayerId === 'number' && cookiePlayerId > 0) {
    if (cookiePlayerId !== routePlayerId) {
      return {response: c.json({error: 'player_forbidden'}, 403)};
    }
    return {playerId: cookiePlayerId};
  }
  if (config().authDisabled) return {playerId: routePlayerId};
  return {response: c.json({error: 'playerId_required'}, 400)};
}

function parsePositiveInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
