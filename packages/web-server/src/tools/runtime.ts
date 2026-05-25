/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Runtime field tools — read & write the world's state machine.
//
// Per-player overlay logic:
//   - get_runtime_field(field_id) → checks runtime_player_overlay first
//     (filtered by ctx.playerId), falls back to runtime_values, then
//     to runtime_fields.default_value.
//   - set_runtime_field looks at runtime_fields.scope_per_player to
//     decide which table to write to.

import {z} from 'zod';
import {query, withTransaction, type TxClient} from '../db.js';
import {
  emitFieldChangesById,
  type RuntimeFieldChangeById,
} from '../runtimeFieldEvents.js';
import {validateRuntimeFieldValue} from '../runtimeFieldValidation.js';
import {evaluateTransitions} from '../transitionEngine.js';
import {registerTool, ToolExecutionError} from './base.js';

const GetFieldArgs = z.object({
  field_id: z.number().int().positive(),
});

registerTool({
  name: 'get_runtime_field',
  description:
    "Read a runtime field's current value and metadata. Resolves per-player overlay if scoped, otherwise the global value, otherwise the default. Use returned field_id/value_type/allowed_values exactly; do not invent runtime fields.",
  paramsSchema: GetFieldArgs,
  async execute(args, ctx) {
    const r = await query<{
      field_key: string;
      value_type: string;
      scope_per_player: boolean;
      default_value: unknown;
      allowed_values: unknown[] | null;
      description: string | null;
      overlay_value: unknown;
      global_value: unknown;
    }>(
      `SELECT
         f.field_key, f.value_type, f.scope_per_player, f.default_value,
         f.allowed_values, f.description,
         o.value AS overlay_value,
         v.value AS global_value
       FROM runtime_fields f
       LEFT JOIN runtime_player_overlay o
              ON o.field_id = f.id AND o.player_id = $2
       LEFT JOIN runtime_values v
              ON v.field_id = f.id
       WHERE f.id = $1`,
      [args.field_id, ctx.playerId],
    );
    if (r.rows.length === 0) {
      return {found: false, error: `unknown field_id ${args.field_id}`};
    }
    const row = r.rows[0]!;
    let value = row.default_value;
    let source: 'overlay' | 'global' | 'default' = 'default';
    if (row.scope_per_player && row.overlay_value !== null) {
      value = row.overlay_value;
      source = 'overlay';
    } else if (row.global_value !== null) {
      value = row.global_value;
      source = 'global';
    }
    return {
      found: true,
      field_id: args.field_id,
      field_key: row.field_key,
      value_type: row.value_type,
      allowed_values: row.allowed_values,
      description: row.description,
      value,
      source,
    };
  },
});

const SetFieldArgs = z.object({
  field_id: z.number().int().positive(),
  value: z.unknown(),
  /**
   * Force where to write — per_player or global. If omitted, falls back
   * to the field's declared scope.
   */
  scope: z.enum(['per_player', 'global']).optional(),
  /** Free-text reason for the audit log + telemetry. */
  source: z.string().optional(),
});

