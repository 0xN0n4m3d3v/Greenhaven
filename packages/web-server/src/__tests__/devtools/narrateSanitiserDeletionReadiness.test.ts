/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-2 Phase 3 deletion-readiness policy. Pins the four blocker
// categories from the spec:
//
//   1. local soak passed but deletion blocked by single
//      cartridge / single model family,
//   2. deletion blocked by nonzero Phase 3 total (and so is the
//      soak — they share the runtime gate),
//   3. deletion blocked by failed / cancelled / timeout /
//      submit-failed turns,
//   4. deletion allowed only when every configured threshold is met.
//
// Tests live below the helper layer so they don't need PGlite. The
// helper is pure: same inputs → same decision → same blocker
// strings. That stability is load-bearing for future master-plan
// entries pasting blocker arrays verbatim.

import {describe, expect, it} from 'vitest';
import {
  aggregateDriverSummariesForDeletionReadiness,
  DEFAULT_DELETION_READINESS_POLICY,
  evaluateNarrateSanitiserDeletionReadiness,
  normaliseCartridgeLabel,
  normaliseCartridgeLabels,
  normaliseModelFamilyLabel,
  normaliseModelFamilyLabels,
  type DeletionReadinessInput,
  type DeletionReadinessPolicy,
  type DriverSummaryArtifact,
} from '../../devtools/narrateSanitiserDeletionReadiness.js';

function baseInput(
  overrides: Partial<DeletionReadinessInput> = {},
): DeletionReadinessInput {
  return {
    new_inspected_events: 8,
    new_phase3_total: 0,
    turns_failed: 0,
    turns_cancelled: 0,
    turns_timeout: 0,
    turns_submit_failed: 0,
    shutdown_force_fallback_used: false,
    configured_languages: ['en', 'ru'],
    languages_completed: ['en', 'ru'],
    cartridges_attempted: ['packaged'],
    model_families_attempted: [],
    ready_for_phase3_gate: true,
    policy: {...DEFAULT_DELETION_READINESS_POLICY},
    ...overrides,
  };
}

describe('evaluateNarrateSanitiserDeletionReadiness', () => {
  it('local_soak_passed=true but ready_for_regex_deletion=false when only the packaged cartridge / one model family is exercised', () => {
    const decision = evaluateNarrateSanitiserDeletionReadiness(
      baseInput({
        cartridges_attempted: ['packaged'],
        model_families_attempted: ['anthropic'],
      }),
    );
    expect(decision.local_soak_passed).toBe(true);
    expect(decision.soak_blockers).toEqual([]);
    expect(decision.ready_for_regex_deletion).toBe(false);
    expect(decision.deletion_blockers).toEqual([
      'cartridges_attempted_below_min:1/2',
      'model_families_attempted_below_min:1/2',
    ]);
    expect(decision.observed).toEqual({
      distinct_languages_completed: 2,
      distinct_cartridges_attempted: 1,
      distinct_model_families_attempted: 1,
    });
  });

  it('records readiness gate + nonzero phase3 as soak blockers (deletion is blocked transitively)', () => {
    const decision = evaluateNarrateSanitiserDeletionReadiness(
      baseInput({
        new_phase3_total: 3,
        ready_for_phase3_gate: false,
      }),
    );
    expect(decision.local_soak_passed).toBe(false);
    expect(decision.soak_blockers).toEqual([
      'readiness_gate_not_passing',
      'new_phase3_total_nonzero:3',
    ]);
    expect(decision.ready_for_regex_deletion).toBe(false);
    expect(decision.deletion_blockers).toEqual(
      expect.arrayContaining([
        'readiness_gate_not_passing',
        'new_phase3_total_nonzero:3',
        'cartridges_attempted_below_min:1/2',
        'model_families_attempted_below_min:0/2',
      ]),
    );
  });

  it('lists every turn-error class plus force-fallback as soak blockers', () => {
    const decision = evaluateNarrateSanitiserDeletionReadiness(
      baseInput({
        turns_failed: 1,
        turns_cancelled: 2,
        turns_timeout: 3,
        turns_submit_failed: 4,
        shutdown_force_fallback_used: true,
        languages_completed: ['en'],
      }),
    );
    expect(decision.local_soak_passed).toBe(false);
    expect(decision.soak_blockers).toEqual([
      'turns_failed:1',
      'turns_cancelled:2',
      'turns_timeout:3',
      'turns_submit_failed:4',
      'shutdown_force_fallback_used',
      'languages_not_completed:ru',
      'languages_completed_below_min:1/2',
    ]);
    expect(decision.ready_for_regex_deletion).toBe(false);
  });

  it('reports new_inspected_events below threshold honestly without inflating the count', () => {
    const decision = evaluateNarrateSanitiserDeletionReadiness(
      baseInput({
        new_inspected_events: 3,
        policy: {...DEFAULT_DELETION_READINESS_POLICY, min_inspected_events: 8},
      }),
    );
    expect(decision.soak_blockers).toContain(
      'new_inspected_events_below_min:3/8',
    );
    expect(decision.local_soak_passed).toBe(false);
  });

  it('ready_for_regex_deletion=true only when every configured threshold is met (multi-cartridge multi-model)', () => {
    const decision = evaluateNarrateSanitiserDeletionReadiness(
      baseInput({
        cartridges_attempted: ['greenhaven', 'tomb-tutorial'],
        model_families_attempted: ['anthropic', 'deepseek'],
      }),
    );
    expect(decision.local_soak_passed).toBe(true);
    expect(decision.ready_for_regex_deletion).toBe(true);
    expect(decision.soak_blockers).toEqual([]);
    expect(decision.deletion_blockers).toEqual([]);
  });

  it('honours custom policy overrides', () => {
    const policy: DeletionReadinessPolicy = {
      min_inspected_events: 4,
      min_languages: 1,
      min_cartridges: 1,
      min_model_families: 0,
    };
    const decision = evaluateNarrateSanitiserDeletionReadiness(
      baseInput({
        new_inspected_events: 4,
        languages_completed: ['en'],
        configured_languages: ['en'],
        cartridges_attempted: ['packaged'],
        model_families_attempted: [],
        policy,
      }),
    );
    expect(decision.local_soak_passed).toBe(true);
    expect(decision.ready_for_regex_deletion).toBe(true);
  });
});

