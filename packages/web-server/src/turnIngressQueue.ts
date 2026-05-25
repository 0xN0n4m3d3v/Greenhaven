/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 83 foundation: durable turn ingress queue.

import {randomUUID} from 'node:crypto';
import {query, type TxClient, withTransaction} from './db.js';
import type {Session} from './sessionManager.js';
import {currentPresentationBarrier} from './presentationScheduler.js';
import type {TurnHandle, TurnInput} from './turnRunnerV2.js';

export const MAX_QUEUED_PER_SESSION = 3;
const STUCK_QUEUE_AGE_MS = 5 * 60 * 1000;

export interface TurnQueueRow {
  id: number;
  sessionId: string;
  playerId: number;
  turnId: string;
  status: 'queued' | 'starting' | 'running' | 'done' | 'cancelled' | 'failed';
  text: string;
  actionId: string | null;
  language: string | null;
  queueIndex: number;
  visibleAfterTurnId: string | null;
}

export interface TurnQueueSnapshotRow extends TurnQueueRow {
  clientRequestId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  ageMs: number;
  runningAgeMs: number | null;
  position: number;
  stuck: boolean;
}

export interface EnqueueTurnResult {
  row: TurnQueueRow;
  reused: boolean;
  position: number;
}

// DEEP-8 — per-session in-process mutex for enqueueTurn. Two
// concurrent POST /api/session/:id/turn requests for the same session
// must not race the countQueued -> nextQueueIndex -> INSERT triplet.
// On managed Postgres the SELECT ... FOR UPDATE inside the tx
// serialises us; on PGlite (single shared connection across the
// process) a JS-level mutex is the only safe way to keep transaction
// isolation. Keeping the mutex on both backends makes the contract
// identical and reduces unique-index contention noise on pg.
const enqueueMutex = new Map<string, Promise<unknown>>();

async function withSessionEnqueueLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = enqueueMutex.get(sessionId) ?? Promise.resolve();
  const next: Promise<T> = prev.catch(() => undefined).then(fn);
  enqueueMutex.set(sessionId, next);
  try {
    return await next;
  } finally {
    if (enqueueMutex.get(sessionId) === next) {
      enqueueMutex.delete(sessionId);
    }
  }
}

export async function enqueueTurn(opts: {
  sessionId: string;
  playerId: number;
  text: string;
  actionId?: string;
  language?: string;
  clientRequestId?: string;
  visibleAfterTurnId?: string | null;
}): Promise<EnqueueTurnResult> {
  // Fast pre-check outside the lock/tx — a clientRequestId that's
  // already known returns without paying the per-session serialisation
  // cost. We re-check inside the tx (after the row lock) so a true
  // concurrent retry of the same clientRequestId still resolves to a
  // single durable row.
  if (opts.clientRequestId) {
    const prior = await findByClientRequest(
      opts.sessionId,
      opts.clientRequestId,
    );
    if (prior) {
      return {
        row: prior,
        reused: true,
        position: await queuePosition(opts.sessionId, prior.turnId),
      };
    }
  }

  return withSessionEnqueueLock(opts.sessionId, async () => {
    const enqueued = await withTransaction(async tx => {
      await lockSessionQueueTx(tx, opts.sessionId);

      if (opts.clientRequestId) {
        const prior = await findByClientRequestTx(
          tx,
          opts.sessionId,
          opts.clientRequestId,
        );
        if (prior) return {row: prior, reused: true};
      }

      const queued = await countQueuedTx(tx, opts.sessionId);
      if (queued >= MAX_QUEUED_PER_SESSION) {
        throw new Error('queue_full');
      }

      const idx = await nextQueueIndexTx(tx, opts.sessionId);
      const inserted = await tx.query<QueueDbRow>(
        `INSERT INTO turn_ingress_queue
           (session_id, player_id, turn_id, status, text, action_id, language,
            client_request_id, queue_index, visible_after_turn_id)
         VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9)
         RETURNING id, session_id, player_id, turn_id, status, text, action_id,
                   language, queue_index, visible_after_turn_id`,
        [
          opts.sessionId,
          opts.playerId,
          `turn-${randomUUID().slice(0, 8)}`,
          opts.text,
          opts.actionId ?? null,
          opts.language ?? null,
          opts.clientRequestId ?? null,
          idx,
          opts.visibleAfterTurnId ?? null,
        ],
      );
      return {row: mapQueueRow(inserted.rows[0]!), reused: false};
    });

    return {
      ...enqueued,
      position: await queuePosition(opts.sessionId, enqueued.row.turnId),
    };
  });
}

