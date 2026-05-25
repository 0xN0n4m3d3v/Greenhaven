/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-REL-1 (2026-05-17) — Bonds / relationship strings hook.
//
//   * Reads `GET /api/player/:id/strings/graph` through
//     `fetchStringsGraph()` (no leaf-component fetch).
//   * Refreshes on the normalized `system:event` channel when the
//     payload `type === 'string:changed'`; the bridge envelope
//     (`bridge/eventTimeline.ts`) rewrites every released `gui_event`
//     into `__emit('system:event', {type, ...})`, so per-type direct
//     SSE no longer fires for relationship updates in production.
//   * A legacy direct `EventsOn('string:changed', ...)` listener is
//     kept as defensive belt-and-braces: any future SSE that bypasses
//     the normalized envelope will still refresh the surface.
//   * NO mock/demo graph. A missing endpoint, network failure, or
//     non-2xx response surfaces as an `'error'` or `'empty'` state so
//     the UI can render a real empty/loading message instead of fake
//     NPCs. FEAT-REL-1 explicitly removes the
//     `buildMockGraph(playerId)` fallback (the Mira/Jorek demo data)
//     that previously fired on `kind: 'missing'`.

import {useCallback, useEffect, useState} from 'react';
import {EventsOn} from '../bridge/platform';
import {fetchStringsGraph} from '../bridge/strings';
import {useTranslation} from '../i18n';

export type StringKind =
  | 'love'
  | 'desire'
  | 'trust'
  | 'debt'
  | 'rivalry'
  | 'fear'
  | 'resentment'
  | 'loyalty'
  | 'contempt'
  | 'awe';

export type StringValence = 'positive' | 'negative' | 'ambivalent';

export interface StringNode {
  id: number;
  kind: 'player' | 'npc';
  name: string;
  portraitPersonaId?: string;
  archived?: boolean;
}

export interface StringEdge {
  id: string;
  from: number;
  to: number;
  kind: StringKind | string;
  intensity: number;
  valence: StringValence;
  lastEventId?: string;
  lastTurnId?: string;
  summary?: string;
}

export interface StringsGraph {
  playerId: number;
  asOfTurn: string | null;
  nodes: StringNode[];
  edges: StringEdge[];
}

const EMPTY_GRAPH: StringsGraph = {
  playerId: 0,
  asOfTurn: null,
  nodes: [],
  edges: [],
};

interface State {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'forbidden' | 'error';
  graph: StringsGraph;
  error: string | null;
}

export function useStringsGraph(playerId: number | null): State & {
  refresh: () => void;
} {
  const {language} = useTranslation();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<State>({
    status: 'idle',
    graph: EMPTY_GRAPH,
    error: null,
  });

  const refresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!playerId) {
      setState({status: 'idle', graph: EMPTY_GRAPH, error: null});
      return;
    }
    let cancelled = false;
    setState(prev => ({...prev, status: 'loading'}));
    fetchStringsGraph({playerId, language})
      .then(result => {
        if (cancelled) return;
        if (result.kind === 'ready') {
          const graph = result.graph;
          const hasAnyEdge = (graph.edges?.length ?? 0) > 0;
          setState({
            status: hasAnyEdge ? 'ready' : 'empty',
            graph,
            error: null,
          });
        } else if (result.kind === 'forbidden') {
          setState({
            status: 'forbidden',
            graph: {...EMPTY_GRAPH, playerId},
            error: 'forbidden',
          });
        } else {
          // FEAT-REL-1 — no more mock fallback. A 404 / non-2xx /
          // network failure leaves the graph empty and exposes the
          // reason through `error` so the surface can render a real
          // diagnostic.
          setState({
            status: 'error',
            graph: {...EMPTY_GRAPH, playerId},
            error: result.reason || 'unavailable',
          });
        }
      })
      .catch(err => {
        if (cancelled) return;
        setState({
          status: 'error',
          graph: {...EMPTY_GRAPH, playerId},
          error: err instanceof Error ? err.message : 'fetch_failed',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [playerId, tick, language]);

  // FEAT-REL-1 — normalized system:event bus is the canonical refresh
  // trigger (bridge/eventTimeline.ts emits `__emit('system:event',
  // {type: 'string:changed', ...})` for every released gui_event).
  // The legacy direct EventsOn('string:changed', ...) below stays as
  // a defensive fallback for any SSE path that bypasses the envelope.
  useEffect(() => {
    const offSystem = EventsOn('system:event', (data: unknown) => {
      const type =
        data && typeof data === 'object'
          ? (data as {type?: unknown}).type
          : null;
      if (type === 'string:changed') refresh();
    });
    const offLegacy = EventsOn('string:changed', () => refresh());
    return () => {
      offSystem?.();
      offLegacy?.();
    };
  }, [refresh]);

  return {...state, refresh};
}

export const STRING_KIND_HUE: Record<string, number> = {
  love: 340,
  desire: 320,
  trust: 145,
  debt: 38,
  rivalry: 12,
  fear: 200,
  resentment: 280,
  loyalty: 180,
  contempt: 280,
  awe: 50,
};

export function hueForKind(kind: string): number {
  return STRING_KIND_HUE[kind] ?? 220;
}
