/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Forward-chaining transition evaluator.
//
// The cartridge declares transitions in the `transitions` table:
//   when_json: [{field_id, op, value}, ...]   (AND of predicates)
//   set_json:  [{field_id, value}, ...]        (patches to apply)
//   priority:  higher fires first within a pass
//
// After every runtime-field write (set_runtime_field, apply_runtime_field_patch),
// the engine runs a fixpoint pass: scan all transitions, fire those whose
// predicates match, repeat until no transition changes any value. Capped
// at MAX_ITERATIONS to defend against contradicting rules in malformed
// cartridges.
//
// Per spec 0001_cartridge.sql: "Re-evaluated to fixpoint after each
// model patch." That's this module — the missing piece between the
// schema and the cartridge's expected behaviour.
//
// Predicates and patches operate against the SAME runtime-value
// resolution as `get_runtime_field`: per-player overlay > global value
// > field default. Writes go to overlay vs global based on
// `runtime_fields.scope_per_player`.

import {
  getMeta,
  getWorldClockConfig,
} from './cartridge.js';
import {query} from './db.js';
import {
  emitFieldChange,
  emitFieldChanges,
  emitFieldChangesById,
  type RuntimeFieldChangeById,
} from './runtimeFieldEvents.js';
import {validateRuntimeFieldValue} from './runtimeFieldValidation.js';
import {telemetry} from './telemetry/index.js';

const MAX_ITERATIONS = 50;

interface Predicate {
  field_id: number;
  op: string;
  value: unknown;
}

interface Patch {
  field_id: number;
  value: unknown;
}

interface TransitionRow {
  id: number;
  description: string | null;
  when_json: Predicate[];
  set_json: Patch[];
  priority: number;
}

export interface EvalResult {
  fired: Array<{transition_id: number; description: string | null}>;
  iterations: number;
  capped: boolean;
}

/**
 * Spec 32 — world-clock tick. Increments world_time_minutes by 10 per
 * turn, recomputes time_of_day, and emits runtime:field for both so
 * the UI atmosphere overlay smooth-transitions. Called once per turn
 * boundary by turnRunnerV2 alongside decrementConditions.
 */
export async function tickWorldClock(sessionId: string): Promise<void> {
  try {
    // ARCH-9 — `world_entity_id` and clock pacing live in
    // `cartridge_meta`. Obsidian-imported cartridges are allowed to
    // omit a world-clock entity; in that case ticking is simply
    // disabled instead of logging a recoverable failure every turn.
    const worldEntityId = await getMeta<number | null>(
      'world_entity_id',
      null,
    );
    if (worldEntityId == null) return;
    const {tickMinutes, defaultMinutes} = await getWorldClockConfig();
    const fields = await query<{
      id: number;
      field_key: string;
      value: unknown;
      default_value: unknown;
    }>(
      `SELECT rf.id, rf.field_key, rv.value, rf.default_value
         FROM runtime_fields rf
         LEFT JOIN runtime_values rv ON rv.field_id = rf.id
        WHERE rf.owner_entity_id = $1
          AND rf.field_key IN ('world_time_minutes', 'time_of_day')`,
      [worldEntityId],
    );
    const minutesField = fields.rows.find(
      row => row.field_key === 'world_time_minutes',
    );
    const timeField = fields.rows.find(row => row.field_key === 'time_of_day');
    if (!minutesField || !timeField) return;
    const cur = Number(
      minutesField.value ?? minutesField.default_value ?? defaultMinutes,
    );
    const next = (cur + tickMinutes) % 1440;
    await query(
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, $2::jsonb, 'clock', now())
       ON CONFLICT (field_id) DO UPDATE
         SET value = EXCLUDED.value, source = 'clock', updated_at = now()`,
      [minutesField.id, JSON.stringify(next)],
    );
    const tod =
      next < 240
        ? 'midnight'
        : next < 360
          ? 'dawn'
          : next < 540
            ? 'morning'
            : next < 780
              ? 'noon'
              : next < 1020
                ? 'afternoon'
                : next < 1200
                  ? 'dusk'
                  : next < 1380
                    ? 'night'
                    : 'midnight';
    await query(
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, $2::jsonb, 'clock', now())
       ON CONFLICT (field_id) DO UPDATE
         SET value = EXCLUDED.value, source = 'clock', updated_at = now()`,
      [timeField.id, JSON.stringify(tod)],
    );
    emitFieldChange(sessionId, {
      owner_entity_id: worldEntityId,
      field_key: 'world_time_minutes',
      value: next,
      source: 'clock',
    });
    emitFieldChange(sessionId, {
      owner_entity_id: worldEntityId,
      field_key: 'time_of_day',
      value: tod,
      source: 'clock',
    });
  } catch (err) {
    // CATCH-WARN-OK: world-clock tick is a per-turn boundary helper that already fails-open; broker continues with previous tod. Wider telemetry on transition errors is recorded via the ARCH-10 `transitionEngine.fixpoint_failed` channel inside `runTransitions`.
    console.warn('[transitionEngine] tickWorldClock failed:', err);
  }
}

