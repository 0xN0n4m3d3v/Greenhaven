/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-2 Phase 3 mirror — one shared emitter for the narrate-sanitiser
// telemetry pair (`narrate.sanitiser.inspected` + `narrate.sanitiser.fired`).
// Two runtime call sites must produce identical event shapes so the
// readiness gate cannot drift between them:
//
//   * `tools/narrate/register.ts` — the direct narrate tool, used when
//     the broker calls `narrate({...})` and the result reaches the
//     player via the standard execute() pipeline.
//   * `narrationSynthesis.ts` — the synth-v2 fast path used when the
//     broker hands off narration via the narrate-handoff fast path or
//     when an empty/fallback synth turn fires. Live desktop traffic
//     today almost always lands here, NOT through `register.ts`, which
//     was the missing wiring that left the readiness gate stuck at
//     `inspected_events: 0` even after representative narrate traffic.
//
// Both sites pass the report from `sanitiseNarrateTextWithReport(...)`.
// Non-runtime callers of `sanitiseNarrateText(...)` (dialogue context
// builders, supportSmoke fixtures) stay telemetry-silent — they don't
// produce visible-prose runtime output and must not pollute the gate.

import {telemetry} from '../../telemetry/index.js';
import type {NarrateSanitiserReport} from './sanitiser.js';

export type NarrateSanitiserTelemetrySource =
  | 'narrate_tool'
  | 'narrate_synthesis';

export interface NarrateSanitiserTelemetryContext {
  sessionId: string;
  playerId: number | null;
  turnId: string | null;
  /** Synthesis-only — propagates the `SynthesiseNarrateSource` (e.g.
   *  `'broker_narrate_fast_path'`) so post-hoc audits can correlate
   *  inspected/fired counts with the specific synth-v2 origin. */
  synthSource?: string | null;
}

/**
 * Historical N-2 Phase 3 blocker pattern ids. These four ids used to
 * be live `SanitiserPatternId` values emitted by the runtime
 * sanitizer; the regex pipeline that produced them was deleted in
 * Phase 3 (2026-05-17) once the prompt-side leak guard plus
 * inspected/fired telemetry took over as the control layer. The
 * counter remains as a historical artifact label so audit code that
 * scans stored telemetry rows (`devtools/telemetryDiagnostics.ts`,
 * `narrateSanitiserReadinessReport`) can still bucket pre-deletion
 * firings; current sanitizer reports will never contain these.
 */
const N2_PHASE3_HISTORICAL_PATTERN_IDS: readonly string[] = [
  'analysis_heading',
  'stanislavski_label_bold',
  'stanislavski_label_plain',
  'bracket_meta',
];

/**
 * Count occurrences of the four historical Phase 3 pattern ids in a
 * sanitizer report's `patternsFired` list. Runtime reports produced
 * post-Phase-3 deletion always return 0; the helper is kept for
 * backfill replay paths that consume historical telemetry shapes.
 * Accepts `readonly string[]` rather than `readonly SanitiserPatternId[]`
 * so callers replaying historical telemetry rows compile cleanly.
 */
export function countPhase3Patterns(
  patternsFired: readonly string[],
): number {
  let hits = 0;
  for (const id of patternsFired) {
    if (N2_PHASE3_HISTORICAL_PATTERN_IDS.includes(id)) hits++;
  }
  return hits;
}

/**
 * Emit the N-2 readiness pair from one sanitization report.
 *
 * - `narrate.sanitiser.inspected` fires unconditionally — it is the
 *   liveness signal for the readiness gate.
 *   Payload: metadata-only. Never include prose or `original_prefix`.
 * - `narrate.sanitiser.fired` fires only when the sanitizer changed
 *   text. Payload keeps `patterns_fired` and the capped
 *   `original_prefix` (≤ 200 chars) for blocker analysis.
 *
 * Both events flow through `telemetry.record({channel:'gameplay',
 * ...})` so the gameplay sink's `GAMEPLAY_LAKE_MIRROR_EVENTS`
 * whitelist mirrors them into `telemetry_events`.
 */
export function recordNarrateSanitiserTelemetry(opts: {
  ctx: NarrateSanitiserTelemetryContext;
  report: NarrateSanitiserReport;
  source: NarrateSanitiserTelemetrySource;
}): void {
  const {ctx, report, source} = opts;
  const phase3PatternCount = countPhase3Patterns(report.patternsFired);
  const inspectedData: Record<string, unknown> = {
    source,
    changed: report.changed,
    pattern_count: report.patternsFired.length,
    phase3_pattern_count: phase3PatternCount,
    original_length: report.originalLength,
    sanitised_length: report.sanitisedLength,
  };
  if (ctx.synthSource != null) inspectedData['synth_source'] = ctx.synthSource;
  telemetry.record({
    channel: 'gameplay',
    name: 'narrate.sanitiser.inspected',
    sessionId: ctx.sessionId,
    playerId: ctx.playerId,
    turnId: ctx.turnId,
    data: inspectedData,
  });
  if (report.changed) {
    const firedData: Record<string, unknown> = {
      source,
      patterns_fired: report.patternsFired,
      original_length: report.originalLength,
      sanitised_length: report.sanitisedLength,
      original_prefix: report.originalPrefix,
    };
    if (ctx.synthSource != null) firedData['synth_source'] = ctx.synthSource;
    telemetry.record({
      channel: 'gameplay',
      name: 'narrate.sanitiser.fired',
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      data: firedData,
    });
  }
}
