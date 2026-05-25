/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  PolishDescriptionArgs,
  PolishHistoryArgs,
} from '../../services/CharacterAssistService.js';
import {SynthesizeArgs} from '../../services/ExaminerSynthesisService.js';

describe('character assist argument schemas', () => {
  it('accepts null language from the UI on polish-description', () => {
    const parsed = PolishDescriptionArgs.safeParse({
      name: 'Old Mage',
      description: 'Старый добрый маг',
      history: '',
      language: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.language).toBeUndefined();
      expect(parsed.data.description).toBe('Старый добрый маг');
    }
  });

  it('accepts null language from the UI on polish-history', () => {
    const parsed = PolishHistoryArgs.safeParse({
      name: 'Old Mage',
      description: 'Старый добрый маг',
      history: '',
      language: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.language).toBeUndefined();
    }
  });

  it('accepts null language from the UI on synthesis', () => {
    const parsed = SynthesizeArgs.safeParse({
      transcript: [
        {q: 'creator.field.name', a: 'Old Mage'},
        {q: 'creator.field.description', a: 'Старый добрый маг'},
      ],
      partialState: {},
      language: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.language).toBeUndefined();
    }
  });

  it('still rejects malformed language values', () => {
    expect(
      PolishDescriptionArgs.safeParse({
        description: 'Старый добрый маг',
        language: 'r',
      }).success,
    ).toBe(false);
  });
});
