/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Pins the longest-match @mention parser used by
// `cartridge:i18n:check`. The previous greedy regex absorbed Russian
// prose suffixes after canonical `@Name` tokens (e.g. `@Mikka
// перевести`, `@Town square или рядом с палаткой`) into the mention
// and produced false-positive `missing_mention_target` errors. The
// new implementation scans known display names longest-first with
// a Unicode-aware token boundary check and falls back to a single
// word only when no known name matches — so unresolved mentions
// still surface for the validator.

import {describe, expect, it} from 'vitest';
import {extractMentions} from '../../devtools/validateCartridge.js';

describe('validateCartridge.extractMentions', () => {
  it('returns a canonical name followed by Russian prose without absorbing it', () => {
    const known = ['Mikka', 'Sable Vey', 'Town square'];
    expect(extractMentions('Give @Mikka перевести', known)).toEqual(['Mikka']);
    expect(
      extractMentions('Ask @Sable Vey называет цену', known),
    ).toEqual(['Sable Vey']);
    expect(
      extractMentions('Wait at @Town square или рядом с палаткой', known),
    ).toEqual(['Town square']);
  });

  it('prefers the longest known name when multiple share a prefix', () => {
    const known = ['Mikka', 'Mikka Quickgrin'];
    expect(extractMentions('@Mikka Quickgrin will help', known)).toEqual([
      'Mikka Quickgrin',
    ]);
    // Just the bare name still resolves to the short form when the
    // longer alias does not fit.
    expect(extractMentions('@Mikka will help', known)).toEqual(['Mikka']);
  });

  it('respects token boundaries — does not match through run-on letters', () => {
    const known = ['Mikka'];
    // @Mikka123 is NOT a bare-name match (next char is a digit, which
    // continues the token). The fallback then extracts the unresolved
    // single token.
    expect(extractMentions('@Mikka123', known)).toEqual(['Mikka123']);
    // Trailing punctuation releases the mention and is not part of it.
    expect(extractMentions('Thanks, @Mikka.', known)).toEqual(['Mikka']);
    expect(extractMentions('Goodbye, @Mikka!', known)).toEqual(['Mikka']);
    expect(extractMentions('Meet @Mikka,then leave', known)).toEqual(['Mikka']);
  });

  it("matches multi-word names that include apostrophes like @Thief's market", () => {
    const known = ["Thief's market"];
    expect(
      extractMentions("Hide at @Thief's market before dawn", known),
    ).toEqual(["Thief's market"]);
  });

  it('falls back to a single-word extraction for unresolved mentions', () => {
    const known = ['Mikka'];
    expect(
      extractMentions('Find @UnknownStranger near the docks', known),
    ).toEqual(['UnknownStranger']);
    // Multi-word fallback is intentionally NOT swallowed (the bug we
    // are fixing). The fallback stops at the first non-token char.
    expect(
      extractMentions('Find @UnknownStranger перевести', known),
    ).toEqual(['UnknownStranger']);
  });

  it('collects multiple mentions across the same string', () => {
    const known = ['Mikka', 'Town square'];
    expect(
      extractMentions(
        'Meet @Mikka at @Town square, then ask @UnknownGuard about it.',
        known,
      ),
    ).toEqual(['Mikka', 'Town square', 'UnknownGuard']);
  });

  it('ignores @ characters that are not followed by a token', () => {
    const known = ['Mikka'];
    expect(extractMentions('email@', known)).toEqual([]);
    expect(extractMentions('@ stray', known)).toEqual([]);
    expect(extractMentions('cost is $10 @ door', known)).toEqual([]);
  });
});