describe('aggregateDriverSummariesForDeletionReadiness', () => {
  function summary(
    over: Partial<DriverSummaryArtifact> = {},
  ): DriverSummaryArtifact {
    return {
      new_inspected_events: 8,
      new_phase3_total: 0,
      turns_failed: 0,
      turns_cancelled: 0,
      turns_timeout: 0,
      turns_submit_failed: 0,
      shutdown_force_fallback_used: false,
      configured: {languages: ['en', 'ru']},
      languages_completed: ['en', 'ru'],
      cartridges_attempted: ['packaged'],
      model_families_attempted: [],
      ready_for_phase3_gate: true,
      ...over,
    };
  }

  it('returns artifact_count=0 with no soak evidence and blocks deletion', () => {
    const decision = aggregateDriverSummariesForDeletionReadiness([]);
    expect(decision.artifact_count).toBe(0);
    expect(decision.ready_for_regex_deletion).toBe(false);
    expect(decision.soak_blockers).toContain('readiness_gate_not_passing');
  });

  it('aggregates counts across two single-cartridge runs (local_soak_passed=true, deletion still blocked by diversity)', () => {
    const decision = aggregateDriverSummariesForDeletionReadiness(
      [summary(), summary()],
    );
    expect(decision.artifact_count).toBe(2);
    expect(decision.aggregated.new_inspected_events).toBe(16);
    expect(decision.aggregated.cartridges_attempted).toEqual(['packaged']);
    expect(decision.local_soak_passed).toBe(true);
    expect(decision.ready_for_regex_deletion).toBe(false);
    expect(decision.deletion_blockers).toEqual([
      'cartridges_attempted_below_min:1/2',
      'model_families_attempted_below_min:0/2',
    ]);
  });

  it('unions cartridges/model-families across runs so two single-cartridge artifacts can lift the deletion block', () => {
    const decision = aggregateDriverSummariesForDeletionReadiness([
      summary({
        cartridges_attempted: ['greenhaven'],
        model_families_attempted: ['anthropic'],
      }),
      summary({
        cartridges_attempted: ['tomb-tutorial'],
        model_families_attempted: ['deepseek'],
      }),
    ]);
    expect(decision.aggregated.cartridges_attempted).toEqual([
      'greenhaven',
      'tomb-tutorial',
    ]);
    expect(decision.aggregated.model_families_attempted).toEqual([
      'anthropic',
      'deepseek',
    ]);
    expect(decision.local_soak_passed).toBe(true);
    expect(decision.ready_for_regex_deletion).toBe(true);
    expect(decision.deletion_blockers).toEqual([]);
  });

  it('any failed gate or force-fallback in the evidence set poisons the union', () => {
    const decision = aggregateDriverSummariesForDeletionReadiness([
      summary({
        cartridges_attempted: ['greenhaven'],
        model_families_attempted: ['anthropic'],
      }),
      summary({
        cartridges_attempted: ['tomb-tutorial'],
        model_families_attempted: ['deepseek'],
        ready_for_phase3_gate: false,
        shutdown_force_fallback_used: true,
      }),
    ]);
    expect(decision.aggregated.ready_for_phase3_gate).toBe(false);
    expect(decision.aggregated.shutdown_force_fallback_used).toBe(true);
    expect(decision.soak_blockers).toEqual(
      expect.arrayContaining([
        'readiness_gate_not_passing',
        'shutdown_force_fallback_used',
      ]),
    );
    expect(decision.ready_for_regex_deletion).toBe(false);
  });
});

