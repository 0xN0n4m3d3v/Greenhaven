/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// AI-1 / N-3 — bounded JSON salvage helpers.
//
// Greenhaven calls `JSON.parse` in a handful of places where the
// input is model-provided text: AI SDK tool-arg salvage
// (`ai/toolAdapter.ts`), narrate handoff-error salvage
// (`ai/handoff.ts`), narrate wrapper-unwrap and embedded-JSON
// scanning (`tools/narrate.ts`). Each site previously called
// `JSON.parse` directly on unbounded model text, which lets a
// pathological generation pin a single broker turn on JSON parsing
// of megabytes of generated text.
//
// `MAX_JSON_SALVAGE_CHARS` is the single source of truth for the
// cap (128 KiB). The helper below performs the length check before
// `JSON.parse`, so an over-cap candidate is never even tokenised.
// Callers pass the result through their existing post-validation
// (Zod schema, `text` extraction, candidate filtering) so the only
// behavioural change is: over-cap candidates fall through to the
// raw-text path instead of running `JSON.parse`.

export const MAX_JSON_SALVAGE_CHARS = 128 * 1024;

/**
 * Result shape for `tryParseJsonWithinCap`. `ok: true` carries the
 * parsed value (which may legitimately be `null`, `0`, `false`,
 * etc., for JSON literals). `ok: false` distinguishes over-cap
 * (input too long, never parsed) from malformed JSON so callers can
 * surface telemetry separately if they care to.
 */
export type BoundedJsonParseResult =
  | {ok: true; value: unknown}
  | {ok: false; reason: 'over_cap' | 'malformed'};

/**
 * Parse `text` as JSON only when `text.length <= MAX_JSON_SALVAGE_CHARS`.
 * Returns a tagged result so callers can distinguish a JSON-literal
 * `null` from a parse failure.
 */
export function tryParseJsonWithinCap(text: string): BoundedJsonParseResult {
  if (text.length > MAX_JSON_SALVAGE_CHARS) {
    return {ok: false, reason: 'over_cap'};
  }
  try {
    return {ok: true, value: JSON.parse(text)};
  } catch {
    return {ok: false, reason: 'malformed'};
  }
}
