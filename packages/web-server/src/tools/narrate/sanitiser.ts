/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — narrate sanitiser. The flow that runs against raw narrator
// output before any directive parsing or persistence.
// N-2 Phase 1 — sanitiser firings are tracked via
// `sanitiseNarrateTextWithReport(text, language?)`. The original
// `sanitiseNarrateText(text, language?)` ABI keeps returning a plain
// string so non-runtime callers (dialogueContext, narrationSynthesis,
// supportSmoke) stay byte-for-byte identical.
// N-2 Phase 3 (2026-05-17, operator override) — the runtime
// leakage-regex pipeline has been deleted. The four meta-section
// scrubbers (`analysis_heading`, `stanislavski_label_bold`,
// `stanislavski_label_plain`, `bracket_meta`) lived here as belt-and-
// suspenders for the prompt contract; the prompt-side leak guard
// (Phase 2) plus the sanitizer telemetry pair are now the control
// layer. Historical telemetry / audit code may still report these
// ids when summarizing stored rows (see
// `devtools/telemetryDiagnostics.ts` + tests under
// `__tests__/devtools/narrateSanitiser*.test.ts`) but the live
// sanitizer will no longer emit them.
// N-4 — paragraph dedup no longer uses a bare `toLowerCase()` key.
// Strict trimmed comparison is the default; a validated BCP-47
// locale (passed in by the runtime narrate tool from
// `activeTurn.language`) opts in to `toLocaleLowerCase(locale)` so
// Turkish dotted-I (`İstanbul` / `istanbul` under `tr`) dedupes
// correctly without leaking the host's `process.env.LANG` into
// runtime decisions.
//
// Pipeline (current, post-Phase-3 deletion):
//   0. `unwrapNarrateArgsText` — peel a stray `{"text":"..."}` or
//      fenced wrapper.                                  → wrapper_unwrap
//   1. JSON wrapper unwrap (under-cap only).            → json_wrapper_unwrap
//   2. Collapse consecutive duplicate paragraphs.       → paragraph_dedup

import {tryParseJsonWithinCap} from '../../jsonSalvage.js';
import {unwrapNarrateArgsText} from './jsonText.js';

export type SanitiserPatternId =
  | 'wrapper_unwrap'
  | 'json_wrapper_unwrap'
  | 'paragraph_dedup';

export interface NarrateSanitiserReport {
  text: string;
  changed: boolean;
  patternsFired: SanitiserPatternId[];
  originalLength: number;
  sanitisedLength: number;
  /** First 200 characters of the raw input. Never carries the full
   *  prose — telemetry must not log the entire narrator output. */
  originalPrefix: string;
}

const ORIGINAL_PREFIX_CAP = 200;

/**
 * Apply the syntax-neutral narrate sanitizer to the raw model output.
 *
 * Current behaviour is wrapper-unwrap + capped JSON wrapper unwrap +
 * consecutive-paragraph dedup. Wire-format leak guards live in the
 * narrator / broker / scene-painter prompts; the runtime no longer
 * scrubs meta-section labels because the prompt-side contract and
 * telemetry pair (`narrate.sanitiser.inspected` +
 * `narrate.sanitiser.fired`) are the control layer.
 */
export function sanitiseNarrateText(
  text: string,
  language?: string | null,
): string {
  return sanitiseNarrateTextWithReport(text, language).text;
}

/**
 * N-4 — build a paragraph dedup key. Strict trimmed comparison is
 * the default so non-runtime callers (dialogueContext, narration
 * synthesis, support smoke) never trip over the JavaScript host's
 * implicit system locale. When the caller passes a valid BCP-47
 * tag (validated through `Intl.getCanonicalLocales`) the comparison
 * uses `toLocaleLowerCase(locale)`. Invalid or empty locale strings
 * fall back to strict comparison rather than silently folding under
 * the host default.
 */
