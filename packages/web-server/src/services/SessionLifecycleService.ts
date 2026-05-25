/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 — service ownership for the /api/session route. The
// service owns every data-mutating and data-reading concern; the
// route is reduced to Hono wiring, parsing/validation, and response
// shaping. SSE channel + provider mutation stay on the Session
// instance the service hands back to the route.

import { buildAffordances } from '../affordances.js';
import { activeCartridgeEntityPredicate } from '../cartridgeScope.js';
import { qualitySqlPredicate } from '../contentQuality.js';
import { query } from '../db.js';
import { errorOutcome } from '../httpErrors.js';
import {
  clearDialogueParticipants,
  setDialogueParticipants,
} from '../dialogueParticipants.js';
import {
  pickActiveCartridgeLocationAnchor,
  resolveActivePlayerCartridgeContextOptional,
} from './CartridgePlaythroughService.js';
import { telemetry } from '../telemetry/index.js';
import {
  emitGuiEventForSession,
  listGuiEvents,
  type GuiEventEnvelope,
} from '../guiEventOutbox.js';
import { loadVisibleReachableLocations } from '../locationGraph.js';
import { loadPresentPeopleAtLocation } from '../locationPresence.js';
import {
  buildPresenceEnrichment,
  type PresenceStatusBadge,
} from '../presenceEnrichment.js';
import { emitEntityMediaScript } from './CartridgeMediaScriptService.js';
import type {RelationshipBand} from '../stringsContract.js';
import {
  currentPresentationBarrier,
  listPostTurnPresentationSlots,
} from '../presentationScheduler.js';
import { resetSessionState, type ResetSessionResult } from '../resetSession.js';
import {
  SessionOwnershipError,
  sessionManager,
  type Session,
} from '../sessionManager.js';
import { TurnCancelledError } from '../turn/errors.js';
import { startTurnV2 as startTurn } from '../turnRunnerV2.js';
import {
  MAX_QUEUED_PER_SESSION,
  cancelQueuedTurn,
  enqueueTurn,
  listTurnQueueSnapshot,
  markQueueTurnCancelled,
  queueRowToTurnInput,
  recoverAbandonedRunningTurns,
  startNextQueuedTurn,
} from '../turnIngressQueue.js';

export { MAX_QUEUED_PER_SESSION, SessionOwnershipError };
export type { Session };

export interface ResolvedSessionForPlayer {
  session: Session;
  resolvedSessionId: string;
  requestedSessionId: string | null;
  autoResumed: boolean;
}

export interface LocationsViewCurrent {
  id: number;
  name: string;
  summary: string | null;
  visual_asset_urls: Record<string, string> | null;
}

export interface LocationsViewExit {
  id: number;
  name: string;
  summary: string | null;
  kind: string;
  visual_asset_urls: Record<string, string> | null;
}

export interface LocationsViewNearbyRelationship {
  /** Clamped, server-canonical relationship band derived from
   *  `runtime_fields.field_key = 'strings'`. `null` when the player
   *  has no recorded strings toward this NPC yet (rail renders a
   *  neutral / unknown badge). */
  band: RelationshipBand | null;
  /** Raw clamped string count (-10..10), or `null` when no relationship
   *  has been recorded yet. UI uses the band for the label but the
   *  count is kept on the wire for sorting / tooltip. */
  count: number | null;
}

export interface LocationsViewNearby {
  id: number;
  name: string;
  status: string;
  summary: string | null;
  portrait_set: Record<string, string | null> | null;
  /** FEAT-PRESENCE-1 — server-canonical bond / status enrichment. */
  relationship: LocationsViewNearbyRelationship;
  statuses: PresenceStatusBadge[];
}

export interface LocationsViewMapNode {
  id: number;
  name: string;
  kind: string;
  location_kind: string | null;
  x: number;
  y: number;
  color: string | null;
  topology_parent_id: number | null;
  is_current: boolean;
  is_exit: boolean;
  visual_asset_urls: Record<string, string> | null;
}

export interface LocationsView {
  current: LocationsViewCurrent | null;
  exits: LocationsViewExit[];
  nearby: LocationsViewNearby[];
  map: { nodes: LocationsViewMapNode[] };
}

