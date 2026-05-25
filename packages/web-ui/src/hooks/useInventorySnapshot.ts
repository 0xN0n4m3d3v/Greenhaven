/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-INV-1 — Inventory snapshot hook.
//
// Owns the lifecycle for the `InventorySurface` data fetch:
//
//   * One initial load on mount (or `playerId` / `language`
//     change).
//   * Refresh when the SSE bridge dispatches `inventory:changed`
//     or `currency:changed` (re-emitted via the shared
//     `EventsOn` event bus by `sseClient.ts`). Leaf surface
//     components never call `fetch`; this hook is the only
//     frontend bridge consumer.
//
// Equipment changes flow through the same `inventory:changed`
// channel today: `tools/inventoryExt.ts` updates
// `player_inventory.equipped` and the SSE pipeline emits an
// `inventory:changed` envelope. The hook does not subscribe to
// a separate `equipment:changed` channel because no server
// pipeline emits one — adding the listener silently would
// promise a refresh the server cannot deliver.
//
// Status is one of:
//   * `'loading'` — no snapshot has resolved yet (first load).
//   * `'ready'`   — a snapshot is in hand. Subsequent refreshes
//                   keep the previous data visible until the new
//                   one resolves, so the surface body never
//                   flashes to "loading" mid-session.
//   * `'error'`   — the most recent fetch returned non-2xx. The
//                   surface body surfaces a focused empty state
//                   with the error label.

import {useEffect, useRef, useState} from 'react';
import {EventsOn} from '../bridge/platform';
import {
  fetchPlayerInventory,
  type InventorySnapshot,
} from '../bridge/inventory';

type Status = 'loading' | 'ready' | 'error';

export interface UseInventorySnapshotResult {
  snapshot: InventorySnapshot | null;
  status: Status;
  refresh: () => Promise<void>;
}

const REFRESH_EVENTS = [
  'inventory:changed',
  'currency:changed',
] as const;

export function useInventorySnapshot(args: {
  playerId: number;
  language?: string | null;
  baseUrl?: string;
}): UseInventorySnapshotResult {
  const [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null);
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
      const data = await fetchPlayerInventory({
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
    const offs = REFRESH_EVENTS.map((ev) => EventsOn(ev, handler));
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
