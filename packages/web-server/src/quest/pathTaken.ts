/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-5 — runtime cap for `player_quests.path_taken`. Without a cap
// every quest stage transition forever grew the JSONB array; a long-
// running save could end up with hundreds of entries and slow down
// reads / replication. The cap is 100 entries: once the array is
// full, subsequent advancements update the stage but skip the
// append (the breadcrumb stops, the quest continues).
//
// `safe_jsonb_array(...)` (migration 0110) defensively coerces a
// malformed `path_taken` (NULL, scalar, object) into `[]::jsonb`, so
// the length check and the concat both succeed even when an older
// row carries a non-array value.

export const PATH_TAKEN_CAP = 100;

/**
 * Returns the SQL expression that should replace a literal
 * `path_taken || jsonb_build_array(<entry>)` in an UPDATE. The
 * caller is responsible for building `entryExpr` from
 * `jsonb_build_object(...)` and any parameter placeholders the
 * surrounding query already exposes; this helper does NOT accept or
 * interpolate user-controlled SQL.
 *
 *   UPDATE player_quests
 *      SET path_taken = ${cappedPathTakenExpr("jsonb_build_object('at', now()::text, 'stage', $1)")}
 *    ...
 */
export function cappedPathTakenExpr(entryExpr: string): string {
  return (
    `CASE WHEN jsonb_array_length(safe_jsonb_array(path_taken)) >= ${PATH_TAKEN_CAP}` +
    ` THEN safe_jsonb_array(path_taken)` +
    ` ELSE safe_jsonb_array(path_taken) || jsonb_build_array(${entryExpr})` +
    ` END`
  );
}
