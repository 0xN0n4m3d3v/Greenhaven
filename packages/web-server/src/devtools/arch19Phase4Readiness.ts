/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 Phase 4 readiness policy. Non-destructive evaluator that
// reports whether it is safe to remove the legacy `entities.profile`
// JSONB keys (`cartridge_id`, `topology_parent_id`, `origin`), retire
// the `'dynamic'` / `'support-smoke'` tags from the production
// scoping path, and set `entities.cartridge_id` to NOT NULL for
// non-player / non-dynamic / non-support-smoke rows.
//
// Phase 4 is **non-reversible**. This evaluator is intentionally
// conservative-by-default so a future pass cannot accidentally treat
// a single passing dev soak as approval to ship the drop migration.
// The runtime regexes / readers / migrations are NOT touched in this
// pass — the gate is read-only.
//
// Required preconditions (encoded as blockers below):
//
//   1. Dev soak window elapsed. `phase3_shipped` + `min_dev_soak_days`
//      ≤ `as_of`. Phase 3 shipped 2026-05-15; the spec mandates ≥ 14
//      days dev soak.
//   2. Prod release confirmed. At least one release shipped with
//      Phase 3 active. Operator passes `prod_release_confirmed: true`
//      explicitly; the evaluator never infers it.
//   3. Source-sweep allowlist closed. No production reader outside
//      the documented allowlist consults `profile->>'cartridge_id'`,
//      `profile->>'topology_parent_id'`, or `profile->>'origin'`.
//      `arch19ReaderSweep.test.ts` is the canonical static check;
//      this evaluator accepts that sweep's offender list.
//   4. Normalized-column parity. Every row that has a legacy JSONB
//      key must have an equivalent normalized-column value, so the
//      drop migration discards nothing.
//   5. Required-column population. Every non-player / non-dynamic
//      row must have `cartridge_id IS NOT NULL` so the upcoming
//      NOT NULL constraint can apply without a default.
//   6. Forge regeneration. Cartridge Forge SQL exports stop writing
//      the dropped keys (operator passes `forge_export_clean: true`
//      after running the forge invariants test).
//
// Stable blocker strings — designed for verbatim paste into master-
// plan entries.

export interface Arch19Phase4ReadinessPolicy {
  min_dev_soak_days: number;
  require_prod_release: boolean;
  require_forge_export_clean: boolean;
}

export const DEFAULT_ARCH19_PHASE4_POLICY: Arch19Phase4ReadinessPolicy = {
  min_dev_soak_days: 14,
  require_prod_release: true,
  require_forge_export_clean: true,
};

/** Phase 3 shipped 2026-05-15 per the master plan. */
export const ARCH19_PHASE3_SHIPPED_DEFAULT = '2026-05-15';

export interface Arch19SourceSweepOffender {
  /** Repo-relative path under `packages/web-server/src/`. */
  file: string;
  sample: string;
}

