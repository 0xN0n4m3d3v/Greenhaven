/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-NOTICE-1 — Notice Journal bridge.
//
// Owns the `/api/player/:id/notices` read surface so
// `NoticeJournalSurface` and `useNoticeJournal` never call
// `fetch(...)` directly. Mirrors the existing
// `bridge/questDashboard.ts` shape (compact fetch helper +
// typed DTO).

export type JournalEntryType =
  | 'quest'
  | 'progression'
  | 'relationship'
  | 'world'
  | 'story'
  | 'system';

export interface NoticeJournalEntry {
  id: number;
  entryType: JournalEntryType;
  eventType: string;
  sourceEventId: number | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  turnId: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface NoticeJournalSnapshot {
  playerId: number;
  entries: NoticeJournalEntry[];
  nextCursor: number | null;
}

export interface FetchNoticeJournalArgs {
  playerId: number;
  limit?: number;
  cursor?: number | null;
  type?: JournalEntryType | null;
  baseUrl?: string;
}

/**
 * Returns `null` when the endpoint replies non-2xx so the hook
 * can surface a focused error state without leaking HTTP details
 * to the surface body. The server already enforces ownership +
 * pagination caps; we only forward query parameters.
 */
export async function fetchNoticeJournal(
  args: FetchNoticeJournalArgs,
): Promise<NoticeJournalSnapshot | null> {
  const params = new URLSearchParams();
  if (args.limit != null && Number.isFinite(args.limit) && args.limit > 0) {
    params.set('limit', String(Math.floor(args.limit)));
  }
  if (args.cursor != null && Number.isFinite(args.cursor) && args.cursor > 0) {
    params.set('cursor', String(Math.floor(args.cursor)));
  }
  if (args.type) {
    params.set('type', args.type);
  }
  const qs = params.toString();
  const suffix = qs.length > 0 ? `?${qs}` : '';
  const r = await fetch(
    `${args.baseUrl ?? ''}/api/player/${args.playerId}/notices${suffix}`,
    {credentials: 'include'},
  );
  if (!r.ok) return null;
  const data = (await r.json()) as Partial<NoticeJournalSnapshot>;
  return {
    playerId: data.playerId ?? args.playerId,
    entries: Array.isArray(data.entries) ? data.entries : [],
    nextCursor: typeof data.nextCursor === 'number' ? data.nextCursor : null,
  };
}
