/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-10 — `evaluateTransitions()` must emit a structured
// `gameplay/transition_engine.iteration_cap_reached` telemetry event
// when the fixpoint loop hits `MAX_ITERATIONS`. A normal convergence
// (a transition that fires once then stabilises) must NOT emit the
// event.
//
// TE-1 — the `transitions` table is queried exactly once per
// `evaluateTransitions()` call regardless of how many fixpoint passes
// run.
//
// TE-2 — predicate evaluation and patch application operate on a
// single in-memory `FieldSnapshot` taken from one `runtime_fields`
// query, and the eventual persistence is one batched `jsonb_to_recordset`
// flush. No per-predicate `readFieldValue` queries; no per-patch
// field-metadata or insert queries.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const telemetryState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../telemetry/index.js', () => ({
  telemetry: {
    record: vi.fn((event: Record<string, unknown>) => {
      telemetryState.events.push(event);
    }),
    flush: vi.fn(async () => {}),
    pendingCount: vi.fn(() => 0),
  },
  measure: vi.fn(async (_input: unknown, work: () => unknown) => work()),
}));

const eventsState = vi.hoisted(() => ({
  // TE-2 follow-up — count `emitFieldChangesById` calls so tests
  // can assert SSE never fires when the dirty flush throws.
  emitFieldChangesByIdCalls: [] as Array<{
    sessionId: string;
    changes: unknown;
  }>,
}));

vi.mock('../runtimeFieldEvents.js', () => ({
  emitFieldChange: vi.fn(),
  emitFieldChanges: vi.fn(),
  emitFieldChangesById: vi.fn(async (sessionId: string, changes: unknown) => {
    eventsState.emitFieldChangesByIdCalls.push({sessionId, changes});
  }),
}));

vi.mock('../runtimeFieldValidation.js', () => ({
  validateRuntimeFieldValue: vi.fn(() => ({ok: true})),
}));

vi.mock('../cartridge.js', () => ({
  getMeta: vi.fn(async () => null),
}));

interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

interface FieldRow {
  field_id: number;
  field_key: string;
  value_type: string;
  allowed_values: unknown[] | null;
  scope_per_player: boolean;
  default_value: unknown;
  overlay_value: unknown;
  global_value: unknown;
}

interface FlushPayloadEntry {
  field_id: number;
  value: unknown;
  source: string;
  scope_per_player: boolean;
}

const dbState = vi.hoisted(() => ({
  transitionRows: [] as Array<Record<string, unknown>>,
  // TE-2 — snapshot rows returned by the one `runtime_fields` query
  // per invocation. Configured per-test via `setField(...)`.
  fieldRows: [] as Array<{
    field_id: number;
    field_key: string;
    value_type: string;
    allowed_values: unknown[] | null;
    scope_per_player: boolean;
    default_value: unknown;
    overlay_value: unknown;
    global_value: unknown;
  }>,
  transitionQueries: 0,
  // TE-2 — counts of the new snapshot/flush statements. Pre-TE-2
  // code performed many per-predicate `readFieldValue` reads and
  // per-patch field-metadata + insert queries; both counters must
  // stay at zero outside the one snapshot + (optional) one flush
  // per call.
  snapshotQueries: 0,
  flushQueries: 0,
  // Pre-TE-2 counters: the old per-pass readFieldValue / per-patch
  // insert SQL shapes should never fire under TE-2. Each branch
  // increments these so tests can assert zero.
  legacyReadFieldValueQueries: 0,
  legacyFieldMetaQueries: 0,
  legacyOverlayInserts: 0,
  legacyGlobalInserts: 0,
  // Captures the JSONB payload supplied to the flush query so tests
  // can assert the dirty set + per-entry scope routing.
  lastFlushPayload: null as FlushPayloadEntry[] | null,
  // TE-2 follow-up — when true, the next `jsonb_to_recordset` flush
  // throws, simulating a DB write failure mid-evaluation. The flag
  // clears itself after firing so subsequent invocations are
  // unaffected.
  flushThrowOnce: false,
  // TE-3 — make the decrement turn-number lookup or the decay CTE
  // raise so the swallow-and-telemetry path can be exercised. Both
  // flags clear themselves after firing.
  throwOnChatMessagesOnce: false,
  throwOnTrimmedCteOnce: false,
  // Observability: count the number of `emitFieldChanges` calls so
  // tests can assert the success path still ran.
  trimmedCteRows: [] as Array<Record<string, unknown>>,
  trimmedCteTurnArg: null as number | null,
}));

