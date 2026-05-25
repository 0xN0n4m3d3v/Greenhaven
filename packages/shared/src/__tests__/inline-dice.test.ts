/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ID-1 — focused tests for the shared inline-dice parser. These
// stay deterministic by exercising parsing, cap rejection, and the
// chip-replacement helper rather than the runtime Math.random
// roller (each consumer owns its own randomness).

import {describe, expect, it} from 'vitest';
import {
  findInlineDice,
  isWithinCaps,
  MAX_COUNT,
  MAX_MOD,
  MAX_SIDES,
  replaceWithChips,
  rewriteInlineDice,
  type InlineDiceMatch,
} from '../inline-dice.js';

/**
 * Build a deterministic `rollDie` that returns a fixed sequence —
 * the i-th call returns `values[i]`. Tests use this so totals are
 * predictable without monkey-patching `Math.random`.
 */
function sequenceRoller(values: number[]): (sides: number) => number {
  let i = 0;
  return () => {
    const v = values[i] ?? 1;
    i += 1;
    return v;
  };
}

describe('inline-dice — parse', () => {
  it('parses a bare [[d20]] as 1d20+0', () => {
    const matches = findInlineDice('Roll [[d20]] for the saving throw.');
    expect(matches).toEqual<InlineDiceMatch[]>([
      {text: '[[d20]]', notation: '1d20', count: 1, sides: 20, mod: 0},
    ]);
  });

  it('parses [[2d6+3]] with explicit count and positive mod', () => {
    const matches = findInlineDice('Damage: [[2d6+3]] slashing.');
    expect(matches).toEqual<InlineDiceMatch[]>([
      {text: '[[2d6+3]]', notation: '2d6+3', count: 2, sides: 6, mod: 3},
    ]);
  });

  it('parses a negative modifier', () => {
    const matches = findInlineDice('Subtract [[1d4-1]] from the result.');
    expect(matches).toEqual<InlineDiceMatch[]>([
      {text: '[[1d4-1]]', notation: '1d4-1', count: 1, sides: 4, mod: -1},
    ]);
  });

  it('finds multiple inline dice in order', () => {
    const matches = findInlineDice('I attack [[1d20+5]] for [[2d6]] damage.');
    expect(matches.map((m) => m.text)).toEqual(['[[1d20+5]]', '[[2d6]]']);
  });

  it('does not stash state between calls (regex is fresh each call)', () => {
    const text = 'Use [[d20]] and again [[d20]].';
    const first = findInlineDice(text);
    const second = findInlineDice(text);
    expect(first.length).toBe(2);
    expect(second.length).toBe(2);
    expect(second.map((m) => m.text)).toEqual(['[[d20]]', '[[d20]]']);
  });
});

describe('inline-dice — caps', () => {
  it('accepts the cap boundaries themselves', () => {
    expect(
      isWithinCaps({
        text: '',
        notation: '',
        count: MAX_COUNT,
        sides: MAX_SIDES,
        mod: MAX_MOD,
      }),
    ).toBe(true);
    expect(
      isWithinCaps({
        text: '',
        notation: '',
        count: 1,
        sides: 1,
        mod: -MAX_MOD,
      }),
    ).toBe(true);
  });

  it('rejects over-cap counts, sides, and mods', () => {
    expect(
      isWithinCaps({
        text: '',
        notation: '',
        count: MAX_COUNT + 1,
        sides: 6,
        mod: 0,
      }),
    ).toBe(false);
    expect(
      isWithinCaps({
        text: '',
        notation: '',
        count: 1,
        sides: MAX_SIDES + 1,
        mod: 0,
      }),
    ).toBe(false);
    expect(
      isWithinCaps({
        text: '',
        notation: '',
        count: 1,
        sides: 6,
        mod: MAX_MOD + 1,
      }),
    ).toBe(false);
    expect(
      isWithinCaps({
        text: '',
        notation: '',
        count: 1,
        sides: 6,
        mod: -(MAX_MOD + 1),
      }),
    ).toBe(false);
  });

  it('rejects zero/negative counts and sides', () => {
    expect(
      isWithinCaps({text: '', notation: '', count: 0, sides: 6, mod: 0}),
    ).toBe(false);
    expect(
      isWithinCaps({text: '', notation: '', count: 1, sides: 0, mod: 0}),
    ).toBe(false);
  });
});

