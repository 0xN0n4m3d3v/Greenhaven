/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-NOTICE-1 — Notice Journal snapshot hook.
//
// Owns the lifecycle for the `NoticeJournalSurface` data fetch:
//
//   * One initial load on mount (or `playerId` / `language` /
//     `type` change). `type` is server-owned: changing the chip
//     refetches `/api/player/:id/notices?type=...` rather than
//     filtering loaded text locally, so the server is canon for
//     bucket membership.
//   * Refresh whenever any released `gui_event` envelope whose
//     `event_type` is in `JOURNAL_REFRESH_TYPES` reaches the
//     `system:event` bus that `bridge/eventTimeline.ts` already
//     feeds (`emitSystemEventFromGuiEnvelope` pushes every released
//     envelope into `__emit('system:event', {type, ...})`).
//     Spurious system events outside the taxonomy are filtered
//     server-side by `NoticeJournalService` and client-side here.
//   * `loadMore()` appends the next page using the server-returned
//     `nextCursor` (cursor pagination, exclusive). Entries are
//     deduped by `id` so a refresh that crosses a page boundary
//     never doubles a row.
//
// Refresh coalescing: bursts of important events within a short
// window collapse into a single refetch via a tiny debounce. This
// keeps the storm of `quest:advanced` + `xp:awarded` + `string:changed`
// that fires on quest completion from triggering five sequential
// fetches.
//
// Status is `'loading' | 'ready' | 'error'`. Subsequent refreshes
// keep the previous entries visible (no flash to "loading" mid-
// session); `loading` only fires before the very first snapshot
// resolves or after a `type` change that reset the list.

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {EventsOn} from '../bridge/platform';
import {
  fetchNoticeJournal,
  type JournalEntryType,
  type NoticeJournalEntry,
  type NoticeJournalSnapshot,
} from '../bridge/noticeJournal';

type Status = 'loading' | 'ready' | 'error';

export interface UseNoticeJournalArgs {
  playerId: number;
  language?: string | null;
  baseUrl?: string;
  pageSize?: number;
  type?: JournalEntryType | null;
}

