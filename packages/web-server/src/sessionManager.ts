/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SessionManager — multi-tenant Map-based registry of live Sessions.
//
// Post-cleanup: the inherited Config / Scheduler /
// ConfirmationBridge bootstrap is gone. A Session now carries only
// the AI-SDK-side state needed by turnRunnerV2:
//   - id, cwd, lastActivityAt
//   - SSE bridge for streaming events to the web-ui
//   - RunnerProviders (broker + narrator LanguageModels), built lazily
//   - activeTurn handle so /cancel can abort in-flight work
//
// SessionManager.getOrCreate(id?, playerId) is idempotent on the id
// only for the owning player. A janitor
// sweeps idle Sessions every 30 minutes (idle = >2h since last
// activity AND no live SSE subscribers AND no activeTurn).

import {randomUUID} from 'node:crypto';
import type {Mode} from './ai/classifier.js';
import type {RoleConfig, RunnerProviders} from './ai/providers.js';
import {buildProviders} from './ai/providers.js';
import {query} from './db.js';
import type {PresentationBarrier} from './presentationScheduler.js';
import {SseBridge} from './sseBridge.js';
import {telemetry} from './telemetry/index.js';

export interface SessionSnapshot {
  sessionId: string;
  cwd: string;
  ready: boolean;
  playerId?: number | null;
  brokerModelId?: string;
  narratorModelId?: string;
}

export type ToolHistorySource = 'ai_sdk' | 'direct' | 'batch_child';

export interface ToolHistoryEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  source: ToolHistorySource;
  result?: unknown;
  error?: string;
  batch_id?: string;
  operation_id?: string;
}

export class SessionOwnershipError extends Error {
  readonly status = 403;

  constructor(sessionId: string) {
    super(`Session ${sessionId} belongs to a different player`);
    this.name = 'SessionOwnershipError';
  }
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly sse: SseBridge;
  playerId: number | null;
  // Mutable so settings UI can swap models without restarting the
  // server. Replaced wholesale via setProviders(). Built lazily —
  // DEEPSEEK_API_KEY may be absent at boot for routes that don't drive
  // a turn; ensureProviders() checks.
  providers: RunnerProviders | undefined;

  /** Wall-clock of last attached turn — drives janitor idleness check. */
  lastActivityAt: number;

  /**
   * The currently-running turn, if any. We allow only ONE concurrent
   * turn per session — a second POST /turn rejects with 409 Conflict.
   * The controller is exposed so /cancel can abort in-flight work.
   */
  activeTurn?: {
    turnId: string;
    /** Durable turn_ingress_queue.id when this turn came from the queue. */
    queueId?: number;
    abortController: AbortController;
    startedAt: number;
    /**
     * Resolves when the async turn runner has finished its cleanup.
     * Session reset uses this to wait briefly for an aborted turn before
     * deleting session-scoped rows.
     */
    done?: Promise<void>;
    /**
     * Set by session reset before aborting the turn. The runner uses it
     * to suppress stale turn.end/post-turn work after the visible session
     * has been wiped.
     */
    resetRequestedAt?: number;
    /**
     * Set by the turn watchdog when provider work exceeds the runtime
     * deadline. Late async work must not append visible state after this.
     */
    timeoutRequestedAt?: number;
    timeoutReason?: string;
    /**
     * Set true the moment the model's response stream produces its
     * first content delta. Reserved for narrate to skip a synthetic
     * re-emit when the natural stream already wrote prose.
     */
    streamedContent?: boolean;
    streamSeq?: number;
    finalMessageId?: number;
    /**
     * Spec 19 — when broker offers a Devil's Bargain mid-turn it
     * stashes the player's accept/reject decision here for the
     * downstream dice_check to read. Idempotent on bargainId.
     */
    pendingBargain?: {bargainId: string; accepted: boolean};
    /**
     * Spec 22 — append-only log of the broker's tool calls for this
     * turn. questEngine.evaluateActiveQuests reads this to evaluate
     * `tool_called` objectives. Cleared with the activeTurn handle on
     * turn.end.
     *
     * Spec 39 — Quest Watcher (postTurnPhase specialist) also reads
     * this to decide whether the player completed a stage's
     * objective.
     */
    toolHistory?: ToolHistoryEntry[];
    /**
     * Spec 39 — accumulated visible narrative for the turn (every
     * `narrate.text` arg concatenated). Quest Watcher reads this at
     * turn.end to decide stage progression based on what the player
     * actually saw, not just what tools fired.
     */
    narrativeBuffer?: string;
    /** Last classified gameplay mode for post-turn deterministic systems. */
    mode?: string;
    /** Broker profile selected for this turn, for profile-scoped guards. */
    brokerToolProfile?: string;
    /** Effective player/UI language for post-turn deterministic systems. */
    language?: string;
    /** Turn ended with a technical fail-open bubble; skip post-turn systems. */
    suppressPostTurn?: boolean;
  };

