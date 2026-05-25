/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 82/86 foundation: in-memory presentation barrier plus durable
// post-turn slot placeholders in gui_events.
//
// Durable slot release still belongs to the next pass, but this barrier
// already prevents the most visible ordering bug: a new chat turn cannot
// start while previous post-turn specialists are still forming
// chat-visible cards for the just-finished turn.

import {query} from './db.js';
import {
  emitGuiEvent,
  releaseGuiEvent,
  type EmitGuiEventOptions,
  type GuiEventEnvelope,
  type GuiEventLane,
} from './guiEventOutbox.js';
import type {Session} from './sessionManager.js';
import {telemetry} from './telemetry/index.js';

export interface PresentationBarrier {
  id: string;
  turnId: string;
  openedAt: number;
  /**
   * S-14 — wall-clock cap of last resort. The barrier no longer
   * expires on the short per-hook deadline (that produced phantom
   * expiries when the event loop or GC paused for more than a few
   * seconds). The orchestrator's slot-resolution path remains the
   * primary close trigger; this is only the dead-service fallback,
   * defaulted to 5 minutes from `openedAt`.
   */
  fallbackDeadlineAt: number;
  /**
   * S-14 — snapshot of `gui_events.release_seq` at the moment the
   * barrier opened. Pure diagnostic: lets ops correlate which post-
   * turn presentation activity was outstanding when the barrier was
   * waiting. `null` when the helper read failed or the session has
   * never released a GUI event before.
   */
  openedReleaseSeq: number | null;
  pendingVisibleSlots: number;
  state: 'open' | 'closed' | 'expired';
  reason?: string;
}

export interface PostTurnPresentationMeta {
  slotKey: string;
  lane: 'post_response' | 'status' | 'rail';
  ordinal: number;
  visible: boolean;
  barrierMode: 'chat_visible' | 'non_blocking';
  deadlineMs: number;
}

export interface ReservedPresentationSlot {
  slotId: number;
  sessionId: string;
  playerId: number;
  turnId: string;
  hookName: string;
  meta: PostTurnPresentationMeta;
}

export interface PresentationHandle {
  slotId: number;
  slotKey: string;
  emit(
    type: string,
    payload: Record<string, unknown>,
    opts?: EmitGuiEventOptions,
  ): Promise<GuiEventEnvelope | null>;
  skip(reason?: string): Promise<void>;
  fail(error: unknown, visibleDiagnostic?: boolean): Promise<void>;
}

