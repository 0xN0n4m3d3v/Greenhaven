/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// AI-1 / N-3 — `sanitiseNarrateText` no longer runs `JSON.parse`
// on an over-cap JSON wrapper. The under-cap path still unwraps
// the inner `text` field (existing behavior); the over-cap path
// falls through verbatim so the raw wrapper survives into the
// dedup step and the player sees the garbage rather than letting
// the broker spend CPU on a megabyte-scale parse.

import {describe, expect, it} from 'vitest';
import {MAX_JSON_SALVAGE_CHARS} from '../../jsonSalvage.js';
import {sanitiseNarrateText} from '../../tools/narrate.js';

describe('sanitiseNarrateText — AI-1 / N-3 JSON wrapper cap', () => {
  it('still unwraps an under-cap JSON wrapper into the inner text', () => {
    const wrapper = '{"text":"hello world"}';
    expect(sanitiseNarrateText(wrapper)).toBe('hello world');
  });

  it('still unwraps an under-cap fenced JSON wrapper', () => {
    const wrapper = '```json\n{"text":"fenced hello"}\n```';
    expect(sanitiseNarrateText(wrapper)).toBe('fenced hello');
  });

  it('does NOT JSON.parse an over-cap wrapper — the raw wrapper survives sanitisation', () => {
    // Build a wrapper whose serialized length comfortably exceeds the
    // bounded cap. The inner `text` is large enough that parsing it
    // would dominate broker CPU; the cap must prevent that.
    const inner = 'A'.repeat(MAX_JSON_SALVAGE_CHARS);
    const wrapper = `{"text":"${inner}"}`;
    expect(wrapper.length).toBeGreaterThan(MAX_JSON_SALVAGE_CHARS);

    const result = sanitiseNarrateText(wrapper);
    // The over-cap wrapper was not unwrapped; the raw JSON shape
    // survives (still starts with `{` and ends with `}`) and the
    // sentinel "text" key is still inside.
    expect(result.startsWith('{')).toBe(true);
    expect(result.endsWith('}')).toBe(true);
    expect(result.includes('"text"')).toBe(true);
  });
});
