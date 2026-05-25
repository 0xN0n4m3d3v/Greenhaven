/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-15 — `isTopLevelJson` was the renderer's cheapest way to ask
// "did the model hand me a JSON tool payload by mistake?" but it
// called `JSON.parse(trimmed)` on every match of the cheap
// shape-check, which means a single >1 MB broker emission could pin
// the main event loop for tens of milliseconds. The bounded form
// short-circuits any string longer than `MAX_TOP_LEVEL_JSON_DETECTION_CHARS`
// (64 KiB) before reaching `JSON.parse`. These tests pin three things:
//
//   1. An over-cap JSON-shaped string returns `false` AND `JSON.parse`
//      is never called for it.
//   2. A canonical under-cap JSON object still parses as JSON.
//   3. An under-cap malformed JSON-shaped string still returns `false`
//      (and goes through `JSON.parse`, which is the intended cost
//      ceiling for the bounded path).

import {afterEach, describe, expect, it, vi} from 'vitest';
import {protagonistActionRendererInternals} from '../../agents/protagonistActionRenderer.js';

const {isTopLevelJson, MAX_TOP_LEVEL_JSON_DETECTION_CHARS} =
  protagonistActionRendererInternals;

describe('isTopLevelJson — DEEP-15 size cap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes a 64 KiB detection cap', () => {
    expect(MAX_TOP_LEVEL_JSON_DETECTION_CHARS).toBe(64 * 1024);
  });

  it('rejects an over-cap JSON-shaped string without invoking JSON.parse', () => {
    const spy = vi.spyOn(JSON, 'parse');
    // Build a syntactically-valid JSON object whose total length
    // exceeds the cap. Content does not matter — the cap fires on
    // length, not validity.
    const padding = 'x'.repeat(MAX_TOP_LEVEL_JSON_DETECTION_CHARS);
    const overCap = `{"payload":"${padding}"}`;
    expect(overCap.length).toBeGreaterThan(MAX_TOP_LEVEL_JSON_DETECTION_CHARS);

    expect(isTopLevelJson(overCap)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still detects valid under-cap JSON objects and arrays', () => {
    expect(isTopLevelJson('{"hello":"world","n":42}')).toBe(true);
    expect(isTopLevelJson('[1, 2, 3, "four"]')).toBe(true);
    // Whitespace-tolerant — the trim runs first.
    expect(isTopLevelJson('   {"a":1}   ')).toBe(true);
  });

  it('returns false for under-cap malformed JSON-shaped strings', () => {
    // Shape matches (`{...}`), JSON.parse fails.
    expect(isTopLevelJson('{ not actually json }')).toBe(false);
    // Shape does not match — never reaches JSON.parse.
    expect(isTopLevelJson('I open the door and look around.')).toBe(false);
    expect(isTopLevelJson('')).toBe(false);
  });
});
