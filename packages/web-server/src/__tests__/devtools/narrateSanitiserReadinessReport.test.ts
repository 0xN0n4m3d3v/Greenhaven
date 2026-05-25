/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-2 Phase 3 readiness gate. The runtime narrate tool emits TWO
// observable events per call: `gameplay narrate.sanitiser.inspected`
// (every runtime narrate call, even clean output — the liveness
// signal) and `gameplay narrate.sanitiser.fired` (only when the
// sanitiser actually changed the text — the patterns-fired surface).
// Both are mirrored into `telemetry_events` by the gameplay sink. The
// regex deletion in `tools/narrate/sanitiser.ts` is gated on
// production telemetry proving:
//
//   1. `inspected_events > 0` — the sanitiser code path is
//      observably reachable in the queried window.
//   2. `phase3_total === 0` — zero firings of the four
//      Stanislavski/meta patterns (`analysis_heading`,
//      `stanislavski_label_bold`, `stanislavski_label_plain`,
//      `bracket_meta`).
//
// This file pins:
//
//   * `ready_for_phase3: true` only when (1) AND (2) hold. Note that
//     `total_events` (the fired count) can legitimately be zero on a
//     healthy sanitiser with clean traffic; the gate uses the
//     inspected count to avoid that ambiguity.
//   * `inspected_events === 0` → `ready_for_phase3: false` even when
//     `phase3_total === 0` (no observable liveness).
//   * Any nonzero Phase 3 firing → `ready_for_phase3: false`.
//   * `wrapper_unwrap`, `json_wrapper_unwrap`, `paragraph_dedup`
//     firings on their own do NOT authorize regex deletion — they
//     stay tracked but ignored by the gate.
//   * Sample rows carry the existing `original_prefix` cap (≤ 200
//     chars) verbatim; the report never widens the cap.

import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('../../db.js', () => {
  return {
    query: vi.fn(),
  };
});

import {query} from '../../db.js';
import {narrateSanitiserReadinessReport} from '../../devtools/telemetryDiagnostics.js';

const queryMock = vi.mocked(query);

interface Row {
  occurred_at: string;
  properties: Record<string, unknown>;
}

function rowsResult(rows: Row[]) {
  return {
    rows: rows.map((row, idx) => ({
      id: idx + 1,
      occurred_at: row.occurred_at,
      trace_id: null,
      span_id: null,
      session_id: null,
      player_id: null,
      turn_id: null,
      event_id: null,
      release_seq: null,
      schema_name: 'gameplay.narrate_sanitiser_fired',
      schema_version: 1,
      category: 'gameplay',
      event_name: 'narrate.sanitiser.fired',
      severity: 'info',
      properties: row.properties,
      redaction_tier: 'tier1_local_debug',
      validation_status: 'valid',
      source: 'narrate_tool',
    })),
    rowCount: rows.length,
  };
}

function countResult(count: number) {
  return {rows: [{count}], rowCount: 1};
}

function patternsRowsResult(patternLists: unknown[][]) {
  return {
    rows: patternLists.map(list => ({patterns_fired: list})),
    rowCount: patternLists.length,
  };
}

afterEach(() => {
  queryMock.mockReset();
});

// N-2 Phase 3 readiness — query order inside
// `narrateSanitiserReadinessReport`:
//   1. fired sample rows  (queryTelemetryEvents)
//   2. fired count         (SELECT COUNT(*) WHERE event_name = 'narrate.sanitiser.fired')
//   3. inspected count     (SELECT COUNT(*) WHERE event_name = 'narrate.sanitiser.inspected') [NEW]
//   4. fired patterns      (SELECT properties->'patterns_fired')
// Every test below must mock all four in the same order.

