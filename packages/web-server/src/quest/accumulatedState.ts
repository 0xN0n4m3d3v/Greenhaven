/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-3 — atomic JSONB patch helper for `player_quests.accumulated_state`.
//
// Previously, every code path that touched the scratchpad followed a
// read-modify-write pattern: `SELECT accumulated_state`, mutate in
// JavaScript, `UPDATE accumulated_state = $::jsonb`. Two concurrent
// updaters racing on different keys would clobber each other because
// each wrote the WHOLE object. With the JSONB `||` merge operator we
// can patch only the keys we care about and let Postgres keep the
// rest untouched.
//
// The helper is intentionally small: one SQL statement, parameterised
// patch payload, optional list of keys to drop. Callers run it from
// inside the same `withTransaction(...)` as the rest of the QE-2
// mutation so rollback semantics remain a single boundary.

import type {TxClient} from '../db.js';

export async function patchAccumulatedState(
  tx: TxClient,
  playerId: number,
  questEntityId: number,
  patch: Record<string, unknown>,
  removeKeys: readonly string[] = [],
): Promise<void> {
  const params: unknown[] = [JSON.stringify(patch)];
  // The merge MUST be parenthesised: in Postgres the jsonb `-`
  // (key-removal) operator binds tighter than `||` (concatenation),
  // so `a || b - 'k'` would parse as `a || (b - 'k')` and leave the
  // existing `k` in `a` untouched. Wrapping forces the removal to
  // apply to the merge result.
  let expr = `(COALESCE(accumulated_state, '{}'::jsonb) || $1::jsonb)`;
  for (const key of removeKeys) {
    params.push(key);
    expr += ` - $${params.length}::text`;
  }
  params.push(playerId);
  const playerParam = `$${params.length}`;
  params.push(questEntityId);
  const questParam = `$${params.length}`;
  await tx.query(
    `UPDATE player_quests
        SET accumulated_state = ${expr}
      WHERE player_id = ${playerParam}
        AND quest_entity_id = ${questParam}`,
    params,
  );
}