describe('inline-dice — replaceWithChips', () => {
  it('rewrites each matched span with INLINE_DICE_CHIP placeholders', () => {
    const matches = findInlineDice('Attack [[1d20+5]] for [[2d6]] damage.');
    const results = [
      {match: matches[0]!, total: 17},
      {match: matches[1]!, total: 9},
    ];
    expect(replaceWithChips('Attack [[1d20+5]] for [[2d6]] damage.', results)).toBe(
      'Attack [INLINE_DICE_CHIP notation="1d20+5" total="17"] for [INLINE_DICE_CHIP notation="2d6" total="9"] damage.',
    );
  });

  it('returns the prose unchanged when there are no results', () => {
    const prose = 'No dice in this sentence.';
    expect(replaceWithChips(prose, [])).toBe(prose);
  });
});

describe('inline-dice — rewriteInlineDice (ID-3 single-pass)', () => {
  it('rewrites multiple dice in one sentence in text order with the chip placeholder', () => {
    // 1d20+5: die rolls 12 → total 12 + 5 = 17.
    // 2d6   : dies roll 3, 4 → total 7 + 0 = 7.
    const roll = sequenceRoller([12, 3, 4]);
    const result = rewriteInlineDice(
      'Attack [[1d20+5]] for [[2d6]] damage.',
      roll,
    );
    expect(result.rewritten).toBe(
      'Attack [INLINE_DICE_CHIP notation="1d20+5" total="17"] for [INLINE_DICE_CHIP notation="2d6" total="7"] damage.',
    );
    expect(result.rolls.map((r) => r.total)).toEqual([17, 7]);
    expect(result.rolls.map((r) => r.rolls)).toEqual([[12], [3, 4]]);
    expect(result.rejected).toEqual([]);
  });

  it('leaves over-cap dice raw next to accepted dice, and surfaces them in rejected', () => {
    // The first formula is over the count cap; the second is within
    // every cap. The rewriter must keep the first verbatim and chip
    // the second.
    const roll = sequenceRoller([3, 5]); // first chip rolls 3, then 5
    const result = rewriteInlineDice(
      `Volley [[${MAX_COUNT + 1}d6]] and a single [[2d4]] for resolution.`,
      roll,
    );
    expect(result.rewritten).toBe(
      `Volley [[${MAX_COUNT + 1}d6]] and a single [INLINE_DICE_CHIP notation="2d4" total="8"] for resolution.`,
    );
    expect(result.rolls).toHaveLength(1);
    expect(result.rolls[0]!.match.notation).toBe('2d4');
    expect(result.rolls[0]!.total).toBe(8);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.notation).toBe(`${MAX_COUNT + 1}d6`);
  });

  it('handles repeated identical dice as separate rolls with chips in text order', () => {
    // Three [[d20]] in a row. The deterministic roller yields 4, 9,
    // 17 — chips must appear left-to-right with those totals.
    const roll = sequenceRoller([4, 9, 17]);
    const result = rewriteInlineDice(
      'Saves: [[d20]] then [[d20]] then [[d20]].',
      roll,
    );
    expect(result.rewritten).toBe(
      'Saves: [INLINE_DICE_CHIP notation="1d20" total="4"] then [INLINE_DICE_CHIP notation="1d20" total="9"] then [INLINE_DICE_CHIP notation="1d20" total="17"].',
    );
    expect(result.rolls.map((r) => r.total)).toEqual([4, 9, 17]);
  });

  it('rewrites prose with no dice unchanged and reports empty rolls/rejected', () => {
    const roll = sequenceRoller([7]);
    const result = rewriteInlineDice('Nothing to roll here.', roll);
    expect(result.rewritten).toBe('Nothing to roll here.');
    expect(result.rolls).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});
