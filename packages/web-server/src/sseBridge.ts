/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SseBridge — per-session event fan-out for SSE clients.
//
// We use Hono's built-in streamSSE helper at the route level (it handles
// headers, encoding, and Node-server quirks correctly). The bridge here
// is just a typed pub-sub: producers `emit()`, the route's `streamSSE`
// callback subscribes and pumps events to the wire via `writeSSE`.
//
// Multiple clients per session are supported. Disconnects propagate via
// the SSEStreamingApi: a `write` against a closed stream throws, which
// we catch and remove the client.

import type {SSEStreamingApi} from 'hono/streaming';
import {onTransactionCommit} from './db.js';
import {telemetry} from './telemetry/index.js';

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

interface Subscriber {
  push(event: SseEvent): void;
  close(): void;
}

export interface SseBridgeOptions {
  sessionId?: string;
}

export class SseBridge {
  private subscribers = new Set<Subscriber>();
  private readonly sessionId: string | null;
  /**
   * Pre-subscribe buffer. The runtime races: a turn can start
   * (turn.start, content deltas) before the UI's EventSource has
   * finished its TCP handshake → the route handler hasn't added a
   * subscriber yet → emit() finds no targets and silently drops
   * everything. The first turn after a fresh page refresh used to
   * deliver an empty bubble for exactly this reason.
   *
   * Fix: while we have no subscribers, queue events here. The next
   * subscriber drains the buffer in arrival order before listening
   * for new ones. Once at least one subscriber exists, we go back to
   * direct fan-out and never refill the buffer.
   */
  private preconnectBuffer: SseEvent[] = [];
  /**
   * S-4 — count of preconnect events that the BUFFER_LIMIT cap forced
   * out. We surface this through bounded telemetry: the first drop
   * and every tenth drop after that fires `sse.preconnect_buffer_drop`
   * so an operator can spot a session that overflows its preconnect
   * window without flooding the gameplay log on every cap hit.
   */
  private droppedCount = 0;
  private static readonly BUFFER_LIMIT = 200;

  constructor(opts: SseBridgeOptions = {}) {
    this.sessionId = opts.sessionId ?? null;
  }

  emit(event: string, data: unknown, id?: string): void {
    const payload: SseEvent = {event, data, id};
    if (onTransactionCommit(() => this.emitNow(payload))) {
      return;
    }
    this.emitNow(payload);
  }

  private emitNow(payload: SseEvent): void {
    if (this.subscribers.size === 0) {
      this.preconnectBuffer.push(payload);
      if (this.preconnectBuffer.length > SseBridge.BUFFER_LIMIT) {
        const dropped = this.preconnectBuffer.shift();
        this.droppedCount += 1;
        if (
          this.droppedCount === 1 ||
          this.droppedCount % 10 === 0
        ) {
          telemetry.record({
            channel: 'gameplay',
            name: 'sse.preconnect_buffer_drop',
            sessionId: this.sessionId ?? undefined,
            data: {
              stage: 'sse_preconnect_buffer',
              dropped_total: this.droppedCount,
              dropped_event_type: dropped?.event ?? null,
              dropped_event_id: dropped?.id ?? null,
              buffer_limit: SseBridge.BUFFER_LIMIT,
              buffer_size: this.preconnectBuffer.length,
            },
          });
        }
      }
      return;
    }
    for (const sub of this.subscribers) {
      try {
        sub.push(payload);
      } catch (err) {
        console.error('[sse] subscriber threw on push', err);
      }
    }
  }

  /**
   * Pumps events into a Hono SSEStreamingApi. Returns a Promise that
   * resolves when the client disconnects (the route handler awaits it
   * to keep the connection open).
   *
   * S-5 — every close path runs through a single idempotent `finish()`
   * helper that:
   *   1. flips `closed` so push/heartbeat see the new state,
   *   2. clears the heartbeat interval exactly once,
   *   3. removes the subscriber from `this.subscribers` exactly once,
   *   4. wakes the pump loop so it can exit.
   * The same helper covers `closeAll()`, `stream.onAbort(...)`,
   * heartbeat `stream.write(': ping')` rejection, `writeSSE(...)`
   * rejection, AND a rejecting initial `stream.write(': connected')`
   * — the leak the pre-S-5 code had when the initial write failed
   * before the outer try/finally.
   */
  async runFor(stream: SSEStreamingApi): Promise<void> {
    const queue: SseEvent[] = [];
    let waker: (() => void) | undefined;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let cleanedUp = false;

    const finish = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      closed = true;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      this.subscribers.delete(sub);
      const w = waker;
      waker = undefined;
      w?.();
    };

    const sub: Subscriber = {
      push(event) {
        if (closed) return;
        queue.push(event);
        waker?.();
      },
      close() {
        finish();
      },
    };
    this.subscribers.add(sub);
    // Register the abort handler before the initial write so an
    // early abort (before headers go out) still routes through
    // finish() and removes the subscriber.
    stream.onAbort(() => {
      sub.close();
    });

    // Drain anything that emit() queued before we had any subscribers.
    // Runs ONCE — after this, subscribers.size > 0 so emit() pushes
    // directly and the buffer never refills.
    if (this.preconnectBuffer.length > 0) {
      for (const ev of this.preconnectBuffer) queue.push(ev);
      this.preconnectBuffer = [];
    }

    try {
      // Initial flush so headers + first byte go through immediately.
      // SSE comments start with `:` and are ignored by clients — we
      // write them via the underlying StreamingApi.write (writeSSE
      // always adds its own `event:`/`data:` prefixes which would
      // corrupt comments). If this write rejects we still need to
      // tear the subscriber back down, which the outer `finally` and
      // the idempotent `finish()` handle.
      try {
        await stream.write(': connected\n\n');
      } catch {
        sub.close();
        return;
      }
      if (closed) return;

      // Heartbeat: keeps proxies / Node TCP alive between sparse
      // events. The arrow checks `closed` before writing so a late
      // tick fired between `closed = true` and `clearInterval(...)`
      // does not push another `: ping`.
      heartbeat = setInterval(() => {
        if (closed) return;
        stream.write(': ping\n\n').catch(() => sub.close());
      }, 25_000);

      while (!closed) {
        while (queue.length > 0) {
          const ev = queue.shift()!;
          try {
            await stream.writeSSE({
              event: ev.event,
              data: JSON.stringify(ev.data),
              id: ev.id,
            });
          } catch {
            sub.close();
            return;
          }
        }
        if (closed) break;
        await new Promise<void>(resolve => {
          waker = () => {
            waker = undefined;
            resolve();
          };
        });
      }
    } finally {
      finish();
    }
  }

  closeAll(): void {
    for (const sub of this.subscribers) sub.close();
    this.subscribers.clear();
  }

  get clientCount(): number {
    return this.subscribers.size;
  }
}
