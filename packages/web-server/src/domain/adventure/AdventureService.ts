/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { query, withTransaction } from '../../db.js';
import { emitGuiEventForSession } from '../../guiEventOutbox.js';
import { synthesiseNarrate } from '../../narrationSynthesis.js';
import type { Session } from '../../sessionManager.js';
import { sessionManager } from '../../sessionManager.js';
import { buildAdventureAcceptFollowup } from './runtime/adventureAcceptFollowup.js';
import { applyReadyAdventureBlueprint } from './runtime/adventureArbiter.js';
import {
  buildAdventureHookPayload,
  claimReadyAdventureForAcceptance,
  getAdventureQueueRow,
  listAdventureQueue,
  markAdventureCancelled,
  markAdventureFailed,
  type AdventureQueueRow,
} from './runtime/adventureQueue.js';
import { setDialogueParticipants } from '../../dialogueParticipants.js';
import {
  assignMemoryCluster,
  attachMemoryToThread,
  insertAdventureIgnoreMemory as insertAdventureIgnoreMemoryRow,
  recordThreadEvidence,
  selectAdventureIgnoreMemoryId,
} from '../memory/index.js';
import { telemetry } from '../../telemetry/index.js';

// USER-5/USER-6 — sentinel used by `acceptPlayerAdventure` to roll
// back the inner blueprint savepoint on a soft `{ ok: false }`
// result while keeping the outer accept transaction alive so it
// can still persist the queue `failed` status. The outer catch
// unwraps `.applied` to surface the original applier result.
type BlueprintApplied = Awaited<ReturnType<typeof applyReadyAdventureBlueprint>>;

class BlueprintApplicationFailedError extends Error {
  constructor(readonly applied: BlueprintApplied) {
    super(applied.message ?? 'blueprint application failed');
    this.name = 'BlueprintApplicationFailedError';
  }
}

export interface PlayerAdventurePayload {
  queueId: number;
  sessionId: string;
  playerId: number;
  turnId: string | null;
  status: string;
  adventureKind: string;
  title: string;
  summary: string;
  playerFacingHook: string;
  danger: unknown;
  speakerEntityId: number | null;
  speakerName: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  acceptUrl: string;
  ignoreUrl: string;
}

export interface AdventureIgnoreConsequence {
  queueId: number;
  ownerEntityId: number | null;
  ownerName: string | null;
  ownerKind: string | null;
  memoryId: number | null;
  threadId: string | null;
  speakerEntityId: number | null;
  speakerName: string | null;
  dialogueFocused: boolean;
}

export class AdventureService {
  static async listPlayerAdventures(opts: {
    playerId: number;
    sessionId?: string | null;
    limit?: number;
  }): Promise<PlayerAdventurePayload[]> {
    return listPlayerAdventures(opts);
  }

  static async acceptPlayerAdventure(opts: {
    playerId: number;
    queueId: number;
    sessionId?: string | null;
    turnId?: string | null;
  }): ReturnType<typeof acceptPlayerAdventure> {
    return acceptPlayerAdventure(opts);
  }

  static async ignorePlayerAdventure(opts: {
    playerId: number;
    queueId: number;
    sessionId?: string | null;
    turnId?: string | null;
    reason?: string;
  }): ReturnType<typeof ignorePlayerAdventure> {
    return ignorePlayerAdventure(opts);
  }
}

