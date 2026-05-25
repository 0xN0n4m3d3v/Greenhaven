/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-6 — shared `advance_on` resolver. The runtime helper and the
// cartridge validator share the same allowlist; the tests below pin
// every branch so a regression in one path forces a deliberate edit
// in the other.

import {describe, expect, it} from 'vitest';
import {
  isValidAdvanceOn,
  resolveAdvanceMode,
  VALID_ADVANCE_ON_VALUES,
} from '../../quest/advanceOn.js';

describe('VALID_ADVANCE_ON_VALUES', () => {
  it('lists exactly the four documented aliases', () => {
    expect([...VALID_ADVANCE_ON_VALUES].sort()).toEqual(
      ['all', 'all_objectives_complete', 'any', 'any_objective_complete'].sort(),
    );
  });
});

describe('isValidAdvanceOn', () => {
  it('accepts every alias', () => {
    for (const v of VALID_ADVANCE_ON_VALUES) {
      expect(isValidAdvanceOn(v)).toBe(true);
    }
  });

  it('rejects legacy / invalid strings', () => {
    expect(isValidAdvanceOn('manual')).toBe(false);
    expect(isValidAdvanceOn('manual_or_watcher')).toBe(false);
    expect(isValidAdvanceOn('manual_debug')).toBe(false);
    expect(isValidAdvanceOn('any_objective')).toBe(false);
    expect(isValidAdvanceOn('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidAdvanceOn(null)).toBe(false);
    expect(isValidAdvanceOn(undefined)).toBe(false);
    expect(isValidAdvanceOn(0)).toBe(false);
    expect(isValidAdvanceOn(true)).toBe(false);
    expect(isValidAdvanceOn({all: true})).toBe(false);
    expect(isValidAdvanceOn([])).toBe(false);
  });
});

describe('resolveAdvanceMode', () => {
  it('returns "all" for null / undefined / missing', () => {
    expect(resolveAdvanceMode(null)).toBe('all');
    expect(resolveAdvanceMode(undefined)).toBe('all');
  });

  it('normalizes both AND aliases to "all"', () => {
    expect(resolveAdvanceMode('all')).toBe('all');
    expect(resolveAdvanceMode('all_objectives_complete')).toBe('all');
  });

  it('normalizes both OR aliases to "any"', () => {
    expect(resolveAdvanceMode('any')).toBe('any');
    expect(resolveAdvanceMode('any_objective_complete')).toBe('any');
  });

  it('throws on unknown non-null values rather than silently defaulting', () => {
    expect(() => resolveAdvanceMode('manual')).toThrow(/invalid advance_on/);
    expect(() => resolveAdvanceMode('manual_or_watcher')).toThrow(
      /invalid advance_on/,
    );
    expect(() => resolveAdvanceMode('manual_debug')).toThrow(
      /invalid advance_on/,
    );
    expect(() => resolveAdvanceMode('typo')).toThrow(/invalid advance_on/);
    expect(() => resolveAdvanceMode(42)).toThrow(/invalid advance_on/);
    expect(() => resolveAdvanceMode({})).toThrow(/invalid advance_on/);
  });

  it('mentions the allowlist in the error message so authors can fix it', () => {
    try {
      resolveAdvanceMode('manual');
      throw new Error('expected resolveAdvanceMode to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const v of VALID_ADVANCE_ON_VALUES) {
        expect(msg).toContain(v);
      }
    }
  });
});
