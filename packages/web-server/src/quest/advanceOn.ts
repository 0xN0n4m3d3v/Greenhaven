/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-6 — shared resolver for quest stage `advance_on`. The runtime
// used to do `stage['advance_on'] === 'any_objective_complete' ? 'any'
// : 'all'`, which silently treated every misspelt / legacy value as
// `'all'` and made it impossible to catch authoring mistakes
// upstream. The cartridge validator now rejects unknown values; the
// runtime normalizer below mirrors the same allowlist so behaviour
// stays consistent between author-time and turn-time.
//
// Allowed values:
//   - `'any'` / `'any_objective_complete'`     → OR (any objective satisfied)
//   - `'all'` / `'all_objectives_complete'`    → AND (every objective satisfied)
//   - `null` / `undefined`                     → default to `'all'`
// Anything else throws so the broken stage is loud, not silent.

export type AdvanceMode = 'any' | 'all';

export const VALID_ADVANCE_ON_VALUES: readonly string[] = [
  'any',
  'all',
  'any_objective_complete',
  'all_objectives_complete',
];

export function isValidAdvanceOn(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    (VALID_ADVANCE_ON_VALUES as readonly string[]).includes(raw)
  );
}

export function resolveAdvanceMode(raw: unknown): AdvanceMode {
  if (raw == null) return 'all';
  if (raw === 'any' || raw === 'any_objective_complete') return 'any';
  if (raw === 'all' || raw === 'all_objectives_complete') return 'all';
  throw new Error(
    `invalid advance_on: ${JSON.stringify(raw)} (expected one of ${VALID_ADVANCE_ON_VALUES.join(', ')})`,
  );
}
