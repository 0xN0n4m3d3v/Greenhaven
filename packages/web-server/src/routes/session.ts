/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Session-scoped routes mounted under /api/session. Business logic
// lives in SessionLifecycleService — this file is Hono wiring,
// auth/rate-limit middleware, request parsing, SSE boundary, and
// response shaping only (ARCH-18).

import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import {
  rateLimitSse,
  rateLimitStateChanges,
  rateLimitTurns,
} from '../middleware/rateLimit.js';
import {
  SessionLifecycleService,
  SessionOwnershipError,
  type RouteOutcome,
  type Session,
} from '../services/SessionLifecycleService.js';

export const sessionRoutes = new Hono();
sessionRoutes.use('*', requireAuth);
// SEC-5 — per-player 30/min ceiling. Mounted AFTER `requireAuth`
// so an unauthenticated session probe still emits 401 (the
// `rateLimitStateChanges` middleware itself skips GETs and
// passes through when `config().authDisabled`). The `/turn`
// endpoint keeps its specialized `rateLimitTurns` 10-burst /
// 30-min bucket below; SEC-5 sits one layer up so a player who
// pumps `cancel` + `reset` + `dialogue/start` cannot evade the
// turn ceiling by mixing endpoints.
sessionRoutes.use('*', rateLimitStateChanges());

type PlayerPayload = { playerId?: number };

function parsePositivePlayerId(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolvePlayerId(
  c: Context,
  body: PlayerPayload = {},
  queryPlayerId?: string | null,
): number | null {
  const fromCookie = (c.var as { playerId?: number })?.playerId;
  if (typeof fromCookie === 'number' && fromCookie > 0) return fromCookie;
  if (!config().authDisabled) return null;
  const fromBody = parsePositivePlayerId(body.playerId);
  if (fromBody !== null) return fromBody;
  return parsePositivePlayerId(queryPlayerId);
}

async function readBody<T>(c: Context): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T;
}

function respond(c: Context, outcome: RouteOutcome): Response {
  return c.json(outcome.body, outcome.status as ContentfulStatusCode);
}

type OwnedHandler = (
  session: Session,
  playerId: number,
) => Promise<Response> | Response;

async function withOwned(
  c: Context,
  body: PlayerPayload,
  queryPlayerId: string | null | undefined,
  handler: OwnedHandler,
): Promise<Response> {
  const playerId = resolvePlayerId(c, body, queryPlayerId);
  if (playerId == null) return c.json({ error: 'playerId_required' }, 400);
  const id = c.req.param('id') ?? '';
  try {
    const session = await SessionLifecycleService.getOwned(id, playerId);
    if (!session) return c.json({ error: 'unknown_session' }, 404);
    return await handler(session, playerId);
  } catch (err) {
    if (err instanceof SessionOwnershipError) {
      return c.json({ error: 'session_forbidden' }, 403);
    }
    throw err;
  }
}

sessionRoutes.post('/', async (c) => {
  const body = await readBody<{ sessionId?: string; playerId?: number }>(c);
  const playerId = resolvePlayerId(c, body);
  if (playerId == null) return c.json({ error: 'playerId_required' }, 400);
  try {
    const { session } = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId,
      requestedSessionId: body.sessionId,
    });
    return c.json({ sessionId: session.id, state: session.snapshot() });
  } catch (err) {
    if (err instanceof SessionOwnershipError) {
      return c.json({ error: 'session_forbidden' }, 403);
    }
    throw err;
  }
});

sessionRoutes.get('/:id/stream', rateLimitSse(), async (c) =>
  withOwned(c, {}, c.req.query('playerId'), (session) =>
    streamSSE(c, async (stream) => {
      await session.sse.runFor(stream);
    }),
  ),
);

sessionRoutes.get('/:id/state', async (c) =>
  withOwned(c, {}, c.req.query('playerId'), (session) =>
    c.json(session.snapshot()),
  ),
);

sessionRoutes.get('/:id/locations', async (c) =>
  withOwned(c, {}, c.req.query('playerId'), async (session, playerId) =>
    c.json(
      await SessionLifecycleService.loadLocationsView({ session, playerId }),
    ),
  ),
);

sessionRoutes.get('/:id/messages', async (c) =>
  withOwned(c, {}, c.req.query('playerId'), async (session) =>
    c.json(
      await SessionLifecycleService.listMessages(
        session.id,
        Number(c.req.query('limit')) || 200,
      ),
    ),
  ),
);

