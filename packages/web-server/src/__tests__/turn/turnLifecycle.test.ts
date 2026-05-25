/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 unit tests — `src/turn/TurnLifecycle.ts`.
//
// Closes USER-2 (deferred turn start) at the unit level by proving
// that `deferTurnStart` does not invoke its work until the next
// microtask, and USER-1 (safe post-turn pipeline) by proving that
// `runPostTurnSafely` forwards sync throws + async rejections through
// the ARCH-2 telemetry facade as a `post_turn_pipeline.unhandled`
// gameplay event instead of letting them become unhandled rejections.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const telemetryState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../telemetry/index.js', () => ({
  telemetry: {
    record: vi.fn((event: Record<string, unknown>) => {
      telemetryState.events.push(event);
    }),
    flush: vi.fn(async () => {}),
    pendingCount: vi.fn(() => 0),
  },
  measure: vi.fn(async (_input: unknown, work: () => unknown) => work()),
}));

import {
  deferTurnStart,
  runPostTurnSafely,
} from '../../turn/TurnLifecycle.js';

beforeEach(() => {
  telemetryState.events.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deferTurnStart', () => {
  it('does not invoke the work synchronously', () => {
    let invoked = false;
    const promise = deferTurnStart(() => {
      invoked = true;
    });
    expect(invoked).toBe(false);
    // Awaiting the promise drains the microtask queue and lets the
    // deferred work run.
    return promise.then(() => {
      expect(invoked).toBe(true);
    });
  });

  it('forwards the work result through the returned promise', async () => {
    const result = await deferTurnStart(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('surfaces sync throws as a promise rejection', async () => {
    await expect(
      deferTurnStart(() => {
        throw new Error('boom-sync');
      }),
    ).rejects.toThrow(/boom-sync/);
  });

  it('surfaces async rejections', async () => {
    await expect(
      deferTurnStart(() => Promise.reject(new Error('boom-async'))),
    ).rejects.toThrow(/boom-async/);
  });
});

describe('runPostTurnSafely', () => {
  const envelope = {
    sessionId: 'sess-1',
    playerId: 7,
    turnId: 'turn-1',
  };

  it('runs the invoke callback synchronously when it does not throw', () => {
    let called = false;
    runPostTurnSafely(envelope, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(telemetryState.events).toEqual([]);
  });

  it('captures sync throws and emits gameplay:post_turn_pipeline.unhandled', () => {
    const err = new Error('sync-explosion');
    runPostTurnSafely(envelope, () => {
      throw err;
    });
    expect(telemetryState.events).toHaveLength(1);
    const ev = telemetryState.events[0]!;
    expect(ev['channel']).toBe('gameplay');
    expect(ev['name']).toBe('post_turn_pipeline.unhandled');
    expect(ev['sessionId']).toBe(envelope.sessionId);
    expect(ev['playerId']).toBe(envelope.playerId);
    expect(ev['turnId']).toBe(envelope.turnId);
    expect(ev['error']).toBe(err);
    const data = ev['data'] as Record<string, unknown>;
    expect(data['raw_message']).toBe('sync-explosion');
    expect(typeof data['stack']).toBe('string');
  });

  it('captures returned-promise rejections without throwing', async () => {
    let postRejected = false;
    expect(() => {
      runPostTurnSafely(envelope, () => {
        return new Promise((_resolve, reject) =>
          queueMicrotask(() => {
            postRejected = true;
            reject(new Error('async-explosion'));
          }),
        );
      });
    }).not.toThrow();
    // Drain microtasks so the inner rejection settles.
    await new Promise((r) => setImmediate(r));
    expect(postRejected).toBe(true);
    expect(telemetryState.events).toHaveLength(1);
    const ev = telemetryState.events[0]!;
    expect(ev['name']).toBe('post_turn_pipeline.unhandled');
    expect((ev['data'] as Record<string, unknown>)['raw_message']).toBe(
      'async-explosion',
    );
  });

  it('stringifies non-Error rejection payloads safely', async () => {
    runPostTurnSafely(envelope, () => Promise.reject('plain-string'));
    await new Promise((r) => setImmediate(r));
    const ev = telemetryState.events[0]!;
    expect((ev['data'] as Record<string, unknown>)['raw_message']).toBe(
      'plain-string',
    );
    // The raw payload passes through as `error` so an ops dashboard can
    // still distinguish a thrown-string from a thrown-Error.
    expect(ev['error']).toBe('plain-string');
  });

  it('does not emit telemetry when the invoke returns void cleanly', () => {
    runPostTurnSafely(envelope, () => undefined);
    expect(telemetryState.events).toEqual([]);
  });
});
