/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-2 Phase 3 deletion-readiness policy. Distinguishes two questions
// the prior pass blurred together by writing a single boolean
// (`ready_for_regex_deletion`) into the desktop soak driver's summary:
//
//   1. **Local soak passed.** The packaged desktop EXE completed a
//      configured turn batch with no failures, the narrate sanitiser
//      mirror produced ≥ N inspected events with zero Phase 3 blocker
//      firings, every configured language reached `done` at least once,
//      and shutdown was graceful. This is a per-run sanity gate. Use
//      `local_soak_passed`.
//
//   2. **Ready to delete runtime regexes.** Same as (1) AND the
//      evidence covers ≥ N cartridges and ≥ N model families. A single
//      packaged-cartridge / single-provider run does NOT satisfy this
//      — the packaged desktop bundle ships one cartridge and exercises
//      one model family per run, so future passes must not interpret a
//      single passing soak as approval to delete the Stanislavski/meta
//      pipeline entries in `sanitiser.ts`. Use
//      `ready_for_regex_deletion`.
//
// Both signals come from the same helper here. Callers (the soak
// driver, the artifact-only CLI, future production gates) feed the
// per-run counters in and read back the booleans plus blocker lists.
// Blockers are arrays of stable strings — machine-readable, suitable
// for pasting straight into a master-plan entry, and never lossy
// (`new_phase3_total_nonzero:3` is more useful than a generic
// "blocked").

export interface DeletionReadinessPolicy {
  /** Minimum count of `narrate.sanitiser.inspected` events the soak
   *  must add to the lake during the run. Defaults to the soak's
   *  Turns parameter so a clean N-turn run is the minimum bar. */
  min_inspected_events: number;
  /** Minimum count of distinct languages that reached terminal `done`
   *  at least once. Local-soak axis. */
  min_languages: number;
  /** Minimum count of distinct cartridges exercised across the
   *  evidence set. Deletion-only axis — the packaged desktop bundle
   *  ships one cartridge, so a single packaged soak cannot satisfy
   *  this without explicit operator input. */
  min_cartridges: number;
  /** Minimum count of distinct model families (LLM provider/family
   *  identifiers) exercised across the evidence set. Deletion-only
   *  axis — same packaged-bundle caveat as cartridges. */
  min_model_families: number;
}

export const DEFAULT_DELETION_READINESS_POLICY: DeletionReadinessPolicy = {
  min_inspected_events: 8,
  min_languages: 2,
  min_cartridges: 2,
  min_model_families: 2,
};

/**
 * Normalize a raw `brokerModelId` / `narratorModelId` (from
 * `/api/session/:id/state`) into a stable model-family label suitable
 * for the deletion-readiness diversity gate.
 *
 * Rules, applied in order:
 * 1. Empty / whitespace / non-string → `'unknown'`.
 * 2. Slash-prefixed hosted ids (e.g. `deepseek/deepseek-chat`,
 *    `openrouter/anthropic/claude-3.5-sonnet`) → the leading provider
 *    segment, lowercased.
 * 3. Known prefixes match canonical family names (`deepseek-*`,
 *    `ds-*` → `deepseek`; `claude-*`, `anthropic-*` → `anthropic`;
 *    `gpt-*`, `openai-*` → `openai`; `gemini-*`, `google-*` →
 *    `google`; `llama-*`, `meta-*` → `meta`; `mistral-*`,
 *    `mixtral-*` → `mistral`; `qwen-*` → `qwen`).
 * 4. Fallback: strip the first `-` / `:` / `_` separator and use the
 *    leading token (lowercased). Unknown ids land here rather than
 *    `'unknown'` so an out-of-rule provider still contributes a
 *    distinct family rather than silently dissolving into the
 *    fallback bucket — but a soak that produces only `'unknown'`
 *    families still legitimately fails the diversity gate.
 *
 * The N-2 soak driver uses `n2-normalise-model-family.ts` to invoke
 * this helper from PowerShell so PS and TS apply identical rules.
 */