/**
 * Spec 33 — drop expired environmental surfaces from every location's
 * `active_surfaces` runtime_value. Same per-turn-boundary pattern as
 * decrementConditions.
 */
export async function decrementSurfaces(sessionId: string): Promise<void> {
  // TE-3 — `stage` and `currentTurn` survive the catch so the
  // swallow telemetry can tell ops which step failed.
  let stage: 'load_turn' | 'apply_decay' | 'emit' = 'load_turn';
  let currentTurn: number | null = null;
  try {
    const turnRow = await query<{turn_no: number}>(
      `SELECT COALESCE(MAX(turn_index), 0) AS turn_no
         FROM chat_messages WHERE session_id = $1`,
      [sessionId],
    );
    currentTurn = Number(turnRow.rows[0]?.turn_no ?? 0);
    stage = 'apply_decay';
    const changed = await query<{
      owner_entity_id: number;
      field_key: string;
      value: unknown;
    }>(
      `WITH trimmed AS (
         SELECT rv.field_id,
                COALESCE(
                  jsonb_agg(s) FILTER (WHERE (s->>'expires_turn')::int > $1),
                  '[]'::jsonb
                ) AS value
           FROM runtime_values rv
           JOIN runtime_fields rf ON rf.id = rv.field_id
           CROSS JOIN LATERAL jsonb_array_elements(rv.value) AS s
          WHERE rf.field_key = 'active_surfaces'
            AND rv.value IS NOT NULL
            AND jsonb_typeof(rv.value) = 'array'
          GROUP BY rv.field_id
       ),
       updated AS (
         UPDATE runtime_values rv
            SET value = trimmed.value,
                source = 'surface_decay',
                updated_at = now()
           FROM trimmed
          WHERE rv.field_id = trimmed.field_id
            AND rv.value IS DISTINCT FROM trimmed.value
          RETURNING rv.field_id, rv.value
       )
       SELECT rf.owner_entity_id, rf.field_key, updated.value
         FROM updated
         JOIN runtime_fields rf ON rf.id = updated.field_id`,
      [currentTurn],
    );
    stage = 'emit';
    emitFieldChanges(
      sessionId,
      changed.rows.map(row => ({
        owner_entity_id: row.owner_entity_id,
        field_key: row.field_key,
        value: row.value,
        source: 'surface_decay',
      })),
    );
  } catch (err) {
    console.warn('[transitionEngine] decrementSurfaces failed:', err);
    // TE-3 — best-effort swallow stays in place; the structured
    // gameplay event lets ops spot recurring decay failures
    // without grepping `console.warn`.
    telemetry.record({
      channel: 'gameplay',
      name: 'transition_engine.decrement_surfaces_failed',
      sessionId,
      error: err,
      data: {
        function: 'decrementSurfaces',
        stage,
        current_turn: currentTurn,
      },
    });
  }
}

/**
 * Spec 17 — drop expired conditions from every NPC's `conditions`
 * runtime_value. Called once per turn boundary by turnRunnerV2 (NOT
 * inside the per-mutation fixpoint, which would compound and decay
 * conditions multiple times per turn).
 */
