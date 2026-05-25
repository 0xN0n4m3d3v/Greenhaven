/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — Character State snapshot hook (scaffold).
//
// Owns the lifecycle for the future `CharacterStateSurface` data
// fetch:
//
//   * One initial load on mount (or `playerId` / `language` /
//     `baseUrl` change).
//   * Refresh whenever any event on the
//     `CHARACTER_STATE_REFRESH_TYPES` taxonomy reaches the
//     `system:event` bus that `bridge/eventTimeline.ts` already
//     feeds (the same channel the notice-journal hook listens
//     on). The taxonomy mirrors the Phase 9 fixspec FEAT-STATE-1
//     refresh list, scoped to envelopes the current server
//     actually emits.
//   * Stale-write guard via a monotonic generation token so a
//     late response from a previous player/filter generation
//     never mutates state in a newer one. Mirrors the
//     `useNoticeJournal` hardening pattern from FEAT-NOTICE-1.
//
// Status is `'loading' | 'ready' | 'error'`. Subsequent refreshes
// keep the previous snapshot visible (no flash to "loading"
// mid-session); `loading` only fires before the very first
// snapshot resolves or after a `playerId` change that reset the
// snapshot.
//
// This file is the SERVER-CONTRACT-FACING scaffold for the
// backend slice. The visible `CharacterStateSurface` body
// replacement and any tabbed UI (Overview / Attributes / Skills /
// Titles / Progression Log) ship in the next FEAT-STATE-1 slice
// per Codex's bounded spec — this hook intentionally exposes the
// snapshot through a stable shape so the later UI pass can drop
// in without re-plumbing.

import {useCallback, useEffect, useRef, useState} from 'react';
import {EventsOn} from '../bridge/platform';
import {
  fetchCharacterState,
  type CharacterStateSnapshot,
} from '../bridge/characterState';

type Status = 'loading' | 'ready' | 'error';

export interface UseCharacterStateArgs {
  playerId: number;
  language?: string | null;
  baseUrl?: string;
}

export interface UseCharacterStateResult {
  snapshot: CharacterStateSnapshot | null;
  status: Status;
  refresh: () => Promise<void>;
}

// Events that travel through the `system:event` replay/live
// channel that `bridge/eventTimeline.ts` already feeds. Every
// `character:*` envelope emitted by the FEAT-STATE-1 mutation
// tools, plus the broker-side `xp:awarded` / `xp:levelup`
// channels and the `damage:dealt` / `actor:status_changed`
// channels that affect HP / conditions, lands here.
export const CHARACTER_STATE_REFRESH_TYPES: ReadonlySet<string> = new Set([
  'xp:awarded',
  'xp:levelup',
  'character:stat_changed',
  'character:skill_unlocked',
  'character:skill_progressed',
  'character:title_awarded',
  'character:title_equipped',
  'damage:dealt',
  'actor:status_changed',
]);

// Events the SSE client re-emits as direct named bus channels
// (NOT wrapped in `system:event`). `inventory:changed` and
// `currency:changed` flow this way out of `sseClient.ts`. The
// hook listens on both transports so an equipment change or a
// gold pickup refreshes the equipment summary / wallet panes
// without having to round-trip through the gui_events replay.
const CHARACTER_STATE_DIRECT_REFRESH_TYPES = [
  'inventory:changed',
  'currency:changed',
  // `equipment:changed` is reserved in the Phase 9 fixspec; if a
  // future server emitter wires it as a direct SSE channel it
  // will refresh here without a client edit.
  'equipment:changed',
] as const;

const REFRESH_COALESCE_MS = 150;

export function useCharacterState(
  args: UseCharacterStateArgs,
): UseCharacterStateResult {
  const [snapshot, setSnapshot] = useState<CharacterStateSnapshot | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  const argsRef = useRef(args);
  argsRef.current = args;
  const generationRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const performLoad = useCallback(async (): Promise<void> => {
    const current = argsRef.current;
    const requestGeneration = generationRef.current;
    const isStale = (): boolean =>
      generationRef.current !== requestGeneration;
    if (!current.playerId || current.playerId <= 0) {
      if (isStale()) return;
      setSnapshot(null);
      setStatus('ready');
      return;
    }
    try {
      const data = await fetchCharacterState({
        playerId: current.playerId,
        language: current.language,
        baseUrl: current.baseUrl,
      });
      if (isStale()) return;
      if (!data) {
        // 404 / non-2xx — clear the prior snapshot so a stale
        // sheet from the previous player or a failed request
        // cannot remain visible under the error label. The
        // surface body keys its error branch off
        // `status === 'error' && !snapshot`.
        setSnapshot(null);
        setStatus('error');
        return;
      }
      setSnapshot(data);
      setStatus('ready');
    } catch {
      if (isStale()) return;
      // Same contract as the !data branch above: a network
      // exception clears the prior snapshot so the surface
      // never shows another player's sheet under an error.
      setSnapshot(null);
      setStatus('error');
    }
  }, []);

  const scheduleRefresh = useCallback((): void => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void performLoad();
    }, REFRESH_COALESCE_MS);
  }, [performLoad]);

  useEffect(() => {
    generationRef.current += 1;
    // FEAT-STATE-1 hardening: identity change (player /
    // language / baseUrl) ALWAYS resets the snapshot. The
    // previous player's sheet must never be visible while we
    // are loading the new one, and the previous player's
    // sheet must never linger under a 404 / error response on
    // the new player either.
    setSnapshot(null);
    setStatus('loading');
    void performLoad();

    const offs: Array<() => void> = [];
    offs.push(
      EventsOn('system:event', (data: unknown) => {
        const type =
          data && typeof data === 'object'
            ? (data as {type?: unknown}).type
            : null;
        if (
          typeof type === 'string' &&
          CHARACTER_STATE_REFRESH_TYPES.has(type)
        ) {
          scheduleRefresh();
        }
      }),
    );
    // Direct named-bus channels — `inventory:changed` and
    // `currency:changed` are emitted by `sseClient.ts` as their
    // own keys, not wrapped in `system:event`. Adding listeners
    // here makes equipment / wallet panes refresh on the same
    // tick the Inventory surface does.
    for (const channel of CHARACTER_STATE_DIRECT_REFRESH_TYPES) {
      offs.push(EventsOn(channel, () => scheduleRefresh()));
    }
    return () => {
      generationRef.current += 1;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.playerId, args.language, args.baseUrl]);

  return {snapshot, status, refresh: performLoad};
}
