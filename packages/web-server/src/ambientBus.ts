/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 37 §3 — server-side ambient bed selector.
//
// Picks the right `ambient_beds.slug` for the current scene + mode
// and emits an `ambient:bed` SSE event. The client (useAmbientBed
// hook) fetches the bed config via /api/audio/bed/:slug and
// cross-fades. Selection rules:
//   - mode='combat'   → 'combat'
//   - mode='intimacy' → 'intimacy'
//   - sceneTags ⊇ {tavern} → 'tavern'
//   - else            → 'default_quiet'

import {sessionManager} from './sessionManager.js';

export function selectAmbientBed(
  sceneTags: string[] | null | undefined,
  mode: string | null | undefined,
): string {
  if (mode === 'combat') return 'combat';
  if (mode === 'intimacy') return 'intimacy';
  if (sceneTags && sceneTags.includes('tavern')) return 'tavern';
  return 'default_quiet';
}

export function emitAmbientChange(sessionId: string, slug: string): void {
  // SSE-OK: emit outside tx (reason: ambient bed slug is a UI
  // cross-fade hint, not a DB state-change; no row is written).
  sessionManager.get(sessionId)?.sse.emit('ambient:bed', {slug});
}