export function normaliseModelFamilyLabel(rawId: unknown): string {
  if (typeof rawId !== 'string') return 'unknown';
  const trimmed = rawId.trim().toLowerCase();
  if (trimmed.length === 0) return 'unknown';
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx > 0) {
    const provider = trimmed.slice(0, slashIdx);
    if (provider.length > 0) return provider;
  }
  if (trimmed === 'deepseek' || trimmed.startsWith('deepseek-') || trimmed.startsWith('ds-')) {
    return 'deepseek';
  }
  if (trimmed === 'claude' || trimmed.startsWith('claude-') || trimmed.startsWith('anthropic-')) {
    return 'anthropic';
  }
  if (trimmed.startsWith('gpt-') || trimmed.startsWith('openai-')) {
    return 'openai';
  }
  if (trimmed.startsWith('gemini-') || trimmed.startsWith('google-')) {
    return 'google';
  }
  if (trimmed.startsWith('llama-') || trimmed.startsWith('meta-llama') || trimmed.startsWith('meta-')) {
    return 'meta';
  }
  if (trimmed.startsWith('mistral-') || trimmed.startsWith('mixtral-')) {
    return 'mistral';
  }
  if (trimmed.startsWith('qwen-')) {
    return 'qwen';
  }
  const sep = trimmed.search(/[-:_]/);
  if (sep > 0) return trimmed.slice(0, sep);
  return trimmed;
}

/**
 * Convenience: take an array of raw observed model ids, drop
 * empty/non-string entries, normalize each, and return the
 * deduplicated stable-sorted family list. The N-2 soak driver feeds
 * this through `n2-normalise-model-family.ts` and writes the result
 * into `driver-summary.json.model_families_attempted` alongside the
 * raw ids.
 */
export function normaliseModelFamilyLabels(
  rawIds: readonly unknown[],
): string[] {
  const families = new Set<string>();
  for (const id of rawIds) {
    if (typeof id !== 'string') continue;
    if (id.trim().length === 0) continue;
    families.add(normaliseModelFamilyLabel(id));
  }
  return Array.from(families).sort();
}

/**
 * Normalize a raw observed cartridge id (read off
 * `/api/world.cartridge_meta.cartridge_id.value`) into a stable label
 * for the deletion-readiness diversity gate.
 *
 * Rules: trim whitespace, lowercase, return `null` for empty /
 * non-string / whitespace-only input. Unlike `normaliseModelFamilyLabel`
 * there is NO `'unknown'` fallback — a cartridge id that is not a real
 * non-empty string must drop entirely so the soak driver cannot
 * silently invent a `packaged` default when no evidence was observed.
 *
 * The N-2 soak driver feeds this through
 * `n2-normalise-model-family.ts --kind cartridge` so PS and TS apply
 * identical rules without duplicating logic.
 */