export async function decrementConditions(sessionId: string): Promise<void> {
  // TE-3 — see decrementSurfaces for the stage/currentTurn rationale.
  let stage: 'load_turn' | 'apply_decay' | 'emit' = 'load_turn';
  let currentTurn: number | null = null;
  try {
    const turnRow = await query<{turn_no: number}>(
      `SELECT COALESCE(MAX(turn_index), 0) AS turn_no
         FROM chat_messages WHERE session_id = $1`,
      [sessionId],
    );
    currentTurn = Number(turnRow.rows[0]?.turn_no ?? 0);
    stage = 'apply_decay';
    const changed = await query<{
      owner_entity_id: number;
      field_key: string;
      value: unknown;
    }>(
      `WITH trimmed AS (
         SELECT rv.field_id,
                COALESCE(
                  jsonb_agg(c) FILTER (WHERE (c->>'expires_turn')::int > $1),
                  '[]'::jsonb
                ) AS value
           FROM runtime_values rv
           JOIN runtime_fields rf ON rf.id = rv.field_id
           CROSS JOIN LATERAL jsonb_array_elements(rv.value) AS c
          WHERE rf.field_key = 'conditions'
            AND rv.value IS NOT NULL
            AND jsonb_typeof(rv.value) = 'array'
          GROUP BY rv.field_id
       ),
       updated AS (
         UPDATE runtime_values rv
            SET value = trimmed.value,
                source = 'condition_decay',
                updated_at = now()
           FROM trimmed
          WHERE rv.field_id = trimmed.field_id
            AND rv.value IS DISTINCT FROM trimmed.value
          RETURNING rv.field_id, rv.value
       )
       SELECT rf.owner_entity_id, rf.field_key, updated.value
         FROM updated
         JOIN runtime_fields rf ON rf.id = updated.field_id`,
      [currentTurn],
    );
    stage = 'emit';
    emitFieldChanges(
      sessionId,
      changed.rows.map(row => ({
        owner_entity_id: row.owner_entity_id,
        field_key: row.field_key,
        value: row.value,
        source: 'condition_decay',
      })),
    );
  } catch (err) {
    console.warn('[transitionEngine] decrementConditions failed:', err);
    // TE-3 — best-effort swallow stays in place; structured event
    // makes recurring decay failures observable without grepping.
    telemetry.record({
      channel: 'gameplay',
      name: 'transition_engine.decrement_conditions_failed',
      sessionId,
      error: err,
      data: {
        function: 'decrementConditions',
        stage,
        current_turn: currentTurn,
      },
    });
  }
}

/**
 * Run the fixpoint evaluator for one player. Best-effort — failures
 * are logged but do not propagate to the caller (a transition bug
 * shouldn't break the player's mutation that triggered the eval).
 */
export async function evaluateTransitions(
  playerId: number,
  sessionId?: string,
): Promise<EvalResult> {
  const fired: Array<{transition_id: number; description: string | null}> = [];
  let iter = 0;
  let capped = false;
  const pendingEvents = new Map<number, RuntimeFieldChangeById>();
  try {
    // TE-1 — cache transitions once per evaluator invocation. The
    // cartridge declares the table at boot and rows do not mutate
    // during a turn, so re-fetching per fixpoint pass was waste.
    const transitionsResult = await query<TransitionRow>(
      `SELECT id, description, when_json, set_json, priority
         FROM transitions
        ORDER BY priority DESC, id ASC`,
    );
    const transitions = transitionsResult.rows;

    // TE-2 — snapshot every runtime field once per invocation. The
    // fixpoint loop then reads predicates and applies patches
    // entirely in memory; the only writes happen in one batched
    // flush after the loop converges. Result: O(1) DB round trips
    // per invocation regardless of transition count or pass count
    // (one transitions query, one snapshot query, one flush when
    // anything is dirty).
    const snapshot = await loadFieldSnapshot(playerId);
    const dirty = new Map<number, DirtyField>();

    for (; iter < MAX_ITERATIONS; iter++) {
      let firedThisPass = 0;
      for (const t of transitions) {
        if (!predicatesMatchInMemory(t.when_json, snapshot)) continue;
        const changed = applyPatchesInMemory(
          t.set_json,
          snapshot,
          dirty,
          pendingEvents,
          `transition:${t.id}`,
        );
        if (changed > 0) {
          firedThisPass++;
          fired.push({transition_id: t.id, description: t.description});
        }
      }
      if (firedThisPass === 0) break;
    }
    if (iter >= MAX_ITERATIONS) {
      capped = true;
      console.warn(
        `[transitionEngine] MAX_ITERATIONS (${MAX_ITERATIONS}) hit for player ${playerId} — likely a contradicting transition pair in the cartridge.`,
      );
      // ARCH-10 — durable structured signal so ops can spot
      // contradicting-transition cartridges without grepping for
      // the `console.warn`. Fire-and-forget through the ARCH-2
      // facade; the sink swallows its own failures.
      telemetry.record({
        channel: 'gameplay',
        name: 'transition_engine.iteration_cap_reached',
        sessionId: sessionId ?? null,
        playerId,
        data: {
          iterations: iter,
          max_iterations: MAX_ITERATIONS,
          fired_count: fired.length,
          last_transition: fired[fired.length - 1] ?? null,
        },
      });
    }

    // TE-2 — single batched flush. Skipped when nothing changed.
    if (dirty.size > 0) {
      await flushDirtyFields(dirty, playerId);
    }

    // TE-2 follow-up — `runtime:field` SSE only emits after the
    // batched flush succeeds. If `flushDirtyFields` above throws,
    // the outer `catch` logs the failure and this block is bypassed
    // entirely, so the UI never observes a transition-applied value
    // that the DB rejected. The inner try/catch still surfaces SSE
    // bridge failures (e.g. session gone, queue full) without
    // escalating.
    if (sessionId && pendingEvents.size > 0) {
      try {
        await emitFieldChangesById(sessionId, [...pendingEvents.values()]);
      } catch (err) {
        // CATCH-WARN-OK: the outer try at line 408 records the fixpoint failure through `console.error` (matched by the ARCH-10 `transitionEngine.fixpoint_failed` telemetry channel above); annotating here keeps the inner non-fatal SSE emit warning surfaced without double-recording.
        console.warn('[transitionEngine] runtime:field emit failed:', err);
      }
    }
  } catch (err) {
    console.error('[transitionEngine] fixpoint failed:', err);
  }
  return {fired, iterations: iter, capped};
}