  /**
   * Spec 82 foundation. Open while post-turn presentation work for the
   * previous visible turn is still forming. `/turn` rejects new visible
   * turns while this is open; Spec 83 will replace the rejection with a
   * durable ingress queue.
   */
  presentationBarrier?: PresentationBarrier;

  /**
   * USER-3 — most-recently-completed turn's broker tool history.
   * `postTurnPipeline` snapshots `activeTurn.toolHistory` into this
   * field just before clearing `activeTurn`, so the NEXT turn's
   * `evaluateActiveQuests` call sees the prior turn's tool calls
   * (the only history that can carry `tool_called` quest objective
   * progress). Reset/cancel paths wipe it back to `[]`.
   *
   * Initialised to `[]` so the very first turn's quest evaluation
   * reads an empty array, not `undefined` — every reader is the
   * questEngine which expects a `ToolHistoryEntry[]`.
   */
  lastTurnToolHistory: ToolHistoryEntry[] = [];

  /**
   * S-10 — last gameplay mode dispatched by `TurnDispatchPreparationPhase`.
   * Used to gate `mode:changed` SSE + combat/ambient side effects on
   * actual transitions (vs same-mode turns). Cleared on session reset
   * so the next turn after a reset treats the previous mode as absent
   * and re-fires `mode:changed` with `prev = null`. This replaces the
   * previous module-scoped `WeakMap<Session, ...>` in
   * `turn/dispatchPrep.ts`; semantics are identical.
   */
  turnModeState: {lastMode?: Mode} = {};

  /** Turn ids invalidated by session reset while their async work unwinds. */
  resetTurnIds = new Set<string>();

  private disposed = false;

  constructor(opts: {id: string; cwd: string; playerId: number | null}) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.playerId = opts.playerId;
    this.sse = new SseBridge({sessionId: opts.id});
    // Providers built lazily — DEEPSEEK_API_KEY may be absent at boot
    // for routes that don't drive a turn. ensureProviders() checks.
    this.providers = undefined;
    this.lastActivityAt = Date.now();
  }

  ensureProviders(): RunnerProviders {
    if (!this.providers || !this.providers.broker) {
      this.providers = buildProviders();
    }
    return this.providers;
  }

  setProviders(opts: {
    broker?: Partial<RoleConfig>;
    narrator?: Partial<RoleConfig>;
  }): RunnerProviders {
    this.providers = buildProviders(opts);
    return this.providers;
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      ready: true,
      playerId: this.playerId,
      brokerModelId: this.providers?.brokerModelId,
      narratorModelId: this.providers?.narratorModelId,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.sse.closeAll();
  }
}

const JANITOR_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

