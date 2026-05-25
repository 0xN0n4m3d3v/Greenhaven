/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 37 §2 — Inkle Ink-style directive tag parser.
//
// Narrator output may include lines like:
//   # portrait: amused
//   # audio: combat_start
//   # banner: dialogue_with(@mikka)
//   # mood: tense
//
// Server strips these from prose, looks up the tag in
// directive_tag_types (migration 0045), parses the payload, and
// emits the corresponding SSE event. Unknown tags are silently
// stripped (tolerate model improvisation).
//
// Dual interface: the broker can also pass a structured `directives`
// arg on `narrate` (alternative path); both end up in the same
// emitter loop.

import {query} from './db.js';
import {emitGuiEventForSession} from './guiEventOutbox.js';

const DIRECTIVE_RE = /(?:^|\n)#\s*([a-z_]+)\s*:\s*([^\n#]+)/gi;

export interface DirectiveMatch {
  tag: string;
  payload: Record<string, unknown>;
}

interface DirectiveTagDef {
  tag: string;
  sse_event: string;
  payload_schema: Record<string, string>;
}

let cache: Map<string, DirectiveTagDef> | null = null;

async function getTagDefs(): Promise<Map<string, DirectiveTagDef>> {
  if (cache) return cache;
  const r = await query<{tag: string; sse_event: string; payload_schema: unknown}>(
    `SELECT tag, sse_event, payload_schema FROM directive_tag_types`,
  );
  const m = new Map<string, DirectiveTagDef>();
  for (const row of r.rows) {
    m.set(row.tag, {
      tag: row.tag,
      sse_event: row.sse_event,
      payload_schema:
        typeof row.payload_schema === 'object' && row.payload_schema !== null
          ? (row.payload_schema as Record<string, string>)
          : {},
    });
  }
  cache = m;
  return m;
}

export function clearDirectiveCache(): void {
  cache = null;
}

export async function parseDirectives(
  prose: string,
): Promise<{cleanedProse: string; directives: DirectiveMatch[]}> {
  const directives: DirectiveMatch[] = [];
  const allowed = await getTagDefs();
  const cleaned = prose.replace(
    DIRECTIVE_RE,
    (_match: string, rawTag: string, rawPayload: string) => {
      const tag = rawTag.toLowerCase().trim();
      const def = allowed.get(tag);
      if (!def) return '';
      const payload = parsePayload(rawPayload.trim(), def.payload_schema);
      if (payload) directives.push({tag, payload});
      return '';
    },
  );
  return {
    cleanedProse: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    directives,
  };
}

function parsePayload(
  raw: string,
  schema: Record<string, string>,
): Record<string, unknown> | null {
  const keys = Object.keys(schema);
  if (keys.length === 0) return {};
  if (keys.length === 1 && !raw.includes('=')) {
    const k = keys[0]!.replace(/\?$/, '');
    return {[k]: raw};
  }
  const out: Record<string, unknown> = {};
  for (const part of raw.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export async function emitDirectives(
  sessionId: string,
  directives: DirectiveMatch[],
): Promise<void> {
  if (directives.length === 0) return;
  const allowed = await getTagDefs();
  for (const d of directives) {
    const def = allowed.get(d.tag);
    if (!def) continue;
    await emitGuiEventForSession(sessionId, def.sse_event, d.payload);
  }
}
