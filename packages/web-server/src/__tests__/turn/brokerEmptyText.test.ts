/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-7 — every `SUPPORTED_LANGUAGE_CODES` entry must resolve to a
// non-empty fail-open string from `locales/<lang>/turn-errors.json`,
// region codes must walk through `languageBase`, and unknown
// languages must fall back to English.

import {describe, expect, it} from 'vitest';
import {
  brokerEmptyFailOpenText,
  brokerEmptyIntimacyRecoveryText,
} from '../../turn/brokerEmptyText.js';
import {SUPPORTED_LANGUAGE_CODES} from '../../languages.js';

describe('brokerEmptyFailOpenText (S-7 catalog loader)', () => {
  it('returns a non-empty string for every supported language', () => {
    for (const code of SUPPORTED_LANGUAGE_CODES) {
      const value = brokerEmptyFailOpenText(code);
      expect(value, code).toBeTypeOf('string');
      expect(value.length, code).toBeGreaterThan(0);
    }
  });

  it('returns distinct text per language (no English collapse)', () => {
    const english = brokerEmptyFailOpenText('en');
    for (const code of SUPPORTED_LANGUAGE_CODES) {
      if (code === 'en') continue;
      expect(brokerEmptyFailOpenText(code), code).not.toBe(english);
    }
  });

  it('resolves region codes through `languageBase`', () => {
    const ru = brokerEmptyFailOpenText('ru');
    expect(brokerEmptyFailOpenText('ru-RU')).toBe(ru);
    expect(brokerEmptyFailOpenText('RU_ru')).toBe(ru);
  });

  it('falls back to English for unsupported and undefined languages', () => {
    const english = brokerEmptyFailOpenText('en');
    expect(brokerEmptyFailOpenText(undefined)).toBe(english);
    expect(brokerEmptyFailOpenText('xx')).toBe(english);
    expect(brokerEmptyFailOpenText('zz-ZZ')).toBe(english);
  });

  it('keeps stable references on repeat calls (cache hit)', () => {
    const first = brokerEmptyFailOpenText('ja');
    const second = brokerEmptyFailOpenText('ja');
    expect(second).toBe(first);
  });
});

describe('brokerEmptyIntimacyRecoveryText (S-8 catalog loader)', () => {
  it('returns a non-empty string for every supported language', () => {
    for (const code of SUPPORTED_LANGUAGE_CODES) {
      const value = brokerEmptyIntimacyRecoveryText(code);
      expect(value, code).toBeTypeOf('string');
      expect(value.length, code).toBeGreaterThan(0);
    }
  });

  it('returns distinct text per language (no English collapse)', () => {
    const english = brokerEmptyIntimacyRecoveryText('en');
    for (const code of SUPPORTED_LANGUAGE_CODES) {
      if (code === 'en') continue;
      expect(brokerEmptyIntimacyRecoveryText(code), code).not.toBe(english);
    }
  });

  it('preserves the structural anchor and `narrate` tool name', () => {
    for (const code of SUPPORTED_LANGUAGE_CODES) {
      const value = brokerEmptyIntimacyRecoveryText(code);
      expect(value, code).toContain('narrate');
      expect(value.startsWith('['), `${code} starts with [...]`).toBe(true);
    }
  });

  it('resolves region codes through `languageBase`', () => {
    const ru = brokerEmptyIntimacyRecoveryText('ru');
    expect(brokerEmptyIntimacyRecoveryText('ru-RU')).toBe(ru);
    expect(brokerEmptyIntimacyRecoveryText('RU_ru')).toBe(ru);
  });

  it('falls back to English for unsupported and undefined languages', () => {
    const english = brokerEmptyIntimacyRecoveryText('en');
    expect(brokerEmptyIntimacyRecoveryText(undefined)).toBe(english);
    expect(brokerEmptyIntimacyRecoveryText('xx')).toBe(english);
    expect(brokerEmptyIntimacyRecoveryText('zz-ZZ')).toBe(english);
  });

  it('keeps stable references on repeat calls (cache hit)', () => {
    const first = brokerEmptyIntimacyRecoveryText('ja');
    const second = brokerEmptyIntimacyRecoveryText('ja');
    expect(second).toBe(first);
  });
});