function setField(partial: Partial<FieldRow> & {field_id: number}): void {
  const idx = dbState.fieldRows.findIndex((f) => f.field_id === partial.field_id);
  const merged: FieldRow = {
    field_key: `field-${partial.field_id}`,
    value_type: 'json',
    allowed_values: null,
    scope_per_player: false,
    default_value: null,
    overlay_value: null,
    global_value: null,
    ...partial,
  } as FieldRow;
  if (idx < 0) dbState.fieldRows.push(merged);
  else dbState.fieldRows[idx] = merged;
}

vi.mock('../db.js', () => ({
  query: vi.fn(
    async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
      // TE-3 — turn-number lookup used by decrementSurfaces /
      // decrementConditions. Default response is `turn_no = 0`.
      if (
        /FROM chat_messages WHERE session_id/i.test(sql) &&
        /MAX\(turn_index\)/i.test(sql)
      ) {
        if (dbState.throwOnChatMessagesOnce) {
          dbState.throwOnChatMessagesOnce = false;
          throw new Error('chat_messages boom');
        }
        return {
          rows: [{turn_no: 0}] as unknown as T[],
          rowCount: 1,
        };
      }
      // TE-3 — the trimmed/updated CTE used by both decay
      // functions. We capture the turn parameter so tests can
      // confirm the value passed to the CTE.
      if (/WITH trimmed AS/i.test(sql)) {
        if (dbState.throwOnTrimmedCteOnce) {
          dbState.throwOnTrimmedCteOnce = false;
          throw new Error('trimmed cte boom');
        }
        const turnArg = params?.[0];
        if (typeof turnArg === 'number') dbState.trimmedCteTurnArg = turnArg;
        return {
          rows: dbState.trimmedCteRows as unknown as T[],
          rowCount: dbState.trimmedCteRows.length,
        };
      }
      if (/FROM transitions/i.test(sql)) {
        dbState.transitionQueries += 1;
        return {
          rows: dbState.transitionRows as unknown as T[],
          rowCount: dbState.transitionRows.length,
        };
      }
      // TE-2 — snapshot query is the only `FROM runtime_fields f`
      // that returns the full surface (field_key, value_type, ...).
      if (
        /FROM runtime_fields f/i.test(sql) &&
        /field_key/i.test(sql) &&
        /value_type/i.test(sql)
      ) {
        dbState.snapshotQueries += 1;
        return {
          rows: dbState.fieldRows as unknown as T[],
          rowCount: dbState.fieldRows.length,
        };
      }
      // Pre-TE-2 readFieldValue SQL — should never run under TE-2.
      if (/FROM runtime_fields f/i.test(sql)) {
        dbState.legacyReadFieldValueQueries += 1;
        return {rows: [] as T[], rowCount: 0};
      }
      if (/FROM runtime_fields WHERE id/i.test(sql)) {
        dbState.legacyFieldMetaQueries += 1;
        return {rows: [] as T[], rowCount: 0};
      }
      if (/jsonb_to_recordset/i.test(sql)) {
        dbState.flushQueries += 1;
        const payloadArg = params?.[0];
        if (typeof payloadArg === 'string') {
          try {
            dbState.lastFlushPayload = JSON.parse(
              payloadArg,
            ) as FlushPayloadEntry[];
          } catch {
            /* leave null */
          }
        }
        if (dbState.flushThrowOnce) {
          dbState.flushThrowOnce = false;
          throw new Error('flush boom');
        }
        return {rows: [] as T[], rowCount: 1};
      }
      if (/INSERT INTO runtime_player_overlay/i.test(sql)) {
        dbState.legacyOverlayInserts += 1;
        return {rows: [] as T[], rowCount: 1};
      }
      if (/INSERT INTO runtime_values/i.test(sql)) {
        dbState.legacyGlobalInserts += 1;
        return {rows: [] as T[], rowCount: 1};
      }
      return {rows: [] as T[], rowCount: 0};
    },
  ),
}));