export function normaliseCartridgeLabel(rawId: unknown): string | null {
  if (typeof rawId !== 'string') return null;
  const trimmed = rawId.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/**
 * Convenience: take an array of raw observed cartridge ids, drop
 * empty / non-string / whitespace-only entries, normalize each, and
 * return the deduplicated stable-sorted label list. Returns `[]` when
 * no usable evidence is present — callers must treat that as "no
 * cartridge diversity" and not as approval to invent one.
 */
export function normaliseCartridgeLabels(
  rawIds: readonly unknown[],
): string[] {
  const labels = new Set<string>();
  for (const id of rawIds) {
    const label = normaliseCartridgeLabel(id);
    if (label !== null) labels.add(label);
  }
  return Array.from(labels).sort();
}

export interface DeletionReadinessInput {
  new_inspected_events: number;
  new_phase3_total: number;
  turns_failed: number;
  turns_cancelled: number;
  turns_timeout: number;
  turns_submit_failed: number;
  shutdown_force_fallback_used: boolean;
  configured_languages: readonly string[];
  languages_completed: readonly string[];
  cartridges_attempted: readonly string[];
  model_families_attempted: readonly string[];
  ready_for_phase3_gate: boolean;
  policy: DeletionReadinessPolicy;
}

export interface DeletionReadinessDecision {
  local_soak_passed: boolean;
  ready_for_regex_deletion: boolean;
  soak_blockers: string[];
  deletion_blockers: string[];
  policy: DeletionReadinessPolicy;
  observed: {
    distinct_languages_completed: number;
    distinct_cartridges_attempted: number;
    distinct_model_families_attempted: number;
  };
}

/**
 * Evaluate one soak run against the policy. Returns the typed
 * decision plus stable blocker strings.
 */
export function evaluateNarrateSanitiserDeletionReadiness(
  input: DeletionReadinessInput,
): DeletionReadinessDecision {
  const soakBlockers: string[] = [];

  if (!input.ready_for_phase3_gate) {
    soakBlockers.push('readiness_gate_not_passing');
  }
  if (input.new_inspected_events < input.policy.min_inspected_events) {
    soakBlockers.push(
      `new_inspected_events_below_min:${input.new_inspected_events}/${input.policy.min_inspected_events}`,
    );
  }
  if (input.new_phase3_total !== 0) {
    soakBlockers.push(`new_phase3_total_nonzero:${input.new_phase3_total}`);
  }
  if (input.turns_failed > 0) {
    soakBlockers.push(`turns_failed:${input.turns_failed}`);
  }
  if (input.turns_cancelled > 0) {
    soakBlockers.push(`turns_cancelled:${input.turns_cancelled}`);
  }
  if (input.turns_timeout > 0) {
    soakBlockers.push(`turns_timeout:${input.turns_timeout}`);
  }
  if (input.turns_submit_failed > 0) {
    soakBlockers.push(`turns_submit_failed:${input.turns_submit_failed}`);
  }
  if (input.shutdown_force_fallback_used) {
    soakBlockers.push('shutdown_force_fallback_used');
  }

  const completedSet = new Set(input.languages_completed);
  const missingLanguages = input.configured_languages.filter(
    (l) => !completedSet.has(l),
  );
  if (missingLanguages.length > 0) {
    soakBlockers.push(`languages_not_completed:${missingLanguages.join(',')}`);
  }
  const distinctLanguagesCompleted = completedSet.size;
  if (distinctLanguagesCompleted < input.policy.min_languages) {
    soakBlockers.push(
      `languages_completed_below_min:${distinctLanguagesCompleted}/${input.policy.min_languages}`,
    );
  }

  const distinctCartridgesAttempted = new Set(input.cartridges_attempted).size;
  const distinctModelFamiliesAttempted = new Set(
    input.model_families_attempted,
  ).size;

  const localSoakPassed = soakBlockers.length === 0;

  const deletionBlockers: string[] = [...soakBlockers];
  if (distinctCartridgesAttempted < input.policy.min_cartridges) {
    deletionBlockers.push(
      `cartridges_attempted_below_min:${distinctCartridgesAttempted}/${input.policy.min_cartridges}`,
    );
  }
  if (distinctModelFamiliesAttempted < input.policy.min_model_families) {
    deletionBlockers.push(
      `model_families_attempted_below_min:${distinctModelFamiliesAttempted}/${input.policy.min_model_families}`,
    );
  }

  return {
    local_soak_passed: localSoakPassed,
    ready_for_regex_deletion: deletionBlockers.length === 0,
    soak_blockers: soakBlockers,
    deletion_blockers: deletionBlockers,
    policy: input.policy,
    observed: {
      distinct_languages_completed: distinctLanguagesCompleted,
      distinct_cartridges_attempted: distinctCartridgesAttempted,
      distinct_model_families_attempted: distinctModelFamiliesAttempted,
    },
  };
}

// The subset of the soak driver's driver-summary.json shape that the
// evaluator reads. Extra fields on the JSON are ignored, so the
// driver's summary contract can grow without breaking artifact-only
// audits.
export interface DriverSummaryArtifact {
  new_inspected_events?: number;
  new_phase3_total?: number;
  turns_failed?: number;
  turns_cancelled?: number;
  turns_timeout?: number;
  turns_submit_failed?: number;
  shutdown_force_fallback_used?: boolean;
  configured?: {
    languages?: readonly string[];
  };
  languages_completed?: readonly string[];
  cartridges_attempted?: readonly string[];
  model_families_attempted?: readonly string[];
  ready_for_phase3_gate?: boolean;
  /** Recorded by the soak driver so artifact-only audits can pick the
   *  most-conservative threshold across runs without an operator
   *  override. */
  policy?: Partial<DeletionReadinessPolicy>;
  /** Audit-only provenance fields written by the N-2 soak driver as of
   *  2026-05-17. The evaluator ignores these — they exist so the
   *  artifact-only CLI can distinguish honest evidence-driven runs
   *  (`world_overview` / `session_state`) from operator override
   *  (`manual`) or legacy summaries that pre-date the provenance
   *  contract (absent fields). Older artifacts that lack these are
   *  filtered out of auto-discovery unless `--include-legacy` is
   *  supplied; explicit `--artifact <path>` always opts in. */
  driver_kind?: string;
  driver_end_iso?: string;
  cartridge_source?: string;
  model_family_source?: string;
  cartridges_attempted_raw?: readonly string[];
  model_families_attempted_raw?: readonly string[];
  local_soak_passed?: boolean;
  ready_for_regex_deletion?: boolean;
}

/**
 * Derive the effective policy across one or more artifacts by taking
 * the max per axis. Falls back to `defaultPolicy` for axes not
 * recorded by any artifact. Used by the artifact-only CLI when no
 * `--min-*` override is supplied — the policy travels with the
 * evidence rather than the CLI's static default.
 */
export function deriveAggregatedPolicy(
  summaries: readonly DriverSummaryArtifact[],
  defaultPolicy: DeletionReadinessPolicy = DEFAULT_DELETION_READINESS_POLICY,
): DeletionReadinessPolicy {
  const pick = (key: keyof DeletionReadinessPolicy): number => {
    let best: number | null = null;
    for (const s of summaries) {
      const raw = s.policy?.[key];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
        if (best == null || raw > best) best = raw;
      }
    }
    return best ?? defaultPolicy[key];
  };
  return {
    min_inspected_events: pick('min_inspected_events'),
    min_languages: pick('min_languages'),
    min_cartridges: pick('min_cartridges'),
    min_model_families: pick('min_model_families'),
  };
}