export interface PresentationSlotSnapshot {
  slotId: number;
  sessionId: string;
  turnId: string | null;
  hookName: string;
  slotKey: string;
  ordinal: number;
  lane: string;
  barrierMode: string;
  status: string;
  slotStatus: string;
  reason: string | null;
  emittedEventIds: number[];
  ageMs: number;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * S-14 — 5-minute hard cap for the dead-service fallback. The
 * orchestrator's slot-resolution path is expected to close the
 * barrier well before this deadline; the fallback only protects
 * against a hook that never settles (no telemetry, no failure)
 * so queued turns can eventually drain.
 */
const DEFAULT_PRESENTATION_FALLBACK_MS = 5 * 60_000;

export function openPresentationBarrier(
  session: Session,
  opts: {
    turnId: string;
    pendingVisibleSlots: number;
    /**
     * S-14 — optional override for the dead-service fallback. The
     * legacy short-deadline `deadlineMs` callers pass is still
     * accepted but is intentionally ignored for the close path;
     * see `fallbackDeadlineMs` for the new cap.
     */
    fallbackDeadlineMs?: number;
    /** @deprecated S-14 — short per-hook deadline no longer drives barrier close. */
    deadlineMs?: number;
    openedReleaseSeq?: number | null;
  },
): PresentationBarrier {
  const now = Date.now();
  const fallbackMs = opts.fallbackDeadlineMs ?? DEFAULT_PRESENTATION_FALLBACK_MS;
  const barrier: PresentationBarrier = {
    id: `${opts.turnId}:post-turn`,
    turnId: opts.turnId,
    openedAt: now,
    fallbackDeadlineAt: now + fallbackMs,
    openedReleaseSeq: opts.openedReleaseSeq ?? null,
    pendingVisibleSlots: opts.pendingVisibleSlots,
    state: 'open',
  };
  session.presentationBarrier = barrier;
  return barrier;
}

export function closePresentationBarrier(
  session: Session,
  barrierId: string,
  reason = 'resolved',
): void {
  const current = session.presentationBarrier;
  if (!current || current.id !== barrierId) return;
  current.state = 'closed';
  current.reason = reason;
  session.presentationBarrier = undefined;
}

export function expirePresentationBarrier(
  session: Session,
  barrierId: string,
  reason = 'deadline_exceeded',
): void {
  const current = session.presentationBarrier;
  if (!current || current.id !== barrierId) return;
  current.state = 'expired';
  current.reason = reason;
  session.presentationBarrier = undefined;
}

export function currentPresentationBarrier(
  session: Session,
): PresentationBarrier | null {
  const current = session.presentationBarrier;
  if (!current) return null;
  if (current.state !== 'open') return null;
  // S-14 — only the 5-minute dead-service fallback can expire an
  // open barrier here. The orchestrator's slot-resolution path is
  // the canonical close trigger and runs through
  // `closePresentationBarrier(...)`; an event-loop or GC pause that
  // would have tripped the old short wall-clock deadline must NOT
  // phantom-release queued turns while real post-turn work is still
  // unresolved.
  if (Date.now() > current.fallbackDeadlineAt) {
    expirePresentationBarrier(
      session,
      current.id,
      'fallback_deadline_exceeded',
    );
    return null;
  }
  return current;
}

export async function reservePostTurnPresentationSlots(
  opts: {
    sessionId: string;
    playerId: number;
    turnId: string;
  },
  hooks: Array<{name: string; presentation: PostTurnPresentationMeta}>,
): Promise<ReservedPresentationSlot[]> {
  const slots: ReservedPresentationSlot[] = [];
  const now = Date.now();
  for (const hook of hooks) {
    const expiresAt = new Date(now + hook.presentation.deadlineMs).toISOString();
    const inserted = await query<{
      id: number | string;
    }>(
      `INSERT INTO gui_events
         (session_id, player_id, turn_id, lane, phase, event_type, status,
          dedupe_key, display_policy, payload, expires_at)
       VALUES ($1, $2, $3, $4, 'post_turn', 'presentation:slot', 'pending',
               $5, $6::jsonb, $7::jsonb, $8::timestamptz)
       ON CONFLICT (session_id, dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET status = 'pending',
                     lane = EXCLUDED.lane,
                     display_policy = EXCLUDED.display_policy,
                     payload = EXCLUDED.payload,
                     expires_at = EXCLUDED.expires_at,
                     ready_at = NULL,
                     released_at = NULL
       RETURNING id`,
      [
        opts.sessionId,
        opts.playerId,
        opts.turnId,
        hook.presentation.lane,
        presentationSlotDedupeKey(opts.turnId, hook.presentation.slotKey),
        JSON.stringify({
          hidden: true,
          slot: true,
          slotKey: hook.presentation.slotKey,
          hookName: hook.name,
          ordinal: hook.presentation.ordinal,
          barrierMode: hook.presentation.barrierMode,
        }),
        JSON.stringify({
          slot_status: 'pending',
          slot_key: hook.presentation.slotKey,
          hook_name: hook.name,
          ordinal: hook.presentation.ordinal,
          barrier_mode: hook.presentation.barrierMode,
          deadline_ms: hook.presentation.deadlineMs,
          visible: hook.presentation.visible,
          emitted_event_ids: [],
        }),
        expiresAt,
      ],
    );
    slots.push({
      slotId: Number(inserted.rows[0]!.id),
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      turnId: opts.turnId,
      hookName: hook.name,
      meta: hook.presentation,
    });
  }
  return slots;
}

export async function runPostTurnHookWithPresentation(
  slot: ReservedPresentationSlot,
  run: (ctx: {presentation: PresentationHandle}) => Promise<void>,
): Promise<{slotId: number; status: string; durationMs: number}> {
  const startedAt = Date.now();
  const eventIds: number[] = [];
  let closed = false;
  let closeStatus = 'pending';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const complete = async (
    slotStatus: 'emitted' | 'skipped' | 'failed' | 'expired',
    reason: string,
    visibleDiagnostic = true,
  ): Promise<void> => {
    if (closed) return;
    closed = true;
    closeStatus = slotStatus;
    if (timer) clearTimeout(timer);
    if (slotStatus === 'emitted') {
      await resolvePresentationSlot(
        slot,
        'dead',
        slotStatus,
        reason,
        eventIds,
        Date.now() - startedAt,
      );
      await releaseReadyPostTurnEvents(slot.sessionId, slot.turnId);
      return;
    }
    if (slotStatus === 'skipped') {
      await resolvePresentationSlot(
        slot,
        'dead',
        slotStatus,
        reason,
        eventIds,
        Date.now() - startedAt,
      );
      await releaseReadyPostTurnEvents(slot.sessionId, slot.turnId);
      return;
    }
    if (visibleDiagnostic && slot.meta.barrierMode === 'chat_visible') {
      const diagnostic = await emitGuiEvent(
        {
          sessionId: slot.sessionId,
          playerId: slot.playerId,
          turnId: slot.turnId,
        },
        'post_turn:slot_failed',
        {
          slotId: slot.slotId,
          slotKey: slot.meta.slotKey,
          hookName: slot.hookName,
          status: slotStatus,
          reason,
          deadlineMs: slot.meta.deadlineMs,
        },
        {
          lane: 'status',
          phase: 'post_turn',
          dedupeKey: `post-turn-slot-failed:${slot.turnId}:${slot.meta.slotKey}`,
          displayPolicy: {
            lane: 'status',
            anchor: 'turn_id',
            slotId: slot.slotId,
            slotKey: slot.meta.slotKey,
          },
          deferRelease: true,
        },
      );
      if (diagnostic) {
        eventIds.push(diagnostic.eventId);
      }
    }
    await resolvePresentationSlot(
      slot,
      'failed',
      slotStatus,
      reason,
      eventIds,
      Date.now() - startedAt,
    );
    await releaseReadyPostTurnEvents(slot.sessionId, slot.turnId);
  };

  const handle: PresentationHandle = {
    slotId: slot.slotId,
    slotKey: slot.meta.slotKey,
    async emit(type, payload, opts = {}) {
      if (closed) {
        console.warn(
          `[presentationSlot ${slot.slotId}] suppressing late ${type} after ${closeStatus}`,
        );
        return null;
      }
      const chatVisible = slot.meta.barrierMode === 'chat_visible';
      const envelope = await emitGuiEvent(
        {
          sessionId: slot.sessionId,
          playerId: slot.playerId,
          turnId: slot.turnId,
        },
        type,
        payload,
        {
          ...opts,
          lane: opts.lane ?? (slot.meta.lane as GuiEventLane),
          phase: opts.phase ?? 'post_turn',
          displayPolicy: {
            ...(opts.displayPolicy ?? {}),
            slotId: slot.slotId,
            slotKey: slot.meta.slotKey,
            slotOrdinal: slot.meta.ordinal,
            hookName: slot.hookName,
          },
          deferRelease: opts.deferRelease ?? chatVisible,
        },
      );
      if (envelope) eventIds.push(envelope.eventId);
      if (!chatVisible) {
        closed = true;
        closeStatus = 'emitted';
        if (timer) clearTimeout(timer);
        await resolvePresentationSlot(
          slot,
          'dead',
          'emitted',
          `emitted:${type}`,
          eventIds,
          Date.now() - startedAt,
        );
      }
      return envelope;
    },
    async skip(reason = 'no_visible_change') {
      await complete('skipped', reason, false);
    },
    async fail(error, visibleDiagnostic = true) {
      await complete('failed', errorMessage(error), visibleDiagnostic);
    },
  };

  const deadline = new Promise<{slotId: number; status: string; durationMs: number}>(
    resolve => {
      timer = setTimeout(() => {
        // VOID-FF-OK: deadline timer; `complete()` is itself a deterministic recorder that resolves through `.finally` below, so a rejection inside it cannot escape the slot lifecycle.
        void complete(
          eventIds.length > 0 ? 'emitted' : 'expired',
          eventIds.length > 0 ? 'deadline_after_event' : 'deadline_exceeded',
          true,
        ).finally(() =>
          resolve({
            slotId: slot.slotId,
            status: eventIds.length > 0 ? 'emitted' : 'expired',
            durationMs: Date.now() - startedAt,
          }),
        );
      }, Math.max(1, slot.meta.deadlineMs));
    },
  );

  const work = Promise.resolve()
    .then(() => run({presentation: handle}))
    .then(async () => {
      await complete(
        eventIds.length > 0 ? 'emitted' : 'skipped',
        eventIds.length > 0 ? 'emitted' : 'completed_without_visible_event',
        false,
      );
      return {
        slotId: slot.slotId,
        status: eventIds.length > 0 ? 'emitted' : 'skipped',
        durationMs: Date.now() - startedAt,
      };
    })
    .catch(async err => {
      await complete('failed', errorMessage(err), true);
      return {
        slotId: slot.slotId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
      };
    });

  return Promise.race([work, deadline]);
}

export async function releaseReadyPostTurnEvents(
  sessionId: string,
  turnId: string,
): Promise<void> {
  const slots = await listPostTurnPresentationSlots(sessionId, {turnId});
  for (const slot of slots
    .filter(s => s.barrierMode === 'chat_visible')
    .sort((a, b) => a.ordinal - b.ordinal || a.slotId - b.slotId)) {
    if (slot.slotStatus === 'pending') return;
    for (const eventId of slot.emittedEventIds) {
      await releaseGuiEvent(eventId);
    }
  }
}

export async function listPostTurnPresentationSlots(
  sessionId: string,
  opts: {turnId?: string | null; unresolvedOnly?: boolean} = {},
): Promise<PresentationSlotSnapshot[]> {
  const params: unknown[] = [sessionId];
  let where = `WHERE session_id = $1 AND event_type = 'presentation:slot'`;
  if (opts.turnId) {
    params.push(opts.turnId);
    where += ` AND turn_id = $${params.length}`;
  }
  if (opts.unresolvedOnly) {
    where += ` AND status = 'pending'`;
  }
  const rows = await query<{
    id: number | string;
    session_id: string;
    turn_id: string | null;
    lane: string;
    status: string;
    payload: Record<string, unknown> | null;
    expires_at: string | null;
    created_at: string;
    age_ms: number | string;
  }>(
    `SELECT id, session_id, turn_id, lane, status, payload,
            expires_at::text AS expires_at,
            created_at::text AS created_at,
            (EXTRACT(EPOCH FROM (now() - created_at)) * 1000)::int AS age_ms
       FROM gui_events
       ${where}
      ORDER BY (payload->>'ordinal')::int ASC, id ASC`,
    params,
  );
  return rows.rows.map(row => {
    const payload = row.payload ?? {};
    return {
      slotId: Number(row.id),
      sessionId: row.session_id,
      turnId: row.turn_id,
      hookName: String(payload['hook_name'] ?? ''),
      slotKey: String(payload['slot_key'] ?? ''),
      ordinal: Number(payload['ordinal'] ?? 0),
      lane: row.lane,
      barrierMode: String(payload['barrier_mode'] ?? 'chat_visible'),
      status: row.status,
      slotStatus: String(payload['slot_status'] ?? 'pending'),
      reason:
        typeof payload['reason'] === 'string'
          ? (payload['reason'] as string)
          : null,
      emittedEventIds: Array.isArray(payload['emitted_event_ids'])
        ? (payload['emitted_event_ids'] as unknown[])
            .map(Number)
            .filter(Number.isFinite)
        : [],
      ageMs: Number(row.age_ms ?? 0),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  });
}

async function resolvePresentationSlot(
  slot: ReservedPresentationSlot,
  eventStatus: 'dead' | 'failed',
  slotStatus: 'emitted' | 'skipped' | 'failed' | 'expired',
  reason: string,
  emittedEventIds: number[],
  durationMs: number,
): Promise<void> {
  await recordPresentationSlotTelemetry(slot, slotStatus, durationMs);
  await query(
    `UPDATE gui_events
        SET status = $2,
            ready_at = COALESCE(ready_at, now()),
            payload = payload || $3::jsonb
      WHERE id = $1
        AND event_type = 'presentation:slot'
        AND status = 'pending'`,
    [
      slot.slotId,
      eventStatus,
      JSON.stringify({
        slot_status: slotStatus,
        reason,
        resolved_at: new Date().toISOString(),
        duration_ms: Math.max(0, durationMs),
        emitted_event_ids: emittedEventIds,
      }),
    ],
  );
}

async function recordPresentationSlotTelemetry(
  slot: ReservedPresentationSlot,
  slotStatus: 'emitted' | 'skipped' | 'failed' | 'expired',
  durationMs: number,
): Promise<void> {
  try {
    await query(
      `INSERT INTO turn_telemetry
         (session_id, turn_id, role, model_id, thinking, input_tokens,
          output_tokens, cache_hit_tokens, cache_miss_tokens, duration_ms,
          cost_usd, player_id, tier, slot_id, slot_key, slot_status,
          deadline_ms, expired)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        slot.sessionId,
        slot.turnId,
        `presentation_slot:${slot.hookName}`,
        'presentation-scheduler',
        false,
        0,
        0,
        0,
        0,
        Math.max(0, Math.trunc(durationMs)),
        0,
        slot.playerId,
        null,
        slot.slotId,
        slot.meta.slotKey,
        slotStatus,
        slot.meta.deadlineMs,
        slotStatus === 'expired',
      ],
    );
  } catch (err) {
    // CATCH-WARN-OK: this catch wraps the SQL write to `presentation_slot_telemetry`; the immediately-following `telemetry.record({channel: 'performance', name: post_turn.${slot.hookName}})` call records the same slot status through the facade, so the operator already sees the slot outcome even when the secondary table write fails.
    console.warn(
      '[presentationSlot.telemetry] write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
  telemetry.record({
    channel: 'performance',
    name: `post_turn.${slot.hookName}`,
    sessionId: slot.sessionId,
    playerId: slot.playerId,
    turnId: slot.turnId,
    traceId: slot.turnId,
    kind: 'agent',
    phase: `post_turn.${slot.hookName}`,
    status: slotStatus === 'emitted' || slotStatus === 'skipped' ? 'ok' : slotStatus,
    durationMs,
    metadata: {
      slot_id: slot.slotId,
      slot_key: slot.meta.slotKey,
      slot_status: slotStatus,
      ordinal: slot.meta.ordinal,
      barrier_mode: slot.meta.barrierMode,
      deadline_ms: slot.meta.deadlineMs,
    },
  });
}

function presentationSlotDedupeKey(turnId: string, slotKey: string): string {
  return `presentation-slot:${turnId}:${slotKey}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