registerTool({
  name: 'set_runtime_field',
  description:
    'Set a listed runtime field by numeric field_id. By default writes to per-player overlay if the field is scope_per_player, otherwise to the global value. Pass scope to override. Never guess field ids or values; read query_entity/query_player_state/get_runtime_field and obey value_type plus allowed_values.',
  paramsSchema: SetFieldArgs,
  async execute(args, ctx) {
    const f = await query<{
      id: number;
      field_key: string;
      value_type: string;
      scope_per_player: boolean;
      allowed_values: unknown[] | null;
    }>(
      `SELECT id, field_key, value_type, scope_per_player, allowed_values
         FROM runtime_fields WHERE id = $1`,
      [args.field_id],
    );
    if (f.rows.length === 0) {
      throw unknownRuntimeFieldError(args.field_id);
    }
    const row = f.rows[0]!;
    const scope = args.scope ?? (row.scope_per_player ? 'per_player' : 'global');

    const validation = validateRuntimeFieldValue(row, args.value);
    if (!validation.ok) {
      throw invalidRuntimeFieldValueError(row, args.value, validation.reason);
    }

    const valueJson = JSON.stringify(args.value);
    const sourceTag = args.source ?? 'tool_apply';

    if (scope === 'per_player') {
      await query(
        `INSERT INTO runtime_player_overlay (field_id, player_id, value, source, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (field_id, player_id)
         DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
        [args.field_id, ctx.playerId, valueJson, sourceTag],
      );
    } else {
      await query(
        `INSERT INTO runtime_values (field_id, value, source, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (field_id)
         DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
        [args.field_id, valueJson, sourceTag],
      );
    }

    // Forward-chaining: re-evaluate cartridge transitions to fixpoint.
    // A field write may make a transition's `when_json` predicates true,
    // which auto-advances dependent state (e.g. payment_confirmed=true
    // → quest_phase='service') without the model having to chain calls.
    await emitFieldChangesById(ctx.sessionId, [
      {
        field_id: args.field_id,
        value: args.value,
        source: sourceTag,
      },
    ]);
    const evalResult = await evaluateTransitions(ctx.playerId, ctx.sessionId);
    return {
      field_id: args.field_id,
      scope,
      value: args.value,
      transitions_fired: evalResult.fired,
    };
  },
});

// ── apply_runtime_field_patch ──────────────────────────────────────────
// Batch helper for the common "advance a quest stage" pattern: a recipe
// like Mikka's PAYMENT-ACCEPTED sets four fields (offered_gold,
// payment_confirmed, service_tier, next_step) in one logical step.
// Calling set_runtime_field four times works but burns four tool
// rounds and the model is more likely to forget one. apply_runtime_field_patch
// takes an array, walks each patch through the same scope/allowed-values
// gate, and returns a per-patch report so the model can confirm the
// whole tier landed.

const PatchEntry = z.object({
  field_id: z.number().int().positive(),
  value: z.unknown(),
  scope: z.enum(['per_player', 'global']).optional(),
  /** How to combine the patch value with the existing field value:
   *    set     — replace whole value (default; current behaviour)
   *    append  — push value onto an existing JSONB array (creates [] if null)
   *    remove  — drop array elements that match value (deep-equal) OR object
   *              keys equal to value (when existing is an object)
   *    merge   — shallow-merge value (object) into existing object
   *  Used by Conditions (append, spec 17), Strings (merge object key, spec 18),
   *  Trauma (append, spec 20). Other shapes fall back to set.
   *  Non-'set' ops only target the global runtime_values row today;
   *  per-player overlay extension is deferred to a future spec. */
  op: z.enum(['set', 'append', 'remove', 'merge']).default('set'),
});

const ApplyPatchArgs = z.object({
  patches: z.array(PatchEntry).min(1),
  source: z.string().optional(),
});

function unknownRuntimeFieldError(fieldId: number): ToolExecutionError {
  return new ToolExecutionError(`unknown field_id ${fieldId}`, {
    rejected: true,
    suggestion: {
      field_id: fieldId,
      error: 'unknown_field_id',
      retry: {
        tool: 'query_entity',
        reason: 'read the target entity runtime_fields and use a listed field_id',
      },
    },
  });
}

function invalidRuntimeFieldValueError(
  field: {
    id: number;
    field_key: string;
    value_type: string;
    allowed_values: unknown[] | null;
  },
  value: unknown,
  reason?: string,
): ToolExecutionError {
  return new ToolExecutionError(
    `field ${field.id} (${field.field_key}) rejects ${JSON.stringify(value)}; expected ${field.value_type}${
      Array.isArray(field.allowed_values)
        ? ` in ${JSON.stringify(field.allowed_values)}`
        : ''
    }${reason ? ` (${reason})` : ''}`,
    {
      rejected: true,
      suggestion: {
        field_id: field.id,
        field_key: field.field_key,
        expected_type: field.value_type,
        allowed_values: field.allowed_values,
        received_value: value,
        retry: Array.isArray(field.allowed_values)
          ? {value: field.allowed_values[0] ?? null}
          : {tool: 'get_runtime_field', field_id: field.id},
      },
    },
  );
}

function resolveRuntimePatchSentinel(value: unknown, playerId: number): unknown {
  return value === 'add_current_player' ? playerId : value;
}

registerTool({
  name: 'apply_runtime_field_patch',
  description:
    'Set multiple runtime fields atomically. Use this when a quest stage advances ' +
    'or a scene flips into a new mode and several fields move together (e.g. payment_confirmed=true, ' +
    'service_tier="extended", next_step="service" all in one beat). Each patch obeys the field\'s ' +
    'scope_per_player declaration unless `scope` is overridden. Returns one entry per patch with ' +
    "the resolved scope and the value that landed; if any single patch's value violates allowed_values " +
    'the whole call fails (no partial writes). Use only field_id values returned by runtime context/tools; do not convert field names or narrative states into guessed ids.',
  paramsSchema: ApplyPatchArgs,
  async execute(args, ctx) {
    const patches = args.patches.map(p => ({
      ...p,
      value: resolveRuntimePatchSentinel(p.value, ctx.playerId),
    }));
    interface FieldMeta {
      id: number;
      field_key: string;
      value_type: string;
      scope_per_player: boolean;
      allowed_values: unknown[] | null;
    }

    // Pre-load every field meta in one round trip, then validate before
    // any write — keeps the call all-or-nothing in spirit (PGlite has
    // no first-class multi-statement transaction in this codebase, but
    // a pre-validate ensures we never half-apply).
    const ids = patches.map(p => p.field_id);
    const meta = await query<FieldMeta>(
      `SELECT id, field_key, value_type, scope_per_player, allowed_values
         FROM runtime_fields
        WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    const metaById = new Map<number, FieldMeta>();
    for (const m of meta.rows) metaById.set(m.id, m);

    for (const p of patches) {
      const m = metaById.get(p.field_id);
      if (!m) throw unknownRuntimeFieldError(p.field_id);
      const validation = validateRuntimeFieldValue(m, p.value);
      if (!validation.ok) {
        throw invalidRuntimeFieldValueError(m, p.value, validation.reason);
      }
    }

    const sourceTag = args.source ?? 'tool_apply_patch';
    const applied: Array<{field_id: number; scope: string; value: unknown}> = [];
    const eventChanges: RuntimeFieldChangeById[] = [];
    // Wrap the writes in a single transaction so a partial failure
    // mid-loop rolls back every prior patch instead of leaving the
    // quest in a half-advanced state. Pattern C from
    // plans/multi-user-scaling/03-shared-state-and-races.md.
    // Spec 71 - collect field ids so the shared runtime event helper can
    // emit final runtime:field values after the transaction commits.
    await withTransaction(async client => {
      for (const p of patches) {
        const m = metaById.get(p.field_id)!;
        const scope = p.scope ?? (m.scope_per_player ? 'per_player' : 'global');
        const op = p.op ?? 'set';
        const valueJson = JSON.stringify(p.value);
        if (op !== 'set') {
          // Array / object ops on the global runtime_values row.
          await applyPatchRawWithClient(
            client,
            p.field_id,
            p.value,
            op,
            sourceTag,
          );
        } else if (scope === 'per_player') {
          await client.query(
            `INSERT INTO runtime_player_overlay (field_id, player_id, value, source, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, now())
             ON CONFLICT (field_id, player_id)
             DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
            [p.field_id, ctx.playerId, valueJson, sourceTag],
          );
        } else {
          await client.query(
            `INSERT INTO runtime_values (field_id, value, source, updated_at)
             VALUES ($1, $2::jsonb, $3, now())
             ON CONFLICT (field_id)
             DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
            [p.field_id, valueJson, sourceTag],
          );
        }
        applied.push({field_id: p.field_id, scope, value: p.value});
        eventChanges.push(
          op === 'set'
            ? {field_id: p.field_id, value: p.value, source: sourceTag}
            : {field_id: p.field_id, source: sourceTag},
        );
      }
    });

    // Spec 30 — fan out runtime:field events post-commit. Skip per-
    // player-overlay writes for now (UI doesn't subscribe to those).
    await emitFieldChangesById(ctx.sessionId, eventChanges);

    // Fixpoint forward-chaining after the batch commits. Any transition
    // whose predicates now match auto-fires (potentially cascading
    // through several rules). Returned to the model so it knows what
    // the cartridge resolved on its own — narrate accordingly.
    const evalResult = await evaluateTransitions(ctx.playerId, ctx.sessionId);
    return {applied, transitions_fired: evalResult.fired};
  },
});

// ── applyPatchRaw / applyPatchRawWithClient ────────────────────────────
// Internal helpers exported for tools that need direct array/object ops
// on a runtime_values row WITHOUT going through the full
// apply_runtime_field_patch validation path. Used by combat.ts (spec 17
// conditions append), and future spec 18 / 20 / 35 callers.
//
// All ops target the global runtime_values row (per-player array ops are
// deferred). Caller is responsible for resolving the field_id and for
// providing a useful source tag.

export type PatchOp = 'set' | 'append' | 'remove' | 'merge';

/** Single-shot variant: opens its own connection. */
export async function applyPatchRaw(
  fieldId: number,
  value: unknown,
  op: PatchOp,
  sourceTag: string,
): Promise<void> {
  const json = JSON.stringify(value);
  if (op === 'append') {
    await query(
      // M-6 follow-up: safe_jsonb_array hardens append over a
      // preexisting non-array runtime value so the result stays an
      // array containing only valid prior entries plus the new one.
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, jsonb_build_array($2::jsonb), $3, now())
       ON CONFLICT (field_id)
       DO UPDATE SET value = safe_jsonb_array(runtime_values.value)
                             || jsonb_build_array($2::jsonb),
                     source = EXCLUDED.source,
                     updated_at = now()`,
      [fieldId, json, sourceTag],
    );
  } else if (op === 'remove') {
    await query(
      `UPDATE runtime_values
          SET value = (
            CASE jsonb_typeof(value)
              WHEN 'array'  THEN (
                SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
                  FROM jsonb_array_elements(value) e
                 WHERE e <> $1::jsonb
              )
              WHEN 'object' THEN value - ($1#>>'{}')
              ELSE value
            END),
              source = $3,
              updated_at = now()
        WHERE field_id = $2`,
      [json, fieldId, sourceTag],
    );
  } else if (op === 'merge') {
    await query(
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (field_id)
       DO UPDATE SET value = COALESCE(runtime_values.value, '{}'::jsonb)
                             || EXCLUDED.value,
                     source = EXCLUDED.source,
                     updated_at = now()`,
      [fieldId, json, sourceTag],
    );
  } else {
    await query(
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (field_id)
       DO UPDATE SET value = EXCLUDED.value,
                     source = EXCLUDED.source,
                     updated_at = now()`,
      [fieldId, json, sourceTag],
    );
  }
}

/** Tx-scoped variant: routes through the caller's transaction client. */
export async function applyPatchRawWithClient(
  client: TxClient,
  fieldId: number,
  value: unknown,
  op: PatchOp,
  sourceTag: string,
): Promise<void> {
  const json = JSON.stringify(value);
  if (op === 'append') {
    await client.query(
      // M-6 follow-up: safe_jsonb_array hardens append over a
      // preexisting non-array runtime value (tx-scoped variant).
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, jsonb_build_array($2::jsonb), $3, now())
       ON CONFLICT (field_id)
       DO UPDATE SET value = safe_jsonb_array(runtime_values.value)
                             || jsonb_build_array($2::jsonb),
                     source = EXCLUDED.source,
                     updated_at = now()`,
      [fieldId, json, sourceTag],
    );
  } else if (op === 'remove') {
    await client.query(
      `UPDATE runtime_values
          SET value = (
            CASE jsonb_typeof(value)
              WHEN 'array'  THEN (
                SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
                  FROM jsonb_array_elements(value) e
                 WHERE e <> $1::jsonb
              )
              WHEN 'object' THEN value - ($1#>>'{}')
              ELSE value
            END),
              source = $3,
              updated_at = now()
        WHERE field_id = $2`,
      [json, fieldId, sourceTag],
    );
  } else if (op === 'merge') {
    await client.query(
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (field_id)
       DO UPDATE SET value = COALESCE(runtime_values.value, '{}'::jsonb)
                             || EXCLUDED.value,
                     source = EXCLUDED.source,
                     updated_at = now()`,
      [fieldId, json, sourceTag],
    );
  } else {
    await client.query(
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (field_id)
       DO UPDATE SET value = EXCLUDED.value,
                     source = EXCLUDED.source,
                     updated_at = now()`,
      [fieldId, json, sourceTag],
    );
  }
}
