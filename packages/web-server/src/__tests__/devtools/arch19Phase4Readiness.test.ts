/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 Phase 4 readiness policy. Pins the six spec-required
// blocker categories:
//
//   1. Dev soak window not elapsed (`as_of - phase3_shipped <
//      min_dev_soak_days`).
//   2. Prod release not confirmed (`prod_release_confirmed: false`).
//   3. Source-sweep offender present (any production reader off the
//      allowlist still consulting `profile->>'…'`).
//   4. Parity mismatch (any of cartridge_id / topology_parent_id /
//      dynamic_origin).
//   5. Null required `cartridge_id` (non-player / non-dynamic /
//      non-support-smoke rows with NULL column value).
//   6. Forge export not yet clean.
//
// Plus a happy-path case proving `ready_for_phase4_drop: true` only
// when every clause is simultaneously satisfied. Legacy key/tag
// counts are informational warnings (non-blocking) so the gate
// doesn't trip on the very rows it is meant to drop.

import {describe, expect, it} from 'vitest';
import {
  ARCH19_PHASE3_SHIPPED_DEFAULT,
  DEFAULT_ARCH19_PHASE4_POLICY,
  evaluateArch19Phase4Readiness,
  type Arch19Phase4ReadinessInput,
} from '../../devtools/arch19Phase4Readiness.js';

function baseInput(
  overrides: Partial<Arch19Phase4ReadinessInput> = {},
): Arch19Phase4ReadinessInput {
  return {
    as_of: '2026-06-01',
    phase3_shipped: ARCH19_PHASE3_SHIPPED_DEFAULT,
    prod_release_confirmed: true,
    forge_export_clean: true,
    source_sweep_offenders: [],
    cartridge_id_parity_mismatches: 0,
    topology_parent_id_parity_mismatches: 0,
    dynamic_origin_parity_mismatches: 0,
    null_cartridge_id_rows: 0,
    legacy_key_counts: {
      profile_cartridge_id: 0,
      profile_topology_parent_id: 0,
      profile_origin: 0,
    },
    legacy_tag_counts: {dynamic_tag: 0, support_smoke_tag: 0},
    database_safety_checked: true,
    policy: {...DEFAULT_ARCH19_PHASE4_POLICY},
    ...overrides,
  };
}

describe('evaluateArch19Phase4Readiness', () => {
  it('blocks when dev soak window has not elapsed (today vs Phase 3 ship date)', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({as_of: '2026-05-17'}),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toContain(
      'dev_soak_window_not_elapsed:2/14_days',
    );
    expect(decision.observed.dev_soak_complete).toBe(false);
    expect(decision.observed.days_since_phase3).toBe(2);
  });

  it('blocks when prod release has not been confirmed', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({prod_release_confirmed: false}),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toContain('prod_release_not_confirmed');
  });

  it('blocks when forge SQL exports still write the dropped keys', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({forge_export_clean: false}),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toContain(
      'forge_export_still_writes_dropped_keys',
    );
  });

  it('blocks per source-sweep offender (each emits its own stable blocker)', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({
        source_sweep_offenders: [
          {file: 'some/reader.ts', sample: "profile->>'cartridge_id'"},
          {file: 'other/file.ts', sample: "profile['origin']"},
        ],
      }),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        'source_sweep_offender:some/reader.ts',
        'source_sweep_offender:other/file.ts',
      ]),
    );
    expect(decision.observed.source_sweep_offender_count).toBe(2);
    expect(decision.observed.source_sweep_offender_files).toEqual([
      'some/reader.ts',
      'other/file.ts',
    ]);
  });

  it('blocks on every parity-mismatch column independently', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({
        cartridge_id_parity_mismatches: 3,
        topology_parent_id_parity_mismatches: 1,
        dynamic_origin_parity_mismatches: 5,
      }),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        'cartridge_id_parity_mismatch:3',
        'topology_parent_id_parity_mismatch:1',
        'dynamic_origin_parity_mismatch:5',
      ]),
    );
  });

  it('blocks when non-player / non-dynamic rows still have NULL cartridge_id', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({null_cartridge_id_rows: 7}),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toContain('null_cartridge_id_rows:7');
  });

  it('treats legacy JSONB keys and the dynamic tag as warnings, not blockers', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({
        legacy_key_counts: {
          profile_cartridge_id: 1234,
          profile_topology_parent_id: 567,
          profile_origin: 12,
        },
        legacy_tag_counts: {dynamic_tag: 8, support_smoke_tag: 0},
      }),
    );
    // Migration 0123 strips the JSONB keys + 'dynamic' tag. Non-zero
    // is expected pre-drop; parity is what actually matters.
    expect(decision.ready_for_phase4_drop).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.warnings).toEqual([
      'legacy_profile_keys_present:cartridge_id=1234,topology_parent_id=567,origin=12',
      'legacy_dynamic_tag_present:8',
    ]);
  });

  it('blocks when the retired support-smoke tag still leaks into stored rows', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({
        legacy_tag_counts: {dynamic_tag: 0, support_smoke_tag: 3},
      }),
    );
    // ARCH-19 Phase 4 (migration 0124) retired the row-level
    // 'support-smoke' tag in favor of cartridge_id. Any leak is a
    // hard blocker.
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toContain('support_smoke_tag_present:3');
  });

  it('ready_for_phase4_drop=true only when every clause is satisfied (fully synthetic happy path)', () => {
    const decision = evaluateArch19Phase4Readiness(baseInput());
    expect(decision.ready_for_phase4_drop).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.observed.dev_soak_complete).toBe(true);
    expect(decision.observed.days_since_phase3).toBeGreaterThanOrEqual(14);
  });

  it('blocks when database_safety_checked is false, even if every other clause passes', () => {
    // The whole point of the gate: a `--no-db` source-only audit
    // must NEVER authorize the destructive Phase 4 drop.
    const decision = evaluateArch19Phase4Readiness(
      baseInput({database_safety_checked: false}),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toContain('database_counts_not_checked');
    expect(decision.observed.database_safety_checked).toBe(false);
  });

  it('observed.database_safety_checked echoes the input flag on the happy path', () => {
    const decision = evaluateArch19Phase4Readiness(baseInput());
    expect(decision.ready_for_phase4_drop).toBe(true);
    expect(decision.observed.database_safety_checked).toBe(true);
  });

  it('on today (2026-05-17) with default policy returns BLOCKED with the dev-soak and prod-release blockers', () => {
    // Documents the contract the CLI must satisfy on today's date —
    // the spec explicitly requires this verdict.
    const decision = evaluateArch19Phase4Readiness(
      baseInput({
        as_of: '2026-05-17',
        prod_release_confirmed: false,
        forge_export_clean: false,
      }),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        'dev_soak_window_not_elapsed:2/14_days',
        'prod_release_not_confirmed',
        'forge_export_still_writes_dropped_keys',
      ]),
    );
  });

  it('reports unparseable date inputs with a structured blocker', () => {
    const decision = evaluateArch19Phase4Readiness(
      baseInput({as_of: 'not-a-date'}),
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers[0]).toContain('dev_soak_dates_unparseable');
  });
});
