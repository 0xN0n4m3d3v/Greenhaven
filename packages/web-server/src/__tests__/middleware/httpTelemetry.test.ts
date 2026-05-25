/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-15 — HTTP-vs-SSE telemetry split. The middleware must:
//   * record `http.request` after a normal request resolves,
//   * record `http.request.error` and rethrow on a normal-request
//     thrown error,
//   * record `sse.opened` + `sse.closed` for SSE long-poll
//     connections (path ends in `/stream` OR Accept contains
//     `text/event-stream`), even when the handler throws.
//
// The tests call the middleware directly with a fake Hono context
// instead of going through `app.request(...)`. The latter would let
// Hono's outer `onError` convert a thrown handler into a 500
// response before the middleware's catch sees it; the unit test
// drives the middleware contract directly.

import {describe, expect, it} from 'vitest';
import type {Context} from 'hono';
import {
  createHttpTelemetryMiddleware,
  isSseRequest,
} from '../../middleware/httpTelemetry.js';
import type {TelemetryEvent} from '../../telemetry/channels.js';

function makeRecorder(): {
  record: (event: TelemetryEvent) => void;
  events: TelemetryEvent[];
} {
  const events: TelemetryEvent[] = [];
  return {
    record(event) {
      events.push(event);
    },
    events,
  };
}

interface FakeCtxOptions {
  method?: string;
  path: string;
  accept?: string;
  status?: number;
}

function makeContext(opts: FakeCtxOptions): Context {
  return {
    req: {
      method: opts.method ?? 'GET',
      path: opts.path,
      header(name: string) {
        if (name.toLowerCase() === 'accept') return opts.accept;
        return undefined;
      },
    },
    res: {status: opts.status ?? 200},
  } as unknown as Context;
}

describe('createHttpTelemetryMiddleware (ARCH-15)', () => {
  it('records http.request after a normal request resolves', async () => {
    const recorder = makeRecorder();
    const mw = createHttpTelemetryMiddleware(recorder);
    const ctx = makeContext({path: '/ok', status: 200});
    await mw(ctx, async () => undefined);
    expect(recorder.events).toHaveLength(1);
    const event = recorder.events[0]!;
    expect(event.channel).toBe('gameplay');
    expect(event.name).toBe('http.request');
    const data = (event as {data: Record<string, unknown>}).data;
    expect(data.method).toBe('GET');
    expect(data.path).toBe('/ok');
    expect(data.status).toBe(200);
    expect(typeof data.duration_ms).toBe('number');
  });

  it('records http.request.error and rethrows when a normal handler throws', async () => {
    const recorder = makeRecorder();
    const mw = createHttpTelemetryMiddleware(recorder);
    const ctx = makeContext({path: '/boom'});
    await expect(
      mw(ctx, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(recorder.events).toHaveLength(1);
    const event = recorder.events[0]!;
    expect(event.channel).toBe('gameplay');
    expect(event.name).toBe('http.request.error');
    expect(((event as {error: Error}).error as Error).message).toBe('boom');
    const data = (event as {data: Record<string, unknown>}).data;
    expect(data.method).toBe('GET');
    expect(data.path).toBe('/boom');
    expect(typeof data.duration_ms).toBe('number');
  });

  it('records sse.opened + sse.closed for /stream paths, never http.request', async () => {
    const recorder = makeRecorder();
    const mw = createHttpTelemetryMiddleware(recorder);
    const ctx = makeContext({path: '/api/session/abc/stream', status: 200});
    await mw(ctx, async () => undefined);
    const names = recorder.events.map(e => e.name);
    expect(names).toEqual(['sse.opened', 'sse.closed']);
    const closed = recorder.events.find(e => e.name === 'sse.closed')!;
    const data = (closed as {data: Record<string, unknown>}).data;
    expect(data.status).toBe(200);
    expect(typeof data.duration_ms).toBe('number');
  });

  it('classifies SSE by Accept header containing text/event-stream', async () => {
    const recorder = makeRecorder();
    const mw = createHttpTelemetryMiddleware(recorder);
    const ctx = makeContext({
      path: '/api/events',
      accept: 'text/event-stream, application/json;q=0.5',
      status: 200,
    });
    await mw(ctx, async () => undefined);
    const names = recorder.events.map(e => e.name);
    expect(names).toEqual(['sse.opened', 'sse.closed']);
  });

  it('still records sse.closed when an SSE handler throws', async () => {
    const recorder = makeRecorder();
    const mw = createHttpTelemetryMiddleware(recorder);
    const ctx = makeContext({path: '/api/session/abc/stream'});
    await expect(
      mw(ctx, async () => {
        throw new Error('sse-handler-failed');
      }),
    ).rejects.toThrow('sse-handler-failed');
    const names = recorder.events.map(e => e.name);
    expect(names).toEqual(['sse.opened', 'sse.closed']);
    const closed = recorder.events.find(e => e.name === 'sse.closed')!;
    const closedData = (closed as {data: Record<string, unknown>}).data;
    expect(closedData.errored).toBe(true);
    expect(((closed as {error: Error}).error as Error).message).toBe(
      'sse-handler-failed',
    );
  });

  it('does not emit http.* events for SSE-classified handlers, even on error', async () => {
    const recorder = makeRecorder();
    const mw = createHttpTelemetryMiddleware(recorder);
    const ctx = makeContext({path: '/api/foo/stream'});
    await expect(
      mw(ctx, async () => {
        throw new Error('sse-2');
      }),
    ).rejects.toThrow('sse-2');
    const names = recorder.events.map(e => e.name);
    expect(names.includes('http.request')).toBe(false);
    expect(names.includes('http.request.error')).toBe(false);
  });

  it('isSseRequest classifies path and Accept header correctly', () => {
    const cases: Array<{
      path: string;
      accept?: string;
      expected: boolean;
    }> = [
      {path: '/api/session/abc/stream', expected: true},
      {path: '/api/session/abc', accept: 'text/event-stream', expected: true},
      {
        path: '/api/foo',
        accept: 'text/event-stream, application/json;q=0.5',
        expected: true,
      },
      {path: '/api/health', accept: 'application/json', expected: false},
      {path: '/index.html', expected: false},
    ];
    for (const {path, accept, expected} of cases) {
      const fakeCtx = {
        req: {
          path,
          header(name: string) {
            if (name === 'accept') return accept;
            return undefined;
          },
        },
      };
      expect(isSseRequest(fakeCtx as never)).toBe(expected);
    }
  });
});