export interface Arch19Phase4ReadinessInput {
  /** ISO date string for "today" — supplied so tests are deterministic. */
  as_of: string;
  /** ISO date string for when Phase 3 migration 0106 shipped. */
  phase3_shipped: string;
  /** Operator-supplied: a prod release shipped with Phase 3 active. */
  prod_release_confirmed: boolean;
  /** Operator-supplied: forge SQL exports verified to stop writing
   *  the dropped keys. Defaults to false in the CLI so the gate
   *  blocks until verified. */
  forge_export_clean: boolean;
  /** Output of the same static sweep `arch19ReaderSweep.test.ts`
   *  performs. Empty when every production reader is on the
   *  documented allowlist. */
  source_sweep_offenders: readonly Arch19SourceSweepOffender[];
  /** Count of rows where `profile->>'cartridge_id'` is set AND the
   *  normalized column disagrees (NULL or different value). */
  cartridge_id_parity_mismatches: number;
  /** Same shape for `profile->>'topology_parent_id'` vs
   *  `entities.topology_parent_id`. */
  topology_parent_id_parity_mismatches: number;
  /** Count of rows where `profile->>'origin' = 'dynamic'` OR
   *  `'dynamic' = ANY(tags)` AND `dynamic_origin = false`. */
  dynamic_origin_parity_mismatches: number;
  /** Count of non-player / non-dynamic rows with NULL
   *  `entities.cartridge_id`. After Phase 4 these rows would
   *  violate the NOT NULL constraint. */
  null_cartridge_id_rows: number;
  /** Informational — number of rows that still carry each legacy
   *  JSONB key. Phase 4 will strip these. Non-zero is expected
   *  pre-drop; the evaluator emits a `warnings` entry but does NOT
   *  block, because the drop migration's whole point is to remove
   *  them. Parity mismatches are the real safety bar. */
  legacy_key_counts: {
    profile_cartridge_id: number;
    profile_topology_parent_id: number;
    profile_origin: number;
  };
  /** Informational — same shape for legacy tags. */
  legacy_tag_counts: {
    dynamic_tag: number;
    support_smoke_tag: number;
  };
  /** Operator-supplied (via the CLI it is set automatically): true
   *  only when the parity / null-cartridge / legacy-count queries
   *  actually ran against a real pgdata. `--no-db` advisory runs
   *  set this to false so the evaluator emits
   *  `database_counts_not_checked` and refuses to authorize the
   *  drop on source-sweep evidence alone. */
  database_safety_checked: boolean;
  policy: Arch19Phase4ReadinessPolicy;
}

