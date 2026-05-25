/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// AI-1 — bounded JSON salvage. The cap is shared with the narrate
// sanitiser (N-3) so any tool-adapter or handoff salvage path that
// receives megabytes of model-emitted text falls through to the
// raw-string path without invoking `JSON.parse`.

import {describe, expect, it} from 'vitest';
import {stringJsonSalvage} from '../../ai/toolAdapter.js';
import {
  MAX_JSON_SALVAGE_CHARS,
  tryParseJsonWithinCap,
} from '../../jsonSalvage.js';

describe('jsonSalvage — tryParseJsonWithinCap', () => {
  it('parses a valid under-cap object', () => {
    const result = tryParseJsonWithinCap('{"text":"hello"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({text: 'hello'});
    }
  });

  it('parses a valid under-cap array', () => {
    const result = tryParseJsonWithinCap('[1,2,3]');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });

  it('refuses to parse an over-cap candidate and reports over_cap', () => {
    // Build a string that is JSON-shaped but exactly one character
    // over the cap. The contents do not matter; the cap check fires
    // before `JSON.parse` is reached.
    const oversize = '{"text":"' + 'a'.repeat(MAX_JSON_SALVAGE_CHARS) + '"}';
    expect(oversize.length).toBeGreaterThan(MAX_JSON_SALVAGE_CHARS);
    const result = tryParseJsonWithinCap(oversize);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('over_cap');
    }
  });

  it('reports malformed for under-cap garbage that does not parse', () => {
    const result = tryParseJsonWithinCap('{not json}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });
});

describe('jsonSalvage — stringJsonSalvage (tool-adapter integration)', () => {
  it('passes non-string values through verbatim', () => {
    const input = {already: 'object'};
    expect(stringJsonSalvage(input)).toBe(input);
    expect(stringJsonSalvage(123)).toBe(123);
    expect(stringJsonSalvage(null)).toBeNull();
    expect(stringJsonSalvage(undefined)).toBeUndefined();
  });

  it('passes plain non-JSON-looking strings through verbatim', () => {
    expect(stringJsonSalvage('hello there')).toBe('hello there');
    expect(stringJsonSalvage('   no braces  ')).toBe('   no braces  ');
  });

  it('parses an under-cap JSON-encoded object', () => {
    expect(stringJsonSalvage('{"text":"hi","damage":3}')).toEqual({
      text: 'hi',
      damage: 3,
    });
  });

  it('passes an over-cap JSON-encoded string through unchanged so downstream Zod still rejects it', () => {
    const oversize =
      '{"text":"' + 'b'.repeat(MAX_JSON_SALVAGE_CHARS) + '"}';
    const result = stringJsonSalvage(oversize);
    // The salvage returns the original string verbatim; AI SDK's
    // schema validator will then reject it with "Invalid input"
    // exactly as if no salvage helper existed for this case.
    expect(result).toBe(oversize);
  });

  it('passes malformed JSON-looking strings through verbatim', () => {
    expect(stringJsonSalvage('{not json}')).toBe('{not json}');
  });
});
