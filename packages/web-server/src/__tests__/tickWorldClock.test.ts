/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-9 — `tickWorldClock` reads `world_entity_id` and the
// `world_clock` config from `cartridge_meta` rather than embedding
// numeric fallbacks. These tests cover the three branches the spec
// calls out: a normal advance using configured values, fail-open when
// `world_entity_id` is missing, and a custom (`tick_minutes`,
// `default_minutes`) pair.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FieldRow {
  id: number;
  field_key: string;
  value: unknown;
  default_value: unknown;
}

const cartridgeState = vi.hoisted(() => ({
  worldEntityId: null as number | null,
  worldClock: {tickMinutes: 10, defaultMinutes: 450},
}));

const dbState = vi.hoisted(() => ({
  worldClockFields: [] as FieldRow[],
  writes: [] as Array<{fieldId: number; value: unknown}>,
}));

const eventsState = vi.hoisted(() => ({
  emitFieldChangeCalls: [] as Array<{
    sessionId: string;
    payload: Record<string, unknown>;
  }>,
}));

vi.mock('../cartridge.js', () => ({
  getMeta: vi.fn(async (key: string, fallback?: unknown) => {
    if (key === 'world_entity_id') {
      return cartridgeState.worldEntityId ?? fallback;
    }
    return fallback;
  }),
  getMetaRequired: vi.fn(async (key: string) => {
    if (key === 'world_entity_id') {
      if (cartridgeState.worldEntityId == null) {
        throw new Error(`cartridge_meta missing required key: '${key}'`);
      }
      return cartridgeState.worldEntityId;
    }
    return null;
  }),
  getWorldClockConfig: vi.fn(async () => cartridgeState.worldClock),
}));

vi.mock('../runtimeFieldEvents.js', () => ({
  emitFieldChange: vi.fn(
    (sessionId: string, payload: Record<string, unknown>) => {
      eventsState.emitFieldChangeCalls.push({sessionId, payload});
    },
  ),
  emitFieldChanges: vi.fn(),
  emitFieldChangesById: vi.fn(),
}));

vi.mock('../db.js', () => ({
  query: vi.fn(
    async <T>(sql: string, params?: unknown[]): Promise<{
      rows: T[];
      rowCount: number;
    }> => {
      if (
        /SELECT rf\.id, rf\.field_key, rv\.value, rf\.default_value/i.test(
          sql,
        ) &&
        /world_time_minutes/i.test(sql)
      ) {
        return {
          rows: dbState.worldClockFields as unknown as T[],
          rowCount: dbState.worldClockFields.length,
        };
      }
      if (/INSERT INTO runtime_values/i.test(sql)) {
        const fieldId = Number(params?.[0]);
        const raw = params?.[1];
        let parsed: unknown = raw;
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
        }
        dbState.writes.push({fieldId, value: parsed});
        return {rows: [] as T[], rowCount: 1};
      }
      return {rows: [] as T[], rowCount: 0};
    },
  ),
}));

import {tickWorldClock} from '../transitionEngine.js';

function setWorldClockFields(initialMinutes: number | null): void {
  dbState.worldClockFields = [
    {id: 10012, field_key: 'world_time_minutes', value: initialMinutes, default_value: null},
    {id: 10010, field_key: 'time_of_day', value: '"dusk"', default_value: null},
  ];
}

function reset(): void {
  cartridgeState.worldEntityId = null;
  cartridgeState.worldClock = {tickMinutes: 10, defaultMinutes: 450};
  dbState.worldClockFields = [];
  dbState.writes = [];
  eventsState.emitFieldChangeCalls = [];
}

beforeEach(() => {
  reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ARCH-9 — tickWorldClock cartridge meta', () => {
  it('advances minutes by configured tick and recomputes time_of_day', async () => {
    cartridgeState.worldEntityId = 10;
    setWorldClockFields(450);

    await tickWorldClock('sess-1');

    expect(dbState.writes).toHaveLength(2);
    const minutesWrite = dbState.writes.find(w => w.fieldId === 10012);
    const todWrite = dbState.writes.find(w => w.fieldId === 10010);
    expect(minutesWrite?.value).toBe(460);
    expect(todWrite?.value).toBe('morning');
    const fieldKeys = eventsState.emitFieldChangeCalls.map(
      call => (call.payload as {field_key: string}).field_key,
    );
    expect(fieldKeys).toContain('world_time_minutes');
    expect(fieldKeys).toContain('time_of_day');
  });

  it('fails open without touching runtime fields when world_entity_id is missing', async () => {
    cartridgeState.worldEntityId = null;
    setWorldClockFields(450);

    await tickWorldClock('sess-1');

    expect(dbState.writes).toHaveLength(0);
    expect(eventsState.emitFieldChangeCalls).toHaveLength(0);
  });

  it('honors configured tick_minutes and default_minutes', async () => {
    cartridgeState.worldEntityId = 10;
    cartridgeState.worldClock = {tickMinutes: 30, defaultMinutes: 360};
    // value is null so the engine falls back to `default_minutes` from
    // the cartridge config (360) — 360 + 30 = 390 (still 'morning').
    setWorldClockFields(null);

    await tickWorldClock('sess-1');

    const minutesWrite = dbState.writes.find(w => w.fieldId === 10012);
    const todWrite = dbState.writes.find(w => w.fieldId === 10010);
    expect(minutesWrite?.value).toBe(390);
    expect(todWrite?.value).toBe('morning');
  });
});