import {
  decrementConditions,
  decrementSurfaces,
  evaluateTransitions,
} from '../transitionEngine.js';

function pickEvents(name: string): Array<Record<string, unknown>> {
  return telemetryState.events.filter((e) => e.name === name);
}

function resetDbState(): void {
  dbState.transitionRows = [];
  dbState.fieldRows = [];
  dbState.transitionQueries = 0;
  dbState.snapshotQueries = 0;
  dbState.flushQueries = 0;
  dbState.legacyReadFieldValueQueries = 0;
  dbState.legacyFieldMetaQueries = 0;
  dbState.legacyOverlayInserts = 0;
  dbState.legacyGlobalInserts = 0;
  dbState.lastFlushPayload = null;
  dbState.flushThrowOnce = false;
  dbState.throwOnChatMessagesOnce = false;
  dbState.throwOnTrimmedCteOnce = false;
  dbState.trimmedCteRows = [];
  dbState.trimmedCteTurnArg = null;
  eventsState.emitFieldChangesByIdCalls.length = 0;
}

beforeEach(() => {
  telemetryState.events.length = 0;
  resetDbState();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ARCH-10 — transition_engine.iteration_cap_reached telemetry', () => {
  it('emits exactly one cap event when MAX_ITERATIONS is reached', async () => {
    // Two transitions that oscillate forever — pre-TE-2 the cap test
    // relied on a stale per-pass `readFieldValue` returning null; with
    // the in-memory snapshot a true infinite loop requires the
    // transitions themselves to keep flipping the field.
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'flip to a',
        priority: 10,
        when_json: [{field_id: 100, op: 'ne', value: 'a'}],
        set_json: [{field_id: 100, value: 'a'}],
      },
      {
        id: 2,
        description: 'flip to b',
        priority: 5,
        when_json: [{field_id: 100, op: 'eq', value: 'a'}],
        set_json: [{field_id: 100, value: 'b'}],
      },
    ];
    const result = await evaluateTransitions(42, 'sess-1');
    expect(result.capped).toBe(true);
    expect(result.iterations).toBe(50);
    const events = pickEvents('transition_engine.iteration_cap_reached');
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.channel).toBe('gameplay');
    expect(event.sessionId).toBe('sess-1');
    expect(event.playerId).toBe(42);
    expect(event.data).toEqual(
      expect.objectContaining({
        iterations: 50,
        max_iterations: 50,
        fired_count: result.fired.length,
      }),
    );
    const data = event.data as Record<string, unknown>;
    // Each pass walks T1 then T2 (priority DESC, id ASC). T2 is
    // the last to fire on the final pass, so it is the captured
    // `last_transition`.
    expect(data.last_transition).toEqual(
      expect.objectContaining({transition_id: 2, description: 'flip to b'}),
    );
  });

  it('emits no cap event when the fixpoint converges normally', async () => {
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'set once',
        priority: 0,
        when_json: [{field_id: 100, op: 'ne', value: 'fired-value'}],
        set_json: [{field_id: 100, value: 'fired-value'}],
      },
    ];
    const result = await evaluateTransitions(7);
    expect(result.capped).toBe(false);
    expect(result.iterations).toBeLessThan(50);
    expect(pickEvents('transition_engine.iteration_cap_reached')).toHaveLength(
      0,
    );
  });

  it('passes sessionId === null when invoked without a session', async () => {
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'flip to a',
        priority: 10,
        when_json: [{field_id: 100, op: 'ne', value: 'a'}],
        set_json: [{field_id: 100, value: 'a'}],
      },
      {
        id: 2,
        description: 'flip to b',
        priority: 5,
        when_json: [{field_id: 100, op: 'eq', value: 'a'}],
        set_json: [{field_id: 100, value: 'b'}],
      },
    ];
    const result = await evaluateTransitions(11);
    expect(result.capped).toBe(true);
    const events = pickEvents('transition_engine.iteration_cap_reached');
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe(null);
    expect(events[0]!.playerId).toBe(11);
  });
});

