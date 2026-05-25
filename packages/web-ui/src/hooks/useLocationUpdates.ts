import {useEffect} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import {EventsOn} from '../bridge/platform';
import {normalizeState} from '../lib/state';
import type {GameState} from '../types/app';

type LocationUpdatePayload = Array<{
  id: number;
  name: string;
  status?: string;
  unread?: number;
  visual_asset_urls?: Record<string, string> | null;
}>;

type NearbyUpdatePayload = Array<{
  id: number;
  name: string;
  status?: string;
  summary?: string | null;
  portrait_set?: Record<string, string | null> | null;
  // FEAT-PRESENCE-1 — server-canonical bond / status enrichment.
  // Server omits the fields entirely on legacy emitters; the consumer
  // treats absence the same as `band: null` + empty status list.
  relationship?: {band: string | null; count: number | null} | null;
  statuses?: Array<{kind: string; value: string; intensity: number}>;
}>;

type MapNodePayload = Array<{
  id: number;
  name: string;
  kind: string;
  location_kind: string | null;
  x: number;
  y: number;
  color: string | null;
  topology_parent_id: number | null;
  is_current: boolean;
  is_exit: boolean;
  visual_asset_urls?: Record<string, string> | null;
}>;

export function useLocationUpdates(
  setState: Dispatch<SetStateAction<GameState | null>>,
): void {
  useEffect(() => {
    const off = EventsOn('locations:updated', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as LocationUpdatePayload | undefined;
      if (!Array.isArray(payload)) {
        console.warn(
          '[useLocationUpdates] locations:updated payload not an array; ignoring',
          payload,
        );
        return;
      }
      console.log(
        `[useLocationUpdates] locations:updated count=${payload.length} ` +
          `current=${
            payload.find(l => l.status === 'current')?.name ?? '(none)'
          }`,
      );
      setState(prev => {
        if (!prev) {
          console.warn('[useLocationUpdates] prev state is null; ignoring');
          return prev;
        }
        const normalised = payload.map(location => ({
          id: location.id,
          name: location.name,
          status: location.status ?? 'connected',
          unread: location.unread ?? 0,
          visual_asset_urls: location.visual_asset_urls ?? null,
        }));
        const current =
          normalised.find(location => location.status === 'current') ??
          normalised[0] ??
          null;
        const next = {...prev} as typeof prev & {
          locations: unknown;
          currentLocation: unknown;
        };
        next.locations = normalised;
        if (current) {
          next.currentLocation = {
            ...(prev.currentLocation ?? {}),
            id: current.id,
            name: current.name,
            status: current.status,
            unread: current.unread,
            visual_asset_urls: current.visual_asset_urls ?? null,
          };
        }
        console.log(
          `[useLocationUpdates] setState prev.currentLocation=${
            (prev.currentLocation as {name?: string} | undefined)?.name ?? '?'
          } → next.currentLocation=${(next.currentLocation as {name?: string}).name ?? '?'}`,
        );
        return normalizeState(next as never);
      });
    });
    return () => off();
  }, [setState]);

  useEffect(() => {
    const off = EventsOn('map:updated', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as MapNodePayload | undefined;
      if (!Array.isArray(payload)) {
        console.warn('[useLocationUpdates] map:updated payload not an array');
        return;
      }
      console.log(
        `[useLocationUpdates] map:updated nodes=${payload.length} ` +
          `current=${payload.find(n => n.is_current)?.name ?? '(none)'} ` +
          `exits=${payload.filter(n => n.is_exit).length}`,
      );
      setState(prev => {
        if (!prev) return prev;
        return normalizeState({
          ...prev,
          mapNodes: payload,
        } as never);
      });
    });
    return () => off();
  }, [setState]);

  useEffect(() => {
    const off = EventsOn('nearby:updated', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as NearbyUpdatePayload | undefined;
      if (!Array.isArray(payload)) {
        console.warn('[useLocationUpdates] nearby:updated payload not an array');
        return;
      }
      console.log(
        `[useLocationUpdates] nearby:updated count=${payload.length} ` +
          `names=${payload.slice(0, 4).map(n => n.name).join(',') || '(none)'}` +
          (payload.length > 4 ? '…' : ''),
      );
      setState(prev => {
        if (!prev) return prev;
        return normalizeState({
          ...prev,
          nearby: payload.map(npc => ({
            id: npc.id,
            name: npc.name,
            status: npc.status,
            summary: npc.summary,
            portrait_set: npc.portrait_set,
            relationship: npc.relationship ?? null,
            statuses: Array.isArray(npc.statuses) ? npc.statuses : [],
          })),
        } as never);
      });
    });
    return () => off();
  }, [setState]);
}
