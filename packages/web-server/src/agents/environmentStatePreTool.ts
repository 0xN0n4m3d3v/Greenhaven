/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Targeted narrate guard for persistent environmental state. It prevents the
// broker from saying the Velvet Booths curtain was cut/dropped while the
// cartridge runtime field still says it is hanging.

import {query} from '../db.js';
import {
  sessionManager,
  type ToolHistoryEntry,
} from '../sessionManager.js';
import type {PreToolValidator, ToolContext} from '../tools/base.js';
import {registerPreToolValidatorSpecialist} from '../specialists/registry.js';

const VELVET_CURTAIN_STATE_FIELD_ID = 2400;
const VELVET_TABLE_SIGN_STATE_FIELD_ID = 2401;

const validator: PreToolValidator = async (toolName, args, ctx) => {
  try {
    if (toolName === 'apply_runtime_field_patch') {
      return detectRuntimePatch(args as Record<string, unknown>, ctx);
    }
    if (toolName !== 'narrate') return {ok: true};
    return await detect(args as Record<string, unknown>, ctx);
  } catch (err) {
    // CATCH-WARN-OK: pre-tool validator that explicitly fails open so the broker's tool call still proceeds; the validator's outcome is observed by the tool dispatch layer (which already records its own pre-tool telemetry), and re-emitting here would mask the fail-open semantics with a false "failure" signal.
    console.warn(
      '[environment_state_pretool] failed-open:',
      err instanceof Error ? err.message : err,
    );
    return {ok: true};
  }
};

async function detect(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<
  {ok: true} | {ok: false; reason: string; suggestion?: Record<string, unknown>}
> {
  // Cartridge-state gate: only run the legacy Quickgrin-Lane curtain
  // guard when its runtime field actually exists in the active cartridge.
  // grinhaven-full does not use fields 2400/2401, so this guard becomes a
  // no-op there — which also avoids parsing the player's prose with the
  // old en+ru keyword regex that the guard relies on.
  const current = await currentRuntimeValue(VELVET_CURTAIN_STATE_FIELD_ID);
  if (current == null) return {ok: true};

  const text = typeof args['text'] === 'string' ? args['text'] : '';
  if (!CURTAIN_CHANGED_RE.test(text)) return {ok: true};
  if (historyMutatesField(ctx, VELVET_CURTAIN_STATE_FIELD_ID)) return {ok: true};

  if (current !== 'hanging') return {ok: true};

  return {
    ok: false,
    reason:
      'environment_state_guard: curtain prose changes require runtime field 2400',
    suggestion: {
      guard: 'environment_state_guard',
      field_id: VELVET_CURTAIN_STATE_FIELD_ID,
      field_key: 'curtain_state',
      retry:
        'Before narrate, call set_runtime_field(field_id=2400, value="cut" or "dropped", source="player_action") if the curtain changed. Otherwise rewrite narrate so the cut attempt fails and the curtain remains hanging.',
    },
  };
}

function detectRuntimePatch(
  args: Record<string, unknown>,
  ctx: ToolContext,
): {ok: true} | {ok: false; reason: string; suggestion?: Record<string, unknown>} {
  const tableSignPatch = fieldPatchFor(args, VELVET_TABLE_SIGN_STATE_FIELD_ID);
  if (!tableSignPatch) return {ok: true};
  if (tableSignPatch['value'] === 'unknown') return {ok: true};
  if (historyHasSuccessfulDiceCheck(ctx)) return {ok: true};
  return {
    ok: false,
    reason:
      'environment_state_guard: hidden table sign resolution requires dice_check first',
    suggestion: {
      guard: 'environment_state_guard',
      field_id: VELVET_TABLE_SIGN_STATE_FIELD_ID,
      field_key: 'table_sign_state',
      retry:
        'Call dice_check for the hidden table sign search. If the roll succeeds, retry apply_runtime_field_patch for field 2401; if it fails, do not mark the sign found.',
    },
  };
}

const CURTAIN_CHANGED_RE = new RegExp(
  [
    String.raw`\b(?:curtain|cord|velvet)\b.{0,80}\b(?:cut|dropped|fallen|torn)\b`,
    String.raw`(?:\u0437\u0430\u043d\u0430\u0432\u0435\u0441|\u0448\u043d\u0443\u0440|\u0431\u0430\u0440\u0445\u0430\u0442).{0,120}(?:\u043f\u0435\u0440\u0435\u0440\u0435\u0437|\u043e\u0431\u043e\u0440\u0432|\u0440\u0443\u0445\u043d|\u0443\u043f\u0430\u043b|\u043b\u0435\u0436\u0438\u0442\s+\u043d\u0430\s+\u043f\u043e\u043b)`,
  ].join('|'),
  'iu',
);

function historyMutatesField(ctx: ToolContext, fieldId: number): boolean {
  const history = activeHistory(ctx);
  if (!history) return false;
  return history.some(entry => entry.ok && entryMutatesField(entry, fieldId));
}

function historyHasSuccessfulDiceCheck(ctx: ToolContext): boolean {
  const history = activeHistory(ctx);
  if (!history) return false;
  return history.some(entry => entry.ok && entry.name === 'dice_check');
}

function activeHistory(ctx: ToolContext): ToolHistoryEntry[] | null {
  const session = sessionManager.get(ctx.sessionId);
  const active = session?.activeTurn;
  if (!active) return null;
  if (
    ctx.turnId &&
    active.turnId !== ctx.turnId &&
    !ctx.turnId.startsWith(`${active.turnId}:`)
  ) {
    return null;
  }
  return active.toolHistory ?? [];
}

function entryMutatesField(entry: ToolHistoryEntry, fieldId: number): boolean {
  if (entry.name === 'set_runtime_field') {
    return Number(entry.args['field_id']) === fieldId;
  }
  if (entry.name !== 'apply_runtime_field_patch') return false;
  const patches = entry.args['patches'];
  if (!Array.isArray(patches)) return false;
  return patches.some(patch => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return false;
    }
    return Number((patch as Record<string, unknown>)['field_id']) === fieldId;
  });
}

function fieldPatchFor(
  args: Record<string, unknown>,
  fieldId: number,
): Record<string, unknown> | null {
  const patches = args['patches'];
  if (!Array.isArray(patches)) return null;
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      continue;
    }
    const record = patch as Record<string, unknown>;
    if (Number(record['field_id']) === fieldId) return record;
  }
  return null;
}

async function currentRuntimeValue(fieldId: number): Promise<unknown> {
  const res = await query<{value: unknown}>(
    `SELECT COALESCE(rv.value, rf.default_value) AS value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.id = $1`,
    [fieldId],
  );
  return res.rows[0]?.value;
}

registerPreToolValidatorSpecialist({
  name: 'environment_state.narrate',
  phase: 'preToolValidator',
  toolName: 'narrate',
  validator,
});

registerPreToolValidatorSpecialist({
  name: 'environment_state.apply_runtime_field_patch',
  phase: 'preToolValidator',
  toolName: 'apply_runtime_field_patch',
  validator,
});
