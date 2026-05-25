/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-QUEST-1 — Quest Dashboard snapshot hook.
//
// Owns the lifecycle for the `QuestDashboardSurface` data fetch:
//
//   * One initial load on mount (or `playerId` / `language`
//     change).
//   * Refresh whenever a quest- or adventure-relevant event lands
//     anywhere on the existing GUI event plumbing. There are two
//     real transport channels in this codebase, and the dashboard
//     has to listen to both:
//       - `bridge/eventTimeline.ts` re-emits every gui_event
//         envelope (replay + live SSE) onto the in-process bus as
//         `__emit('system:event', {type, ...})`. Quest /
//         adventure events that are *not* `quest:changed` flow
//         through that one channel.
//       - `quest:changed` is handled as a side-effect-only event
//         in the same bridge: it is NOT re-emitted on the
//         `system:event` channel (the timeline doesn't render a
//         `quest:changed` card), but it IS dispatched on
//         `window` via `dispatchQuestChanged`. The dashboard hook
//         keeps a matching `window` listener so side-effect-only
//         quest updates still refresh the visible surface.
//     Both listeners point at the same `load()` so the dashboard
//     can never miss a refresh because the bridge picked the
//     other transport.
//
// Status is `'loading' | 'ready' | 'error'`. Subsequent refreshes
// keep the previous snapshot visible (no flash to "loading" mid-
// session).

import {useEffect, useRef, useState} from 'react';
import {EventsOn} from '../bridge/platform';
import {
  fetchQuestDashboard,
  type QuestDashboardSnapshot,
} from '../bridge/questDashboard';

type Status = 'loading' | 'ready' | 'error';

export interface UseQuestDashboardResult {
  snapshot: QuestDashboardSnapshot | null;
  status: Status;
  refresh: () => Promise<void>;
}

// Mirror of the server-side `QUEST_DASHBOARD_EVENT_TYPES` taxonomy.
// Kept as a literal here so the hook stays a single source of
// truth for refresh wiring; the server-side type list is exported
// from `QuestDashboardService.ts` and is the doc-side canonical
// reference. Any new emit site needs both lists updated.
export const QUEST_DASHBOARD_REFRESH_TYPES: ReadonlySet<string> = new Set([
  'quest:created',
  'quest:started',
  'quest:advanced',
  'quest:auto_advanced',
  'quest:choice_required',
  'quest:completed',
  'quest:changed',
  'adventure:hook',
  'adventure:accepted',
  'adventure:expired',
]);

export function useQuestDashboard(args: {
  playerId: number;
  language?: string | null;
  baseUrl?: string;
}): UseQuestDashboardResult {
  const [snapshot, setSnapshot] = useState<QuestDashboardSnapshot | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const cancelledRef = useRef(false);
  const argsRef = useRef(args);
  argsRef.current = args;

  async function load(): Promise<void> {
    const current = argsRef.current;
    if (!current.playerId || current.playerId <= 0) {
      setSnapshot(null);
      setStatus('ready');
      return;
    }
    try {
      const data = await fetchQuestDashboard({
        playerId: current.playerId,
        language: current.language,
        baseUrl: current.baseUrl,
      });
      if (cancelledRef.current) return;
      if (!data) {
        setStatus('error');
        return;
      }
      setSnapshot(data);
      setStatus('ready');
    } catch {
      if (cancelledRef.current) return;
      setStatus('error');
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    setStatus(snapshot ? 'ready' : 'loading');
    void load();
    const handler = () => {
      void load();
    };
    const offs: Array<() => void> = [];
    // `bridge/eventTimeline.ts:emitSystemEventFromGuiEnvelope`
    // pushes every released gui_event into `__emit('system:event',
    // {type, ...})`. Filter to the dashboard event taxonomy here
    // so unrelated `system:event`s (e.g. `dice:rolled`, `xp:awarded`)
    // do not trigger spurious snapshot fetches.
    offs.push(
      EventsOn('system:event', (data: unknown) => {
        const type =
          data && typeof data === 'object'
            ? (data as {type?: unknown}).type
            : null;
        if (typeof type === 'string' && QUEST_DASHBOARD_REFRESH_TYPES.has(type)) {
          handler();
        }
      }),
    );
    // `quest:changed` is dispatched as a `window` event by the
    // bridge (`dispatchQuestChanged`) and never on the in-process
    // bus. Add a `window` listener so the dashboard refreshes on
    // that side-effect-only transport too.
    if (typeof window !== 'undefined') {
      const winQuestHandler = () => handler();
      window.addEventListener('quest:changed', winQuestHandler);
      offs.push(() =>
        window.removeEventListener('quest:changed', winQuestHandler),
      );
      // `adventure:*` events also produce a `window` `adventure:changed`
      // side effect via `dispatchAdventureChanged`. Listen for it so
      // the dashboard refreshes even if the `system:event` filter is
      // bypassed by a future timeline change.
      const winAdvHandler = () => handler();
      window.addEventListener('adventure:changed', winAdvHandler);
      offs.push(() =>
        window.removeEventListener('adventure:changed', winAdvHandler),
      );
    }
    return () => {
      cancelledRef.current = true;
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.playerId, args.language, args.baseUrl]);

  return {
    snapshot,
    status,
    refresh: load,
  };
}