describe('TE-1 — transitions table is queried exactly once per evaluateTransitions()', () => {
  it('caches rows across MAX_ITERATIONS passes (no re-fetch inside the fixpoint)', async () => {
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'flip to a',
        priority: 10,
        when_json: [{field_id: 100, op: 'ne', value: 'a'}],
        set_json: [{field_id: 100, value: 'a'}],
      },
      {
        id: 2,
        description: 'flip to b',
        priority: 5,
        when_json: [{field_id: 100, op: 'eq', value: 'a'}],
        set_json: [{field_id: 100, value: 'b'}],
      },
    ];
    const result = await evaluateTransitions(42, 'sess-cache-1');
    expect(result.iterations).toBe(50);
    expect(dbState.transitionQueries).toBe(1);
  });

  it('still queries the table once when the fixpoint converges in one pass', async () => {
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'set once',
        priority: 0,
        when_json: [{field_id: 100, op: 'ne', value: 'fired-value'}],
        set_json: [{field_id: 100, value: 'fired-value'}],
      },
    ];
    const result = await evaluateTransitions(7, 'sess-cache-2');
    expect(result.capped).toBe(false);
    expect(result.iterations).toBeLessThan(50);
    expect(dbState.transitionQueries).toBe(1);
  });
});

describe('TE-2 — bounded snapshot + flush', () => {
  it('uses exactly one snapshot query and one flush query per dirty invocation', async () => {
    setField({field_id: 100});
    setField({field_id: 200});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'set X=5',
        priority: 10,
        when_json: [{field_id: 100, op: 'ne', value: 5}],
        set_json: [{field_id: 100, value: 5}],
      },
      {
        id: 2,
        description: 'when X=5 set Y=10',
        priority: 5,
        when_json: [{field_id: 100, op: 'eq', value: 5}],
        set_json: [{field_id: 200, value: 10}],
      },
    ];
    const result = await evaluateTransitions(42, 'sess-bounded');
    expect(result.capped).toBe(false);
    expect(result.fired.map((f) => f.transition_id)).toEqual([1, 2]);
    expect(dbState.transitionQueries).toBe(1);
    expect(dbState.snapshotQueries).toBe(1);
    expect(dbState.flushQueries).toBe(1);
    // Pre-TE-2 paths must never fire.
    expect(dbState.legacyReadFieldValueQueries).toBe(0);
    expect(dbState.legacyFieldMetaQueries).toBe(0);
    expect(dbState.legacyOverlayInserts).toBe(0);
    expect(dbState.legacyGlobalInserts).toBe(0);
  });

  it('skips the flush entirely when nothing was dirty', async () => {
    setField({field_id: 100, global_value: 'already-set'});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'idempotent',
        priority: 0,
        when_json: [{field_id: 100, op: 'eq', value: 'already-set'}],
        set_json: [{field_id: 100, value: 'already-set'}],
      },
    ];
    const result = await evaluateTransitions(8);
    expect(result.fired).toHaveLength(0);
    expect(dbState.snapshotQueries).toBe(1);
    expect(dbState.flushQueries).toBe(0);
  });

  it('caps query growth even when the fixpoint runs all 50 passes', async () => {
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'flip to a',
        priority: 10,
        when_json: [{field_id: 100, op: 'ne', value: 'a'}],
        set_json: [{field_id: 100, value: 'a'}],
      },
      {
        id: 2,
        description: 'flip to b',
        priority: 5,
        when_json: [{field_id: 100, op: 'eq', value: 'a'}],
        set_json: [{field_id: 100, value: 'b'}],
      },
    ];
    await evaluateTransitions(13, 'sess-bounded-cap');
    expect(dbState.transitionQueries).toBe(1);
    expect(dbState.snapshotQueries).toBe(1);
    // Only one flush even though 100 fired transitions oscillated
    // the same field 100 times in memory.
    expect(dbState.flushQueries).toBe(1);
    expect(dbState.legacyReadFieldValueQueries).toBe(0);
    expect(dbState.legacyOverlayInserts).toBe(0);
    expect(dbState.legacyGlobalInserts).toBe(0);
  });

  it('routes scoped vs global writes through one flush payload', async () => {
    // Two fields: one per-player overlay, one global. Both should
    // land in the same JSONB payload with `scope_per_player`
    // distinguishing the routes.
    setField({field_id: 100, scope_per_player: true});
    setField({field_id: 200, scope_per_player: false});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'set overlay X',
        priority: 10,
        when_json: [],
        set_json: [{field_id: 100, value: 'overlay-value'}],
      },
      {
        id: 2,
        description: 'set global Y',
        priority: 5,
        when_json: [],
        set_json: [{field_id: 200, value: 'global-value'}],
      },
    ];
    const result = await evaluateTransitions(99, 'sess-route');
    expect(result.capped).toBe(false);
    expect(result.fired.map((f) => f.transition_id)).toEqual([1, 2]);
    expect(dbState.flushQueries).toBe(1);
    expect(dbState.lastFlushPayload).not.toBeNull();
    const payload = dbState.lastFlushPayload!;
    const overlay = payload.find((p) => p.field_id === 100);
    const global = payload.find((p) => p.field_id === 200);
    expect(overlay).toEqual(
      expect.objectContaining({
        field_id: 100,
        value: 'overlay-value',
        source: 'transition:1',
        scope_per_player: true,
      }),
    );
    expect(global).toEqual(
      expect.objectContaining({
        field_id: 200,
        value: 'global-value',
        source: 'transition:2',
        scope_per_player: false,
      }),
    );
  });

  it('emits runtime:field SSE through emitFieldChangesById after a successful flush', async () => {
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'set X=fired',
        priority: 0,
        when_json: [{field_id: 100, op: 'ne', value: 'fired-value'}],
        set_json: [{field_id: 100, value: 'fired-value'}],
      },
    ];
    const result = await evaluateTransitions(42, 'sess-emit-success');
    expect(result.fired).toHaveLength(1);
    expect(dbState.flushQueries).toBe(1);
    expect(eventsState.emitFieldChangesByIdCalls).toHaveLength(1);
    expect(eventsState.emitFieldChangesByIdCalls[0]).toEqual(
      expect.objectContaining({
        sessionId: 'sess-emit-success',
        changes: expect.arrayContaining([
          expect.objectContaining({
            field_id: 100,
            value: 'fired-value',
            source: 'transition:1',
          }),
        ]),
      }),
    );
  });

  it('skips runtime:field SSE when the dirty flush throws (TE-2 follow-up)', async () => {
    // The transition dirties a field, the flush attempt is made
    // but the DB rejects it. The outer fixpoint catch logs the
    // failure; `emitFieldChangesById` must NOT fire — the UI must
    // never observe a value that was not persisted.
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'set X=fired',
        priority: 0,
        when_json: [{field_id: 100, op: 'ne', value: 'fired-value'}],
        set_json: [{field_id: 100, value: 'fired-value'}],
      },
    ];
    dbState.flushThrowOnce = true;
    const result = await evaluateTransitions(42, 'sess-flush-fail');
    // The transition did fire in-memory; the result reflects that.
    expect(result.fired).toHaveLength(1);
    // The flush was attempted exactly once before failing.
    expect(dbState.flushQueries).toBe(1);
    // No SSE may escape after a failed persist.
    expect(eventsState.emitFieldChangesByIdCalls).toHaveLength(0);
  });

  it('does not emit when no session id is supplied even on a successful flush', async () => {
    // Sanity: existing contract — without a sessionId there is
    // nowhere to deliver the SSE. Pre-existing behavior preserved.
    setField({field_id: 100});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'set X=fired',
        priority: 0,
        when_json: [{field_id: 100, op: 'ne', value: 'fired-value'}],
        set_json: [{field_id: 100, value: 'fired-value'}],
      },
    ];
    const result = await evaluateTransitions(42);
    expect(result.fired).toHaveLength(1);
    expect(dbState.flushQueries).toBe(1);
    expect(eventsState.emitFieldChangesByIdCalls).toHaveLength(0);
  });

  it('honors in-pass snapshot mutation: a later transition sees an earlier patch', async () => {
    // T1 (priority 10) sets X=5 in memory. T2 (priority 5)'s
    // predicate `X == 5` only matches if the in-memory snapshot has
    // been updated mid-pass. The fixpoint must therefore complete in
    // a single pass (with a converging pass 2).
    setField({field_id: 100});
    setField({field_id: 200});
    dbState.transitionRows = [
      {
        id: 1,
        description: 'set X=5',
        priority: 10,
        when_json: [{field_id: 100, op: 'ne', value: 5}],
        set_json: [{field_id: 100, value: 5}],
      },
      {
        id: 2,
        description: 'when X=5 set Y=10',
        priority: 5,
        when_json: [{field_id: 100, op: 'eq', value: 5}],
        set_json: [{field_id: 200, value: 10}],
      },
    ];
    const result = await evaluateTransitions(101);
    expect(result.fired.map((f) => f.transition_id)).toEqual([1, 2]);
    // Both fields recorded in the single flush payload.
    const payload = dbState.lastFlushPayload ?? [];
    expect(payload.map((p) => p.field_id).sort()).toEqual([100, 200]);
  });
});

