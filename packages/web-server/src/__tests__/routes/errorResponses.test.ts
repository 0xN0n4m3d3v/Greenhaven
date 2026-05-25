/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-3 / DEEP-7 — integration coverage for the generic error
// response contract. These tests exercise the full Hono request /
// response path so the `app.onError` shim + `errorResponse` helper
// are pinned together: an uncaught route exception must produce
// `500 {error: 'internal_error', correlation_id: <uuid>}` with no
// `message`, `String(err)`, or stack text leaking through.
//
// The tests build a tiny Hono app rather than booting the real
// server entry point so they stay hermetic (no DB, no real
// telemetry sinks).

import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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

import {errorResponse} from '../../httpErrors.js';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeApp(): Hono {
  const app = new Hono();
  // Mirror the production `app.onError` wiring exactly. If this
  // line ever drifts from `src/index.ts` it is a real regression,
  // because the global handler is the last-resort wire-format
  // guarantee.
  app.onError((err, c) =>
    errorResponse(c, 500, 'internal_error', {internal: err}),
  );
  app.post('/api/explode', () => {
    throw new Error(
      'ECONNREFUSED 127.0.0.1:54321 connecting to upstream provider',
    );
  });
  app.get('/api/db-shaped', () => {
    // Postgres-style error message: column / table names and the
    // raw SQL fragment are a classic leak source.
    throw new Error(
      'duplicate key value violates unique constraint "sessions_player_id_uidx"',
    );
  });
  app.get('/api/health', (c) => c.json({ok: true}));
  return app;
}

describe('app.onError (SEC-3 / DEEP-7)', () => {
  beforeEach(() => {
    telemetryState.events.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns 500 with opaque body and a v4 UUID correlation id', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/explode', {
      method: 'POST',
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: 'internal_error',
      correlation_id: expect.stringMatching(UUID_V4_RE),
    });
  });

  it('never includes the internal exception message in the wire body', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/explode', {
      method: 'POST',
    });
    const text = await res.text();
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('upstream provider');
    expect(text).not.toContain('127.0.0.1:54321');
    // Stack-derived text must never reach the client either.
    expect(text).not.toMatch(/\bat\s+\S+:\d+:\d+/);
  });

  it('never leaks DB-shaped exception text (schema names, column names, SQL fragments)', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/db-shaped', {
      method: 'GET',
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('internal_error');
    expect(body['correlation_id']).toEqual(
      expect.stringMatching(UUID_V4_RE),
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain('duplicate key value');
    expect(text).not.toContain('sessions_player_id_uidx');
    expect(text).not.toContain('unique constraint');
  });

  it('records a gameplay-channel http.error telemetry event with method/path/status/code/correlation_id', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/explode', {
      method: 'POST',
    });
    const body = (await res.json()) as Record<string, unknown>;
    const corr = body['correlation_id'] as string;

    expect(telemetryState.events).toHaveLength(1);
    const event = telemetryState.events[0]!;
    expect(event['channel']).toBe('gameplay');
    expect(event['name']).toBe('http.error');
    // The original Error rides along so ops can read the message.
    expect(event['error']).toBeInstanceOf(Error);
    expect((event['error'] as Error).message).toContain('ECONNREFUSED');
    expect(event['data']).toMatchObject({
      status: 500,
      code: 'internal_error',
      correlation_id: corr,
      method: 'POST',
      path: '/api/explode',
    });
  });

  it('mints a fresh correlation id per failing request', async () => {
    const app = makeApp();
    const a = (await (
      await app.request('http://127.0.0.1:7777/api/explode', {method: 'POST'})
    ).json()) as Record<string, unknown>;
    const b = (await (
      await app.request('http://127.0.0.1:7777/api/explode', {method: 'POST'})
    ).json()) as Record<string, unknown>;
    expect(a['correlation_id']).not.toBe(b['correlation_id']);
  });

  it('does not intercept ordinary 200 responses', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/health', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
    expect(telemetryState.events).toHaveLength(0);
  });
});
