/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-2 Phase 1 — `sanitiseNarrateTextWithReport` reports each
// sanitizer pattern that fires plus length/prefix metadata.
//
// N-2 Phase 3 (2026-05-17, operator override) — the runtime meta-section
// scrubbers (`analysis_heading`, `stanislavski_label_bold`,
// `stanislavski_label_plain`, `bracket_meta`) have been deleted from
// the runtime sanitizer. The prompt-side leak guard (Phase 2) and the
// inspected/fired telemetry pair are now the control layer. These
// tests pin the live sanitizer behaviour to the surviving steps —
// wrapper unwrap, capped JSON wrapper unwrap, paragraph dedup — and
// keep the shared telemetry emitter coverage.
//
// Two runtime emitters share the same telemetry helper so the event
// shape cannot drift: `tools/narrate/register.ts` (direct narrate
// tool) and `narrationSynthesis.ts:synthesiseNarrate` (broker
// fast-path + empty fallbacks). Non-runtime callers
// (`turnContext/dialogueContext.ts`, `devtools/supportSmoke.ts`,
// dialogue-history fixtures) keep using the plain `sanitiseNarrateText`
// wrapper and stay telemetry-silent so they don't pollute the
// readiness gate.

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  sanitiseNarrateText,
  sanitiseNarrateTextWithReport,
} from '../../tools/narrate/sanitiser.js';
import {
  countPhase3Patterns,
  recordNarrateSanitiserTelemetry,
} from '../../tools/narrate/sanitiserTelemetry.js';
import {telemetry} from '../../telemetry/index.js';
import type {
  GameplayTelemetryEvent,
  TelemetryEvent,
} from '../../telemetry/channels.js';

describe('sanitiseNarrateTextWithReport — surviving Phase 3 pipeline', () => {
  it('reports no patterns and changed=false for clean prose', () => {
    const input = 'A clean paragraph.\n\nAnother one without any directives.';
    const report = sanitiseNarrateTextWithReport(input);
    expect(report.changed).toBe(false);
    expect(report.patternsFired).toEqual([]);
    expect(report.text).toBe(input);
    expect(report.originalLength).toBe(input.length);
    expect(report.sanitisedLength).toBe(report.text.length);
    expect(report.originalPrefix.length).toBeLessThanOrEqual(200);
  });

  it('flags wrapper_unwrap for a pure JSON narrate dump', () => {
    const input = '{"text":"hello world"}';
    const report = sanitiseNarrateTextWithReport(input);
    expect(report.text).toBe('hello world');
    expect(report.patternsFired).toContain('wrapper_unwrap');
  });

  it('flags paragraph_dedup when consecutive identical paragraphs collapse', () => {
    const input = 'Mikka grins.\n\nMikka grins.\n\nA third paragraph.';
    const report = sanitiseNarrateTextWithReport(input);
    expect(report.patternsFired).toContain('paragraph_dedup');
    expect(report.text).toBe('Mikka grins.\n\nA third paragraph.');
  });

  it('caps original_prefix at 200 characters', () => {
    const long = 'a'.repeat(500);
    const report = sanitiseNarrateTextWithReport(long);
    expect(report.originalPrefix.length).toBe(200);
    // Prose with no recognised pattern stays unchanged.
    expect(report.changed).toBe(false);
    expect(report.patternsFired).toEqual([]);
  });

  it('no longer scrubs meta-section labels — that is now the prompt contract', () => {
    // Phase 3 deletion: the runtime regex pipeline that used to strip
    // analysis headings, Subtext/Beat/etc. labels, and `[OOC]` tags is
    // gone. The prompt-side leak guard plus the
    // `narrate.sanitiser.inspected` / `narrate.sanitiser.fired`
    // telemetry pair are now the control layer. Verify the sanitizer
    // leaves these strings in place verbatim.
    const headingInput = '# Heading line\n\nA prose paragraph.';
    const headingReport = sanitiseNarrateTextWithReport(headingInput);
    expect(headingReport.text).toBe(headingInput);
    expect(headingReport.changed).toBe(false);

    const boldLabelInput = '**Subtext**: hidden grief.\n\nMikka grins.';
    const boldReport = sanitiseNarrateTextWithReport(boldLabelInput);
    expect(boldReport.text).toBe(boldLabelInput);
    expect(boldReport.changed).toBe(false);

    const plainLabelInput = 'Beat: a quiet exchange.\n\nMikka grins.';
    const plainReport = sanitiseNarrateTextWithReport(plainLabelInput);
    expect(plainReport.text).toBe(plainLabelInput);
    expect(plainReport.changed).toBe(false);

    const bracketInput = '[OOC: aside]\nThe NPC speaks.';
    const bracketReport = sanitiseNarrateTextWithReport(bracketInput);
    expect(bracketReport.text).toBe(bracketInput);
    expect(bracketReport.changed).toBe(false);
  });
});

describe('sanitiseNarrateText — wrapper ABI', () => {
  it('returns just the cleaned text so non-runtime callers stay byte-for-byte identical', () => {
    const input = '{"text":"NPC speaks."}';
    expect(sanitiseNarrateText(input)).toBe('NPC speaks.');
    // No throwing, no telemetry side effects observable from this
    // call site — non-runtime callers (`turnContext/dialogueContext.ts`,
    // `devtools/supportSmoke.ts`) consume the wrapper specifically
    // so they don't pollute the N-2 readiness gate. Runtime
    // visible-prose callers (`register.ts`, `synthesiseNarrate`)
    // use the report wrapper plus `recordNarrateSanitiserTelemetry`
    // below.
  });
});

