// Focused regression for the renderer audio clamp helper. The
// happy-path proves the existing fade math (`from + (to - from) * t`)
// can't reach the browser with a tiny negative undershoot; the edge
// cases pin the fallback behavior so future call sites (Howler,
// localStorage, props) cannot push an out-of-range value through.
//
// Lives under `packages/web-ui/tests/` so `tsc -b src` does NOT type-
// check vitest globals as app source. Run via the workspace root:
//   `npm exec -- vitest run packages/web-ui/tests/audioVolume.test.ts`.

import {describe, expect, it} from 'vitest';
import {
  clampUnitInterval,
  clampAudioVolume,
} from '../src/lib/audioVolume';

describe('clampUnitInterval', () => {
  it('passes through values already inside [0, 1]', () => {
    expect(clampUnitInterval(0)).toBe(0);
    expect(clampUnitInterval(0.25)).toBe(0.25);
    expect(clampUnitInterval(0.55)).toBe(0.55);
    expect(clampUnitInterval(1)).toBe(1);
  });

  it('coerces tiny floating-point undershoot to 0 (the IndexSizeError case)', () => {
    // Real values seen in the desktop renderer log.
    expect(clampUnitInterval(-0.000112444)).toBe(0);
    expect(clampUnitInterval(-6.11109e-7)).toBe(0);
    expect(clampUnitInterval(-0.0000611111)).toBe(0);
  });

  it('clamps any negative finite value to 0', () => {
    expect(clampUnitInterval(-0.5)).toBe(0);
    expect(clampUnitInterval(-1)).toBe(0);
    expect(clampUnitInterval(-100)).toBe(0);
  });

  it('clamps any > 1 finite value to 1', () => {
    expect(clampUnitInterval(1.0001)).toBe(1);
    expect(clampUnitInterval(2)).toBe(1);
    expect(clampUnitInterval(Number.MAX_SAFE_INTEGER)).toBe(1);
  });

  it('returns the (clamped) fallback for non-finite inputs', () => {
    expect(clampUnitInterval(Number.NaN)).toBe(0);
    expect(clampUnitInterval(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampUnitInterval(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clampUnitInterval(Number.NaN, 0.7)).toBe(0.7);
    expect(clampUnitInterval(Number.POSITIVE_INFINITY, 0.4)).toBe(0.4);
  });

  it('returns the (clamped) fallback for non-numeric inputs', () => {
    expect(clampUnitInterval(undefined)).toBe(0);
    expect(clampUnitInterval(null)).toBe(0);
    expect(clampUnitInterval('0.5')).toBe(0);
    expect(clampUnitInterval({}, 0.3)).toBe(0.3);
  });

  it('clamps an out-of-range fallback before using it', () => {
    expect(clampUnitInterval(Number.NaN, -2)).toBe(0);
    expect(clampUnitInterval(Number.NaN, 2)).toBe(1);
    expect(clampUnitInterval(Number.NaN, Number.NaN)).toBe(0);
  });

  it('treats clampAudioVolume as a strict alias', () => {
    expect(clampAudioVolume).toBe(clampUnitInterval);
    expect(clampAudioVolume(-0.000122222)).toBe(0);
    expect(clampAudioVolume(1.5)).toBe(1);
  });
});