export async function listPlayerAdventures(opts: {
  playerId: number;
  sessionId?: string | null;
  limit?: number;
}): Promise<PlayerAdventurePayload[]> {
  const limit = sanitizeLimit(opts.limit);
  const rows = opts.sessionId
    ? await listAdventureQueue({
        sessionId: opts.sessionId,
        playerId: opts.playerId,
        statuses: ['ready'],
        limit,
      })
    : await listReadyAdventuresAcrossSessions(opts.playerId, limit);
  const adventures: PlayerAdventurePayload[] = [];
  for (const row of rows) {
    const payload = await buildAdventureHookPayload(row);
    if (!payload) continue;
    adventures.push({
      queueId: row.id,
      sessionId: row.sessionId,
      playerId: row.playerId,
      turnId: row.turnId,
      status: row.status,
      adventureKind: row.adventureKind,
      title: String(payload['title'] ?? row.adventureKind),
      summary: String(payload['summary'] ?? ''),
      playerFacingHook: String(payload['playerFacingHook'] ?? ''),
      danger: payload['danger'] ?? 'safe',
      speakerEntityId:
        typeof payload['speakerEntityId'] === 'number'
          ? payload['speakerEntityId']
          : null,
      speakerName:
        typeof payload['speakerName'] === 'string'
          ? payload['speakerName']
          : null,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      acceptUrl: String(payload['acceptUrl']),
      ignoreUrl: String(payload['ignoreUrl']),
    });
  }
  return adventures;
}