interface FieldSnapshot {
  field_id: number;
  field_key: string;
  value_type: string;
  allowed_values: unknown[] | null;
  scope_per_player: boolean;
  default_value: unknown;
  overlay_value: unknown;
  global_value: unknown;
  /** Resolved value following the same per-player overlay > global
   *  > default chain as `get_runtime_field`. The fixpoint loop reads
   *  and mutates this in place; the flush at the end of the loop
   *  walks `dirty` to persist whichever fields changed. */
  currentValue: unknown;
}

interface DirtyField {
  field_id: number;
  value: unknown;
  source: string;
  scope_per_player: boolean;
}

async function loadFieldSnapshot(
  playerId: number,
): Promise<Map<number, FieldSnapshot>> {
  const rows = await query<{
    field_id: number | string;
    field_key: string;
    value_type: string;
    allowed_values: unknown[] | null;
    scope_per_player: boolean;
    default_value: unknown;
    overlay_value: unknown;
    global_value: unknown;
  }>(
    `SELECT f.id AS field_id,
            f.field_key,
            f.value_type,
            f.allowed_values,
            f.scope_per_player,
            f.default_value,
            o.value AS overlay_value,
            v.value AS global_value
       FROM runtime_fields f
       LEFT JOIN runtime_values v
              ON v.field_id = f.id
       LEFT JOIN runtime_player_overlay o
              ON o.field_id = f.id AND o.player_id = $1`,
    [playerId],
  );
  const snapshot = new Map<number, FieldSnapshot>();
  for (const row of rows.rows) {
    const field_id = Number(row.field_id);
    const currentValue = resolveFieldValue(row);
    snapshot.set(field_id, {
      field_id,
      field_key: row.field_key,
      value_type: row.value_type,
      allowed_values: row.allowed_values,
      scope_per_player: row.scope_per_player,
      default_value: row.default_value,
      overlay_value: row.overlay_value,
      global_value: row.global_value,
      currentValue,
    });
  }
  return snapshot;
}

function resolveFieldValue(row: {
  scope_per_player: boolean;
  default_value: unknown;
  overlay_value: unknown;
  global_value: unknown;
}): unknown {
  if (row.scope_per_player && row.overlay_value !== null) return row.overlay_value;
  if (row.global_value !== null) return row.global_value;
  return row.default_value;
}

function predicatesMatchInMemory(
  predicates: Predicate[] | null,
  snapshot: Map<number, FieldSnapshot>,
): boolean {
  if (!predicates || predicates.length === 0) return true;
  for (const p of predicates) {
    const field = snapshot.get(p.field_id);
    const actual = field ? field.currentValue : null;
    if (!opMatches(actual, p.op, p.value)) return false;
  }
  return true;
}