function normalizePlayerId(value: number | string | null): number | null {
  if (value === null) return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

class SessionManager {
  private sessions = new Map<string, Session>();
  private creating = new Map<string, Promise<Session>>();
  private janitorTimer?: NodeJS.Timeout;

  /**
   * Look up an existing session OR create a new one.
   * - sessionId provided + present → return existing.
   * - sessionId provided + absent → boot with that id.
   * - sessionId omitted → mint a fresh UUID and boot.
   */
  async getOrCreate(sessionId: string | undefined, playerId: number): Promise<Session> {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        await this.assertAndClaimLiveSession(existing, playerId);
        existing.lastActivityAt = Date.now();
        return existing;
      }
    }
    const id = sessionId ?? randomUUID();
    const inflight = this.creating.get(id);
    if (inflight) {
      const session = await inflight;
      await this.assertAndClaimLiveSession(session, playerId);
      return session;
    }

    const promise = this.bootSession(id, playerId);
    this.creating.set(id, promise);
    try {
      const session = await promise;
      this.sessions.set(id, session);
      this.scheduleJanitor();
      return session;
    } finally {
      this.creating.delete(id);
    }
  }

  private async bootSession(id: string, playerId: number): Promise<Session> {
    const cwd = process.cwd();
    const existing = await query<{player_id: number | string | null}>(
      `SELECT player_id
       FROM sessions
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    const row = existing.rows[0];
    if (row) {
      const owner = normalizePlayerId(row.player_id);
      if (owner !== null && owner !== playerId) {
        throw new SessionOwnershipError(id);
      }
      if (owner === null) {
        await this.assertStoredSessionAdoptable(id, playerId);
        await this.claimStoredSession(id, playerId);
      }
      return new Session({id, cwd, playerId});
    }

    await query(
      `INSERT INTO sessions (id, metadata, player_id)
       VALUES ($1, '{}'::jsonb, $2)`,
      [id, playerId],
    );
    return new Session({id, cwd, playerId});
  }

  async getOwned(id: string, playerId: number): Promise<Session | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    await this.assertAndClaimLiveSession(s, playerId);
    s.lastActivityAt = Date.now();
    return s;
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastActivityAt = Date.now();
    return s;
  }

  async destroy(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    // Abort any active turn to prevent wasted LLM calls and zombie
    // queue rows on an orphaned session (GH-BUG-095).
    if (session.activeTurn) {
      try {
        session.activeTurn.abortController.abort(
          new Error('session destroyed'),
        );
      } catch {
        // AbortController may already be closed.
      }
    }
    await session.dispose();
    this.sessions.delete(id);
    return true;
  }

  private async assertAndClaimLiveSession(
    session: Session,
    playerId: number,
  ): Promise<void> {
    if (session.playerId !== null && session.playerId !== playerId) {
      throw new SessionOwnershipError(session.id);
    }
    if (session.playerId === null) {
      await this.assertStoredSessionAdoptable(session.id, playerId);
      await this.claimStoredSession(session.id, playerId);
      session.playerId = playerId;
    }
  }

  private async claimStoredSession(
    sessionId: string,
    playerId: number,
  ): Promise<void> {
    const updated = await query<{player_id: number | string | null}>(
      `UPDATE sessions
       SET player_id = $2
       WHERE id = $1 AND player_id IS NULL
       RETURNING player_id`,
      [sessionId, playerId],
    );
    if (updated.rows.length > 0) return;

    const current = await query<{player_id: number | string | null}>(
      `SELECT player_id
       FROM sessions
       WHERE id = $1
       LIMIT 1`,
      [sessionId],
    );
    if (normalizePlayerId(current.rows[0]?.player_id ?? null) !== playerId) {
      throw new SessionOwnershipError(sessionId);
    }
  }

  private async assertStoredSessionAdoptable(
    sessionId: string,
    playerId: number,
  ): Promise<void> {
    // DEEP-11 — single adoption guard. Before checking the chat /
    // tool-invocation history for foreign-owner traces, re-read
    // the canonical `sessions.player_id` row itself: a non-null
    // owner that differs from the requesting player makes the
    // session non-adoptable, even when no messages have been
    // written yet. Callers (`bootSession`,
    // `assertAndClaimLiveSession`) already do an equivalent
    // pre-check, but pushing it into the guard means any future
    // caller that invokes the adoption flow without that
    // pre-check still cannot adopt a foreign-owned row.
    const stored = await query<{player_id: number | string | null}>(
      `SELECT player_id
       FROM sessions
       WHERE id = $1
       LIMIT 1`,
      [sessionId],
    );
    const storedOwner = normalizePlayerId(stored.rows[0]?.player_id ?? null);
    if (storedOwner !== null && storedOwner !== playerId) {
      throw new SessionOwnershipError(sessionId);
    }
    const blockers = await query<{count: number | string}>(
      `SELECT COUNT(*)::int AS count
       FROM (
         SELECT 1
         FROM chat_messages cm
         WHERE cm.session_id = $1
           AND (
             (cm.player_id IS NOT NULL AND cm.player_id <> $2)
             OR EXISTS (
               SELECT 1
               FROM players p
               WHERE p.entity_id = cm.author_entity_id
                 AND cm.author_entity_id <> $2
             )
           )
         LIMIT 1
       ) chat_owner
       UNION ALL
       SELECT COUNT(*)::int AS count
       FROM (
         SELECT 1
         FROM tool_invocations ti
         WHERE ti.session_id = $1
           AND ti.player_id IS NOT NULL
           AND ti.player_id <> $2
         LIMIT 1
       ) tool_owner`,
      [sessionId, playerId],
    );
    const hasOtherOwner = blockers.rows.some(row => Number(row.count) > 0);
    if (hasOtherOwner) {
      throw new SessionOwnershipError(sessionId);
    }
  }

  count(): number {
    return this.sessions.size;
  }

  /** Iterable over (id, session) pairs — for debug routes that need
   *  to enumerate live sessions. */
  entries(): IterableIterator<[string, Session]> {
    return this.sessions.entries();
  }

  /** Dispose every live session. Used by /api/debug/reset-world. */
  async destroyAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.destroy(id);
    }
  }

  private scheduleJanitor(): void {
    if (this.janitorTimer) return;
    this.janitorTimer = setInterval(() => {
      // VOID-FF-OK: fire-and-forget janitor tick; `.catch(...)` below records the failure through the gameplay telemetry channel so the operator sees the sweep error without blocking the timer.
      void this.sweep().catch(err =>
        telemetry.record({
          channel: 'gameplay',
          name: 'session_manager.janitor_sweep_failed',
          error: err,
          data: {
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    }, JANITOR_INTERVAL_MS);
    this.janitorTimer.unref?.();
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - IDLE_THRESHOLD_MS;
    for (const [id, session] of this.sessions) {
      if (session.activeTurn) continue;
      if (session.sse.clientCount > 0) continue;
      if (session.lastActivityAt >= cutoff) continue;
      try {
        await session.dispose();
        this.sessions.delete(id);
        console.log(`[sessionManager] janitor disposed idle session ${id}`);
      } catch (err) {
        telemetry.record({
          channel: 'gameplay',
          name: 'session_manager.janitor_dispose_failed',
          sessionId: id,
          error: err,
          data: {
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }
}

export const sessionManager = new SessionManager();
