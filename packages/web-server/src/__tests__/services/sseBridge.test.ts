/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-4 — SSE preconnect buffer drop telemetry.
//
// SseBridge silently drops the oldest buffered event when its
// preconnect buffer crosses BUFFER_LIMIT. The cap behavior is
// deliberate (a slow EventSource handshake must not blow the
// server's memory), but the lossy fact needs to surface so an
// operator notices a session that's filling its preconnect window
// fast enough to lose state. The tests below prove the bounded
// telemetry contract: first drop fires, then every tenth drop, no
// telemetry below the cap, retained buffer ordering after overflow.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

vi.mock('../../db.js', () => ({
  onTransactionCommit: () => false,
}));

import {SseBridge} from '../../sseBridge.js';

const BUFFER_LIMIT = 200;

function dropEvents(): Array<Record<string, unknown>> {
  return telemetryState.events.filter(
    e => e.name === 'sse.preconnect_buffer_drop',
  );
}

beforeEach(() => {
  telemetryState.events.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SseBridge — S-4 preconnect buffer drop telemetry', () => {
  it('emits no telemetry while the buffer stays under BUFFER_LIMIT', () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    for (let i = 0; i < BUFFER_LIMIT; i++) {
      bridge.emit('content', {index: i});
    }
    expect(dropEvents()).toHaveLength(0);
  });

  it('fires telemetry on the very first dropped event', () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    for (let i = 0; i < BUFFER_LIMIT; i++) {
      bridge.emit('content', {index: i});
    }
    expect(dropEvents()).toHaveLength(0);
    bridge.emit('content', {index: BUFFER_LIMIT}, 'evt-overflow');
    const events = dropEvents();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.channel).toBe('gameplay');
    expect(event.sessionId).toBe('sess-1');
    expect(event.data).toEqual(
      expect.objectContaining({
        stage: 'sse_preconnect_buffer',
        dropped_total: 1,
        dropped_event_type: 'content',
        buffer_limit: BUFFER_LIMIT,
        buffer_size: BUFFER_LIMIT,
      }),
    );
  });

  it('throttles drop telemetry to the 1st event and every 10th after', () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    for (let i = 0; i < BUFFER_LIMIT + 50; i++) {
      bridge.emit('content', {index: i});
    }
    const events = dropEvents();
    const totals = events.map(e => (e.data as {dropped_total: number}).dropped_total);
    expect(totals).toEqual([1, 10, 20, 30, 40, 50]);
    expect(events).toHaveLength(6);
  });

  it('preserves arrival order after overflow when a subscriber drains the buffer', async () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    for (let i = 0; i < BUFFER_LIMIT + 50; i++) {
      bridge.emit('content', {index: i});
    }
    const writes: Array<{event: string; data: unknown}> = [];
    const stream = {
      write: vi.fn(async () => undefined),
      writeSSE: vi.fn(
        async (event: {event?: string; data?: string; id?: string}) => {
          writes.push({
            event: event.event ?? '',
            data: event.data ? JSON.parse(event.data) : null,
          });
        },
      ),
      onAbort: vi.fn(),
    };
    const pump = bridge.runFor(stream as never);
    // Drain microtasks so the runFor loop pulls every preconnect
    // buffer event out and writes them through writeSSE before we
    // ask it to shut down.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    bridge.closeAll();
    await pump;

    const indexes = writes.map(w => (w.data as {index: number}).index);
    // First 50 events should have been dropped; the surviving buffer
    // starts at index 50 and ends at the last emitted index.
    expect(indexes[0]).toBe(50);
    expect(indexes[indexes.length - 1]).toBe(BUFFER_LIMIT + 49);
    expect(indexes).toHaveLength(BUFFER_LIMIT);
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBe(indexes[i - 1]! + 1);
    }
  });

  it('forwards the dropped event id and type to telemetry', () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    for (let i = 0; i < BUFFER_LIMIT; i++) {
      bridge.emit('content', {index: i}, `id-${i}`);
    }
    bridge.emit('content', {index: BUFFER_LIMIT}, 'overflow-id');
    const events = dropEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual(
      expect.objectContaining({
        dropped_event_type: 'content',
        dropped_event_id: 'id-0',
      }),
    );
  });

  it('does not emit telemetry once a subscriber is present (fan-out path)', () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    const stream = {
      write: vi.fn(async () => undefined),
      writeSSE: vi.fn(async () => undefined),
      onAbort: vi.fn(),
    };
    // Schedule runFor but don't await — once the subscriber registers,
    // direct fan-out path bypasses the preconnect buffer.
    void bridge.runFor(stream as never);
    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        for (let i = 0; i < BUFFER_LIMIT * 2; i++) {
          bridge.emit('content', {index: i});
        }
        expect(dropEvents()).toHaveLength(0);
        bridge.closeAll();
      });
  });
});

interface FakeStream {
  write: ReturnType<typeof vi.fn>;
  writeSSE: ReturnType<typeof vi.fn>;
  onAbort: ReturnType<typeof vi.fn>;
  abortHandler: (() => void) | null;
}

