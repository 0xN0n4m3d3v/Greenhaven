/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-2 Phase 3 readiness gate — verify the storage path, not just the
// caller-side channel routing.
//
// The repaired gate counts `narrate.sanitiser.inspected` rows in
// `telemetry_events` as the liveness signal. That count only works if
// the default gameplay sink in `Telemetry.ts` actually invokes
// `recordTelemetryEvent` for the two sanitizer event names while
// still appending JSONL via `appendGameplayLog`. The
// captured-sinks tests in `telemetryFacade.test.ts` only prove the
// channel router calls SOME `gameplay` sink — they substitute a fake
// sink and never exercise the production `defaultTelemetrySinks()`
// implementation.
//
// This sibling file mocks `gameplayLog.ts` and `telemetryLake.ts`
// before importing the facade so the real default sinks call the
// mocks and we can assert on the exact shape (schema id, category,
// source, redaction tier, properties, presence/absence of
// `original_prefix`).
//
// Other gameplay events (e.g. `turn.output`) keep their
// JSONL-only retention; the mirror is restricted to the documented
// `GAMEPLAY_LAKE_MIRROR_EVENTS` whitelist.

import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

type GameplayLogArg = Parameters<
  typeof import('../../gameplayLog.js').appendGameplayLog
>[0];
type TelemetryLakeArg = Parameters<
  typeof import('../../telemetryLake.js').tryRecordTelemetryEvent
>[0];

const gameplayMock = vi.hoisted(() => ({
  appendGameplayLog: vi.fn<(arg: unknown) => Promise<void>>(async () => {}),
}));
// `tryRecordTelemetryEvent` is the resultful sibling the gameplay-mirror
// branch now uses so it can log per-event success/failure breadcrumbs.
// `recordTelemetryEvent` keeps a `void` signature for frontend/desktop
// sinks; both are exercised by these tests.
const lakeMock = vi.hoisted(() => ({
  tryRecordTelemetryEvent: vi.fn<
    (arg: unknown) => Promise<{ok: true} | {ok: false; error: string}>
  >(async () => ({ok: true})),
  recordTelemetryEvent: vi.fn<(arg: unknown) => Promise<void>>(async () => {}),
}));

vi.mock('../../gameplayLog.js', () => gameplayMock);
vi.mock('../../telemetryLake.js', () => lakeMock);
// Telemetry.ts also imports `performanceTelemetry` / `turnTelemetry`;
// stub them so the import graph resolves without touching the real
// DB-bound writers.
vi.mock('../../performanceTelemetry.js', () => ({
  recordPerformanceEvent: vi.fn<(arg: unknown) => Promise<void>>(async () => {}),
}));
vi.mock('../../turnTelemetry.js', () => ({
  recordTurnTelemetry: vi.fn<(arg: unknown) => Promise<void>>(async () => {}),
}));

let createTelemetry: typeof import('../../telemetry/Telemetry.js').createTelemetry;
let defaultTelemetrySinks: typeof import('../../telemetry/Telemetry.js').defaultTelemetrySinks;

beforeAll(async () => {
  ({createTelemetry, defaultTelemetrySinks} = await import(
    '../../telemetry/Telemetry.js'
  ));
});

afterEach(() => {
  gameplayMock.appendGameplayLog.mockClear();
  lakeMock.tryRecordTelemetryEvent.mockClear();
  lakeMock.recordTelemetryEvent.mockClear();
});

