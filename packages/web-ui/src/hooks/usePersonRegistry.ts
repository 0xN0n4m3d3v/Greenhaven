// Spec 32 §A.1 (audit follow-up) — person-id → {portrait_set,
// persona_slug, persona_hue} map fetched from /api/character/persons.
// Bridge nearby[] is currently empty; this hook fills the gap so
// MessageFlow can resolve portrait_set per author id without per-
// bubble round-trips.

import {useEffect, useState} from 'react';
import {fetchPersonRegistry} from '../bridge/character';

export interface PersonRecord {
  id: number;
  name: string;
  portrait_set: Record<string, string | null> | null;
  persona_slug: string | null;
  persona_hue: string | null;
}

export type PersonRegistry = Map<number, PersonRecord>;

export function usePersonRegistry(baseUrl = ''): PersonRegistry {
  const [reg, setReg] = useState<PersonRegistry>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    fetchPersonRegistry({baseUrl})
      .then(persons => {
        if (cancelled) return;
        const m: PersonRegistry = new Map();
        for (const p of persons) m.set(p.id, p);
        setReg(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);
  return reg;
}