export async function acceptPlayerAdventure(opts: {
  playerId: number;
  queueId: number;
  sessionId?: string | null;
  turnId?: string | null;
}): Promise<{
  ok: boolean;
  status?: string;
  queue?: AdventureQueueRow;
  questResult?: unknown;
  spawnResults?: unknown[];
  followup?: AdventureAcceptFollowupEmission;
  reason?: string;
  message?: string;
}> {
  const queue = await requireOwnedAdventureQueue(opts);
  if (!queue.ok) return queue;
  const row = queue.queue;
  if (row.status === 'accepted') {
    return { ok: true, status: 'accepted', queue: row };
  }
  if (row.status !== 'ready') {
    return {
      ok: false,
      status: row.status,
      queue: row,
      reason: 'queue_not_ready',
      message: `adventure queue row is ${row.status}`,
    };
  }
  // USER-5/USER-6 — the entire accept flow runs inside one outer
  // `withTransaction(...)`: `claimReadyAdventureForAcceptance` UPDATE
  // → `applyReadyAdventureBlueprint` (nested savepoint) →
  // post-blueprint queue read → `adventure:accepted` GUI emit. If
  // the emit throws the outer tx rolls back the claim, the
  // blueprint mutations, and the deferred SSE. If
  // `applyReadyAdventureBlueprint` returns `{ ok: false }` or
  // throws, the inner savepoint rolls back partial blueprint
  // writes (spawn rows, runtime field patches, etc.) while the
  // outer tx still records the `failed` status via
  // `markAdventureFailed`. The follow-up `turn.start` / `turn.end`
  // lifecycle markers stay outside the tx (handled below after
  // commit) — they are turn-lifecycle markers, not state-changes.
  // SSE auto-defers via `SseBridge.emit`'s `onTransactionCommit`
  // path.
  type AcceptCommitOutcome =
    | {kind: 'accepted'; eventRow: AdventureQueueRow; applied: BlueprintApplied; claimed: AdventureQueueRow; effectiveTurnId: string | null}
    | {kind: 'idempotent'; queue: AdventureQueueRow}
    | {kind: 'not_ready'; queue: AdventureQueueRow; reason: string; message: string}
    | {kind: 'failed'; queue: AdventureQueueRow; reason: string; message: string};

  const commitOutcome = await withTransaction(async (): Promise<AcceptCommitOutcome> => {
    const claimed = await claimReadyAdventureForAcceptance(row.id);
    if (!claimed) {
      const latest = await getAdventureQueueRow(row.id);
      if (latest?.status === 'accepted') {
        return {kind: 'idempotent', queue: latest};
      }
      return {
        kind: 'not_ready',
        queue: latest ?? row,
        reason: 'queue_not_ready',
        message: `adventure queue row is ${latest?.status ?? row.status}`,
      };
    }

    const effectiveTurnId = opts.turnId ?? claimed.turnId ?? null;

    // Inner savepoint for the blueprint applier. Both failure
    // modes must roll the savepoint back so partial create_quest /
    // spawn / runtime-field writes are undone:
    //   - soft `{ ok: false }` result → rethrown as
    //     `BlueprintApplicationFailedError` so the outer catch can
    //     unwrap the applier's reason/message
    //   - raw thrown exception (a tool dispatch crashes, an
    //     unexpected DB error, etc.) → caught here and converted to
    //     the same `applied = { ok: false }` shape with reason
    //     `tool_application_failed` and the error message preserved
    //     for `markAdventureFailed`.
    // Either way the outer tx survives and proceeds to record the
    // `failed` queue status; no `adventure:accepted` GUI/SSE event
    // is emitted on these branches.
    let applied: BlueprintApplied;
    try {
      applied = await withTransaction(async () => {
        const inner = await applyReadyAdventureBlueprint(claimed.id, {
          sessionId: claimed.sessionId,
          playerId: claimed.playerId,
          turnId: effectiveTurnId ?? `adventure-accept:${claimed.id}`,
          signal: sessionManager.get(claimed.sessionId)?.activeTurn?.abortController
            .signal,
        });
        if (!inner.ok) {
          throw new BlueprintApplicationFailedError(inner);
        }
        return inner;
      });
    } catch (err) {
      if (err instanceof BlueprintApplicationFailedError) {
        applied = err.applied;
      } else {
        applied = {
          ok: false,
          reason: 'tool_application_failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (!applied.ok) {
      console.warn('[adventure] accept application failed', {
        queueId: claimed.id,
        playerId: claimed.playerId,
        sessionId: claimed.sessionId,
        turnId: effectiveTurnId,
        adventureKind: claimed.adventureKind,
        reason: applied.reason,
        message: applied.message,
      });
      const failed = await markAdventureFailed(
        claimed.id,
        'accept_application_failed',
        {
          reason: applied.reason,
          message: applied.message,
        },
      );
      return {
        kind: 'failed',
        queue: failed ?? claimed,
        reason: applied.reason ?? 'tool_application_failed',
        message: applied.message ?? 'accept application failed',
      };
    }

    const accepted = await getAdventureQueueRow(claimed.id);
    const eventRow = accepted ?? claimed;
    await emitGuiEventForSession(
      claimed.sessionId,
      'adventure:accepted',
      {
        queueId: claimed.id,
        playerId: claimed.playerId,
        adventureKind: claimed.adventureKind,
        status: 'accepted',
        title: String(claimed.blueprint?.['title'] ?? claimed.adventureKind),
        summary: String(claimed.blueprint?.['summary'] ?? ''),
        danger: claimed.blueprint?.['danger'] ?? 'safe',
        questResult: applied.questResult ?? null,
        spawnResults: applied.spawnResults ?? [],
      },
      {
        playerId: claimed.playerId,
        turnId: effectiveTurnId,
        lane: 'post_response',
        phase: 'mutation',
        dedupeKey: `adventure-accepted:${claimed.id}`,
      },
    );
    return {kind: 'accepted', eventRow, applied, claimed, effectiveTurnId};
  });

  if (commitOutcome.kind === 'idempotent') {
    return {ok: true, status: 'accepted', queue: commitOutcome.queue};
  }
  if (commitOutcome.kind === 'not_ready') {
    return {
      ok: false,
      status: commitOutcome.queue.status,
      queue: commitOutcome.queue,
      reason: commitOutcome.reason,
      message: commitOutcome.message,
    };
  }
  if (commitOutcome.kind === 'failed') {
    return {
      ok: false,
      status: 'failed',
      queue: commitOutcome.queue,
      reason: commitOutcome.reason,
      message: commitOutcome.message,
    };
  }
  const {eventRow, applied, claimed} = commitOutcome;
  const followup: AdventureAcceptFollowupEmission = opts.turnId
    ? { emitted: false as const, reason: 'active_turn_acceptance' }
    : await maybeEmitAdventureAcceptFollowup({
        session: sessionManager.get(claimed.sessionId),
        row: eventRow,
        playerId: claimed.playerId,
      });
  return {
    ok: true,
    status: 'accepted',
    queue: eventRow,
    questResult: applied.questResult,
    spawnResults: applied.spawnResults,
    followup,
  };
}

export async function ignorePlayerAdventure(opts: {
  playerId: number;
  queueId: number;
  sessionId?: string | null;
  turnId?: string | null;
  reason?: string;
}): Promise<{
  ok: boolean;
  status?: string;
  queue?: AdventureQueueRow;
  hookPayload?: Record<string, unknown> | null;
  consequence?: AdventureIgnoreConsequence | null;
  reason?: string;
  message?: string;
}> {
  const queue = await requireOwnedAdventureQueue(opts);
  if (!queue.ok) return queue;
  const row = queue.queue;
  if (row.status === 'cancelled' || row.status === 'expired') {
    return { ok: true, status: row.status, queue: row };
  }
  if (row.status === 'accepted') {
    return {
      ok: false,
      status: row.status,
      queue: row,
      reason: 'already_accepted',
      message: 'accepted adventures cannot be ignored',
    };
  }
  const hookPayload = await buildAdventureHookPayload(row).catch((err) => {
    console.warn(
      '[adventure] ignore hook payload build failed (continuing):',
      err instanceof Error ? err.message : err,
    );
    telemetry.record({
      channel: 'gameplay',
      name: 'error.adventure_ignore_hook_payload',
      sessionId: row.sessionId,
      playerId: row.playerId,
      turnId: row.turnId ?? null,
      data: { error: String(err) },
    });
    return null;
  });
  // USER-5/USER-6 — `markAdventureCancelled` UPDATE and the
  // visible `adventure:ignored` GUI event share one transaction.
  // If the emit fails the UPDATE rolls back and the deferred SSE
  // never escapes. `recordAdventureIgnoreConsequence` is
  // intentionally fail-open (its `.catch` swallows errors) and is
  // not a state event the UI subscribes to, so it stays outside
  // the tx and runs after commit. SSE auto-defers via
  // `SseBridge.emit`'s `onTransactionCommit` path.
  const hookWasVisible = await wasAdventureHookVisible(row.sessionId, row.id);
  const finalRow = await withTransaction(async () => {
    const cancelled = await markAdventureCancelled(
      row.id,
      opts.reason ?? 'player_ignored',
      { turnId: opts.turnId ?? null },
    );
    const resolvedRow =
      cancelled ?? (await getAdventureQueueRow(row.id)) ?? row;
    if (hookWasVisible) {
      await emitGuiEventForSession(
        row.sessionId,
        'adventure:ignored',
        {
          queueId: row.id,
          playerId: row.playerId,
          adventureKind: row.adventureKind,
          status: resolvedRow.status,
          title: String(row.blueprint?.['title'] ?? row.adventureKind),
          reason: opts.reason ?? 'player_ignored',
        },
        {
          playerId: row.playerId,
          turnId: row.turnId,
          lane: 'post_response',
          phase: 'mutation',
          dedupeKey: `adventure-ignored:${row.id}`,
        },
      );
    }
    return resolvedRow;
  });
  const consequence = await recordAdventureIgnoreConsequence({
    row: finalRow,
    hookPayload,
    playerId: row.playerId,
    sessionId: row.sessionId,
    turnId: opts.turnId ?? row.turnId ?? null,
    reason: opts.reason ?? 'player_ignored',
  }).catch((err) => {
    console.warn(
      '[adventure] ignore consequence failed (continuing):',
      err instanceof Error ? err.message : err,
    );
    telemetry.record({
      channel: 'gameplay',
      name: 'error.adventure_ignore_consequence',
      sessionId: row.sessionId,
      playerId: row.playerId,
      turnId: opts.turnId ?? row.turnId ?? null,
      data: { error: String(err) },
    });
    return null;
  });
  return {
    ok: true,
    status: finalRow.status,
    queue: finalRow,
    hookPayload,
    consequence,
  };
}

async function listReadyAdventuresAcrossSessions(
  playerId: number,
  limit: number,
): Promise<AdventureQueueRow[]> {
  const rows = await query<{
    session_id: string;
  }>(
    `SELECT session_id
       FROM adventure_queue
      WHERE player_id = $1
        AND status = 'ready'
      GROUP BY session_id
      ORDER BY MAX(updated_at) DESC`,
    [playerId],
  );
  const out: AdventureQueueRow[] = [];
  for (const row of rows.rows) {
    out.push(
      ...(await listAdventureQueue({
        sessionId: row.session_id,
        playerId,
        statuses: ['ready'],
        limit,
      })),
    );
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

async function requireOwnedAdventureQueue(opts: {
  playerId: number;
  queueId: number;
  sessionId?: string | null;
}): Promise<
  | { ok: true; queue: AdventureQueueRow }
  | { ok: false; reason: string; message?: string; status?: string }
> {
  const row = await getAdventureQueueRow(opts.queueId);
  if (!row) {
    return { ok: false, reason: 'not_found', message: 'unknown adventure' };
  }
  if (row.playerId !== opts.playerId) {
    return { ok: false, reason: 'forbidden', message: 'player mismatch' };
  }
  if (opts.sessionId && row.sessionId !== opts.sessionId) {
    return { ok: false, reason: 'forbidden', message: 'session mismatch' };
  }
  return { ok: true, queue: row };
}

async function wasAdventureHookVisible(
  sessionId: string,
  queueId: number,
): Promise<boolean> {
  const rows = await query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM gui_events
      WHERE session_id = $1
        AND event_type = 'adventure:hook'
        AND payload->>'queueId' = $2`,
    [sessionId, String(queueId)],
  );
  return Number(rows.rows[0]?.count ?? 0) > 0;
}

function parsePositiveInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sanitizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(Math.trunc(limit), 200));
}

async function recordAdventureIgnoreConsequence(opts: {
  row: AdventureQueueRow;
  hookPayload: Record<string, unknown> | null;
  playerId: number;
  sessionId: string;
  turnId?: string | null;
  reason: string;
}): Promise<AdventureIgnoreConsequence> {
  const hook = opts.hookPayload ?? {};
  const title =
    readText(hook['title']) ??
    readText(opts.row.blueprint?.['title']) ??
    opts.row.adventureKind;
  const summary =
    readText(hook['summary']) ?? readText(opts.row.blueprint?.['summary']);
  const playerFacingHook =
    readText(hook['playerFacingHook']) ??
    readText(opts.row.blueprint?.['playerFacingHook']) ??
    summary;
  const speakerEntityId = parsePositiveInt(hook['speakerEntityId']);
  const speakerName = readText(hook['speakerName']);
  const dialogueFocused = await maybeFocusAdventureSpeaker({
    playerId: opts.playerId,
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    speakerEntityId,
  });
  const owner =
    (speakerEntityId != null
      ? await loadMemoryOwner(speakerEntityId, ['person'])
      : null) ?? (await loadCurrentLocationMemoryOwner(opts.playerId));
  const threadId = await recordThreadEvidence({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    kind: 'adventure_declined',
    payload: {
      queueId: opts.row.id,
      reason: opts.reason,
      title,
      summary: summary ?? null,
      playerFacingHook: playerFacingHook ?? null,
      speakerEntityId,
      speakerName,
      turnId: opts.turnId ?? null,
    },
  }).catch((err) => {
    console.warn(
      '[adventure] ignore thread evidence failed (continuing):',
      err instanceof Error ? err.message : err,
    );
    telemetry.record({
      channel: 'gameplay',
      name: 'error.adventure_ignore_thread_evidence',
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      turnId: opts.turnId ?? null,
      data: { error: String(err) },
    });
    return null;
  });
  if (!owner) {
    return {
      queueId: opts.row.id,
      ownerEntityId: null,
      ownerName: null,
      ownerKind: null,
      memoryId: null,
      threadId,
      speakerEntityId,
      speakerName,
      dialogueFocused,
    };
  }

  const queueTag = `adventure_queue:${opts.row.id}`;
  const existingMemoryId = await selectAdventureIgnoreMemoryId({
    ownerEntityId: owner.id,
    queueTag,
  });
  const memoryId =
    existingMemoryId ??
    (await insertAdventureIgnoreMemory({
      ownerId: owner.id,
      playerId: opts.playerId,
      turnId: opts.turnId ?? null,
      title,
      playerFacingHook,
      speakerName,
      queueTag,
    }));
  if (existingMemoryId == null) {
    await attachMemoryToThread({
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      memoryId,
    }).catch((err) => {
      // CATCH-WARN-OK: post-ignore archival side effect; the adventure ignore transaction has already committed and the underlying `attachMemoryToThread` SQL failure is surfaced through its own thread-write telemetry.
      console.warn(
        '[adventure] ignore memory thread attach failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    });
    await assignMemoryCluster(memoryId).catch((err) => {
      // CATCH-WARN-OK: post-ignore archival side effect; `assignMemoryCluster` already records its own clustering telemetry, and the adventure ignore transaction has already committed.
      console.warn(
        '[adventure] ignore memory clustering failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    });
  }
  return {
    queueId: opts.row.id,
    ownerEntityId: owner.id,
    ownerName: owner.name,
    ownerKind: owner.kind,
    memoryId,
    threadId,
    speakerEntityId,
    speakerName,
    dialogueFocused,
  };
}

async function insertAdventureIgnoreMemory(opts: {
  ownerId: number;
  playerId: number;
  turnId: string | null;
  title: string;
  playerFacingHook: string | null;
  speakerName: string | null;
  queueTag: string;
}): Promise<number> {
  const text = truncateText(
    [
      `Adventure hook declined: ${opts.title}.`,
      opts.speakerName ? `Speaker: ${opts.speakerName}.` : null,
      opts.playerFacingHook ? `Offer: ${opts.playerFacingHook}` : null,
      'Treat this refusal as a player boundary that should shape the immediate response and future offers.',
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
    1600,
  );
  const tags = uniqueTags([
    'adventure',
    'adventure_declined',
    'refusal',
    'boundary',
    opts.queueTag,
    opts.turnId ? `turn:${opts.turnId}` : '',
  ]);
  const inserted = await insertAdventureIgnoreMemoryRow({
    ownerEntityId: opts.ownerId,
    aboutEntityId: opts.playerId,
    text,
    tags,
    sourceTurnId: opts.turnId,
    metadata: {
      visibility: 'private',
      auto: true,
      consequence: 'adventure_declined',
      queue_tag: opts.queueTag,
    },
  });
  return inserted.id;
}

async function maybeFocusAdventureSpeaker(opts: {
  playerId: number;
  sessionId: string;
  turnId?: string | null;
  speakerEntityId: number | null;
}): Promise<boolean> {
  if (opts.speakerEntityId == null) return false;
  // Capture the narrowed non-null id so the async closure below
  // doesn't have to repeat the type narrowing through
  // `withTransaction`.
  const speakerEntityId = opts.speakerEntityId;
  try {
    // USER-5/USER-6 — `setDialogueParticipants` UPDATE and the
    // `dialogue:participants_updated` SSE share one transaction so
    // the deferred event auto-defers via `SseBridge.emit`'s
    // `onTransactionCommit` path. Rollback drops both.
    const focusResult = await withTransaction(async () => {
      const update = await setDialogueParticipants(opts.playerId, {
        focusedId: speakerEntityId,
        participantIds: [speakerEntityId],
        explicitParticipantIds: [speakerEntityId],
        allowRecentAuthors: true,
        preserveExisting: false,
        sessionId: opts.sessionId,
        source: 'route',
        turnId: opts.turnId,
      });
      const liveSession = sessionManager.get(opts.sessionId);
      // SSE-OK: emit outside tx (reason: setDialogueParticipants above is the canonical write inside the withTransaction wrapper; SseBridge.emit auto-defers via onTransactionCommit, and this emit only fires after the focus update is durable).
      liveSession?.sse.emit('dialogue:participants_updated', {
        focused_partner_id: update.state.focused_partner_id,
        participant_ids: update.state.participant_ids,
        participants: update.participants,
        source: update.state.source,
      });
      return update;
    });
    return focusResult.state.focused_partner_id === opts.speakerEntityId;
  } catch (err) {
    // CATCH-WARN-OK: best-effort focus refinement after a successful ignore tx; the speaker focus is a UI hint, not a state mutation that needs separate telemetry. `setDialogueParticipants` failures are surfaced through dialogueParticipants writer-side telemetry on the way in.
    console.warn(
      '[adventure] ignore speaker focus failed (continuing):',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function loadMemoryOwner(
  entityId: number,
  allowedKinds?: readonly string[],
): Promise<{ id: number; name: string; kind: string } | null> {
  const rows = await query<{ id: number; display_name: string; kind: string }>(
    `SELECT id, display_name, kind
       FROM entities
      WHERE id = $1
      LIMIT 1`,
    [entityId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  if (allowedKinds && !allowedKinds.includes(row.kind)) return null;
  return { id: Number(row.id), name: row.display_name, kind: row.kind };
}

async function loadCurrentLocationMemoryOwner(
  playerId: number,
): Promise<{ id: number; name: string; kind: string } | null> {
  const rows = await query<{ id: number; display_name: string; kind: string }>(
    `SELECT e.id, e.display_name, e.kind
       FROM players p
       JOIN entities e ON e.id = p.current_location_id
      WHERE p.entity_id = $1
        AND e.kind IN ('location', 'district')
      LIMIT 1`,
    [playerId],
  );
  const row = rows.rows[0];
  return row
    ? { id: Number(row.id), name: row.display_name, kind: row.kind }
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function truncateText(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max - 3).trimEnd()}...`;
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

type AdventureAcceptFollowupEmission =
  | {
      emitted: true;
      turnId: string;
      messageId: number | null;
      language: string;
    }
  | {
      emitted: false;
      reason:
        | 'active_turn_acceptance'
        | 'active_turn_running'
        | 'session_not_live'
        | 'no_followup_text';
    };

async function maybeEmitAdventureAcceptFollowup(opts: {
  session: Session | undefined;
  row: AdventureQueueRow;
  playerId: number;
}): Promise<AdventureAcceptFollowupEmission> {
  const { session, row, playerId } = opts;
  if (!session) return { emitted: false, reason: 'session_not_live' };
  if (session.activeTurn) {
    return { emitted: false, reason: 'active_turn_running' };
  }
  const followup = await buildAdventureAcceptFollowup({ row, playerId });
  if (!followup) return { emitted: false, reason: 'no_followup_text' };

  const startedAt = Date.now();
  // SSE-OK: emit outside tx (reason: turn-lifecycle marker for
  // the synthetic adventure-accept follow-up turn; not a DB
  // state-change).
  session.sse.emit('turn.start', {
    turnId: followup.turnId,
    text: '',
    originalText: '',
    visibleText: '',
    actionId: 'adventure.accept',
    source: 'adventure_accept_followup',
    queueId: row.id,
  });
  const narrate = await synthesiseNarrate(
    session,
    playerId,
    followup.turnId,
    followup.text,
    false,
    {
      author: followup.authorId ?? undefined,
      author_id: followup.authorId,
      tone: followup.authorId == null ? 'narrator' : 'npc',
      done: true,
      source: 'adventure_accept_followup',
    },
    'adventure_accept_followup',
  );
  // SSE-OK: emit outside tx (reason: turn-lifecycle marker for
  // the synthetic adventure-accept follow-up turn; not a DB
  // state-change).
  session.sse.emit('turn.end', {
    turnId: followup.turnId,
    messageId: narrate?.messageId ?? null,
    durationMs: Date.now() - startedAt,
    source: 'adventure_accept_followup',
    queueId: row.id,
  });
  if (!narrate) return { emitted: false, reason: 'no_followup_text' };
  return {
    emitted: true,
    turnId: followup.turnId,
    messageId: narrate.messageId,
    language: followup.language,
  };
}
