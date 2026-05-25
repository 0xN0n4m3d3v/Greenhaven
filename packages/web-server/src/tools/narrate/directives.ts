/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — Inkle-style `# tag: payload` directive parsing/emission
// wrapper. Spec 37 §2 — parse directives out of the sanitised
// prose, emit them as typed SSE events, and return the cleaned
// prose for the chat bubble. Failures here are deliberately
// non-fatal: a broken directive_tag_types row should not block the
// player from seeing the bubble.

import {emitDirectives, parseDirectives} from '../../directiveParser.js';

export async function applyDirectivePass(args: {
  sessionId: string;
  sanitisedText: string;
}): Promise<{cleanedText: string}> {
  try {
    const parsed = await parseDirectives(args.sanitisedText);
    await emitDirectives(args.sessionId, parsed.directives);
    return {cleanedText: parsed.cleanedProse};
  } catch (err) {
    // CATCH-WARN-OK: directive parsing is best-effort enrichment; the narrate tool falls through to the already-sanitised prose body and the underlying `parseDirectives` failure is surfaced through narrate.sanitiser telemetry (N-2 Phase 1) on the way in.
    console.warn(
      `[narrate] directive parsing failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return {cleanedText: args.sanitisedText};
  }
}
