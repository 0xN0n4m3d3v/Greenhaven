/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Universal Unicode script detection for multilingual specialists.
//
// Replaces the previous Cyrillic-vs-Latin-only hack scattered across
// agents. Counts characters in major Unicode blocks and returns:
//   - scriptCounts: per-script tallies for diagnostics
//   - dominantScript: the script with the most characters (or
//     'unknown' when text has no script characters)
//   - languageHint: best-guess ISO 639-1 / 639-3 code based on the
//     dominant script (deliberately conservative — distinguishing
//     French from English from German from Spanish is NOT possible
//     from script alone, so all Latin-script languages return 'en'
//     by default; the LLM is responsible for finer distinctions)
//
// When a specialist needs SEMANTIC language understanding (does
// this prose actually place the player at a location? does this
// title MATCH the selected player language?), it should call the LLM
// rather than rely on script-level heuristics.

export type ScriptTag =
  | 'latin'
  | 'cyrillic'
  | 'hebrew'
  | 'arabic'
  | 'devanagari'
  | 'bengali'
  | 'thai'
  | 'greek'
  | 'armenian'
  | 'georgian'
  | 'hangul'
  | 'hiragana'
  | 'katakana'
  | 'han'
  | 'unknown';

export interface ScriptDetection {
  scriptCounts: Record<ScriptTag, number>;
  dominantScript: ScriptTag;
  /** Best-guess ISO code; conservative — Latin defaults to 'en'. */
  languageHint: string;
  /** Total counted (script-bearing) characters. */
  total: number;
}

/**
 * Map a Unicode codepoint to a script tag. Covers the major living
 * scripts the runtime is likely to see. Punctuation, digits, and
 * symbols are ignored (they don't reveal the script of surrounding
 * prose).
 */
export function scriptOf(codepoint: number): ScriptTag {
  // Latin
  if (
    (codepoint >= 0x0041 && codepoint <= 0x005a) ||
    (codepoint >= 0x0061 && codepoint <= 0x007a) ||
    (codepoint >= 0x00c0 && codepoint <= 0x024f) ||
    (codepoint >= 0x1e00 && codepoint <= 0x1eff)
  )
    return 'latin';
  // Cyrillic
  if (
    (codepoint >= 0x0400 && codepoint <= 0x04ff) ||
    (codepoint >= 0x0500 && codepoint <= 0x052f) ||
    (codepoint >= 0x2de0 && codepoint <= 0x2dff) ||
    (codepoint >= 0xa640 && codepoint <= 0xa69f)
  )
    return 'cyrillic';
  // Hebrew
  if (codepoint >= 0x0590 && codepoint <= 0x05ff) return 'hebrew';
  // Arabic (also covers Persian, Urdu base)
  if (
    (codepoint >= 0x0600 && codepoint <= 0x06ff) ||
    (codepoint >= 0x0750 && codepoint <= 0x077f) ||
    (codepoint >= 0xfb50 && codepoint <= 0xfdff) ||
    (codepoint >= 0xfe70 && codepoint <= 0xfeff)
  )
    return 'arabic';
  // Devanagari (Hindi, Sanskrit, Marathi, Nepali)
  if (codepoint >= 0x0900 && codepoint <= 0x097f) return 'devanagari';
  // Bengali / Bangla / Assamese
  if (codepoint >= 0x0980 && codepoint <= 0x09ff) return 'bengali';
  // Thai
  if (codepoint >= 0x0e00 && codepoint <= 0x0e7f) return 'thai';
  // Greek
  if (
    (codepoint >= 0x0370 && codepoint <= 0x03ff) ||
    (codepoint >= 0x1f00 && codepoint <= 0x1fff)
  )
    return 'greek';
  // Armenian
  if (codepoint >= 0x0530 && codepoint <= 0x058f) return 'armenian';
  // Georgian
  if (
    (codepoint >= 0x10a0 && codepoint <= 0x10ff) ||
    (codepoint >= 0x2d00 && codepoint <= 0x2d2f)
  )
    return 'georgian';
  // Hangul (Korean)
  if (
    (codepoint >= 0xac00 && codepoint <= 0xd7af) ||
    (codepoint >= 0x1100 && codepoint <= 0x11ff) ||
    (codepoint >= 0x3130 && codepoint <= 0x318f)
  )
    return 'hangul';
  // Hiragana (Japanese)
  if (codepoint >= 0x3040 && codepoint <= 0x309f) return 'hiragana';
  // Katakana (Japanese)
  if (
    (codepoint >= 0x30a0 && codepoint <= 0x30ff) ||
    (codepoint >= 0x31f0 && codepoint <= 0x31ff)
  )
    return 'katakana';
  // CJK Unified Ideographs (Chinese / Japanese kanji)
  if (
    (codepoint >= 0x4e00 && codepoint <= 0x9fff) ||
    (codepoint >= 0x3400 && codepoint <= 0x4dbf) ||
    (codepoint >= 0x20000 && codepoint <= 0x2a6df) ||
    (codepoint >= 0x2a700 && codepoint <= 0x2b73f) ||
    (codepoint >= 0x2b740 && codepoint <= 0x2b81f) ||
    (codepoint >= 0x2b820 && codepoint <= 0x2ceaf)
  )
    return 'han';
  return 'unknown';
}