describe('normaliseModelFamilyLabel', () => {
  it('returns "unknown" for empty / non-string / whitespace input', () => {
    expect(normaliseModelFamilyLabel('')).toBe('unknown');
    expect(normaliseModelFamilyLabel('   ')).toBe('unknown');
    expect(normaliseModelFamilyLabel(null as unknown)).toBe('unknown');
    expect(normaliseModelFamilyLabel(undefined as unknown)).toBe('unknown');
    expect(normaliseModelFamilyLabel(42 as unknown)).toBe('unknown');
  });

  it('extracts the leading provider segment of a slash-prefixed hosted id', () => {
    expect(normaliseModelFamilyLabel('deepseek/deepseek-chat')).toBe(
      'deepseek',
    );
    expect(normaliseModelFamilyLabel('openrouter/anthropic/claude-3.5')).toBe(
      'openrouter',
    );
    expect(normaliseModelFamilyLabel('Mistral/Mixtral-8x7B')).toBe('mistral');
  });

  it('maps known prefixes to canonical family names', () => {
    expect(normaliseModelFamilyLabel('deepseek-chat')).toBe('deepseek');
    expect(normaliseModelFamilyLabel('ds-r1')).toBe('deepseek');
    expect(normaliseModelFamilyLabel('claude-3.5-sonnet')).toBe('anthropic');
    expect(normaliseModelFamilyLabel('anthropic-haiku')).toBe('anthropic');
    expect(normaliseModelFamilyLabel('gpt-4o')).toBe('openai');
    expect(normaliseModelFamilyLabel('openai-o1')).toBe('openai');
    expect(normaliseModelFamilyLabel('gemini-2.0-pro')).toBe('google');
    expect(normaliseModelFamilyLabel('google-gemma-2')).toBe('google');
    expect(normaliseModelFamilyLabel('llama-3-70b')).toBe('meta');
    expect(normaliseModelFamilyLabel('meta-llama-3.1')).toBe('meta');
    expect(normaliseModelFamilyLabel('mistral-large')).toBe('mistral');
    expect(normaliseModelFamilyLabel('mixtral-8x22b')).toBe('mistral');
    expect(normaliseModelFamilyLabel('qwen-72b')).toBe('qwen');
  });

  it('falls back to the leading -/:/_ token for unknown ids', () => {
    expect(normaliseModelFamilyLabel('grok-2')).toBe('grok');
    expect(normaliseModelFamilyLabel('cohere:command-r')).toBe('cohere');
    expect(normaliseModelFamilyLabel('jamba_1.5-mini')).toBe('jamba');
    // No separator → returns the raw lowercased token. Unusual but
    // safe — the diversity gate still sees a distinct family value.
    expect(normaliseModelFamilyLabel('Magnum')).toBe('magnum');
  });
});

describe('normaliseModelFamilyLabels', () => {
  it('dedupes + sorts + drops empty / non-string entries', () => {
    expect(
      normaliseModelFamilyLabels([
        'deepseek-chat',
        'DeepSeek-Reasoner',
        'claude-3.5-sonnet',
        '',
        '   ',
        null as unknown,
        undefined as unknown,
        12 as unknown,
        'anthropic-haiku',
      ]),
    ).toEqual(['anthropic', 'deepseek']);
  });

  it('returns [] for empty input', () => {
    expect(normaliseModelFamilyLabels([])).toEqual([]);
  });
});

describe('normaliseCartridgeLabel', () => {
  it('returns null for empty / non-string / whitespace input', () => {
    // The cartridge axis must NEVER auto-fill: dropping invalid input
    // is the difference between a real evidence gate and one an
    // operator can pad with default strings.
    expect(normaliseCartridgeLabel('')).toBeNull();
    expect(normaliseCartridgeLabel('   ')).toBeNull();
    expect(normaliseCartridgeLabel(null as unknown)).toBeNull();
    expect(normaliseCartridgeLabel(undefined as unknown)).toBeNull();
    expect(normaliseCartridgeLabel(42 as unknown)).toBeNull();
    expect(normaliseCartridgeLabel({slug: 'grinhaven-full'} as unknown)).toBeNull();
  });

  it('trims and lowercases real ids', () => {
    expect(normaliseCartridgeLabel('grinhaven-full')).toBe('grinhaven-full');
    expect(normaliseCartridgeLabel('  Grinhaven-Full  ')).toBe('grinhaven-full');
    expect(normaliseCartridgeLabel('PACKAGED')).toBe('packaged');
  });
});

describe('normaliseCartridgeLabels', () => {
  it('dedupes + sorts + drops empty / non-string entries', () => {
    expect(
      normaliseCartridgeLabels([
        'grinhaven-full',
        'Grinhaven-Full',
        'packaged',
        '',
        '   ',
        null as unknown,
        undefined as unknown,
        42 as unknown,
        '  PACKAGED  ',
      ]),
    ).toEqual(['grinhaven-full', 'packaged']);
  });

  it('returns [] when no usable evidence is present', () => {
    // Caller MUST treat this as "no cartridge diversity", not as
    // permission to invent a `packaged` default.
    expect(normaliseCartridgeLabels([])).toEqual([]);
    expect(normaliseCartridgeLabels(['', '   ', null as unknown])).toEqual([]);
  });
});