/**
 * Apply every patch in order, mutating both the in-memory snapshot
 * and the `dirty` / `pendingEvents` maps. Returns the count of
 * patches that actually changed a value; callers treat any non-zero
 * count as "this transition fired this pass". Unknown field ids and
 * `validateRuntimeFieldValue` rejections are warned-and-skipped,
 * exactly matching the pre-TE-2 behavior.
 */
function applyPatchesInMemory(
  patches: Patch[] | null,
  snapshot: Map<number, FieldSnapshot>,
  dirty: Map<number, DirtyField>,
  pendingEvents: Map<number, RuntimeFieldChangeById>,
  source: string,
): number {
  if (!patches || patches.length === 0) return 0;
  let changedCount = 0;
  for (const p of patches) {
    const field = snapshot.get(p.field_id);
    if (!field) {
      console.warn(
        `[transitionEngine] unknown field_id ${p.field_id} in patch — skipping`,
      );
      continue;
    }
    if (jsonEqual(field.currentValue, p.value)) continue;
    const validation = validateRuntimeFieldValue(
      {
        id: field.field_id,
        field_key: field.field_key,
        value_type: field.value_type,
        allowed_values: field.allowed_values,
      },
      p.value,
    );
    if (!validation.ok) {
      console.warn(
        `[transitionEngine] field_id ${p.field_id} (${field.field_key}) rejected transition value ${JSON.stringify(p.value)}: ${validation.reason}`,
      );
      continue;
    }
    field.currentValue = p.value;
    dirty.set(p.field_id, {
      field_id: p.field_id,
      value: p.value,
      source,
      scope_per_player: field.scope_per_player,
    });
    pendingEvents.set(p.field_id, {
      field_id: p.field_id,
      value: p.value,
      source,
    });
    changedCount += 1;
  }
  return changedCount;
}

/**
 * TE-2 — write every dirty field in one statement.
 *
 * The payload is a JSONB array of `{field_id, value, source,
 * scope_per_player}` records. `jsonb_to_recordset` deserialises it
 * into a typed CTE that two data-modifying CTEs split into the
 * `runtime_player_overlay` / `runtime_values` tables based on the
 * `scope_per_player` flag. PostgreSQL guarantees both CTEs execute
 * even though the final `SELECT 1` does not reference them.
 */
async function flushDirtyFields(
  dirty: Map<number, DirtyField>,
  playerId: number,
): Promise<void> {
  const payload = [...dirty.values()].map((d) => ({
    field_id: d.field_id,
    value: d.value,
    source: d.source,
    scope_per_player: d.scope_per_player,
  }));
  await query(
    `WITH dirty AS (
       SELECT field_id, value, source, scope_per_player
         FROM jsonb_to_recordset($1::jsonb)
           AS x(field_id bigint, value jsonb, source text, scope_per_player boolean)
     ),
     overlay_writes AS (
       INSERT INTO runtime_player_overlay (field_id, player_id, value, source, updated_at)
       SELECT field_id, $2::bigint, value, source, now()
         FROM dirty
        WHERE scope_per_player
       ON CONFLICT (field_id, player_id)
       DO UPDATE SET value = EXCLUDED.value,
                     source = EXCLUDED.source,
                     updated_at = now()
       RETURNING 1
     ),
     global_writes AS (
       INSERT INTO runtime_values (field_id, value, source, updated_at)
       SELECT field_id, value, source, now()
         FROM dirty
        WHERE NOT scope_per_player
       ON CONFLICT (field_id)
       DO UPDATE SET value = EXCLUDED.value,
                     source = EXCLUDED.source,
                     updated_at = now()
       RETURNING 1
     )
     SELECT 1`,
    [JSON.stringify(payload), playerId],
  );
}

function opMatches(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return jsonEqual(actual, expected);
    case 'ne':
      return !jsonEqual(actual, expected);
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'in':
      return Array.isArray(expected) && expected.some(v => jsonEqual(actual, v));
    case 'not_in':
      return Array.isArray(expected) && !expected.some(v => jsonEqual(actual, v));
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    default:
      console.warn(`[transitionEngine] unknown predicate op '${op}' — treating as false`);
      return false;
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// TE-2 — the obsolete per-predicate `readFieldValue` and per-patch
// `applyPatchesIfChanged` helpers were removed. The fixpoint loop
// now reads predicates / applies patches against the in-memory
// `FieldSnapshot` built once per invocation and persists every
// dirty field through `flushDirtyFields(...)` in a single batched
// statement.
