/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from './db.js';
import {sessionManager} from './sessionManager.js';
import {telemetry} from './telemetry/index.js';
import type {ToolContext} from './tools/base.js';

export type GuiEventLane =
  | 'chat'
  | 'pre_response'
  | 'response'
  | 'post_response'
  | 'status'
  | 'rail';

export type GuiEventPhase =
  | 'pre_turn'
  | 'mutation'
  | 'narration'
  | 'post_turn'
  | 'support';

export interface GuiEventEnvelope {
  eventId: number;
  sessionId: string;
  playerId: number | null;
  turnId: string | null;
  turnIndex: number | null;
  lane: GuiEventLane;
  phase: GuiEventPhase;
  type: string;
  messageId: number | null;
  displayPolicy: Record<string, unknown>;
  payload: Record<string, unknown>;
  createdAt: string;
  releasedAt: string | null;
  releaseSeq: number | null;
}

export interface EmitGuiEventOptions {
  playerId?: number | null;
  turnId?: string | null;
  turnIndex?: number | null;
  lane?: GuiEventLane;
  phase?: GuiEventPhase;
  messageId?: number | null;
  releaseAfterMessageId?: number | null;
  dedupeKey?: string | null;
  displayPolicy?: Record<string, unknown>;
  status?: 'pending' | 'ready';
  deferRelease?: boolean;
  expiresAt?: string | null;
}

export async function emitGuiEvent(
  ctx: Pick<ToolContext, 'sessionId' | 'playerId' | 'turnId'>,
  type: string,
  payload: Record<string, unknown>,
  opts: EmitGuiEventOptions = {},
): Promise<GuiEventEnvelope | null> {
  return emitGuiEventForSession(ctx.sessionId, type, payload, {
    playerId: opts.playerId ?? ctx.playerId,
    turnId: opts.turnId ?? ctx.turnId ?? null,
    ...opts,
  });
}