export interface Arch19Phase4ReadinessDecision {
  ready_for_phase4_drop: boolean;
  blockers: string[];
  warnings: string[];
  policy: Arch19Phase4ReadinessPolicy;
  observed: {
    days_since_phase3: number | null;
    dev_soak_complete: boolean;
    prod_release_confirmed: boolean;
    forge_export_clean: boolean;
    source_sweep_offender_count: number;
    source_sweep_offender_files: string[];
    cartridge_id_parity_mismatches: number;
    topology_parent_id_parity_mismatches: number;
    dynamic_origin_parity_mismatches: number;
    null_cartridge_id_rows: number;
    legacy_key_counts: Arch19Phase4ReadinessInput['legacy_key_counts'];
    legacy_tag_counts: Arch19Phase4ReadinessInput['legacy_tag_counts'];
    database_safety_checked: boolean;
  };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value: string): number | null {
  // Accept `YYYY-MM-DD` and full ISO timestamps. Reject anything
  // that doesn't parse cleanly so the operator notices.
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Evaluate ARCH-19 Phase 4 readiness against the policy. Pure: same
 * inputs → same decision → same blocker strings.
 */
export function evaluateArch19Phase4Readiness(
  input: Arch19Phase4ReadinessInput,
): Arch19Phase4ReadinessDecision {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const asOfMs = parseIsoDate(input.as_of);
  const phase3Ms = parseIsoDate(input.phase3_shipped);
  let daysSincePhase3: number | null = null;
  let devSoakComplete = false;
  if (asOfMs == null || phase3Ms == null) {
    blockers.push(
      `dev_soak_dates_unparseable:as_of=${input.as_of},phase3_shipped=${input.phase3_shipped}`,
    );
  } else {
    daysSincePhase3 = Math.floor((asOfMs - phase3Ms) / ONE_DAY_MS);
    devSoakComplete = daysSincePhase3 >= input.policy.min_dev_soak_days;
    if (!devSoakComplete) {
      blockers.push(
        `dev_soak_window_not_elapsed:${daysSincePhase3}/${input.policy.min_dev_soak_days}_days`,
      );
    }
  }

  if (input.policy.require_prod_release && !input.prod_release_confirmed) {
    blockers.push('prod_release_not_confirmed');
  }

  if (input.policy.require_forge_export_clean && !input.forge_export_clean) {
    blockers.push('forge_export_still_writes_dropped_keys');
  }

  for (const off of input.source_sweep_offenders) {
    blockers.push(`source_sweep_offender:${off.file}`);
  }

  if (input.cartridge_id_parity_mismatches > 0) {
    blockers.push(
      `cartridge_id_parity_mismatch:${input.cartridge_id_parity_mismatches}`,
    );
  }
  if (input.topology_parent_id_parity_mismatches > 0) {
    blockers.push(
      `topology_parent_id_parity_mismatch:${input.topology_parent_id_parity_mismatches}`,
    );
  }
  if (input.dynamic_origin_parity_mismatches > 0) {
    blockers.push(
      `dynamic_origin_parity_mismatch:${input.dynamic_origin_parity_mismatches}`,
    );
  }

  if (input.null_cartridge_id_rows > 0) {
    blockers.push(`null_cartridge_id_rows:${input.null_cartridge_id_rows}`);
  }

  // Database-evidence gate. A `--no-db` advisory run cannot
  // authorize the destructive Phase 4 drop, even when every other
  // policy clause is satisfied. Parity / null-cartridge / legacy
  // counts MUST come from a real pgdata before
  // `ready_for_phase4_drop` can flip true.
  if (!input.database_safety_checked) {
    blockers.push('database_counts_not_checked');
  }

  // Informational warnings — non-zero legacy JSONB key counts are
  // expected pre-drop. Parity mismatches above are the real safety
  // bar.
  const legacyKeyTotal =
    input.legacy_key_counts.profile_cartridge_id +
    input.legacy_key_counts.profile_topology_parent_id +
    input.legacy_key_counts.profile_origin;
  if (legacyKeyTotal > 0) {
    warnings.push(
      `legacy_profile_keys_present:cartridge_id=${input.legacy_key_counts.profile_cartridge_id},topology_parent_id=${input.legacy_key_counts.profile_topology_parent_id},origin=${input.legacy_key_counts.profile_origin}`,
    );
  }
  // ARCH-19 Phase 4 (migration 0124) retired the `'support-smoke'`
  // tag at the row level — the canonical scope is now
  // `cartridge_id = 'support-smoke'`. Any persisted occurrence
  // points at a writer that still emits the retired marker and is
  // a hard blocker. `'dynamic'` is also retired (migration 0123)
  // but remains a warning here: the drop migration already strips
  // it and leakage is treated as advisory.
  if (input.legacy_tag_counts.support_smoke_tag > 0) {
    blockers.push(
      `support_smoke_tag_present:${input.legacy_tag_counts.support_smoke_tag}`,
    );
  }
  if (input.legacy_tag_counts.dynamic_tag > 0) {
    warnings.push(
      `legacy_dynamic_tag_present:${input.legacy_tag_counts.dynamic_tag}`,
    );
  }

  return {
    ready_for_phase4_drop: blockers.length === 0,
    blockers,
    warnings,
    policy: input.policy,
    observed: {
      days_since_phase3: daysSincePhase3,
      dev_soak_complete: devSoakComplete,
      prod_release_confirmed: input.prod_release_confirmed,
      forge_export_clean: input.forge_export_clean,
      source_sweep_offender_count: input.source_sweep_offenders.length,
      source_sweep_offender_files: input.source_sweep_offenders.map(
        (o) => o.file,
      ),
      cartridge_id_parity_mismatches: input.cartridge_id_parity_mismatches,
      topology_parent_id_parity_mismatches:
        input.topology_parent_id_parity_mismatches,
      dynamic_origin_parity_mismatches: input.dynamic_origin_parity_mismatches,
      null_cartridge_id_rows: input.null_cartridge_id_rows,
      legacy_key_counts: input.legacy_key_counts,
      legacy_tag_counts: input.legacy_tag_counts,
      database_safety_checked: input.database_safety_checked,
    },
  };
}
