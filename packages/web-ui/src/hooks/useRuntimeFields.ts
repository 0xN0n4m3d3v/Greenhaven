// Spec 30 — subscribe to the bridge's `runtime:field` runtime-bus
// event and expose a Map<key, value> keyed by `${owner_entity_id}:
// ${field_key}`. Components select via the helper hooks below.

import {useEffect, useState} from 'react';
import {EventsOn} from '../bridge/platform';

interface FieldChange {
  owner_entity_id: number;
  field_key: string;
  value: unknown;
  source: string;
}

const store = new Map<string, unknown>();
const subs: Set<(m: Map<string, unknown>) => void> = new Set();

function notify() {
  for (const cb of subs) cb(new Map(store));
}

if (typeof window !== 'undefined') {
  EventsOn('runtime:field', (raw: unknown) => {
    const c = raw as FieldChange | undefined;
    if (!c || typeof c.owner_entity_id !== 'number' || !c.field_key) return;
    store.set(`${c.owner_entity_id}:${c.field_key}`, c.value);
    notify();
  });
}

export function useRuntimeField<T = unknown>(
  ownerEntityId: number | null | undefined,
  fieldKey: string,
): T | undefined {
  const [snap, setSnap] = useState<Map<string, unknown>>(() => new Map(store));
  useEffect(() => {
    const cb = (m: Map<string, unknown>) => setSnap(m);
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  }, []);
  if (ownerEntityId == null) return undefined;
  return snap.get(`${ownerEntityId}:${fieldKey}`) as T | undefined;
}

export function useConditionsFor(ownerEntityId: number | null) {
  return (
    useRuntimeField<Array<{tag: string; severity?: number; expires_turn?: number}>>(
      ownerEntityId,
      'conditions',
    ) ?? []
  );
}

export function useStringsFor(ownerEntityId: number | null, playerId: number) {
  const map = useRuntimeField<Record<string, number>>(ownerEntityId, 'strings');
  return Number(map?.[String(playerId)] ?? 0);
}

export function useTrauma(playerId: number | null) {
  return useRuntimeField<string[]>(playerId, 'trauma') ?? [];
}
