// U-1 — character bridge. Owns every direct HTTP touchpoint for
// the character creator and the rail's person registry, so the
// components/hooks stay free of `fetch(...)`. Existing error
// surfaces (issues array on profile PATCH, polish failure message,
// classLoadError string) are preserved verbatim.

import type {ClassRow} from '../components/character/wizardTypes';
import type {PersonRecord} from '../hooks/usePersonRegistry';
import type {SynthesisResult} from '../components/character/creator/types';

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {...init, credentials: 'include'});
  const text = await res.text();
  let body: unknown = {};
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = {raw: text};
    }
  }
  if (!res.ok) {
    const baseMessage =
      body && typeof body === 'object' && 'error' in body
        ? String((body as {error?: unknown}).error)
        : text || `${res.status} ${res.statusText}`;
    const issues =
      body && typeof body === 'object' && Array.isArray((body as {issues?: unknown}).issues)
        ? ((body as {issues: Array<{path?: unknown; message?: unknown}>}).issues)
            .map(issue => {
              const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
              const message =
                typeof issue.message === 'string' ? issue.message : 'invalid value';
              return path ? `${path}: ${message}` : message;
            })
            .slice(0, 4)
            .join('; ')
        : '';
    throw new Error(issues ? `${baseMessage} (${issues})` : baseMessage);
  }
  return body as T;
}

async function postJsonStrict<T>(args: {
  url: string;
  body: unknown;
}): Promise<T> {
  const res = await fetch(args.url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    credentials: 'include',
    body: JSON.stringify(args.body),
  });
  const text = await res.text();
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = {raw: text};
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as {error?: unknown}).error)
        : text || `${res.status} ${res.statusText}`;
    const issues =
      data && typeof data === 'object' && Array.isArray((data as {issues?: unknown}).issues)
        ? ((data as {issues: Array<{path?: unknown; message?: unknown}>}).issues)
            .map(issue => {
              const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
              const issueMessage =
                typeof issue.message === 'string' ? issue.message : 'invalid value';
              return path ? `${path}: ${issueMessage}` : issueMessage;
            })
            .slice(0, 4)
            .join('; ')
        : '';
    throw new Error(issues ? `${message} (${issues})` : message);
  }
  return data as T;
}

export async function fetchCharacterClasses(args: {
  language?: string | null;
  baseUrl?: string;
}): Promise<{classes: ClassRow[]}> {
  const url = new URL(
    `${args.baseUrl ?? ''}/api/character/classes`,
    window.location.origin,
  );
  if (args.language) url.searchParams.set('language', args.language);
  const r = await fetch(url.toString(), {credentials: 'include'});
  if (!r.ok) throw new Error(`classes failed: ${r.status}`);
  const d = (await r.json()) as {classes?: ClassRow[]};
  return {classes: Array.isArray(d.classes) ? d.classes : []};
}

export async function fetchPersonRegistry(args: {
  baseUrl?: string;
}): Promise<PersonRecord[]> {
  const r = await fetch(`${args.baseUrl ?? ''}/api/character/persons`, {
    credentials: 'include',
  });
  const d = (await r.json()) as {persons?: PersonRecord[]};
  return Array.isArray(d.persons) ? d.persons : [];
}

export interface CharacterProfilePatch {
  identity?: Record<string, unknown>;
  physical?: Record<string, unknown>;
  background?: Record<string, unknown>;
  starting_class_id?: number | null;
  creator_sheet?: Record<string, unknown>;
  synthesized_class_overridden?: boolean;
  created?: boolean;
}

export async function patchCharacterProfile(args: {
  playerId: number;
  body: CharacterProfilePatch;
  baseUrl?: string;
}): Promise<{profile: unknown}> {
  return requestJson<{profile: unknown}>(
    `${args.baseUrl ?? ''}/api/player/${encodeURIComponent(String(args.playerId))}/profile`,
    {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(args.body),
    },
  );
}

export async function postCharacterStats(args: {
  playerId: number;
  // `scores` is forwarded verbatim. The character creator passes a
  // typed `Stats` record from `components/character/wizardTypes`,
  // but other callers may use plain objects, so the bridge accepts
  // any JSON-serialisable shape.
  scores: Record<string, number> | object;
  method?: 'point_buy' | 'standard_array' | 'roll';
  baseUrl?: string;
}): Promise<{ok: boolean}> {
  return requestJson<{ok: boolean}>(
    `${args.baseUrl ?? ''}/api/character/${encodeURIComponent(String(args.playerId))}/stats`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({scores: args.scores, method: args.method ?? 'point_buy'}),
    },
  );
}

export async function postCharacterSkills(args: {
  playerId: number;
  picks: string[];
  baseUrl?: string;
}): Promise<{ok: boolean}> {
  return requestJson<{ok: boolean}>(
    `${args.baseUrl ?? ''}/api/character/${encodeURIComponent(String(args.playerId))}/skills`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({picks: args.picks}),
    },
  );
}

export interface PolishRequestBody {
  name: string;
  description: string;
  history: string;
  language?: string | null;
}

export async function polishCharacterDescription(args: {
  body: PolishRequestBody;
  baseUrl?: string;
}): Promise<unknown> {
  return postJsonStrict<unknown>({
    url: `${args.baseUrl ?? ''}/api/character/polish-description`,
    body: args.body,
  });
}

export async function polishCharacterHistory(args: {
  body: PolishRequestBody;
  baseUrl?: string;
}): Promise<unknown> {
  return postJsonStrict<unknown>({
    url: `${args.baseUrl ?? ''}/api/character/polish-history`,
    body: args.body,
  });
}

export interface SynthesizeCharacterSheetBody {
  transcript: Array<{q: string; a: string}>;
  language: string | null;
  partialState: Record<string, unknown>;
}

export async function synthesizeCharacterSheet(args: {
  body: SynthesizeCharacterSheetBody;
  baseUrl?: string;
}): Promise<SynthesisResult> {
  return postJsonStrict<SynthesisResult>({
    url: `${args.baseUrl ?? ''}/api/character/sheet/synthesize`,
    body: args.body,
  });
}
