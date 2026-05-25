/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-3 / DEEP-7 — `httpErrors.ts` helper unit tests.
//
// Pins the contract of `errorResponse(c, status, code, opts?)` and
// `errorOutcome(status, code, opts?)`:
//
//   * Body shape: `{error: <code>, correlation_id: <uuid>}`. No
//     `message`, no `String(err)`, no `raw` model output, no
//     stack-derived text.
//   * Correlation id matches the RFC 4122 v4 UUID form so log
//     triage can grep the id straight from the wire.
//   * `internal`, `data`, `method`, `path`, `status`, and `code`
//     ride along on the gameplay-channel `http.error` telemetry
//     record so operators still have everything they need to
//     diagnose the failure.
//   * A `console.error` line includes the correlation id so log
//     grep matches the client-visible value.
//   * Two helpers emit identical telemetry / log shapes — the
//     difference is only whether they hand back a Hono `Response`
//     or a `RouteOutcome`-style `{status, body}`.

import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Context} from 'hono';

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
  buildErrorBody,
  errorOutcome,
  errorResponse,
} from '../../httpErrors.js';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FakeJsonCall {
  body: unknown;
  status: number;
}

function makeContext(opts: {method?: string; path?: string} = {}): {
  ctx: Context;
  jsonCalls: FakeJsonCall[];
} {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? '/api/test';
  const jsonCalls: FakeJsonCall[] = [];
  const ctx = {
    req: {method, path, header: () => undefined},
    json(body: unknown, status: number) {
      jsonCalls.push({body, status});
      return {body, status} as unknown as Response;
    },
  } as unknown as Context;
  return {ctx, jsonCalls};
}

describe('buildErrorBody', () => {
  it('returns body with the supplied code and a v4 UUID correlation id', () => {
    const body = buildErrorBody('test_code');
    expect(body.error).toBe('test_code');
    expect(body.correlation_id).toMatch(UUID_V4_RE);
  });

  it('mints a fresh correlation id per call', () => {
    const a = buildErrorBody('x');
    const b = buildErrorBody('x');
    expect(a.correlation_id).not.toBe(b.correlation_id);
  });
});

describe('errorResponse (SEC-3 / DEEP-7)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    telemetryState.events.length = 0;
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('emits an opaque 500 body with a v4 UUID correlation id', () => {
    const {ctx, jsonCalls} = makeContext({method: 'POST', path: '/api/x'});
    errorResponse(ctx, 500, 'internal_error', {
      internal: new Error('ECONNREFUSED 127.0.0.1:54321'),
    });
    expect(jsonCalls).toHaveLength(1);
    expect(jsonCalls[0]!.status).toBe(500);
    expect(jsonCalls[0]!.body).toEqual({
      error: 'internal_error',
      correlation_id: expect.stringMatching(UUID_V4_RE),
    });
    // The internal exception message is never placed in the body.
    expect(JSON.stringify(jsonCalls[0]!.body)).not.toContain('ECONNREFUSED');
  });

  it('records a gameplay-channel http.error telemetry event with full context', () => {
    const {ctx, jsonCalls} = makeContext({method: 'PUT', path: '/api/save'});
    const internal = new Error('disk full');
    errorResponse(ctx, 500, 'save_restore_failed', {
      internal,
      data: {slot_id: 42},
    });
    expect(telemetryState.events).toHaveLength(1);
    const event = telemetryState.events[0]!;
    expect(event['channel']).toBe('gameplay');
    expect(event['name']).toBe('http.error');
    // The full Error rides along on the telemetry record so ops
    // can read stack + message without the client ever seeing it.
    expect(event['error']).toBe(internal);
    expect(event['data']).toEqual({
      status: 500,
      code: 'save_restore_failed',
      correlation_id: (jsonCalls[0]!.body as {correlation_id: string})
        .correlation_id,
      method: 'PUT',
      path: '/api/save',
      slot_id: 42,
    });
  });

  it('logs a console.error line containing the correlation id and internal error', () => {
    const {ctx, jsonCalls} = makeContext({
      method: 'POST',
      path: '/api/player/anonymous',
    });
    const internal = new Error('duplicate key value');
    errorResponse(ctx, 500, 'internal_error', {internal});
    const corr = (jsonCalls[0]!.body as {correlation_id: string}).correlation_id;
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const callArgs = consoleSpy.mock.calls[0]!;
    expect(callArgs[0]).toContain(corr);
    expect(callArgs[0]).toContain('POST /api/player/anonymous');
    expect(callArgs[0]).toContain('500 internal_error');
    expect(callArgs[1]).toBe(internal);
  });

  it('handles a missing `internal` without crashing or logging a phantom error', () => {
    const {ctx} = makeContext();
    errorResponse(ctx, 500, 'internal_error');
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]!['error']).toBeUndefined();
    // Still logged once with just the header line.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0]!.length).toBe(1);
  });

  it('supports method/path overrides (used by service-layer adapters)', () => {
    const {ctx} = makeContext({method: 'GET', path: '/api/x'});
    errorResponse(ctx, 500, 'svc_failed', {
      method: 'POST',
      path: '/svc/override',
    });
    expect(telemetryState.events[0]!['data']).toMatchObject({
      method: 'POST',
      path: '/svc/override',
    });
  });
});

describe('errorOutcome (SEC-3 / DEEP-7)', () => {
  beforeEach(() => {
    telemetryState.events.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns a `{status, body}` RouteOutcome with the same opaque body shape', () => {
    const outcome = errorOutcome(500, 'turn_enqueue_failed', {
      internal: new Error('queue lock timeout'),
      data: {session_id: 'sess-abc'},
    });
    expect(outcome.status).toBe(500);
    expect(outcome.body).toEqual({
      error: 'turn_enqueue_failed',
      correlation_id: expect.stringMatching(UUID_V4_RE),
    });
    expect(JSON.stringify(outcome.body)).not.toContain('queue lock timeout');
  });

  it('records telemetry with null method/path (no Hono context available)', () => {
    errorOutcome(500, 'svc_failed', {internal: new Error('boom')});
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]!['data']).toMatchObject({
      status: 500,
      code: 'svc_failed',
      method: null,
      path: null,
    });
  });

  it('merges `data` into the telemetry payload without touching the body', () => {
    const outcome = errorOutcome(500, 'synthesis_unparseable', {
      data: {finish_reason: 'length', usage: {inputTokens: 10}},
    });
    expect(Object.keys(outcome.body)).toEqual(['error', 'correlation_id']);
    expect(telemetryState.events[0]!['data']).toMatchObject({
      finish_reason: 'length',
      usage: {inputTokens: 10},
    });
  });

  it('mints a unique correlation id per call', () => {
    const a = errorOutcome(500, 'x');
    const b = errorOutcome(500, 'x');
    expect(a.body.correlation_id).not.toBe(b.body.correlation_id);
  });
});