describe('defaultTelemetrySinks().gameplay — N-2 Phase 3 mirror', () => {
  it('appends narrate.sanitiser.inspected to JSONL AND mirrors it into telemetry_events with strict metadata only', async () => {
    const telemetry = createTelemetry(defaultTelemetrySinks());
    telemetry.record({
      channel: 'gameplay',
      name: 'narrate.sanitiser.inspected',
      sessionId: 'sess-1',
      playerId: 42,
      turnId: 'turn-9',
      traceId: 'trace-9',
      data: {
        source: 'narrate_tool',
        changed: false,
        pattern_count: 0,
        phase3_pattern_count: 0,
        original_length: 142,
        sanitised_length: 142,
      },
    });
    await telemetry.flush();

    // JSONL append always runs first.
    expect(gameplayMock.appendGameplayLog).toHaveBeenCalledTimes(1);
    const jsonlArg = gameplayMock.appendGameplayLog.mock.calls[0]![0] as GameplayLogArg;
    expect(jsonlArg).toMatchObject({
      type: 'narrate.sanitiser.inspected',
      sessionId: 'sess-1',
      playerId: 42,
      turnId: 'turn-9',
      traceId: 'trace-9',
    });

    // Mirror into `telemetry_events`.
    expect(lakeMock.tryRecordTelemetryEvent).toHaveBeenCalledTimes(1);
    const lakeArg = lakeMock.tryRecordTelemetryEvent.mock.calls[0]![0] as TelemetryLakeArg;
    expect(lakeArg).toMatchObject({
      sessionId: 'sess-1',
      playerId: 42,
      turnId: 'turn-9',
      traceId: 'trace-9',
      schemaName: 'gameplay.narrate_sanitiser_inspected',
      schemaVersion: 1,
      category: 'gameplay',
      eventName: 'narrate.sanitiser.inspected',
      severity: 'info',
      redactionTier: 'tier1_local_debug',
      validationStatus: 'valid',
      source: 'narrate_tool',
    });
    // Inspected payload MUST NOT carry `original_prefix` — that is
    // exclusively a `fired` field.
    expect(lakeArg.properties).not.toHaveProperty('original_prefix');
    expect(lakeArg.properties).toEqual({
      source: 'narrate_tool',
      changed: false,
      pattern_count: 0,
      phase3_pattern_count: 0,
      original_length: 142,
      sanitised_length: 142,
    });
  });

  it('mirrors narrate.sanitiser.fired with schema gameplay.narrate_sanitiser_fired and preserves the existing payload (patterns_fired + 200-char prefix)', async () => {
    const telemetry = createTelemetry(defaultTelemetrySinks());
    const firedData = {
      source: 'narrate_tool',
      patterns_fired: ['analysis_heading', 'paragraph_dedup'],
      original_length: 320,
      sanitised_length: 240,
      original_prefix: '# Stanislavski Internal Analysis\n\nMikka grins.'.slice(
        0,
        200,
      ),
    };
    telemetry.record({
      channel: 'gameplay',
      name: 'narrate.sanitiser.fired',
      sessionId: 'sess-2',
      playerId: 7,
      turnId: 'turn-2',
      data: firedData,
    });
    await telemetry.flush();

    expect(gameplayMock.appendGameplayLog).toHaveBeenCalledTimes(1);
    expect(gameplayMock.appendGameplayLog.mock.calls[0]![0] as GameplayLogArg).toMatchObject({
      type: 'narrate.sanitiser.fired',
    });

    expect(lakeMock.tryRecordTelemetryEvent).toHaveBeenCalledTimes(1);
    const lakeArg = lakeMock.tryRecordTelemetryEvent.mock.calls[0]![0] as TelemetryLakeArg;
    expect(lakeArg.schemaName).toBe('gameplay.narrate_sanitiser_fired');
    expect(lakeArg.eventName).toBe('narrate.sanitiser.fired');
    expect(lakeArg.category).toBe('gameplay');
    expect(lakeArg.source).toBe('narrate_tool');
    expect(lakeArg.redactionTier).toBe('tier1_local_debug');
    // The fired payload keeps `original_prefix` + `patterns_fired`.
    const firedProps = lakeArg.properties as typeof firedData;
    expect(firedProps).toEqual(firedData);
    expect(firedProps.original_prefix.length).toBeLessThanOrEqual(200);
  });

  it('appends an unrelated gameplay event (turn.output) to JSONL but does NOT mirror it into telemetry_events', async () => {
    const telemetry = createTelemetry(defaultTelemetrySinks());
    telemetry.record({
      channel: 'gameplay',
      name: 'turn.output',
      sessionId: 'sess-3',
      playerId: 1,
      turnId: 'turn-3',
      data: {message_id: 99, tone: 'narrator'},
    });
    await telemetry.flush();

    expect(gameplayMock.appendGameplayLog).toHaveBeenCalledTimes(1);
    expect(lakeMock.tryRecordTelemetryEvent).not.toHaveBeenCalled();
  });

  it('whitelists only the two sanitizer event names — other narrate-prefixed events are JSONL-only', async () => {
    const telemetry = createTelemetry(defaultTelemetrySinks());
    // A plausible future gameplay event under the `narrate.*`
    // namespace that should NOT be mirrored unless the whitelist is
    // intentionally extended.
    telemetry.record({
      channel: 'gameplay',
      name: 'narrate.dispatch.queued',
      sessionId: 'sess-4',
      data: {queue_index: 1},
    });
    await telemetry.flush();
    expect(gameplayMock.appendGameplayLog).toHaveBeenCalledTimes(1);
    expect(lakeMock.tryRecordTelemetryEvent).not.toHaveBeenCalled();
  });

  it('continues to write JSONL when the telemetry-lake mirror reports a failure result (one sanitizer event flows through both sinks independently)', async () => {
    lakeMock.tryRecordTelemetryEvent.mockImplementationOnce(async () => ({
      ok: false,
      error: 'lake write failed',
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const telemetry = createTelemetry(defaultTelemetrySinks());
    expect(() =>
      telemetry.record({
        channel: 'gameplay',
        name: 'narrate.sanitiser.inspected',
        sessionId: 'sess-5',
        data: {
          source: 'narrate_tool',
          changed: false,
          pattern_count: 0,
          phase3_pattern_count: 0,
          original_length: 10,
          sanitised_length: 10,
        },
      }),
    ).not.toThrow();
    await telemetry.flush();
    // JSONL was appended; the resultful mirror returned `{ok:false}`;
    // the facade does NOT crash the caller.
    expect(gameplayMock.appendGameplayLog).toHaveBeenCalledTimes(1);
    expect(lakeMock.tryRecordTelemetryEvent).toHaveBeenCalledTimes(1);
    // A `lake_failed` diagnostic must have been logged with the error
    // message attached (metadata-only — no prose).
    const failedCall = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('[telemetry-mirror] lake_failed'),
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![1]).toMatchObject({
      name: 'narrate.sanitiser.inspected',
      sessionId: 'sess-5',
      schemaName: 'gameplay.narrate_sanitiser_inspected',
      error: 'lake write failed',
    });
    // The failed-mirror diagnostic must NEVER carry prose / payload.
    expect(failedCall![1]).not.toHaveProperty('properties');
    expect(failedCall![1]).not.toHaveProperty('original_prefix');
    warnSpy.mockRestore();
  });

  it('emits structured success breadcrumbs (event_emitted → jsonl_attempted/succeeded → lake_attempted/succeeded) for a whitelisted event', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const telemetry = createTelemetry(defaultTelemetrySinks());
    telemetry.record({
      channel: 'gameplay',
      name: 'narrate.sanitiser.inspected',
      sessionId: 'sess-6',
      playerId: 11,
      turnId: 'turn-6',
      data: {
        source: 'narrate_tool',
        changed: false,
        pattern_count: 0,
        phase3_pattern_count: 0,
        original_length: 12,
        sanitised_length: 12,
      },
    });
    await telemetry.flush();
    const stages = logSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (s): s is string =>
          typeof s === 'string' && s.startsWith('[telemetry-mirror] '),
      )
      .map((s) => s.replace('[telemetry-mirror] ', ''));
    expect(stages).toEqual([
      'event_emitted',
      'jsonl_attempted',
      'jsonl_succeeded',
      'lake_attempted',
      'lake_succeeded',
    ]);
    // Each diagnostic line carries metadata only (event name + ids +
    // whitelisted flag; schemaName once mirror is attempted).
    for (const call of logSpy.mock.calls) {
      if (
        typeof call[0] === 'string' &&
        call[0].startsWith('[telemetry-mirror] ')
      ) {
        const meta = call[1] as Record<string, unknown>;
        expect(meta).not.toHaveProperty('data');
        expect(meta).not.toHaveProperty('properties');
        expect(meta).not.toHaveProperty('original_prefix');
      }
    }
    logSpy.mockRestore();
  });

  it('does not emit mirror breadcrumbs for non-whitelisted gameplay events', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const telemetry = createTelemetry(defaultTelemetrySinks());
    telemetry.record({
      channel: 'gameplay',
      name: 'turn.output',
      sessionId: 'sess-7',
      playerId: 12,
      turnId: 'turn-7',
      data: {message_id: 1, tone: 'narrator'},
    });
    await telemetry.flush();
    const mirrorCalls = logSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].startsWith('[telemetry-mirror]'),
    );
    expect(mirrorCalls).toEqual([]);
    logSpy.mockRestore();
  });
});