export async function emitGuiEventForSession(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  opts: EmitGuiEventOptions = {},
): Promise<GuiEventEnvelope | null> {
  const lane = opts.lane ?? defaultLaneFor(type);
  const phase = opts.phase ?? defaultPhaseFor(type);
  const turnId = opts.turnId ?? null;
  const messageId =
    opts.messageId ??
    (await resolveAssistantMessageIdForEvent(sessionId, turnId, lane, phase, opts)) ??
    null;
  const displayPolicy =
    opts.displayPolicy ?? defaultDisplayPolicyFor(lane, messageId);
  const status = opts.status ?? 'ready';
  const waitingForAssistantAnchor = shouldWaitForActiveAssistantAnchor(
    sessionId,
    turnId,
    lane,
    phase,
    opts,
    messageId,
  );
  const released =
    status === 'ready' &&
    opts.deferRelease !== true &&
    !waitingForAssistantAnchor;
  const storedStatus = released ? 'released' : status;
  const inserted = await query<{
    id: number | string;
    created_at: string;
    released_at: string | null;
    release_seq: number | string | null;
    turn_index: number | null;
    message_id: number | null;
  }>(
    `INSERT INTO gui_events
       (session_id, player_id, turn_id, turn_index, lane, phase, event_type,
        status, message_id, release_after_message_id, dedupe_key,
        display_policy, payload, ready_at, released_at, release_seq, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11,
             $12::jsonb, $13::jsonb,
             CASE WHEN $8 IN ('ready', 'released') THEN now() ELSE NULL END,
             CASE WHEN $14 THEN now() ELSE NULL END,
             CASE WHEN $14 THEN nextval('gui_events_release_seq') ELSE NULL END,
             $15::timestamptz)
     ON CONFLICT (session_id, dedupe_key) WHERE dedupe_key IS NOT NULL
     DO UPDATE SET payload = EXCLUDED.payload,
                   status = EXCLUDED.status,
                   ready_at = EXCLUDED.ready_at,
                   released_at = EXCLUDED.released_at,
                   turn_index = COALESCE(EXCLUDED.turn_index, gui_events.turn_index),
                   message_id = COALESCE(EXCLUDED.message_id, gui_events.message_id),
                   display_policy = CASE
                     WHEN EXCLUDED.message_id IS NOT NULL THEN EXCLUDED.display_policy
                     ELSE gui_events.display_policy
                   END,
                   release_seq = CASE
                     WHEN EXCLUDED.status = 'released'
                       THEN COALESCE(gui_events.release_seq, EXCLUDED.release_seq, nextval('gui_events_release_seq'))
                     ELSE gui_events.release_seq
                   END
     RETURNING id, created_at::text AS created_at,
               released_at::text AS released_at, release_seq,
               turn_index, message_id`,
    [
      sessionId,
      opts.playerId ?? null,
      turnId,
      opts.turnIndex ?? null,
      lane,
      phase,
      type,
      storedStatus,
      messageId,
      opts.releaseAfterMessageId ?? null,
      opts.dedupeKey ?? null,
      JSON.stringify(displayPolicy),
      JSON.stringify(payload),
      released,
      opts.expiresAt ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (!row) return null;
  const envelope: GuiEventEnvelope = {
    eventId: Number(row.id),
    sessionId,
    playerId: opts.playerId ?? null,
    turnId,
    turnIndex: row.turn_index == null ? null : Number(row.turn_index),
    lane,
    phase,
    type,
    messageId: row.message_id == null ? null : Number(row.message_id),
    displayPolicy,
    payload,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releaseSeq: row.release_seq == null ? null : Number(row.release_seq),
  };
  telemetry.record({
    channel: 'gameplay',
    name: released ? 'gui.event.released' : 'gui.event.stored',
    sessionId,
    playerId: envelope.playerId,
    turnId: envelope.turnId,
    data: {
      event_id: envelope.eventId,
      event_type: envelope.type,
      lane,
      phase,
      message_id: envelope.messageId,
      release_seq: envelope.releaseSeq,
      payload,
      display_policy: displayPolicy,
    },
  });
  if (released) {
    const session = sessionManager.get(sessionId);
    // GE-1 — outbox-routed events fan out as exactly one
    // normalized `gui:event` SSE per released `gui_events` row. The
    // legacy per-type duplicate (`session?.sse.emit(type, ...)`)
    // was removed so the UI cannot accidentally double-render a
    // single durable event via both the per-type listener and the
    // normalized envelope path. Direct, non-outbox SSE channels
    // (`content`, `narrate`, `player:moved`, etc.) still emit
    // through their own per-type listeners; they do not flow
    // through this function.
    // SSE-OK: emit outside tx (reason: guiEventOutbox is the
    // canonical GUI-event router; SseBridge.emit auto-defers via
    // onTransactionCommit when the caller is inside
    // withTransaction(...), so callers writing gui_events rows
    // inside a tx still get post-commit SSE delivery).
    session?.sse.emit('gui:event', envelope, String(envelope.eventId));
    telemetry.record({
      channel: 'performance',
      name: 'gui.event_released',
      sessionId,
      playerId: envelope.playerId,
      turnId: envelope.turnId,
      traceId: envelope.turnId,
      kind: 'gui',
      phase: 'gui.event_released',
      status: 'ok',
      metadata: {
        event_id: envelope.eventId,
        event_type: envelope.type,
        lane,
        phase,
        message_id: envelope.messageId,
        release_seq: envelope.releaseSeq,
      },
    });
  }
  return envelope;
}

export async function releaseGuiEvent(eventId: number): Promise<GuiEventEnvelope | null> {
  const updated = await query<GuiEventRow>(
    `UPDATE gui_events
        SET status = 'released',
            ready_at = COALESCE(ready_at, now()),
            released_at = now(),
            message_id = COALESCE(
              message_id,
              (
                SELECT cm.id
                  FROM chat_messages cm
                 WHERE cm.session_id = gui_events.session_id
                   AND cm.payload->>'turn_id' = gui_events.turn_id
                   AND cm.tone <> 'player'
                 ORDER BY cm.turn_index DESC, cm.id DESC
                 LIMIT 1
              )
            ),
            display_policy = CASE
              WHEN message_id IS NULL
               AND (
                SELECT cm.id
                  FROM chat_messages cm
                 WHERE cm.session_id = gui_events.session_id
                   AND cm.payload->>'turn_id' = gui_events.turn_id
                   AND cm.tone <> 'player'
                 ORDER BY cm.turn_index DESC, cm.id DESC
                 LIMIT 1
               ) IS NOT NULL
              THEN jsonb_set(COALESCE(display_policy, '{}'::jsonb), '{anchor}', '"message_id"', true)
              ELSE display_policy
            END,
            release_seq = COALESCE(release_seq, nextval('gui_events_release_seq'))
      WHERE id = $1
        AND status IN ('ready', 'pending')
      RETURNING id, session_id, player_id, turn_id, turn_index, lane, phase,
                event_type, message_id, display_policy, payload,
                created_at::text AS created_at,
                released_at::text AS released_at, release_seq`,
    [eventId],
  );
  const row = updated.rows[0];
  if (!row) return null;
  const envelope = guiEventRowToEnvelope(row);
  emitGuiEnvelope(envelope);
  return envelope;
}

export async function bindReleasedTurnGuiEventsToMessage(opts: {
  sessionId: string;
  turnId: string | null | undefined;
  messageId: number | null | undefined;
}): Promise<GuiEventEnvelope[]> {
  if (
    !opts.turnId ||
    typeof opts.messageId !== 'number' ||
    !Number.isFinite(opts.messageId) ||
    opts.messageId <= 0
  ) {
    return [];
  }
  const updated = await query<GuiEventRow>(
    `UPDATE gui_events
        SET message_id = $3,
            display_policy = jsonb_set(COALESCE(display_policy, '{}'::jsonb), '{anchor}', '"message_id"', true),
            status = CASE
              WHEN status = 'ready' THEN 'released'
              ELSE status
            END,
            ready_at = COALESCE(ready_at, now()),
            released_at = CASE
              WHEN status = 'ready' THEN now()
              ELSE released_at
            END,
            release_seq = CASE
              WHEN status = 'ready' OR release_seq IS NULL
                THEN COALESCE(release_seq, nextval('gui_events_release_seq'))
              ELSE release_seq
            END
      WHERE session_id = $1
        AND turn_id = $2
        AND message_id IS NULL
        AND status = 'ready'
        AND lane <> 'rail'
        AND event_type <> 'presentation:slot'
      RETURNING id, session_id, player_id, turn_id, turn_index, lane, phase,
                event_type, message_id, display_policy, payload,
                created_at::text AS created_at,
                released_at::text AS released_at, release_seq`,
    [opts.sessionId, opts.turnId, opts.messageId],
  );
  const envelopes = updated.rows.map(guiEventRowToEnvelope);
  for (const envelope of envelopes) {
    emitGuiEnvelope(envelope);
  }
  return envelopes;
}

/**
 * S-14 — read the highest `release_seq` currently issued for any
 * `released` GUI event in this session. Used by the presentation
 * barrier to snapshot ordering progress at open time so diagnostics
 * can correlate when the barrier finally closed. Returns `0` when no
 * released events have ever been issued for the session.
 */
export async function getCurrentReleaseSeq(
  sessionId: string,
): Promise<number> {
  const r = await query<{n: number | string | null}>(
    `SELECT COALESCE(MAX(release_seq), 0) AS n
       FROM gui_events
      WHERE session_id = $1
        AND release_seq IS NOT NULL`,
    [sessionId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function listGuiEvents(opts: {
  sessionId: string;
  after?: number;
  afterReleaseSeq?: number;
  limit?: number;
}): Promise<GuiEventEnvelope[]> {
  const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 200), 500));
  const after = Number.isFinite(opts.after ?? NaN)
    ? Math.max(0, Math.trunc(opts.after!))
    : 0;
  const afterReleaseSeq = Number.isFinite(opts.afterReleaseSeq ?? NaN)
    ? Math.max(0, Math.trunc(opts.afterReleaseSeq!))
    : 0;
  const cursorColumn = afterReleaseSeq > 0 ? 'release_seq' : 'id';
  const cursorValue = afterReleaseSeq > 0 ? afterReleaseSeq : after;
  const rows = await query<GuiEventRow>(
    `SELECT id, session_id, player_id, turn_id, turn_index, lane, phase,
            event_type, message_id, display_policy, payload,
            created_at::text AS created_at,
            released_at::text AS released_at,
            release_seq
       FROM gui_events
      WHERE session_id = $1
        AND status = 'released'
        AND ${cursorColumn} > $2
      ORDER BY release_seq ASC NULLS LAST, id ASC
      LIMIT $3`,
    [opts.sessionId, cursorValue, limit],
  );
  return rows.rows.map(guiEventRowToEnvelope);
}

interface GuiEventRow {
  id: number | string;
  session_id: string;
  player_id: number | string | null;
  turn_id: string | null;
  turn_index: number | string | null;
  lane: GuiEventLane;
  phase: GuiEventPhase;
  event_type: string;
  message_id: number | string | null;
  display_policy: Record<string, unknown>;
  payload: Record<string, unknown>;
  created_at: string;
  released_at: string | null;
  release_seq: number | string | null;
}

function guiEventRowToEnvelope(row: GuiEventRow): GuiEventEnvelope {
  return {
    eventId: Number(row.id),
    sessionId: row.session_id,
    playerId: row.player_id == null ? null : Number(row.player_id),
    turnId: row.turn_id,
    turnIndex: row.turn_index == null ? null : Number(row.turn_index),
    lane: row.lane,
    phase: row.phase,
    type: row.event_type,
    messageId: row.message_id == null ? null : Number(row.message_id),
    displayPolicy: row.display_policy ?? {},
    payload: row.payload ?? {},
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releaseSeq: row.release_seq == null ? null : Number(row.release_seq),
  };
}

function emitGuiEnvelope(envelope: GuiEventEnvelope): void {
  const session = sessionManager.get(envelope.sessionId);
  // GE-1 — single normalized `gui:event` SSE per released
  // `gui_events` row. See the immediate-release path above for the
  // full rationale; the same contract applies on the delayed
  // release path used by `releaseGuiEvent(...)` and
  // `bindReleasedTurnGuiEventsToMessage(...)`.
  // SSE-OK: emit outside tx (reason: same as above — this is the
  // GUI-event router boundary; SseBridge.emit auto-defers via
  // onTransactionCommit when called inside withTransaction).
  session?.sse.emit('gui:event', envelope, String(envelope.eventId));
  telemetry.record({
    channel: 'gameplay',
    name: 'gui.event.released',
    sessionId: envelope.sessionId,
    playerId: envelope.playerId,
    turnId: envelope.turnId,
    data: {
      event_id: envelope.eventId,
      event_type: envelope.type,
      lane: envelope.lane,
      phase: envelope.phase,
      message_id: envelope.messageId,
      release_seq: envelope.releaseSeq,
      payload: envelope.payload,
      display_policy: envelope.displayPolicy,
    },
  });
  telemetry.record({
    channel: 'performance',
    name: 'gui.event_released',
    sessionId: envelope.sessionId,
    playerId: envelope.playerId,
    turnId: envelope.turnId,
    traceId: envelope.turnId,
    kind: 'gui',
    phase: 'gui.event_released',
    status: 'ok',
    metadata: {
      event_id: envelope.eventId,
      event_type: envelope.type,
      lane: envelope.lane,
      phase: envelope.phase,
      message_id: envelope.messageId,
      release_seq: envelope.releaseSeq,
    },
  });
}

function defaultLaneFor(type: string): GuiEventLane {
  if (type === 'narrate:quarantined' || type === 'turn.error') return 'status';
  if (
    type === 'runtime:field' ||
    type === 'inventory:changed' ||
    type === 'currency:changed'
  ) return 'rail';
  if (type.startsWith('dice:')) return 'pre_response';
  if (type.startsWith('quest_pacer:')) return 'post_response';
  return 'post_response';
}

function defaultPhaseFor(type: string): GuiEventPhase {
  if (
    type.startsWith('quest_pacer:') ||
    type === 'memory:enriched' ||
    type === 'entity:duplicate_warning' ||
    type === 'movement:teleport_detected' ||
    type === 'companion:auto_departed'
  ) {
    return 'post_turn';
  }
  if (type === 'narrate:quarantined' || type === 'turn.error') return 'support';
  if (type === 'narrate') return 'narration';
  return 'mutation';
}

function defaultDisplayPolicyFor(
  lane: GuiEventLane,
  messageId: number | null,
): Record<string, unknown> {
  if (lane === 'rail') return {lane: 'rail_only', anchor: 'none'};
  if (messageId != null) return {lane, anchor: 'message_id'};
  return {lane, anchor: 'turn_id'};
}

async function resolveAssistantMessageIdForEvent(
  sessionId: string,
  turnId: string | null,
  lane: GuiEventLane,
  phase: GuiEventPhase,
  opts: EmitGuiEventOptions,
): Promise<number | null> {
  if (!turnId || !shouldAutoAnchorToAssistant(lane, phase, opts)) return null;
  const rows = await query<{id: number | string}>(
    `SELECT id
       FROM chat_messages
      WHERE session_id = $1
        AND payload->>'turn_id' = $2
        AND tone <> 'player'
      ORDER BY turn_index DESC, id DESC
      LIMIT 1`,
    [sessionId, turnId],
  );
  const id = Number(rows.rows[0]?.id ?? NaN);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function shouldAutoAnchorToAssistant(
  lane: GuiEventLane,
  phase: GuiEventPhase,
  opts: EmitGuiEventOptions,
): boolean {
  const explicitAnchor = opts.displayPolicy?.['anchor'];
  if (explicitAnchor === 'none') return false;
  if (lane === 'rail') return false;
  if (phase === 'support') return false;
  return lane === 'post_response' || phase === 'post_turn' || lane === 'status';
}

function shouldWaitForActiveAssistantAnchor(
  sessionId: string,
  turnId: string | null,
  lane: GuiEventLane,
  phase: GuiEventPhase,
  opts: EmitGuiEventOptions,
  messageId: number | null,
): boolean {
  if (opts.deferRelease === true) return false;
  if (opts.status === 'pending') return false;
  if (messageId != null || !turnId) return false;
  if (!shouldAutoAnchorToAssistant(lane, phase, opts)) return false;
  const activeTurn = sessionManager.get(sessionId)?.activeTurn;
  return activeTurn?.turnId === turnId;
}