describe('TE-3 — decrement decay swallow telemetry', () => {
  it('records transition_engine.decrement_surfaces_failed when the chat_messages turn lookup throws', async () => {
    dbState.throwOnChatMessagesOnce = true;
    await expect(decrementSurfaces('sess-surfaces-load')).resolves.toBeUndefined();
    const events = pickEvents('transition_engine.decrement_surfaces_failed');
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.channel).toBe('gameplay');
    expect(event.sessionId).toBe('sess-surfaces-load');
    expect((event.error as Error).message).toBe('chat_messages boom');
    expect(event.data).toEqual(
      expect.objectContaining({
        function: 'decrementSurfaces',
        stage: 'load_turn',
        // currentTurn is still null because the first query threw
        // before it could be assigned.
        current_turn: null,
      }),
    );
  });

  it('records transition_engine.decrement_surfaces_failed when the decay CTE throws', async () => {
    dbState.throwOnTrimmedCteOnce = true;
    await expect(decrementSurfaces('sess-surfaces-decay')).resolves.toBeUndefined();
    const events = pickEvents('transition_engine.decrement_surfaces_failed');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual(
      expect.objectContaining({
        function: 'decrementSurfaces',
        stage: 'apply_decay',
        // currentTurn populated by the successful first query.
        current_turn: 0,
      }),
    );
  });

  it('records transition_engine.decrement_conditions_failed when the decay CTE throws', async () => {
    dbState.throwOnTrimmedCteOnce = true;
    await expect(
      decrementConditions('sess-conditions-decay'),
    ).resolves.toBeUndefined();
    const events = pickEvents('transition_engine.decrement_conditions_failed');
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.sessionId).toBe('sess-conditions-decay');
    expect((event.error as Error).message).toBe('trimmed cte boom');
    expect(event.data).toEqual(
      expect.objectContaining({
        function: 'decrementConditions',
        stage: 'apply_decay',
        current_turn: 0,
      }),
    );
  });

  it('emits no failure telemetry when the decay succeeds', async () => {
    // Default mock state: chat_messages returns turn_no=0, the
    // trimmed CTE returns an empty change set. Both decay functions
    // should complete cleanly and never call telemetry.record.
    await decrementSurfaces('sess-ok-surfaces');
    await decrementConditions('sess-ok-conditions');
    expect(pickEvents('transition_engine.decrement_surfaces_failed')).toHaveLength(
      0,
    );
    expect(
      pickEvents('transition_engine.decrement_conditions_failed'),
    ).toHaveLength(0);
  });
});
