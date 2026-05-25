/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-14 — presentation barrier no longer phantom-expires on short
// wall-clock deadlines. The orchestrator's slot-resolution path is
// the canonical close trigger; only a 5-minute dead-service
// fallback can expire an open barrier. Queued turns stay blocked
// while any chat-visible slot is unresolved, even when many GUI
// events have already been released between barrier open and now.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const releaseSeqState = vi.hoisted(() => ({
  currentSeq: 0,
  snapshotCalls: 0,
}));

vi.mock('../../guiEventOutbox.js', () => ({
  getCurrentReleaseSeq: vi.fn(async () => {
    releaseSeqState.snapshotCalls += 1;
    return releaseSeqState.currentSeq;
  }),
}));

import {
  closePresentationBarrier,
  currentPresentationBarrier,
  expirePresentationBarrier,
  openPresentationBarrier,
  type PresentationBarrier,
} from '../../presentationScheduler.js';

interface FakeSession {
  id: string;
  presentationBarrier?: PresentationBarrier;
}

function makeSession(): FakeSession {
  return {id: 'sess-1', presentationBarrier: undefined};
}

beforeEach(() => {
  releaseSeqState.currentSeq = 0;
  releaseSeqState.snapshotCalls = 0;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('S-14: presentation barrier shape', () => {
  it('opens without a short deadline and stays open across a 5-second wall-clock advance', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
      const session = makeSession();
      const barrier = openPresentationBarrier(session as never, {
        turnId: 'turn-1',
        pendingVisibleSlots: 2,
      });
      expect(currentPresentationBarrier(session as never)).toBe(barrier);

      // Advance well past the old 12.5s short deadline. The barrier
      // must still be open because no slot has resolved and no
      // fallback has fired.
      vi.advanceTimersByTime(60_000);
      expect(currentPresentationBarrier(session as never)).toBe(barrier);
      expect(barrier.state).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the 5-minute fallbackDeadlineAt at open', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
      const session = makeSession();
      const barrier = openPresentationBarrier(session as never, {
        turnId: 'turn-fb',
        pendingVisibleSlots: 1,
      });
      const fiveMinMs = 5 * 60_000;
      expect(barrier.fallbackDeadlineAt - barrier.openedAt).toBe(fiveMinMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires only when the fallback deadline (default 5 min) is crossed', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
      const session = makeSession();
      const barrier = openPresentationBarrier(session as never, {
        turnId: 'turn-2',
        pendingVisibleSlots: 1,
      });
      // 4 minutes 59 seconds — still open.
      vi.advanceTimersByTime(4 * 60_000 + 59_000);
      expect(currentPresentationBarrier(session as never)).toBe(barrier);

      // Cross the 5-minute boundary — fallback expiry kicks in.
      vi.advanceTimersByTime(2_000);
      expect(currentPresentationBarrier(session as never)).toBe(null);
      expect(session.presentationBarrier).toBeUndefined();
      expect(barrier.state).toBe('expired');
      expect(barrier.reason).toBe('fallback_deadline_exceeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes via the slot-resolution path before the fallback fires', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
      const session = makeSession();
      const barrier = openPresentationBarrier(session as never, {
        turnId: 'turn-3',
        pendingVisibleSlots: 2,
      });
      vi.advanceTimersByTime(2_000);
      // Even after release-seq advances by many events from the
      // first slot, the barrier must still be open while later
      // slots are pending.
      releaseSeqState.currentSeq = 42;
      expect(currentPresentationBarrier(session as never)).toBe(barrier);

      // Orchestrator closes when all chat-visible slots resolve.
      closePresentationBarrier(session as never, barrier.id, 'resolved');
      expect(currentPresentationBarrier(session as never)).toBe(null);
      expect(barrier.state).toBe('closed');
      expect(barrier.reason).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports an explicit shorter fallback for tests and devtools', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
      const session = makeSession();
      const barrier = openPresentationBarrier(session as never, {
        turnId: 'turn-fb-short',
        pendingVisibleSlots: 1,
        fallbackDeadlineMs: 30_000,
      });
      expect(barrier.fallbackDeadlineAt - barrier.openedAt).toBe(30_000);
      vi.advanceTimersByTime(29_000);
      expect(currentPresentationBarrier(session as never)).toBe(barrier);
      vi.advanceTimersByTime(2_000);
      expect(currentPresentationBarrier(session as never)).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes a release-seq snapshot field for diagnostics', () => {
    const session = makeSession();
    const barrier = openPresentationBarrier(session as never, {
      turnId: 'turn-rseq',
      pendingVisibleSlots: 1,
      openedReleaseSeq: 17,
    });
    expect(barrier.openedReleaseSeq).toBe(17);
    expect(currentPresentationBarrier(session as never)?.openedReleaseSeq).toBe(
      17,
    );
    closePresentationBarrier(session as never, barrier.id);
  });

  it('expirePresentationBarrier carries an explicit reason on the released barrier', () => {
    const session = makeSession();
    const barrier = openPresentationBarrier(session as never, {
      turnId: 'turn-reason',
      pendingVisibleSlots: 1,
    });
    expirePresentationBarrier(session as never, barrier.id, 'manual_test');
    expect(barrier.state).toBe('expired');
    expect(barrier.reason).toBe('manual_test');
  });
});