const EMPTY_COUNTS: Record<ScriptTag, number> = {
  latin: 0,
  cyrillic: 0,
  hebrew: 0,
  arabic: 0,
  devanagari: 0,
  bengali: 0,
  thai: 0,
  greek: 0,
  armenian: 0,
  georgian: 0,
  hangul: 0,
  hiragana: 0,
  katakana: 0,
  han: 0,
  unknown: 0,
};

/** Tally script characters in a string. */
export function detectScripts(text: string): ScriptDetection {
  const counts: Record<ScriptTag, number> = {...EMPTY_COUNTS};
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    const s = scriptOf(cp);
    if (s === 'unknown') continue;
    counts[s]++;
    total++;
  }

  // Dominant: the script with the highest count (any tie → first).
  let dominantScript: ScriptTag = 'unknown';
  let max = 0;
  for (const k of Object.keys(counts) as ScriptTag[]) {
    if (counts[k] > max) {
      max = counts[k];
      dominantScript = k;
    }
  }

  return {
    scriptCounts: counts,
    dominantScript,
    languageHint: scriptToLanguageHint(dominantScript, counts),
    total,
  };
}

/**
 * Map a dominant script to a best-guess ISO code. Where multiple
 * languages share a script (Latin), this returns a generic default.
 * The LLM is responsible for fine-grained distinctions.
 */
function scriptToLanguageHint(
  dominant: ScriptTag,
  counts: Record<ScriptTag, number>,
): string {
  switch (dominant) {
    case 'latin':
      return 'en';
    case 'cyrillic':
      return 'ru';
    case 'hebrew':
      return 'he';
    case 'arabic':
      return 'ar';
    case 'devanagari':
      return 'hi';
    case 'bengali':
      return 'bn';
    case 'thai':
      return 'th';
    case 'greek':
      return 'el';
    case 'armenian':
      return 'hy';
    case 'georgian':
      return 'ka';
    case 'hangul':
      return 'ko';
    case 'hiragana':
    case 'katakana':
      return 'ja';
    case 'han': {
      // Han alone could be Chinese OR Japanese kanji. If hiragana or
      // katakana also present, it's Japanese; otherwise default
      // Chinese.
      if (counts.hiragana > 0 || counts.katakana > 0) return 'ja';
      return 'zh';
    }
    case 'unknown':
    default:
      return 'und';
  }
}

/**
 * Quick helper: dominant script tag for `text`. Returns 'unknown' if
 * text has no script characters.
 */
export function dominantScript(text: string): ScriptTag {
  return detectScripts(text).dominantScript;
}

/**
 * Quick helper: ISO language hint based on dominant script.
 */
export function languageHint(text: string): string {
  return detectScripts(text).languageHint;
}

/**
 * Decide whether two texts are in DIFFERENT scripts strongly
 * enough to flag a likely language mismatch. Used by Cartridge
 * Steward to reject e.g. an English title in a Hebrew session.
 *
 * Returns true when:
 *   - both texts have a clear dominant script (>= minTotal counted chars), AND
 *   - the dominant scripts differ
 *
 * The minTotal threshold prevents false positives on very short
 * names like "Bar" that don't carry strong script signal.
 */
export function scriptsDifferStrongly(
  textA: string,
  textB: string,
  minTotal = 4,
): {differ: boolean; aScript: ScriptTag; bScript: ScriptTag} {
  const a = detectScripts(textA);
  const b = detectScripts(textB);
  const differ =
    a.dominantScript !== 'unknown' &&
    b.dominantScript !== 'unknown' &&
    a.dominantScript !== b.dominantScript &&
    a.scriptCounts[a.dominantScript] >= minTotal &&
    b.scriptCounts[b.dominantScript] >= minTotal;
  return {differ, aScript: a.dominantScript, bScript: b.dominantScript};
}