export async function startNextQueuedTurn(
  session: Session,
  starter: (row: TurnQueueRow) => TurnHandle,
): Promise<{row: TurnQueueRow; handle: TurnHandle} | null> {
  if (session.activeTurn) return null;
  if (currentPresentationBarrier(session)) return null;
  const next = await nextQueuedRow(session.id);
  if (!next) return null;

  const claimed = await query<QueueDbRow>(
    `UPDATE turn_ingress_queue
        SET status = 'running', started_at = now(), error = NULL
      WHERE id = $1
        AND status = 'queued'
      RETURNING id, session_id, player_id, turn_id, status, text, action_id,
                language, queue_index, visible_after_turn_id`,
    [next.id],
  );
  const row = claimed.rows[0] ? mapQueueRow(claimed.rows[0]) : null;
  if (!row) return null;

  let handle: TurnHandle;
  try {
    handle = starter(row);
  } catch (err) {
    await markQueueTurnFailed(
      row.id,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
  void handle.done.then(
    () => markQueueTurnDone(row.id),
    err =>
      markQueueTurnFailed(
        row.id,
        err instanceof Error ? err.message : String(err),
      ),
  );
  return {row, handle};
}

export function queueRowToTurnInput(row: TurnQueueRow): TurnInput {
  return {
    text: row.text,
    actionId: row.actionId ?? undefined,
    playerId: row.playerId,
    language: row.language ?? undefined,
    turnId: row.turnId,
    queueId: row.id,
  };
}

export async function cancelQueuedTurn(
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const r = await query(
    `UPDATE turn_ingress_queue
        SET status = 'cancelled', finished_at = now()
      WHERE session_id = $1
        AND turn_id = $2
        AND status = 'queued'`,
    [sessionId, turnId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function markQueueTurnCancelled(
  queueId: number | undefined,
  reason = 'turn cancelled',
): Promise<void> {
  if (queueId == null) return;
  await query(
    `UPDATE turn_ingress_queue
        SET status = 'cancelled', finished_at = now(), error = $2
      WHERE id = $1
        AND status IN ('queued', 'running', 'starting')`,
    [queueId, reason],
  );
}

export async function markQueueTurnDone(queueId: number | undefined): Promise<void> {
  if (queueId == null) return;
  await query(
    `UPDATE turn_ingress_queue
        SET status = 'done', finished_at = now()
      WHERE id = $1
        AND status IN ('queued', 'running', 'starting')`,
    [queueId],
  );
}

export async function markQueueTurnFailed(
  queueId: number | undefined,
  error: string,
): Promise<void> {
  if (queueId == null) return;
  await query(
    `UPDATE turn_ingress_queue
        SET status = 'failed', finished_at = now(), error = $2
      WHERE id = $1
        AND status IN ('queued', 'running', 'starting')`,
    [queueId, error],
  );
}

// ARCH-14 — explicit static SQL per option shape. Each branch carries a
// fixed placeholder count and a hand-written WHERE clause; status is
// always constrained to `running`/`starting`, and the default reason
// stays the same observable string. Callers in `index.ts` and
// `SessionLifecycleService.ts` see no contract change.
export async function recoverAbandonedRunningTurns(opts: {
  sessionId?: string;
  activeTurnId?: string | null;
  reason?: string;
} = {}): Promise<number> {
  const reason =
    opts.reason ??
    'turn abandoned: server restarted or in-memory active turn was lost';
  if (opts.sessionId && opts.activeTurnId) {
    const r = await query(
      `UPDATE turn_ingress_queue
          SET status = 'failed',
              finished_at = now(),
              error = $1
        WHERE status IN ('running', 'starting')
          AND session_id = $2
          AND turn_id <> $3`,
      [reason, opts.sessionId, opts.activeTurnId],
    );
    return r.rowCount ?? 0;
  }
  if (opts.sessionId) {
    const r = await query(
      `UPDATE turn_ingress_queue
          SET status = 'failed',
              finished_at = now(),
              error = $1
        WHERE status IN ('running', 'starting')
          AND session_id = $2`,
      [reason, opts.sessionId],
    );
    return r.rowCount ?? 0;
  }
  if (opts.activeTurnId) {
    const r = await query(
      `UPDATE turn_ingress_queue
          SET status = 'failed',
              finished_at = now(),
              error = $1
        WHERE status IN ('running', 'starting')
          AND turn_id <> $2`,
      [reason, opts.activeTurnId],
    );
    return r.rowCount ?? 0;
  }
  const r = await query(
    `UPDATE turn_ingress_queue
        SET status = 'failed',
            finished_at = now(),
            error = $1
      WHERE status IN ('running', 'starting')`,
    [reason],
  );
  return r.rowCount ?? 0;
}

export async function queuePosition(
  sessionId: string,
  turnId: string,
): Promise<number> {
  const row = await query<{position: number | string}>(
    `SELECT COUNT(*)::int AS position
       FROM turn_ingress_queue marker
       JOIN turn_ingress_queue candidate
         ON candidate.session_id = marker.session_id
        AND candidate.status IN ('queued', 'running', 'starting')
        AND candidate.queue_index <= marker.queue_index
      WHERE marker.session_id = $1
        AND marker.turn_id = $2
      GROUP BY marker.id`,
    [sessionId, turnId],
  );
  return Number(row.rows[0]?.position ?? 0);
}

export async function listTurnQueueSnapshot(
  sessionId: string,
  opts: {includeFinished?: boolean; turnId?: string} = {},
): Promise<TurnQueueSnapshotRow[]> {
  const statuses = opts.includeFinished
    ? ['queued', 'starting', 'running', 'done', 'cancelled', 'failed']
    : ['queued', 'starting', 'running'];
  const params: unknown[] = [sessionId, statuses];
  const filters = [`session_id = $1`, `status = ANY($2::text[])`];
  if (opts.turnId) {
    params.push(opts.turnId);
    filters.push(`turn_id = $${params.length}`);
  }
  const r = await query<QueueSnapshotDbRow>(
    `SELECT id, session_id, player_id, turn_id, status, text, action_id,
            language, client_request_id, queue_index, visible_after_turn_id,
            created_at::text AS created_at,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            error,
            (EXTRACT(EPOCH FROM (now() - created_at)) * 1000)::int AS age_ms,
            CASE
              WHEN started_at IS NULL THEN NULL
              ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
            END AS running_age_ms
       FROM turn_ingress_queue
      WHERE ${filters.join(' AND ')}
      ORDER BY queue_index ASC, id ASC`,
    params,
  );
  let activePosition = 0;
  return r.rows.map(row => {
    const mapped = mapQueueSnapshotRow(row);
    if (
      mapped.status === 'queued' ||
      mapped.status === 'starting' ||
      mapped.status === 'running'
    ) {
      activePosition += 1;
      mapped.position = activePosition;
    }
    return mapped;
  });
}

async function lockSessionQueueTx(
  tx: TxClient,
  sessionId: string,
): Promise<void> {
  // FOR UPDATE on sessions(id) serialises concurrent enqueueTurn
  // transactions for the same session on managed Postgres. The lock
  // is released by COMMIT/ROLLBACK so the row itself is never
  // mutated. PGlite is single-process; the JS mutex above already
  // provides serialisation, so the SELECT here is harmless but no-op
  // for contention.
  await tx.query(`SELECT id FROM sessions WHERE id = $1 FOR UPDATE`, [
    sessionId,
  ]);
}

async function findByClientRequestTx(
  tx: TxClient,
  sessionId: string,
  clientRequestId: string,
): Promise<TurnQueueRow | null> {
  const r = await tx.query<QueueDbRow>(
    `SELECT id, session_id, player_id, turn_id, status, text, action_id,
            language, queue_index, visible_after_turn_id
       FROM turn_ingress_queue
      WHERE session_id = $1
        AND client_request_id = $2
      LIMIT 1`,
    [sessionId, clientRequestId],
  );
  return r.rows[0] ? mapQueueRow(r.rows[0]) : null;
}

async function countQueuedTx(
  tx: TxClient,
  sessionId: string,
): Promise<number> {
  const r = await tx.query<{n: number | string}>(
    `SELECT COUNT(*)::int AS n
       FROM turn_ingress_queue
      WHERE session_id = $1
        AND status IN ('queued', 'starting', 'running')`,
    [sessionId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function nextQueueIndexTx(
  tx: TxClient,
  sessionId: string,
): Promise<number> {
  const r = await tx.query<{n: number | string}>(
    `SELECT COALESCE(MAX(queue_index), 0) + 1 AS n
       FROM turn_ingress_queue
      WHERE session_id = $1`,
    [sessionId],
  );
  return Number(r.rows[0]?.n ?? 1);
}

async function nextQueuedRow(sessionId: string): Promise<TurnQueueRow | null> {
  const r = await query<QueueDbRow>(
    `SELECT id, session_id, player_id, turn_id, status, text, action_id,
            language, queue_index, visible_after_turn_id
       FROM turn_ingress_queue
      WHERE session_id = $1
        AND status = 'queued'
      ORDER BY queue_index ASC
      LIMIT 1`,
    [sessionId],
  );
  return r.rows[0] ? mapQueueRow(r.rows[0]) : null;
}

async function findByClientRequest(
  sessionId: string,
  clientRequestId: string,
): Promise<TurnQueueRow | null> {
  const r = await query<QueueDbRow>(
    `SELECT id, session_id, player_id, turn_id, status, text, action_id,
            language, queue_index, visible_after_turn_id
       FROM turn_ingress_queue
      WHERE session_id = $1
        AND client_request_id = $2
      LIMIT 1`,
    [sessionId, clientRequestId],
  );
  return r.rows[0] ? mapQueueRow(r.rows[0]) : null;
}

interface QueueDbRow {
  id: number | string;
  session_id: string;
  player_id: number | string;
  turn_id: string;
  status: TurnQueueRow['status'];
  text: string;
  action_id: string | null;
  language: string | null;
  queue_index: number | string;
  visible_after_turn_id: string | null;
}

interface QueueSnapshotDbRow extends QueueDbRow {
  client_request_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  age_ms: number | string;
  running_age_ms: number | string | null;
}

function mapQueueRow(row: QueueDbRow): TurnQueueRow {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    playerId: Number(row.player_id),
    turnId: row.turn_id,
    status: row.status,
    text: row.text,
    actionId: row.action_id,
    language: row.language,
    queueIndex: Number(row.queue_index),
    visibleAfterTurnId: row.visible_after_turn_id,
  };
}

function mapQueueSnapshotRow(row: QueueSnapshotDbRow): TurnQueueSnapshotRow {
  const base = mapQueueRow(row);
  const ageMs = Number(row.age_ms ?? 0);
  const runningAgeMs =
    row.running_age_ms == null ? null : Number(row.running_age_ms);
  const stuck =
    (base.status === 'queued' && ageMs >= STUCK_QUEUE_AGE_MS) ||
    ((base.status === 'starting' || base.status === 'running') &&
      (runningAgeMs ?? ageMs) >= STUCK_QUEUE_AGE_MS);
  return {
    ...base,
    clientRequestId: row.client_request_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    ageMs,
    runningAgeMs,
    position: 0,
    stuck,
  };
}