function makeStream(opts: {
  initialWriteRejects?: boolean;
  heartbeatRejects?: boolean;
  writeSseRejects?: boolean;
} = {}): FakeStream {
  const stream: FakeStream = {
    abortHandler: null,
    write: vi.fn(async (text: string) => {
      if (opts.initialWriteRejects && text.includes('connected')) {
        throw new Error('connected-failed');
      }
      if (opts.heartbeatRejects && text.includes('ping')) {
        throw new Error('ping-failed');
      }
      return undefined;
    }) as ReturnType<typeof vi.fn>,
    writeSSE: vi.fn(async () => {
      if (opts.writeSseRejects) throw new Error('writeSSE-failed');
      return undefined;
    }) as ReturnType<typeof vi.fn>,
    onAbort: vi.fn(),
  };
  stream.onAbort.mockImplementation((cb: () => void) => {
    stream.abortHandler = cb;
  });
  return stream;
}

async function drainMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe('SseBridge — S-5 cleanup lifecycle', () => {
  it('removes the subscriber when the initial connected write rejects', async () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    const stream = makeStream({initialWriteRejects: true});
    await bridge.runFor(stream as never);
    expect(bridge.clientCount).toBe(0);
  });

  it('routes early stream.onAbort through finish() before initial write completes', async () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    const stream = makeStream();
    stream.write.mockImplementation(async (text: string) => {
      if (text.includes('connected') && stream.abortHandler) {
        stream.abortHandler();
      }
    });
    const pump = bridge.runFor(stream as never);
    await pump;
    expect(bridge.clientCount).toBe(0);
  });

  it('clears the heartbeat when closeAll fires while the pump is idle', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new SseBridge({sessionId: 'sess-1'});
      const stream = makeStream();
      const pump = bridge.runFor(stream as never);
      await drainMicrotasks();
      expect(bridge.clientCount).toBe(1);
      const initialWrites = stream.write.mock.calls.length;
      vi.advanceTimersByTime(25_001);
      await drainMicrotasks();
      const writesAfterHeartbeat = stream.write.mock.calls.length;
      expect(writesAfterHeartbeat).toBeGreaterThan(initialWrites);
      bridge.closeAll();
      await drainMicrotasks();
      await pump;
      expect(bridge.clientCount).toBe(0);
      vi.advanceTimersByTime(60_000);
      await drainMicrotasks();
      // No more `: ping` writes after closeAll.
      expect(stream.write.mock.calls.length).toBe(writesAfterHeartbeat);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the heartbeat when stream.write(": ping") rejects', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new SseBridge({sessionId: 'sess-1'});
      const stream = makeStream({heartbeatRejects: true});
      const pump = bridge.runFor(stream as never);
      await drainMicrotasks();
      expect(bridge.clientCount).toBe(1);
      vi.advanceTimersByTime(25_001);
      await drainMicrotasks();
      const afterFirstPing = stream.write.mock.calls.length;
      await pump;
      expect(bridge.clientCount).toBe(0);
      vi.advanceTimersByTime(60_000);
      await drainMicrotasks();
      expect(stream.write.mock.calls.length).toBe(afterFirstPing);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the heartbeat when writeSSE rejects', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new SseBridge({sessionId: 'sess-1'});
      const stream = makeStream({writeSseRejects: true});
      const pump = bridge.runFor(stream as never);
      await drainMicrotasks();
      expect(bridge.clientCount).toBe(1);
      bridge.emit('content', {index: 0});
      await drainMicrotasks();
      await pump;
      expect(bridge.clientCount).toBe(0);
      const writesAfterFailure = stream.write.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      await drainMicrotasks();
      // Heartbeat must not fire after writeSSE failure tore the pump
      // down — clearInterval must have run inside finish().
      expect(stream.write.mock.calls.length).toBe(writesAfterFailure);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is idempotent against repeated close calls', async () => {
    const bridge = new SseBridge({sessionId: 'sess-1'});
    const stream = makeStream();
    const pump = bridge.runFor(stream as never);
    await drainMicrotasks();
    expect(bridge.clientCount).toBe(1);
    bridge.closeAll();
    bridge.closeAll();
    bridge.closeAll();
    await pump;
    expect(bridge.clientCount).toBe(0);
  });

  it('does not start the heartbeat if onAbort fires during the initial write', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new SseBridge({sessionId: 'sess-1'});
      const stream = makeStream();
      stream.write.mockImplementation(async (text: string) => {
        if (text.includes('connected') && stream.abortHandler) {
          stream.abortHandler();
        }
      });
      const pump = bridge.runFor(stream as never);
      await pump;
      const callsAfterPump = stream.write.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      await drainMicrotasks();
      // No heartbeat ticks because closed was already true when the
      // initial write returned; setInterval was skipped entirely.
      expect(stream.write.mock.calls.length).toBe(callsAfterPump);
      expect(bridge.clientCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