export interface AggregateDriverSummaryDecision extends DeletionReadinessDecision {
  artifact_count: number;
  aggregated: {
    new_inspected_events: number;
    new_phase3_total: number;
    turns_failed: number;
    turns_cancelled: number;
    turns_timeout: number;
    turns_submit_failed: number;
    shutdown_force_fallback_used: boolean;
    configured_languages: string[];
    languages_completed: string[];
    cartridges_attempted: string[];
    model_families_attempted: string[];
    ready_for_phase3_gate: boolean;
  };
}

function asInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Aggregate one or more soak driver-summary.json artifacts and run the
 * deletion-readiness policy across the union of evidence. Sums the
 * counters and unions the language/cartridge/model-family sets so the
 * "do we cover N cartridges?" question can be answered across runs
 * without re-launching the desktop EXE.
 *
 * `ready_for_phase3_gate` aggregates via AND so a single failing
 * artifact poisons the union (the gate is a per-run liveness signal).
 * `shutdown_force_fallback_used` aggregates via OR — any force-fallback
 * across the evidence set blocks deletion.
 */
export function aggregateDriverSummariesForDeletionReadiness(
  summaries: readonly DriverSummaryArtifact[],
  policy: DeletionReadinessPolicy = DEFAULT_DELETION_READINESS_POLICY,
): AggregateDriverSummaryDecision {
  let newInspected = 0;
  let newPhase3 = 0;
  let turnsFailed = 0;
  let turnsCancelled = 0;
  let turnsTimeout = 0;
  let turnsSubmitFailed = 0;
  let forceFallback = false;
  let gate = summaries.length > 0;
  const configuredLanguages = new Set<string>();
  const completedLanguages = new Set<string>();
  const cartridges = new Set<string>();
  const modelFamilies = new Set<string>();

  for (const s of summaries) {
    newInspected += asInt(s.new_inspected_events);
    newPhase3 += asInt(s.new_phase3_total);
    turnsFailed += asInt(s.turns_failed);
    turnsCancelled += asInt(s.turns_cancelled);
    turnsTimeout += asInt(s.turns_timeout);
    turnsSubmitFailed += asInt(s.turns_submit_failed);
    if (s.shutdown_force_fallback_used === true) forceFallback = true;
    if (s.ready_for_phase3_gate !== true) gate = false;
    for (const l of asStringArray(s.configured?.languages))
      configuredLanguages.add(l);
    for (const l of asStringArray(s.languages_completed))
      completedLanguages.add(l);
    for (const c of asStringArray(s.cartridges_attempted)) cartridges.add(c);
    for (const m of asStringArray(s.model_families_attempted))
      modelFamilies.add(m);
  }

  const decision = evaluateNarrateSanitiserDeletionReadiness({
    new_inspected_events: newInspected,
    new_phase3_total: newPhase3,
    turns_failed: turnsFailed,
    turns_cancelled: turnsCancelled,
    turns_timeout: turnsTimeout,
    turns_submit_failed: turnsSubmitFailed,
    shutdown_force_fallback_used: forceFallback,
    configured_languages: Array.from(configuredLanguages),
    languages_completed: Array.from(completedLanguages),
    cartridges_attempted: Array.from(cartridges),
    model_families_attempted: Array.from(modelFamilies),
    ready_for_phase3_gate: gate,
    policy,
  });

  return {
    ...decision,
    artifact_count: summaries.length,
    aggregated: {
      new_inspected_events: newInspected,
      new_phase3_total: newPhase3,
      turns_failed: turnsFailed,
      turns_cancelled: turnsCancelled,
      turns_timeout: turnsTimeout,
      turns_submit_failed: turnsSubmitFailed,
      shutdown_force_fallback_used: forceFallback,
      configured_languages: Array.from(configuredLanguages).sort(),
      languages_completed: Array.from(completedLanguages).sort(),
      cartridges_attempted: Array.from(cartridges).sort(),
      model_families_attempted: Array.from(modelFamilies).sort(),
      ready_for_phase3_gate: gate,
    },
  };
}