export interface SessionMessageView {
  id: number;
  authorId: number;
  author: string | null;
  tone: string;
  text: string;
  turnIndex: number;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface SessionMessagesPayload {
  messages: SessionMessageView[];
  count: number;
  limit: number;
}

export interface TurnQueueView {
  activeTurnId: string | null;
  barrier: {
    id: string;
    turnId: string;
    pendingVisibleSlots: number;
    /**
     * S-14 — wall-clock ISO timestamp of the dead-service fallback
     * cap (default 5 min). The canonical close trigger is slot
     * resolution; the field is diagnostic only.
     */
    fallbackDeadlineAt: string;
    /**
     * S-14 — snapshot of `gui_events.release_seq` at the moment the
     * barrier opened. `null` when the snapshot read failed or no
     * GUI events have been released for the session yet.
     */
    openedReleaseSeq: number | null;
  } | null;
  maxQueued: number;
  depth: number;
  queuedDepth: number;
  oldestQueuedAgeMs: number;
  stuckRows: Array<{
    queueId: number;
    turnId: string;
    status: string;
    ageMs: number;
    runningAgeMs: number | null;
  }>;
  presentationSlots: Awaited<ReturnType<typeof listPostTurnPresentationSlots>>;
  rows: Awaited<ReturnType<typeof listTurnQueueSnapshot>>;
}

export interface RouteOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface CancelTurnOutcome {
  ok: true;
  hadActive: boolean;
  cancelledQueued?: boolean;
  activeTurnId?: string;
  turnId?: string;
  settled?: boolean;
  hardReleased?: boolean;
}

interface ActivePlaythroughSession {
  cartridge_id: string;
  last_session_id: string | null;
}

async function loadActivePlaythroughSession(
  playerId: number,
): Promise<ActivePlaythroughSession | null> {
  const r = await query<ActivePlaythroughSession>(
    `SELECT cartridge_id,
            last_session_id
       FROM hero_cartridge_states
      WHERE player_id = $1
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [playerId],
  );
  return r.rows[0] ?? null;
}

async function rememberActivePlaythroughSession(
  playerId: number,
  sessionId: string,
): Promise<void> {
  await query(
    `WITH active_state AS (
       SELECT player_id, cartridge_id
         FROM hero_cartridge_states
        WHERE player_id = $1
          AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
     )
     UPDATE hero_cartridge_states h
        SET last_session_id = $2,
            updated_at = now()
       FROM active_state a
      WHERE h.player_id = a.player_id
        AND h.cartridge_id = a.cartridge_id`,
    [playerId, sessionId],
  );
}

export class SessionLifecycleService {
  /** POST /api/session — resolve and/or boot the per-player session.
   *  Active hero playthrough state is canonical. Older builds used
   *  chat_messages/tool_invocations as a best-effort resume source,
   *  but that resurrects stale dialogue after cartridge import /
   *  launch. A client-supplied session id is accepted only when it is
   *  the active playthrough's recorded session id. */
  static async resolveOrCreateForPlayer(opts: {
    playerId: number;
    requestedSessionId?: string;
  }): Promise<ResolvedSessionForPlayer> {
    const requested = opts.requestedSessionId?.trim() || undefined;
    const activePlaythrough = await loadActivePlaythroughSession(opts.playerId);
    let resolvedId: string | undefined;
    let ignoredRequestedSessionId: string | null = null;

    if (activePlaythrough) {
      if (requested) {
        if (activePlaythrough.last_session_id === requested) {
          resolvedId = requested;
        } else {
          // A launch/new-game clears hero_cartridge_states.last_session_id
          // so the next bootstrap mints a clean chat session. If the client
          // still sends an old localStorage session id, treat it as stale
          // instead of reviving previous-playthrough chat/messages.
          ignoredRequestedSessionId = requested;
          resolvedId = undefined;
        }
      } else {
        resolvedId = activePlaythrough.last_session_id ?? undefined;
      }
    } else if (requested) {
      ignoredRequestedSessionId = requested;
    }
    const session = await sessionManager.getOrCreate(resolvedId, opts.playerId);
    if (activePlaythrough) {
      await rememberActivePlaythroughSession(opts.playerId, session.id);
    }
    const autoResumed = !requested && Boolean(resolvedId);
    telemetry.record({
      channel: 'gameplay',
      name: 'session.ready',
      sessionId: session.id,
      playerId: opts.playerId,
      data: {
        requested_session_id: requested ?? null,
        ignored_requested_session_id: ignoredRequestedSessionId,
        active_playthrough_session_id:
          activePlaythrough?.last_session_id ?? null,
        auto_resumed: autoResumed,
        resolved_session_id: session.id,
      },
    });
    await emitBootstrapMediaScriptsForPlayer({
      sessionId: session.id,
      playerId: opts.playerId,
    });
    return {
      session,
      resolvedSessionId: session.id,
      requestedSessionId: requested ?? null,
      autoResumed,
    };
  }

  /** Resolve an owned session or surface a typed not-found / forbidden. */
  static async getOwned(
    sessionId: string,
    playerId: number,
  ): Promise<Session | null> {
    const session = await sessionManager.getOwned(sessionId, playerId);
    return session ?? null;
  }

  static async destroy(sessionId: string): Promise<boolean> {
    return sessionManager.destroy(sessionId);
  }

  /** GET /:id/locations — the current location bubble plus its exits,
   *  density-derived nearby people, and authored map nodes.
   *
   *  FEAT-CART-LIB-7 (2026-05-17) — resolves the player's active
   *  cartridge once via `resolveActivePlayerCartridgeContext(playerId)`
   *  and threads it through every reachability / presence / map read
   *  so multi-cartridge installations never leak exits, NPCs, or map
   *  nodes from a different hero's cartridge.
   *
   *  FEAT-CART-LIB-8 (2026-05-17) — additionally validates
   *  `players.current_location_id` against the active cartridge. If
   *  the player row points at a foreign/stale location (typically a
   *  pre-FEAT-CART-LIB-7 mid-flight switch), the helper recovers via
   *  the active playthrough's `current_location_id` and finally the
   *  cartridge's scoped `starting_location_id`. The foreign
   *  location's name/summary/exits are never surfaced.
   *
   *  FEAT-CART-LIB-7-FOLLOWUP (2026-05-18) — uses the non-throwing
   *  optional resolver. When the hero has no active
   *  `hero_cartridge_states` row AND the legacy global
   *  `cartridge_meta.cartridge_id` mirror is unset (clean engine
   *  baseline, partial reset), the route returns an empty / stable
   *  payload instead of escaping a `cartridge_meta missing required
   *  key` Error as a 500. Tool / write callers keep the strict
   *  contract via `resolveActivePlayerCartridgeContext`. */
  static async loadLocationsView(opts: {
    session: Session;
    playerId: number;
  }): Promise<LocationsView> {
    const cartridgeCtx = await resolveActivePlayerCartridgeContextOptional(
      opts.playerId,
    );
    if (!cartridgeCtx) {
      telemetry.record({
        channel: 'gameplay',
        name: 'location.snapshot',
        sessionId: opts.session.id,
        playerId: opts.playerId,
        data: {
          current: null,
          cartridge_id: null,
          exit_count: 0,
          exits: [],
          nearby_count: 0,
          nearby: [],
          map_count: 0,
          player_current_location_id: null,
          foreign_current_location_recovered: false,
          no_active_playthrough: true,
        },
      });
      return { current: null, exits: [], nearby: [], map: { nodes: [] } };
    }
    const cartridgeId = cartridgeCtx.cartridgeId;
    const player = await query<{ current_location_id: number | null }>(
      `SELECT current_location_id FROM players WHERE entity_id = $1`,
      [opts.playerId],
    );
    const playerCurrentLocationId = player.rows[0]?.current_location_id ?? null;
    const currentLocationId = await pickCurrentLocationId(
      playerCurrentLocationId,
      cartridgeCtx.playthroughLocationId,
      cartridgeId,
    );
    if (currentLocationId == null) {
      telemetry.record({
        channel: 'gameplay',
        name: 'location.snapshot',
        sessionId: opts.session.id,
        playerId: opts.playerId,
        data: {
          current: null,
          cartridge_id: cartridgeId,
          exit_count: 0,
          exits: [],
          nearby_count: 0,
          nearby: [],
          map_count: 0,
          // FEAT-CART-LIB-8 — auditable trail of the foreign-location
          // recovery branch when the player row pointed cross-cartridge.
          player_current_location_id: playerCurrentLocationId,
          foreign_current_location_recovered:
            playerCurrentLocationId != null &&
            playerCurrentLocationId !== currentLocationId,
        },
      });
      return { current: null, exits: [], nearby: [], map: { nodes: [] } };
    }
    const cur = await query<{
      id: number;
      display_name: string;
      summary: string | null;
      profile: Record<string, unknown> | null;
    }>(
      `SELECT id, display_name, summary, profile FROM entities WHERE id = $1`,
      [currentLocationId],
    );
    const current: LocationsViewCurrent | null = cur.rows[0]
      ? {
          id: cur.rows[0].id,
          name: cur.rows[0].display_name,
          summary: cur.rows[0].summary,
          visual_asset_urls: readVisualAssetUrls(cur.rows[0].profile),
        }
      : null;
    const exits: LocationsViewExit[] = (
      await loadVisibleReachableLocations(currentLocationId, cartridgeId)
    ).map((r) => ({
      id: r.id,
      name: r.display_name,
      summary: r.summary,
      kind: r.kind,
      visual_asset_urls: readVisualAssetUrls(r.profile),
    }));
    const nearby = await loadNearbyForLocation(
      currentLocationId,
      opts.playerId,
      cartridgeId,
    );
    const map = await loadCityMapNodes(currentLocationId, cartridgeId);

    telemetry.record({
      channel: 'gameplay',
      name: 'location.snapshot',
      sessionId: opts.session.id,
      playerId: opts.playerId,
      data: {
        current,
        cartridge_id: cartridgeId,
        exit_count: exits.length,
        exits,
        nearby_count: nearby.length,
        nearby,
        map_count: map.nodes.length,
        player_current_location_id: playerCurrentLocationId,
        foreign_current_location_recovered:
          playerCurrentLocationId != null &&
          playerCurrentLocationId !== currentLocationId,
      },
    });
    return { current, exits, nearby, map };
  }

  /** GET /:id/messages — persisted chat_messages, ordered by turn_index. */
  static async listMessages(
    sessionId: string,
    requestedLimit: number,
  ): Promise<SessionMessagesPayload> {
    const limit = Math.max(1, Math.min(requestedLimit || 200, 500));
    const rows = await query<{
      id: number;
      author_entity_id: number | null;
      author_name: string | null;
      tone: string;
      text: string;
      turn_index: number;
      payload: Record<string, unknown> | null;
      created_at: string;
    }>(
      `SELECT cm.id,
              cm.author_entity_id,
              e.display_name AS author_name,
              cm.tone,
              cm.text,
              cm.turn_index,
              cm.payload,
              cm.created_at::text AS created_at
         FROM chat_messages cm
         LEFT JOIN entities e ON e.id = cm.author_entity_id
        WHERE cm.session_id = $1
        ORDER BY cm.turn_index ASC, cm.id ASC
        LIMIT $2`,
      [sessionId, limit],
    );
    return {
      messages: rows.rows.map((r) => ({
        id: r.id,
        authorId: r.author_entity_id ?? 0,
        author: r.author_name,
        tone: r.tone,
        text: r.text,
        turnIndex: r.turn_index,
        payload: r.payload ?? null,
        createdAt: r.created_at,
      })),
      count: rows.rows.length,
      limit,
    };
  }

  /** GET /:id/events — gui_events tail for replay. */
  static async listEvents(opts: {
    sessionId: string;
    after?: number | null;
    afterReleaseSeq?: number | null;
    limit?: number | null;
  }): Promise<{ events: GuiEventEnvelope[]; count: number }> {
    const afterRaw = Number(opts.after ?? 0);
    const afterReleaseSeqRaw = Number(opts.afterReleaseSeq ?? 0);
    const limitRaw = Number(opts.limit ?? 200);
    const events = await listGuiEvents({
      sessionId: opts.sessionId,
      after: Number.isFinite(afterRaw) ? afterRaw : 0,
      afterReleaseSeq: Number.isFinite(afterReleaseSeqRaw)
        ? afterReleaseSeqRaw
        : 0,
      limit: Number.isFinite(limitRaw) ? limitRaw : 200,
    });
    return { events, count: events.length };
  }

  /** GET /:id/turn-queue — diagnostics-grade snapshot of the durable
   *  ingress queue + presentation barrier. */
  static async getTurnQueueView(
    session: Session,
    opts: { turnId?: string; history?: boolean } = {},
  ): Promise<TurnQueueView> {
    const turnId = opts.turnId || undefined;
    const includeFinished = opts.history === true || Boolean(turnId);
    await recoverAbandonedRunningTurns({
      sessionId: session.id,
      activeTurnId: session.activeTurn?.turnId ?? null,
      reason: session.activeTurn
        ? 'turn abandoned: another live active turn owns the session'
        : 'turn abandoned: no live active turn in session',
    });
    const rows = await listTurnQueueSnapshot(session.id, {
      includeFinished,
      turnId,
    });
    const activeRows = rows.filter(
      (row) =>
        row.status === 'queued' ||
        row.status === 'starting' ||
        row.status === 'running',
    );
    const queuedRows = rows.filter((row) => row.status === 'queued');
    const barrier = currentPresentationBarrier(session);
    const presentationSlots = await listPostTurnPresentationSlots(session.id, {
      turnId: barrier?.turnId ?? undefined,
      unresolvedOnly: false,
    });
    return {
      activeTurnId: session.activeTurn?.turnId ?? null,
      barrier: barrier
        ? {
            id: barrier.id,
            turnId: barrier.turnId,
            pendingVisibleSlots: barrier.pendingVisibleSlots,
            // S-14 — `fallbackDeadlineAt` is the dead-service cap
            // (default 5 min), not the per-hook short deadline that
            // the old field name suggested. Diagnostic only — the
            // canonical close trigger is slot resolution.
            fallbackDeadlineAt: new Date(barrier.fallbackDeadlineAt).toISOString(),
            openedReleaseSeq: barrier.openedReleaseSeq,
          }
        : null,
      maxQueued: MAX_QUEUED_PER_SESSION,
      depth: activeRows.length,
      queuedDepth: queuedRows.length,
      oldestQueuedAgeMs:
        queuedRows.length > 0
          ? Math.max(...queuedRows.map((row) => row.ageMs))
          : 0,
      stuckRows: rows
        .filter((row) => row.stuck)
        .map((row) => ({
          queueId: row.id,
          turnId: row.turnId,
          status: row.status,
          ageMs: row.ageMs,
          runningAgeMs: row.runningAgeMs,
        })),
      presentationSlots,
      rows,
    };
  }

  /** POST /:id/_debug/emit — dev-only fake SSE push.  The route gates
   *  this on config().debugSse + nodeEnv; the service only does the
   *  actual emit so test/fixture code can call it directly. */
  static debugEmit(
    session: Session,
    event: string,
    data: unknown,
  ): { ok: true; clients: number } {
    // SSE-OK: emit outside tx (reason: devtool echo for
    // /api/session/:id/_debug/emit; broadcasts an inert payload, no
    // DB row is written).
    session.sse.emit(event, data);
    return { ok: true, clients: session.sse.clientCount };
  }

  /** POST /:id/turn — durable enqueue, optional in-line start. Returns
   *  a route-ready outcome so the handler stays a one-liner. */
  static async enqueueAndMaybeStart(opts: {
    session: Session;
    playerId: number;
    text: string;
    actionId?: string;
    language?: string;
    clientRequestId?: string;
  }): Promise<RouteOutcome> {
    const text = opts.text.trim();
    const { session, playerId } = opts;
    const locationBefore = await query<{
      current_location_id: number | null;
      current_location_name: string | null;
    }>(
      `SELECT p.current_location_id,
              loc.display_name AS current_location_name
         FROM players p
         LEFT JOIN entities loc ON loc.id = p.current_location_id
        WHERE p.entity_id = $1`,
      [playerId],
    );
    telemetry.record({
      channel: 'gameplay',
      name: 'turn.input',
      sessionId: session.id,
      playerId,
      data: {
        text,
        action_id: opts.actionId ?? null,
        language: opts.language ?? null,
        client_request_id: opts.clientRequestId ?? null,
        location_before: locationBefore.rows[0] ?? null,
      },
    });
    const barrier = currentPresentationBarrier(session);
    const visibleNow = !session.activeTurn && !barrier;
    let queued;
    try {
      queued = await enqueueTurn({
        sessionId: session.id,
        playerId,
        text,
        actionId: opts.actionId,
        language: opts.language,
        clientRequestId: opts.clientRequestId,
        visibleAfterTurnId:
          session.activeTurn?.turnId ?? barrier?.turnId ?? null,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'queue_full') {
        return { status: 429, body: { error: 'queue_full', limit: 3 } };
      }
      // SEC-3 / DEEP-7 — opaque body + correlation id; full error
      // captured via `http.error` telemetry + console.error. The
      // sentinel `queue_full` branch above is preserved because it
      // is a client-actionable application code, not an internal
      // exception leak.
      return errorOutcome(500, 'turn_enqueue_failed', {
        internal: err,
        data: { sessionId: session.id, playerId },
      });
    }

    try {
      let started = null as Awaited<
        ReturnType<typeof startNextQueuedTurn>
      > | null;
      if (visibleNow) {
        started = await startNextQueuedTurn(session, (row) =>
          startTurn(session, queueRowToTurnInput(row)),
        );
      }
      const visible = started?.row.turnId === queued.row.turnId;
      const blockedByTurnId = visible
        ? null
        : (session.activeTurn?.turnId ??
          barrier?.turnId ??
          queued.row.visibleAfterTurnId);
      const position = visible ? 0 : queued.position;
      telemetry.record({
        channel: 'gameplay',
        name: 'turn.queued',
        sessionId: session.id,
        playerId,
        turnId: queued.row.turnId,
        data: {
          queue_id: queued.row.id,
          visible,
          position,
          blocked_by_turn_id: blockedByTurnId,
          reused: queued.reused,
        },
      });
      return {
        status: 200,
        body: {
          turnId: queued.row.turnId,
          queueId: queued.row.id,
          queued: !visible,
          visible,
          position,
          blockedByTurnId,
          reused: queued.reused,
        },
      };
    } catch (err) {
      // SEC-3 / DEEP-7 — opaque body + correlation id; full error
      // captured via `http.error` telemetry + console.error.
      return errorOutcome(500, 'turn_start_failed', {
        internal: err,
        data: { sessionId: session.id, playerId },
      });
    }
  }

  /** POST /:id/cancel — abort the active turn or kill a queued row. */
  static async cancelTurn(
    session: Session,
    opts: { turnId?: string } = {},
  ): Promise<CancelTurnOutcome> {
    const active = session.activeTurn;
    if (!active && opts.turnId) {
      const cancelled = await cancelQueuedTurn(session.id, opts.turnId);
      return {
        ok: true,
        hadActive: false,
        cancelledQueued: cancelled,
        turnId: opts.turnId,
      };
    }
    if (!active) {
      return { ok: true, hadActive: false };
    }
    if (opts.turnId && active.turnId !== opts.turnId) {
      const cancelled = await cancelQueuedTurn(session.id, opts.turnId);
      return {
        ok: true,
        hadActive: true,
        cancelledQueued: cancelled,
        activeTurnId: active.turnId,
        turnId: opts.turnId,
      };
    }
    active.resetRequestedAt = Date.now();
    session.resetTurnIds.add(active.turnId);
    await markQueueTurnCancelled(active.queueId, 'turn cancelled by user');
    // S-13 — abort with the shared domain error so the catch
    // handler in `turnRunnerV2.ts` can route `turn.failed`
    // telemetry by `error_code: TURN_CANCELLED` (and so any
    // mid-stream `throwIfAborted` in `ai/handoff.ts` reads back
    // the same instance verbatim).
    active.abortController.abort(new TurnCancelledError());

    let settled = false;
    await Promise.race([
      (active.done ?? Promise.resolve()).then(() => {
        settled = true;
      }),
      delay(1500),
    ]);
    if (!settled && session.activeTurn === active) {
      session.activeTurn = undefined;
    }
    if (settled) {
      session.resetTurnIds.delete(active.turnId);
    }
    // SSE-OK: emit outside tx (reason: turn-lifecycle marker for
    // user cancel; markQueueTurnCancelled above is already
    // committed before this fires).
    session.sse.emit('cancelled', {
      turnId: active.turnId,
      reason: 'user_cancel',
      hardReleased: !settled,
    });
    return {
      ok: true,
      hadActive: true,
      turnId: active.turnId,
      settled,
      hardReleased: !settled,
    };
  }

  /** POST /:id/reset — wipe visible session, keep player + entity state. */
  static async resetSession(
    session: Session,
    playerId: number,
  ): Promise<ResetSessionResult> {
    const result = await resetSessionState(session, playerId);
    // SSE-OK: emit outside tx (reason: resetSessionState above
    // already committed the dialogue clear; SseBridge.emit auto-
    // defers via onTransactionCommit when nested in withTransaction).
    session.sse.emit('dialogue:participants_updated', {
      focused_partner_id: null,
      participant_ids: [],
      participants: [],
      source: 'session_reset',
    });
    // SSE-OK: emit outside tx (reason: session-lifecycle marker
    // fired after resetSessionState commits the wipe; not a DB
    // state-change itself).
    session.sse.emit('reset', {
      at: Date.now(),
      sessionId: session.id,
      playerId,
      cancelledTurnId: result.cancelledTurnId,
      activeTurnTimedOut: result.activeTurnTimedOut,
      deleted: result.deleted,
    });
    return result;
  }

  /** POST /:id/model — single-narrator override (legacy spec 29 wrapper). */
  static setNarratorModel(
    session: Session,
    model: string,
  ):
    | { ok: true; model: string }
    | { ok: false; error: string } {
    try {
      const providers = session.setProviders({ narrator: { modelId: model } });
      return { ok: true, model: providers.narratorModelId };
    } catch (err) {
      // SEC-3 / DEEP-7 — `session.setProviders` throws Errors like
      // "Model 'X' requires DEEPSEEK_API_KEY", which would leak the
      // server's env-config surface to the client. Genericize the
      // body to a stable code; ops still see the internal message
      // via `http.error` telemetry + the console.error line.
      const outcome = errorOutcome(400, 'model_validation_failed', {
        internal: err,
        data: { requested_model: model },
      });
      return { ok: false, error: outcome.body.error };
    }
  }

  /** POST /:id/models — swap V2 broker/narrator role models. */
  static setProviders(
    session: Session,
    opts: {
      broker?: { modelId?: string; thinking?: boolean };
      narrator?: { modelId?: string; thinking?: boolean };
    },
  ):
    | {
        ok: true;
        broker: { modelId: string; thinking: boolean };
        narrator: { modelId: string; thinking: boolean };
      }
    | { ok: false; error: string } {
    try {
      const providers = session.setProviders(opts);
      return {
        ok: true,
        broker: {
          modelId: providers.brokerModelId,
          thinking: providers.brokerThinking,
        },
        narrator: {
          modelId: providers.narratorModelId,
          thinking: providers.narratorThinking,
        },
      };
    } catch (err) {
      // SEC-3 / DEEP-7 — same genericization as setNarratorModel
      // above; the thrown messages name internal env vars / model
      // capability tags that should not leak to the client.
      const outcome = errorOutcome(400, 'model_validation_failed', {
        internal: err,
        data: { requested_models: opts },
      });
      return { ok: false, error: outcome.body.error };
    }
  }

  /** GET /:id/affordances — language-neutral quick-action menu. */
  static async loadAffordances(playerId: number): Promise<{
    actions: Awaited<ReturnType<typeof buildAffordances>>;
  }> {
    return { actions: await buildAffordances(playerId) };
  }

  /** POST /:id/dialogue/start — focus the player onto an NPC. */
  static async startDialogue(opts: {
    session: Session;
    playerId: number;
    npcId: number;
  }): Promise<RouteOutcome> {
    const npc = await query<{ kind: string; display_name: string }>(
      `SELECT kind, display_name FROM entities WHERE id = $1`,
      [opts.npcId],
    );
    if (npc.rows.length === 0) {
      return { status: 404, body: { error: 'npc_not_found' } };
    }
    if (npc.rows[0]!.kind !== 'person') {
      return {
        status: 400,
        body: { error: 'not_an_npc', kind: npc.rows[0]!.kind },
      };
    }
    const update = await setDialogueParticipants(opts.playerId, {
      focusedId: opts.npcId,
      participantIds: [opts.npcId],
      source: 'route',
      sessionId: opts.session.id,
    });
    if (update.rejected_focus_id === opts.npcId) {
      return { status: 400, body: { error: 'npc_not_present' } };
    }
    await emitGuiEventForSession(
      opts.session.id,
      'dialogue:engaged',
      {
        npcId: opts.npcId,
        npcName: npc.rows[0]!.display_name,
      },
      {
        playerId: opts.playerId,
        lane: 'post_response',
        phase: 'mutation',
      },
    );
    await emitEntityMediaScript(
      {
        sessionId: opts.session.id,
        playerId: opts.playerId,
        turnId: undefined,
      },
      opts.npcId,
      'person',
    ).catch((err) => {
      console.warn(
        '[session.dialogue.start] NPC media script failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    });
    // SSE-OK: emit outside tx (reason: setDialogueParticipants
    // above is the canonical write; SseBridge.emit auto-defers
    // via onTransactionCommit when the caller wraps the route in
    // withTransaction).
    opts.session.sse.emit('dialogue:participants_updated', {
      focused_partner_id: update.state.focused_partner_id,
      participant_ids: update.state.participant_ids,
      participants: update.participants,
      source: update.state.source,
    });
    return {
      status: 200,
      body: {
        ok: true,
        npcId: opts.npcId,
        npcName: npc.rows[0]!.display_name,
        participants: update.participants,
      },
    };
  }

  /** POST /:id/dialogue/end — release dialogue focus back to ambient. */
  static async endDialogue(opts: {
    session: Session;
    playerId: number;
  }): Promise<{ ok: true }> {
    const update = await clearDialogueParticipants(opts.playerId, {
      source: 'route',
    });
    // SSE-OK: emit outside tx (reason: clearDialogueParticipants
    // above is the canonical write; SseBridge.emit auto-defers
    // via onTransactionCommit when nested in withTransaction).
    opts.session.sse.emit('dialogue:participants_updated', {
      focused_partner_id: update.state.focused_partner_id,
      participant_ids: update.state.participant_ids,
      participants: update.participants,
      source: update.state.source,
    });
    return { ok: true };
  }
}

async function emitBootstrapMediaScriptsForPlayer(opts: {
  sessionId: string;
  playerId: number;
}): Promise<void> {
  const player = await query<{
    current_location_id: number | null;
    current_scene_id: number | null;
    dialogue_partner_id: number | null;
  }>(
    `SELECT current_location_id,
            current_scene_id,
            dialogue_partner_id
       FROM players
      WHERE entity_id = $1`,
    [opts.playerId],
  ).catch((err) => {
    console.warn(
      '[session.bootstrap.media] player state read failed (continuing):',
      err instanceof Error ? err.message : err,
    );
    return {rows: []};
  });
  const row = player.rows[0];
  if (!row) return;

  let locationId = row.current_location_id ?? null;
  let sceneId = row.current_scene_id ?? null;
  const cartridgeCtx = await resolveActivePlayerCartridgeContextOptional(
    opts.playerId,
  ).catch((err) => {
    console.warn(
      '[session.bootstrap.media] cartridge context read failed (continuing):',
      err instanceof Error ? err.message : err,
    );
    return null;
  });
  if (cartridgeCtx) {
    locationId = await pickCurrentLocationId(
      row.current_location_id ?? null,
      cartridgeCtx.playthroughLocationId,
      cartridgeCtx.cartridgeId,
    ).catch((err) => {
      console.warn(
        '[session.bootstrap.media] location recovery failed (continuing):',
        err instanceof Error ? err.message : err,
      );
      return locationId;
    });
    sceneId = sceneId ?? cartridgeCtx.playthroughSceneId;
  }

  const ctx = {
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    turnId: undefined,
  };
  const targets: Array<{
    id: number | null;
    kind: 'location' | 'scene' | 'person';
    label: string;
  }> = [
    {id: locationId, kind: 'location', label: 'location'},
    {id: sceneId, kind: 'scene', label: 'scene'},
    {id: row.dialogue_partner_id ?? null, kind: 'person', label: 'dialogue'},
  ];

  for (const target of targets) {
    if (target.id == null) continue;
    await emitEntityMediaScript(ctx, target.id, target.kind, {
      musicOnly: true,
      eventOptions: {
        phase: 'support',
        displayPolicy: {lane: 'rail_only', anchor: 'none'},
      },
    }).catch((err) => {
      console.warn(
        `[session.bootstrap.media] ${target.label} media script failed (continuing):`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}

/**
 * FEAT-CART-LIB-8 (2026-05-17) / FEAT-CART-LIB-9 (2026-05-17) — pick
 * the location id that is safe to render as `current` for a hero in
 * the given cartridge. Delegates to
 * `pickActiveCartridgeLocationAnchor` (in `CartridgePlaythroughService`)
 * so the read side and `move_player` share one priority chain.
 */
async function pickCurrentLocationId(
  playerCurrentLocationId: number | null,
  playthroughCurrentLocationId: number | null,
  cartridgeId: string,
): Promise<number | null> {
  const picked = await pickActiveCartridgeLocationAnchor({
    cartridgeId,
    playerCurrentLocationId,
    playthroughCurrentLocationId,
  });
  return picked.locationId;
}

async function loadCityMapNodes(
  currentLocationId: number,
  cartridgeId: string,
): Promise<{
  nodes: LocationsViewMapNode[];
}> {
  const exits = await loadVisibleReachableLocations(
    currentLocationId,
    cartridgeId,
  );
  const exitIds = new Set(exits.map((r) => r.id));

  // FEAT-CART-LIB-7 (2026-05-17) — gate map nodes on the active
  // hero's cartridge so multi-cartridge installs never render a
  // different cartridge's authored map alongside the current run.
  const rows = await query<{
    id: number;
    kind: string;
    display_name: string;
    profile: Record<string, unknown> | null;
    location_kind: string | null;
    map_x: string | null;
    map_y: string | null;
    map_color: string | null;
    topology_parent_id: string | null;
  }>(
    `SELECT id,
            kind,
            display_name,
            profile,
            profile->>'location_kind' AS location_kind,
            profile->'map_position'->>'x' AS map_x,
            profile->'map_position'->>'y' AS map_y,
            profile->>'map_district_color' AS map_color,
            topology_parent_id::text AS topology_parent_id
       FROM entities
      WHERE kind IN ('location', 'district')
        AND profile ? 'map_position'
        AND (profile->>'hidden_until_stage') IS NULL
        AND ${qualitySqlPredicate('entities')}
        AND ${activeCartridgeEntityPredicate('entities', '$1')}
      ORDER BY display_name`,
    [cartridgeId],
  );
  return {
    nodes: rows.rows
      .map((row) => {
        const x = Number(row.map_x);
        const y = Number(row.map_y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          id: Number(row.id),
          name: row.display_name,
          kind: row.kind,
          location_kind: row.location_kind,
          x,
          y,
          color: row.map_color,
          topology_parent_id:
            row.topology_parent_id != null
              ? Number(row.topology_parent_id)
              : null,
          is_current: Number(row.id) === currentLocationId,
          is_exit: exitIds.has(Number(row.id)),
          visual_asset_urls: readVisualAssetUrls(row.profile),
        };
      })
      .filter((node): node is NonNullable<typeof node> => node != null),
  };
}

async function loadNearbyForLocation(
  locationId: number,
  playerId: number,
  cartridgeId: string,
): Promise<LocationsViewNearby[]> {
  const rows = await loadPresentPeopleAtLocation({
    locationId,
    playerId,
    cartridgeId,
    limit: 12,
  });
  // FEAT-PRESENCE-1 — batch the per-NPC relationship band + public
  // status badges for the listed nearby NPCs so the rail/map/profile
  // surfaces can render bond and status without a second round-trip
  // or any leaf-component fetch.
  const enrichment = await buildPresenceEnrichment(
    playerId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const rel = enrichment.relationships.get(row.id);
    const statuses = enrichment.statuses.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.display_name,
      status: readText(row.profile?.['role']) ?? 'here',
      summary: row.summary,
      portrait_set: readPortraitSet(row.profile?.['portrait_set']),
      relationship: rel
        ? {band: rel.band, count: rel.count}
        : {band: null, count: null},
      statuses,
    };
  });
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readVisualAssetUrls(
  profile: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  const raw = profile?.['visual_asset_urls'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] => {
      const [key, value] = entry;
      return (
        key.trim().length > 0 &&
        typeof value === 'string' &&
        value.trim().length > 0
      );
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function readPortraitSet(
  value: unknown,
): Record<string, string | null> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, string | null>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