describe('narrateSanitiserReadinessReport — Phase 3 gate', () => {
  it('reports ready_for_phase3: true only when inspected events exist and zero Phase 3 patterns fired', async () => {
    const sampleRows: Row[] = [
      {
        occurred_at: '2026-05-17T03:00:00.000Z',
        properties: {
          source: 'narrate_tool',
          patterns_fired: ['paragraph_dedup'],
          original_length: 320,
          sanitised_length: 280,
          original_prefix: 'NPC greets the hero. NPC greets the hero.',
        },
      },
      {
        occurred_at: '2026-05-17T02:30:00.000Z',
        properties: {
          source: 'narrate_tool',
          patterns_fired: ['wrapper_unwrap', 'paragraph_dedup'],
          original_length: 410,
          sanitised_length: 390,
          original_prefix: '{"text":"Mikka grins."}\n\nMikka grins.',
        },
      },
    ];
    queryMock
      .mockResolvedValueOnce(rowsResult(sampleRows))
      .mockResolvedValueOnce(countResult(2))
      // Inspected events ≥ fired events: every changed-text fired
      // turn was also inspected, plus a few clean turns produced
      // inspected-only rows.
      .mockResolvedValueOnce(countResult(7))
      .mockResolvedValueOnce(
        patternsRowsResult([
          ['paragraph_dedup'],
          ['wrapper_unwrap', 'paragraph_dedup'],
        ]),
      );

    const result = await narrateSanitiserReadinessReport({
      since: '2026-05-16T03:00:00.000Z',
      limit: 50,
    });

    expect(result.since).toBe('2026-05-16T03:00:00.000Z');
    expect(result.total_events).toBe(2);
    expect(result.inspected_events).toBe(7);
    expect(result.patterns_fired).toEqual({
      wrapper_unwrap: 1,
      paragraph_dedup: 2,
    });
    expect(result.phase3_blockers).toEqual({
      analysis_heading: 0,
      stanislavski_label_bold: 0,
      stanislavski_label_plain: 0,
      bracket_meta: 0,
    });
    expect(result.phase3_total).toBe(0);
    expect(result.ready_for_phase3).toBe(true);
    expect(result.sample).toHaveLength(2);
    expect(result.sample[0]?.patterns_fired).toEqual(['paragraph_dedup']);
    expect(result.sample[0]?.original_prefix).toBe(
      'NPC greets the hero. NPC greets the hero.',
    );
    expect(result.error).toBeUndefined();
  });

  it('reports ready_for_phase3: true when inspected > 0 even with zero fired events (clean window)', async () => {
    // Liveness signal: the runtime sanitizer ran on every narrate
    // call in the window but the model never emitted anything the
    // regexes needed to touch. The gate must open: zero fired AND
    // zero Phase 3 firings AND non-zero inspected is the precise
    // post-prompt-fix steady state.
    queryMock
      .mockResolvedValueOnce(rowsResult([]))
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(countResult(42))
      .mockResolvedValueOnce(patternsRowsResult([]));

    const result = await narrateSanitiserReadinessReport({
      since: '2026-05-16T03:00:00.000Z',
    });

    expect(result.total_events).toBe(0);
    expect(result.inspected_events).toBe(42);
    expect(result.phase3_total).toBe(0);
    expect(result.ready_for_phase3).toBe(true);
  });

  it('keeps ready_for_phase3: false when inspected_events = 0 even if fired = 0 too (no observable liveness)', async () => {
    queryMock
      .mockResolvedValueOnce(rowsResult([]))
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(patternsRowsResult([]));

    const result = await narrateSanitiserReadinessReport({
      since: '2026-05-16T03:00:00.000Z',
    });

    expect(result.total_events).toBe(0);
    expect(result.inspected_events).toBe(0);
    expect(result.phase3_total).toBe(0);
    expect(result.ready_for_phase3).toBe(false);
  });

  it('keeps ready_for_phase3: false when even one Phase 3 pattern fires', async () => {
    const sampleRows: Row[] = [
      {
        occurred_at: '2026-05-17T03:00:00.000Z',
        properties: {
          source: 'narrate_tool',
          patterns_fired: ['analysis_heading', 'paragraph_dedup'],
          original_length: 280,
          sanitised_length: 200,
          original_prefix: '# Stanislavski Internal Analysis\n\nNPC speaks.',
        },
      },
    ];
    queryMock
      .mockResolvedValueOnce(rowsResult(sampleRows))
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(countResult(5))
      .mockResolvedValueOnce(
        patternsRowsResult([['analysis_heading', 'paragraph_dedup']]),
      );

    const result = await narrateSanitiserReadinessReport({
      since: '2026-05-16T03:00:00.000Z',
    });

    expect(result.total_events).toBe(1);
    expect(result.inspected_events).toBe(5);
    expect(result.patterns_fired).toEqual({
      analysis_heading: 1,
      paragraph_dedup: 1,
    });
    expect(result.phase3_blockers.analysis_heading).toBe(1);
    expect(result.phase3_total).toBe(1);
    expect(result.ready_for_phase3).toBe(false);
  });

  it('keeps ready_for_phase3: false when any of the four Phase 3 patterns fire (matrix)', async () => {
    const phase3Patterns = [
      'analysis_heading',
      'stanislavski_label_bold',
      'stanislavski_label_plain',
      'bracket_meta',
    ];
    for (const pattern of phase3Patterns) {
      queryMock
        .mockResolvedValueOnce(
          rowsResult([
            {
              occurred_at: '2026-05-17T03:00:00.000Z',
              properties: {
                source: 'narrate_tool',
                patterns_fired: [pattern],
                original_length: 100,
                sanitised_length: 50,
                original_prefix: 'sample',
              },
            },
          ]),
        )
        .mockResolvedValueOnce(countResult(1))
        .mockResolvedValueOnce(countResult(3))
        .mockResolvedValueOnce(patternsRowsResult([[pattern]]));

      const result = await narrateSanitiserReadinessReport({
        since: '2026-05-16T03:00:00.000Z',
      });
      expect(result.ready_for_phase3, `pattern=${pattern}`).toBe(false);
      expect(result.phase3_total).toBe(1);
    }
  });

  it('treats wrapper_unwrap / json_wrapper_unwrap / paragraph_dedup as tracked but non-blocking', async () => {
    const harmlessPatterns = [
      ['wrapper_unwrap'],
      ['json_wrapper_unwrap'],
      ['paragraph_dedup'],
      ['wrapper_unwrap', 'paragraph_dedup'],
      ['json_wrapper_unwrap', 'paragraph_dedup'],
    ];
    queryMock
      .mockResolvedValueOnce(
        rowsResult(
          harmlessPatterns.map((patterns, idx) => ({
            occurred_at: `2026-05-17T0${idx}:00:00.000Z`,
            properties: {
              source: 'narrate_tool',
              patterns_fired: patterns,
              original_length: 100,
              sanitised_length: 80,
              original_prefix: `sample-${idx}`,
            },
          })),
        ),
      )
      .mockResolvedValueOnce(countResult(harmlessPatterns.length))
      .mockResolvedValueOnce(countResult(harmlessPatterns.length + 10))
      .mockResolvedValueOnce(patternsRowsResult(harmlessPatterns));

    const result = await narrateSanitiserReadinessReport({
      since: '2026-05-16T03:00:00.000Z',
    });

    expect(result.total_events).toBe(5);
    expect(result.inspected_events).toBe(15);
    expect(result.patterns_fired).toEqual({
      wrapper_unwrap: 2,
      json_wrapper_unwrap: 2,
      paragraph_dedup: 3,
    });
    expect(result.phase3_total).toBe(0);
    expect(result.ready_for_phase3).toBe(true);
  });

  it('returns ready_for_phase3: false with an error field when the telemetry table is missing', async () => {
    queryMock.mockRejectedValueOnce(
      new Error('relation "telemetry_events" does not exist'),
    );

    const result = await narrateSanitiserReadinessReport({
      since: '2026-05-16T03:00:00.000Z',
    });

    expect(result.ready_for_phase3).toBe(false);
    expect(result.total_events).toBe(0);
    expect(result.inspected_events).toBe(0);
    expect(result.phase3_total).toBe(0);
    expect(result.error).toContain('telemetry_events');
  });

  it('preserves the existing 200-char original_prefix cap and never widens it', async () => {
    const cappedPrefix = 'a'.repeat(200);
    queryMock
      .mockResolvedValueOnce(
        rowsResult([
          {
            occurred_at: '2026-05-17T03:00:00.000Z',
            properties: {
              source: 'narrate_tool',
              patterns_fired: ['paragraph_dedup'],
              original_length: 1000,
              sanitised_length: 800,
              original_prefix: cappedPrefix,
            },
          },
        ]),
      )
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(patternsRowsResult([['paragraph_dedup']]));

    const result = await narrateSanitiserReadinessReport({
      since: '2026-05-16T03:00:00.000Z',
      limit: 1,
    });

    expect(result.sample).toHaveLength(1);
    expect(result.sample[0]?.original_prefix.length).toBeLessThanOrEqual(200);
    expect(result.sample[0]?.original_prefix).toBe(cappedPrefix);
  });

  it('tolerates malformed properties (missing patterns_fired, non-array, non-string entries)', async () => {
    queryMock
      .mockResolvedValueOnce(
        rowsResult([
          {
            occurred_at: '2026-05-17T03:00:00.000Z',
            properties: {source: 'narrate_tool', original_prefix: 'no patterns'},
          },
          {
            occurred_at: '2026-05-17T02:00:00.000Z',
            properties: {
              source: 'narrate_tool',
              patterns_fired: 'not-an-array',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(countResult(2))
      .mockResolvedValueOnce(countResult(4))
      .mockResolvedValueOnce(
        patternsRowsResult([
          [null, 42, 'paragraph_dedup'],
          undefined as unknown as unknown[],
        ]),
      );

    const result = await narrateSanitiserReadinessReport({
      since: '2026-05-16T03:00:00.000Z',
    });

    expect(result.total_events).toBe(2);
    expect(result.patterns_fired).toEqual({paragraph_dedup: 1});
    expect(result.phase3_total).toBe(0);
    expect(result.ready_for_phase3).toBe(true);
    expect(result.sample[0]?.patterns_fired).toEqual([]);
    expect(result.sample[1]?.patterns_fired).toEqual([]);
  });
});