sessionRoutes.get('/:id/events', async (c) =>
  withOwned(c, {}, c.req.query('playerId'), async (session) =>
    c.json(
      await SessionLifecycleService.listEvents({
        sessionId: session.id,
        after: Number(c.req.query('after') ?? 0),
        afterReleaseSeq: Number(c.req.query('afterReleaseSeq') ?? 0),
        limit: Number(c.req.query('limit') ?? 200),
      }),
    ),
  ),
);

sessionRoutes.get('/:id/turn-queue', async (c) =>
  withOwned(c, {}, c.req.query('playerId'), async (session) =>
    c.json(
      await SessionLifecycleService.getTurnQueueView(session, {
        turnId: c.req.query('turnId') || undefined,
        history: c.req.query('history') === '1',
      }),
    ),
  ),
);

sessionRoutes.post('/:id/_debug/emit', async (c) => {
  if (config().nodeEnv === 'production' || !config().debugSse) {
    return c.json({ error: 'not_found' }, 404);
  }
  const body = await readBody<PlayerPayload & { event?: string; data?: unknown }>(c);
  return withOwned(c, body, null, (session) =>
    c.json(
      SessionLifecycleService.debugEmit(
        session,
        body.event ?? 'debug',
        body.data ?? null,
      ),
    ),
  );
});

sessionRoutes.post('/:id/turn', rateLimitTurns(), async (c) => {
  const body = await readBody<{
    text?: string;
    playerId?: number;
    actionId?: string;
    language?: string;
    clientRequestId?: string;
  }>(c);
  if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
    return c.json({ error: 'text_required' }, 400);
  }
  return withOwned(c, body, null, async (session, playerId) =>
    respond(
      c,
      await SessionLifecycleService.enqueueAndMaybeStart({
        session,
        playerId,
        text: body.text!,
        actionId: body.actionId,
        language: body.language,
        clientRequestId: body.clientRequestId,
      }),
    ),
  );
});

sessionRoutes.post('/:id/cancel', async (c) => {
  const body = await readBody<PlayerPayload & { turnId?: string }>(c);
  return withOwned(c, body, null, async (session) =>
    c.json(
      await SessionLifecycleService.cancelTurn(session, { turnId: body.turnId }),
    ),
  );
});

sessionRoutes.post('/:id/reset', async (c) => {
  const body = await readBody<PlayerPayload>(c);
  return withOwned(c, body, null, async (session, playerId) => {
    const result = await SessionLifecycleService.resetSession(session, playerId);
    return c.json({ ok: true, ...result });
  });
});

sessionRoutes.post('/:id/model', async (c) => {
  const body = await readBody<{ model?: string; playerId?: number }>(c);
  return withOwned(c, body, null, (session) => {
    if (typeof body.model !== 'string' || !body.model) {
      return c.json({ ok: false, error: 'model required' }, 400);
    }
    const outcome = SessionLifecycleService.setNarratorModel(session, body.model);
    return c.json(outcome, outcome.ok ? 200 : 400);
  });
});

sessionRoutes.post('/:id/models', async (c) => {
  const body = await readBody<{
    broker?: { modelId?: string; thinking?: boolean };
    narrator?: { modelId?: string; thinking?: boolean };
    playerId?: number;
  }>(c);
  return withOwned(c, body, null, (session) => {
    const outcome = SessionLifecycleService.setProviders(session, body);
    return c.json(outcome, outcome.ok ? 200 : 400);
  });
});

sessionRoutes.get('/:id/affordances', async (c) =>
  withOwned(c, {}, c.req.query('playerId'), async (_session, playerId) =>
    c.json(await SessionLifecycleService.loadAffordances(playerId)),
  ),
);

sessionRoutes.post('/:id/dialogue/start', async (c) => {
  const body = await readBody<{ playerId?: number; npcId?: number }>(c);
  const npcId = body.npcId;
  if (typeof npcId !== 'number' || npcId <= 0) {
    return c.json({ error: 'npcId_required' }, 400);
  }
  return withOwned(c, body, null, async (session, playerId) =>
    respond(
      c,
      await SessionLifecycleService.startDialogue({ session, playerId, npcId }),
    ),
  );
});

sessionRoutes.post('/:id/dialogue/end', async (c) => {
  const body = await readBody<{ playerId?: number }>(c);
  return withOwned(c, body, null, async (session, playerId) =>
    c.json(
      await SessionLifecycleService.endDialogue({ session, playerId }),
    ),
  );
});

sessionRoutes.delete('/:id', async (c) =>
  withOwned(c, {}, c.req.query('playerId'), async () => {
    const ok = await SessionLifecycleService.destroy(c.req.param('id'));
    return c.json({ ok }, ok ? 200 : 404);
  }),
);