export interface UseNoticeJournalResult {
  entries: NoticeJournalEntry[];
  status: Status;
  nextCursor: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

// Mirror of the server-side `IMPORTANT_EVENT_TYPES`. Kept as a
// `Set` here so the hook stays a single source of truth for the
// refresh filter; the server-side array is canon for journal
// membership, this matches it 1:1.
export const JOURNAL_REFRESH_TYPES: ReadonlySet<string> = new Set([
  'quest:created',
  'quest:started',
  'quest:advanced',
  'quest:auto_advanced',
  'quest:completed',
  'adventure:accepted',
  'adventure:expired',
  'memory:added',
  'memory:enriched',
  'string:changed',
  'companion:added',
  'companion:removed',
  'xp:awarded',
  'xp:levelup',
  'location:first_entry',
]);

const DEFAULT_PAGE_SIZE = 50;
const REFRESH_COALESCE_MS = 150;

export function useNoticeJournal(
  args: UseNoticeJournalArgs,
): UseNoticeJournalResult {
  const [entries, setEntries] = useState<NoticeJournalEntry[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const argsRef = useRef(args);
  argsRef.current = args;
  // FEAT-NOTICE-1 hardening: a single boolean `cancelledRef` is
  // not enough when the effect re-runs faster than an in-flight
  // fetch resolves — the cleanup of generation N sets it `true`,
  // generation N+1 resets it to `false`, and N's late response
  // sneaks past the guard and writes stale rows. A monotonic
  // generation counter, captured at fetch start, lets every
  // pending request decide for itself whether its writes are
  // still wanted.
  const generationRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pageSize = useMemo(() => {
    const raw = args.pageSize;
    if (raw == null) return DEFAULT_PAGE_SIZE;
    const n = Math.floor(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
    return Math.min(200, n);
  }, [args.pageSize]);

  const mergeSnapshot = useCallback(
    (
      snapshot: NoticeJournalSnapshot,
      mode: 'reset' | 'append',
    ): NoticeJournalEntry[] => {
      const incoming = snapshot.entries;
      if (mode === 'reset') return incoming;
      const seen = new Set<number>();
      const merged: NoticeJournalEntry[] = [];
      for (const row of entriesRef.current) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
      }
      for (const row of incoming) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
      }
      // Keep newest-first by id descending; the server already
      // returns rows in that order, but defensively sort in case
      // a refresh interleaves with a loadMore.
      merged.sort((a, b) => b.id - a.id);
      return merged;
    },
    [],
  );
  // Keep an always-fresh ref of the latest entries so the
  // `mergeSnapshot` closure sees current data even when several
  // refreshes race.
  const entriesRef = useRef<NoticeJournalEntry[]>([]);
  entriesRef.current = entries;
  // Mirror of the `nextCursor` state so `performLoad('append')`
  // can read the server-returned cursor without re-rendering
  // when it changes (the state value lags the latest server
  // response by one render).
  const nextCursorRef = useRef<number | null>(null);
  nextCursorRef.current = nextCursor;

  const performLoad = useCallback(
    async (mode: 'reset' | 'append'): Promise<void> => {
      const current = argsRef.current;
      const requestGeneration = generationRef.current;
      const isStale = (): boolean =>
        generationRef.current !== requestGeneration;
      if (!current.playerId || current.playerId <= 0) {
        if (isStale()) return;
        setEntries([]);
        setNextCursor(null);
        setStatus('ready');
        return;
      }
      // FEAT-NOTICE-1 hardening: `loadMore` must send the
      // server-returned `nextCursor` as `cursor`, not a recomputed
      // last-row id. The two values agree today (the server emits
      // the smallest id from the page as `nextCursor`), but the
      // documented contract is "send the cursor the server gave
      // you" — drift between them would surface immediately if
      // the server's pagination logic ever changed (e.g. a future
      // `importance`-aware ordering). Reading `nextCursorRef`
      // (kept in sync with the `nextCursor` state) instead of
      // entriesRef makes the contract explicit.
      const cursor = mode === 'append' ? nextCursorRef.current : null;
      try {
        if (mode === 'append') setLoadingMore(true);
        const data = await fetchNoticeJournal({
          playerId: current.playerId,
          limit: pageSize,
          cursor,
          type: current.type ?? null,
          baseUrl: current.baseUrl,
        });
        if (isStale()) return;
        if (!data) {
          setStatus('error');
          return;
        }
        setEntries((_prev) => mergeSnapshot(data, mode));
        setNextCursor(data.nextCursor);
        setStatus('ready');
      } catch {
        if (isStale()) return;
        setStatus('error');
      } finally {
        if (!isStale()) setLoadingMore(false);
      }
    },
    [mergeSnapshot, pageSize],
  );

  const scheduleRefresh = useCallback((): void => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void performLoad('reset');
    }, REFRESH_COALESCE_MS);
  }, [performLoad]);

  useEffect(() => {
    // Bump the generation token so any in-flight fetch from a
    // previous player/filter generation no-ops when it lands.
    generationRef.current += 1;
    // Reset on identity change: a new player, language, or
    // server-side type filter starts a fresh listing.
    setEntries([]);
    setNextCursor(null);
    setStatus('loading');
    void performLoad('reset');

    const offs: Array<() => void> = [];
    // The bridge feeds every released gui_event into
    // `system:event`; filter to the journal taxonomy here so
    // unrelated envelopes (chat lifecycle, dice, telemetry) do
    // not trigger spurious refetches.
    offs.push(
      EventsOn('system:event', (data: unknown) => {
        const type =
          data && typeof data === 'object'
            ? (data as {type?: unknown}).type
            : null;
        if (
          typeof type === 'string' &&
          JOURNAL_REFRESH_TYPES.has(type)
        ) {
          scheduleRefresh();
        }
      }),
    );
    return () => {
      // Bump the generation token on cleanup so the late
      // response from the most recent fetch of this generation
      // is treated as stale and never writes after unmount /
      // identity change.
      generationRef.current += 1;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.playerId, args.language, args.baseUrl, args.type]);

  const refresh = useCallback(async (): Promise<void> => {
    await performLoad('reset');
  }, [performLoad]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingMore) return;
    if (nextCursor == null) return;
    await performLoad('append');
  }, [loadingMore, nextCursor, performLoad]);

  return {
    entries,
    status,
    nextCursor,
    hasMore: nextCursor != null,
    loadingMore,
    refresh,
    loadMore,
  };
}
