/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// X-3/X-4 follow-up #12 — `getMeta` cartridge metadata read fallback.
// The cartridge_meta table may not exist on a very old DB; the
// accessor falls back to the optional `fallback` argument. The
// fallback path now records a structured gameplay telemetry event
// with the meta key + whether a fallback was provided + the
// normalised error message, so operators can graph metadata-read
// failures without grepping stderr.

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

const queryState = vi.hoisted(() => ({
  responses: [] as Array<() => unknown>,
}));

vi.mock('../../db.js', () => ({
  query: vi.fn(async () => {
    const next = queryState.responses.shift();
    if (!next) return {rows: []};
    return next();
  }),
}));

const {clearMetaCache, getMeta} = await import('../../cartridge.js');

beforeEach(() => {
  telemetryState.events.length = 0;
  queryState.responses.length = 0;
  clearMetaCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getMeta cartridge metadata read fallback', () => {
  it('records gameplay telemetry and returns fallback when the query throws', async () => {
    queryState.responses.push(() => {
      throw Object.assign(
        new Error('relation "cartridge_meta" does not exist'),
        {code: '42P01'},
      );
    });

    const result = await getMeta<number>('world_clock', 42);

    expect(result).toBe(42);
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]).toMatchObject({
      channel: 'gameplay',
      name: 'cartridge.meta_read_failed',
      data: {
        meta_key: 'world_clock',
        fallback_provided: true,
      },
    });
  });

  it('records telemetry with fallback_provided=false when caller omits the fallback', async () => {
    queryState.responses.push(() => {
      throw new Error('boom: cartridge_meta read failed');
    });

    const result = await getMeta<number>('absent_key');

    expect(result).toBeUndefined();
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]).toMatchObject({
      channel: 'gameplay',
      name: 'cartridge.meta_read_failed',
      data: {
        meta_key: 'absent_key',
        fallback_provided: false,
      },
    });
  });

  it('does not emit telemetry on the successful path', async () => {
    queryState.responses.push(() => ({rows: [{value: 'ok'}], rowCount: 1}));
    const result = await getMeta<string>('starting_location_slug');
    expect(result).toBe('ok');
    expect(telemetryState.events).toHaveLength(0);
  });
});
