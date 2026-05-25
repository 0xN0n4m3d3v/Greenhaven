/**
 * Local turn job/runtime state shared by the bridge SSE layer and the
 * Wails-compatible turn job API.
 */

import {main} from './platform';
import {__emit} from './platform';

export const jobs = new Map<string, main.TurnJobSnapshot>();
export const turnText = new Map<string, string>();
export const jobWaiters = new Map<string, Array<(snap: main.TurnJobSnapshot) => void>>();

export interface NarrateMeta {
  author: string | null;
  authorId: number | null;
  tone: 'npc' | 'narrator' | 'system';
  messageId?: number | null;
  turnIndex?: number | null;
  mentions?: Array<{id: number; name: string; kind: string}>;
}

export const turnAuthor = new Map<string, NarrateMeta>();

export interface PersistedDice {
  roll: number;
  dc: number | null;
  outcome: 'success' | 'failure' | null;
  description: string;
  roller: 'player' | 'npc';
  position?: 'controlled' | 'risky' | 'desperate';
  effect?: 'limited' | 'standard' | 'great';
}

export const turnDice = new Map<string, PersistedDice[]>();
export const seenSystemEventAnchors = new Map<number, number | null>();
export const messageIdByTurnId = new Map<string, number>();

export interface TurnQueueSnapshotRow {
  id: number;
  turnId: string;
  status: 'queued' | 'starting' | 'running' | 'done' | 'cancelled' | 'failed';
  actionId: string | null;
  createdAt: string;
  startedAt: string | null;
  position: number;
  error: string | null;
}

export interface TurnQueueSnapshot {
  activeTurnId?: string | null;
  rows?: TurnQueueSnapshotRow[];
}

export type TerminalTurnJobSnapshot = main.TurnJobSnapshot & {
  status: 'done' | 'error' | 'canceled';
};

export function settleJob(
  jobId: string,
  patch: Partial<main.TurnJobSnapshot>,
): void {
  const existing = jobs.get(jobId);
  const base =
    existing ??
    main.TurnJobSnapshot.createFrom({
      id: jobId,
      status: patch.status ?? 'running',
      actionId: patch.actionId ?? '',
      text: patch.text ?? '',
      createdAt: patch.createdAt ?? Date.now(),
    });
  const updated = main.TurnJobSnapshot.createFrom({...base, ...patch});
  jobs.set(jobId, updated);
  const waiters = jobWaiters.get(jobId);
  if (waiters) {
    jobWaiters.delete(jobId);
    for (const waiter of waiters) {
      try {
        waiter(updated);
      } catch (err) {
        console.error('[bridge] job waiter threw', err);
      }
    }
  }
}

export function clearLocalSessionRuntime(reason = 'session reset'): void {
  for (const [id, job] of [...jobs]) {
    if (job.status === 'queued' || job.status === 'running') {
      settleJob(id, {
        status: 'canceled',
        error: reason,
        finishedAt: Date.now(),
      });
    }
  }
  jobs.clear();
  jobWaiters.clear();
  turnText.clear();
  turnDice.clear();
  turnAuthor.clear();
  messageIdByTurnId.clear();
  seenSystemEventAnchors.clear();
}

export function rememberTurnMessageId(
  turnId: string | null | undefined,
  messageId: number | null | undefined,
): void {
  if (!turnId || typeof messageId !== 'number' || messageId <= 0) return;
  messageIdByTurnId.set(turnId, messageId);
  __emit('system:turn_message_known', {turnId, messageId});
}

export function isTerminalJob(
  job: main.TurnJobSnapshot | null | undefined,
): job is TerminalTurnJobSnapshot {
  return (
    !!job &&
    (job.status === 'done' ||
      job.status === 'error' ||
      job.status === 'canceled')
  );
}

export function queueRowToJobSnapshot(
  row: TurnQueueSnapshotRow,
  existing?: main.TurnJobSnapshot,
): main.TurnJobSnapshot {
  const status =
    row.status === 'done'
      ? 'done'
      : row.status === 'failed'
        ? 'error'
        : row.status === 'cancelled'
          ? 'canceled'
          : row.status === 'queued'
            ? 'queued'
            : 'running';
  return main.TurnJobSnapshot.createFrom({
    ...(existing ?? {}),
    id: row.turnId,
    actionId: row.actionId ?? existing?.actionId ?? '',
    text: existing?.text ?? '',
    createdAt: Date.parse(row.createdAt) || existing?.createdAt || Date.now(),
    startedAt:
      row.startedAt != null
        ? Date.parse(row.startedAt) || existing?.startedAt
        : existing?.startedAt,
    finishedAt:
      row.status === 'done' ||
      row.status === 'failed' ||
      row.status === 'cancelled'
        ? Date.now()
        : existing?.finishedAt,
    status,
    kind: status === 'queued' ? 'queued' : existing?.kind,
    error: row.error ?? existing?.error,
  });
}