function paragraphDedupKey(
  trimmed: string,
  language: string | null | undefined,
): string {
  if (typeof language !== 'string' || language.trim().length === 0) {
    return trimmed;
  }
  try {
    const canonical = Intl.getCanonicalLocales(language);
    if (canonical.length === 0) return trimmed;
    return trimmed.toLocaleLowerCase(canonical[0]!);
  } catch {
    return trimmed;
  }
}

/**
 * N-2 Phase 1 — observable sanitiser pipeline. Returns the cleaned
 * text plus a structured report of which patterns fired so the
 * runtime narrate tool can record telemetry without changing
 * sanitiser output.
 *
 * Each pattern is detected by comparing the pre- and post-step text;
 * the equality check is cheaper than a regex callback and unaffected
 * by `lastIndex` state on cached globals.
 */
export function sanitiseNarrateTextWithReport(
  text: string,
  language?: string | null,
): NarrateSanitiserReport {
  const originalLength = text.length;
  const originalPrefix = text.slice(0, ORIGINAL_PREFIX_CAP);
  const patternsFired: SanitiserPatternId[] = [];

  let t = text;

  const unwrapped = unwrapNarrateArgsText(t);
  if (unwrapped != null) {
    if (unwrapped !== t) {
      patternsFired.push('wrapper_unwrap');
    }
    t = unwrapped;
  }

  // 1. JSON wrapper unwrap — Magnum Diamond and some other Featherless
  // narrators occasionally emit the entire narrate-tool args object as
  // raw text instead of using the actual function-call format. Detect
  // {..."text": "..."...} shapes and extract the inner text. Wrapped
  // markdown fences (```json … ```) are stripped first.
  const fenced = t.match(/^[ \t]*```(?:json)?\s*([\s\S]*?)\s*```[ \t]*$/);
  const candidate = fenced ? fenced[1] : t;
  const trimmed = (candidate ?? '').trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('"text"')) {
    // AI-1 / N-3 — refuse to JSON.parse over-cap wrappers. Over-cap
    // candidates fall through to the raw-text path; the player sees
    // the wrapper verbatim rather than the broker spending CPU on
    // a megabyte-scale parse.
    const result = tryParseJsonWithinCap(trimmed);
    if (result.ok) {
      const obj = result.value as {text?: unknown} | null | undefined;
      if (obj && typeof obj.text === 'string' && obj.text.trim().length > 0) {
        if (obj.text !== t) patternsFired.push('json_wrapper_unwrap');
        t = obj.text;
      }
    }
    // Malformed or over-cap — leave the raw text alone, better to
    // surface garbage than silently lose the narrator's content.
  }

  // 2. Collapse consecutive duplicate paragraphs (greeting → analysis
  // → same greeting). Split on blank lines, drop a paragraph if it's
  // an exact (or locale-folded) repeat of one we already kept.
  // N-4 — `paragraphDedupKey` defaults to strict trimmed comparison
  // and only opts in to `toLocaleLowerCase(...)` when the caller
  // passes a valid BCP-47 tag.
  const paras = t.split(/\n{2,}/);
  const seen = new Set<string>();
  const kept: string[] = [];
  let droppedAny = false;
  for (const p of paras) {
    const trimmedPara = p.trim();
    if (trimmedPara.length === 0) {
      droppedAny = true;
      continue;
    }
    const key = paragraphDedupKey(trimmedPara, language);
    if (seen.has(key)) {
      droppedAny = true;
      continue;
    }
    seen.add(key);
    kept.push(trimmedPara);
  }
  const dedupedText = kept.join('\n\n');
  // The trim+rejoin alone can mutate whitespace without dropping
  // content; only flag the dedup pattern when at least one paragraph
  // was actually removed (empty or duplicate).
  if (droppedAny && dedupedText !== t) {
    patternsFired.push('paragraph_dedup');
  }
  t = dedupedText;

  const finalText = t.trim();
  return {
    text: finalText,
    changed: finalText !== text,
    patternsFired,
    originalLength,
    sanitisedLength: finalText.length,
    originalPrefix,
  };
}
