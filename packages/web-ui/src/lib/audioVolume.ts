// Spec follow-up — shared audio-volume clamp.
//
// `HTMLMediaElement.volume` accepts only finite values in `[0, 1]`.
// Linear fade loops (ours + Howler's) can undershoot to a tiny
// negative on the last frame due to floating-point drift:
// `0.5 * (1 - 1.00000007) === -3.5e-8`. Chromium rejects that with
// `IndexSizeError: ... volume negative` instead of silently clamping,
// and the renderer error reaches the desktop log.
//
// Every audio write in `packages/web-ui/src` routes through
// `clampUnitInterval`; the optional `installVolumeSetterGuard()` also
// wraps the prototype setter so third-party libraries (Howler) and any
// future callers cannot push an out-of-range value through.
//
// The helper is pure, has no React / DOM coupling, and lives outside
// `src/components/**` so a focused vitest can import it without an
// app bundle.

/**
 * Clamp `value` into the valid `HTMLMediaElement.volume` range
 * `[0, 1]`. Non-finite inputs (`NaN`, `±Infinity`, non-numbers)
 * collapse to a clamped `fallback`. Negative finite inputs become 0;
 * `> 1` finite inputs become 1.
 */
export function clampUnitInterval(value: unknown, fallback: number = 0): number {
  const fallbackBounded =
    typeof fallback === 'number' && Number.isFinite(fallback)
      ? Math.max(0, Math.min(1, fallback))
      : 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallbackBounded;
  }
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Alias for `clampUnitInterval`. Named for audio call sites that want
 * the intent to read as "audio volume" at the use site.
 */
export const clampAudioVolume = clampUnitInterval;

let volumeSetterGuardInstalled = false;

/**
 * Wrap `HTMLMediaElement.prototype.volume`'s setter once so any
 * caller — Howler's internal fade loops, third-party widgets,
 * future call sites — has its write clamped into `[0, 1]` before
 * the browser sees it.
 *
 * Idempotent: subsequent calls are no-ops. Safe to invoke during
 * boot before any media element is constructed. Silently no-ops
 * outside the DOM (SSR, vitest jsdom-less runs) so the helper file
 * itself stays platform-agnostic.
 */
export function installVolumeSetterGuard(): boolean {
  if (volumeSetterGuardInstalled) return true;
  if (typeof globalThis === 'undefined') return false;
  const mediaCtor = (globalThis as {HTMLMediaElement?: typeof HTMLMediaElement})
    .HTMLMediaElement;
  if (!mediaCtor || !mediaCtor.prototype) return false;
  const descriptor = Object.getOwnPropertyDescriptor(
    mediaCtor.prototype,
    'volume',
  );
  if (!descriptor || typeof descriptor.set !== 'function') return false;
  const originalSet = descriptor.set;
  const originalGet = descriptor.get;
  Object.defineProperty(mediaCtor.prototype, 'volume', {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get: originalGet,
    set(this: HTMLMediaElement, value: unknown) {
      originalSet.call(this, clampUnitInterval(value));
    },
  });
  volumeSetterGuardInstalled = true;
  return true;
}

/**
 * Test-only reset hook so vitest specs can re-install the guard on a
 * jsdom-style fresh `HTMLMediaElement` prototype between cases.
 * Production callers should not need this.
 */
export function __resetVolumeSetterGuardForTests(): void {
  volumeSetterGuardInstalled = false;
}