describe('recordNarrateSanitiserTelemetry — N-2 Phase 3 shared emitter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('emits exactly `narrate.sanitiser.inspected` for a clean report (no fired event, metadata-only payload)', () => {
    const captured: GameplayTelemetryEvent[] = [];
    const spy = vi
      .spyOn(telemetry, 'record')
      .mockImplementation((event: TelemetryEvent) => {
        captured.push(event as GameplayTelemetryEvent);
      });
    const report = sanitiseNarrateTextWithReport(
      'A clean paragraph.\n\nAnother one.',
    );
    expect(report.changed).toBe(false);
    recordNarrateSanitiserTelemetry({
      ctx: {sessionId: 'sess-a', playerId: 11, turnId: 'turn-a'},
      report,
      source: 'narrate_tool',
    });
    expect(captured).toHaveLength(1);
    const inspected = captured[0]!;
    expect(inspected.channel).toBe('gameplay');
    expect(inspected.name).toBe('narrate.sanitiser.inspected');
    expect(inspected.sessionId).toBe('sess-a');
    expect(inspected.playerId).toBe(11);
    expect(inspected.turnId).toBe('turn-a');
    expect(inspected.data).toEqual({
      source: 'narrate_tool',
      changed: false,
      pattern_count: 0,
      phase3_pattern_count: 0,
      original_length: report.originalLength,
      sanitised_length: report.sanitisedLength,
    });
    expect(inspected.data as Record<string, unknown>).not.toHaveProperty(
      'original_prefix',
    );
    expect(inspected.data as Record<string, unknown>).not.toHaveProperty(
      'synth_source',
    );
    spy.mockRestore();
  });

  it('emits both events with matching ids when the sanitizer changed text (fired keeps original_prefix; inspected does not)', () => {
    const captured: GameplayTelemetryEvent[] = [];
    const spy = vi
      .spyOn(telemetry, 'record')
      .mockImplementation((event: TelemetryEvent) => {
        captured.push(event as GameplayTelemetryEvent);
      });
    // Post-Phase-3 the runtime sanitizer only fires on the surviving
    // steps (wrapper/json-wrapper unwrap + paragraph dedup); use the
    // dedup path to exercise the `fired` emitter while the historical
    // Phase 3 counter stays at zero.
    const input = 'Mikka grins.\n\nMikka grins.\n\nA second paragraph.';
    const report = sanitiseNarrateTextWithReport(input);
    expect(report.changed).toBe(true);
    expect(report.patternsFired).toEqual(['paragraph_dedup']);
    recordNarrateSanitiserTelemetry({
      ctx: {sessionId: 'sess-b', playerId: 22, turnId: 'turn-b'},
      report,
      source: 'narrate_tool',
    });
    expect(captured.map((c) => c.name)).toEqual([
      'narrate.sanitiser.inspected',
      'narrate.sanitiser.fired',
    ]);
    const inspected = captured[0]!.data as Record<string, unknown>;
    expect(inspected).not.toHaveProperty('original_prefix');
    // The runtime can no longer fire the four historical scrubbers, so
    // the inspected counter is always zero on current sanitizer output.
    expect(inspected['phase3_pattern_count']).toBe(0);
    const fired = captured[1]!.data as Record<string, unknown>;
    expect(fired).toHaveProperty('original_prefix');
    expect((fired['original_prefix'] as string).length).toBeLessThanOrEqual(
      200,
    );
    expect(fired['patterns_fired']).toEqual(['paragraph_dedup']);
    spy.mockRestore();
  });

  it('attaches `synth_source` to BOTH events when the synth path is the emitter', () => {
    const captured: GameplayTelemetryEvent[] = [];
    const spy = vi
      .spyOn(telemetry, 'record')
      .mockImplementation((event: TelemetryEvent) => {
        captured.push(event as GameplayTelemetryEvent);
      });
    // Use the wrapper-unwrap path so the synth emitter has a fired
    // event to attach `synth_source` to.
    const report = sanitiseNarrateTextWithReport('{"text":"hello"}');
    expect(report.changed).toBe(true);
    recordNarrateSanitiserTelemetry({
      ctx: {
        sessionId: 'sess-c',
        playerId: 33,
        turnId: 'turn-c',
        synthSource: 'broker_narrate_fast_path',
      },
      report,
      source: 'narrate_synthesis',
    });
    expect(captured).toHaveLength(2);
    for (const ev of captured) {
      const d = ev.data as Record<string, unknown>;
      expect(d['source']).toBe('narrate_synthesis');
      expect(d['synth_source']).toBe('broker_narrate_fast_path');
    }
    // Inspected still has no prose; fired still keeps the prefix.
    const inspected = captured[0]!.data as Record<string, unknown>;
    expect(inspected).not.toHaveProperty('original_prefix');
    const fired = captured[1]!.data as Record<string, unknown>;
    expect(fired).toHaveProperty('original_prefix');
    spy.mockRestore();
  });

  it('counts historical Phase 3 patterns correctly via the exported helper', () => {
    // The helper still tallies the four historical pattern ids when
    // replaying pre-deletion telemetry rows. Current sanitizer output
    // never contains them, so live runtime arrays always score zero.
    expect(countPhase3Patterns([])).toBe(0);
    expect(
      countPhase3Patterns(['wrapper_unwrap', 'paragraph_dedup']),
    ).toBe(0);
    expect(
      countPhase3Patterns([
        'analysis_heading',
        'stanislavski_label_bold',
        'paragraph_dedup',
      ]),
    ).toBe(2);
    expect(
      countPhase3Patterns([
        'analysis_heading',
        'stanislavski_label_bold',
        'stanislavski_label_plain',
        'bracket_meta',
      ]),
    ).toBe(4);
  });
});
