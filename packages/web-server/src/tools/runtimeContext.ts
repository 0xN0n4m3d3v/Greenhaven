/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Runtime context helper — resolves the slice of cartridge state the
// AI needs to actually run a scene/location/quest/NPC: every
// runtime_field owned by that entity (with current values, including
// per-player overlay), plus every entity_instruction whose
// applies_when conditions match the current world state.
//
// Plugged into query_entity (so any look-up returns the live state
// machine, not just static profile) and into query_player_state (so
// one tool call surfaces the player's scene + location + active
// quests' contexts at once — no N+1 round trips).
//
// applies_when shape (from entity_instructions.applies_when JSONB):
//   [{ field_id: number, op: 'eq'|'neq'|'gt'|'lt'|'gte'|'lte', value: unknown }]
// Empty array == always-applies.

import {
  activeCartridgeEntityPredicate,
  activeCartridgeId,
} from '../cartridgeScope.js';
import {qualitySqlPredicate} from '../contentQuality.js';
import {query} from '../db.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';

export interface RuntimeFieldView {
  field_id: number;
  field_key: string;
  value_type: string;
  value: unknown;
  scope_per_player: boolean;
  source: 'overlay' | 'global' | 'default';
  allowed_values?: unknown[] | null;
  description?: string | null;
}

export interface InstructionView {
  id: number;
  priority: number;
  text: string;
}

export interface EntityRuntimeContext {
  runtime_fields: RuntimeFieldView[];
  instructions: InstructionView[];
}

interface FieldRow {
  field_id: number;
  field_key: string;
  value_type: string;
  scope_per_player: boolean;
  default_value: unknown;
  allowed_values: unknown[] | null;
  description: string | null;
  overlay_value: unknown;
  global_value: unknown;
}

interface InstructionRow {
  id: number;
  priority: number;
  applies_when: Array<{field_id: number; op: string; value: unknown}> | null;
  instruction_json: {text?: string; action?: unknown};
}

function resolveFieldValue(row: FieldRow): {
  value: unknown;
  source: 'overlay' | 'global' | 'default';
} {
  if (
    row.scope_per_player &&
    row.overlay_value !== null &&
    row.overlay_value !== undefined
  ) {
    return {value: row.overlay_value, source: 'overlay'};
  }
  if (row.global_value !== null && row.global_value !== undefined) {
    return {value: row.global_value, source: 'global'};
  }
  return {value: row.default_value, source: 'default'};
}

function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case 'eq':
      return JSON.stringify(left) === JSON.stringify(right);
    case 'neq':
      return JSON.stringify(left) !== JSON.stringify(right);
    case 'gt':
      return Number(left) > Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    case 'in':
      return Array.isArray(right) && right.some(v => JSON.stringify(v) === JSON.stringify(left));
    default:
      return false;
  }
}

export interface MentionEntity {
  id: number;
  kind: string;
  display_name: string;
}

/**
 * Pull every entity row that may be referenced as a runtime @mention.
 * Runtime @mentions are keyed only by `entities.display_name`.
 */
export async function getAllMentionEntities(
  playerId: number | null = null,
): Promise<MentionEntity[]> {
  const cartridgeId =
    playerId != null
      ? await resolveActivePlayerCartridgeId(playerId)
      : await activeCartridgeId();
  const rows = await query<{
    id: number;
    kind: string;
    display_name: string;
  }>(
    `SELECT id, kind, display_name
      FROM entities
      WHERE ${activeCartridgeEntityPredicate('entities', '$1')}
        AND ${qualitySqlPredicate('entities')}`,
    [cartridgeId],
  );
  return rows.rows.map(r => ({
    id: r.id,
    kind: r.kind,
    display_name: r.display_name,
  }));
}

/**
 * Scan narrate text for exact canonical `@<display_name>` tokens from
 * the active cartridge. Returns the resolved entities with the exact
 * display name under `name` so the UI builds a verbatim @-trigger.
 * yield two entries — the UI dedupes by id+name later.
 */
export function scanMentions(
  text: string,
  entities: MentionEntity[],
): Array<{id: number; name: string; kind: string}> {
  const out: Array<{id: number; name: string; kind: string}> = [];
  const seen = new Set<string>(); // dedup id+name within ONE scan
  for (const e of entities) {
    const c = e.display_name;
    const key = `${e.id}:${c}`;
    if (seen.has(key)) continue;
    if (text.includes('@' + c)) {
      out.push({id: e.id, name: c, kind: e.kind});
      seen.add(key);
    }
  }
  return out;
}

export interface MentionTextRepair {
  text: string;
  changed: boolean;
  dearmedCount: number;
}

/**
 * Preserve only canonical `@${display_name}` tokens. If a model emits
 * a translated or invented `@...` token, drop the leading `@` so the
 * prose remains readable but no false runtime link is created.
 *
 * This intentionally avoids language-specific name maps. The only
 * source of truth is the active cartridge's canonical display names.
 */
export function enforceCanonicalMentionText(
  text: string,
  entities: MentionEntity[],
): MentionTextRepair {
  if (!text.includes('@')) return {text, changed: false, dearmedCount: 0};
  const names = [...new Set(entities.map(e => e.display_name).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  let out = '';
  let index = 0;
  let dearmedCount = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch !== '@') {
      out += ch;
      index += 1;
      continue;
    }
    const matched = names.find(name => {
      if (!text.startsWith(name, index + 1)) return false;
      return isMentionBoundary(text[index + 1 + name.length]);
    });
    if (matched) {
      out += '@' + matched;
      index += matched.length + 1;
      continue;
    }
    dearmedCount += 1;
    index += 1;
  }
  return {
    text: out,
    changed: out !== text,
    dearmedCount,
  };
}

function isMentionBoundary(ch: string | undefined): boolean {
  if (ch == null || ch.length === 0) return true;
  if (ch.trim() === '') return true;
  return '.,!?;:()[]{}"\'«»“”‘’`'.includes(ch);
}

/**
 * Pull the runtime state machine for one entity. Returns:
 *   - runtime_fields: every field whose owner_entity_id == entityId,
 *     each with the current value resolved through the per-player →
 *     global → default chain
 *   - instructions: every entity_instruction owned by entityId whose
 *     applies_when evaluates true against the current world state for
 *     this player. Action-flavoured rows (UI quick-actions) are
 *     skipped — only narrative `text` rows go to the model.
 */
export async function getEntityRuntimeContext(
  entityId: number,
  playerId: number,
): Promise<EntityRuntimeContext> {
  // 1. Fields owned by this entity (with values).
  const ownFields = await query<FieldRow>(
    `SELECT
       f.id              AS field_id,
       f.field_key       AS field_key,
       f.value_type      AS value_type,
       f.scope_per_player AS scope_per_player,
       f.default_value   AS default_value,
       f.allowed_values  AS allowed_values,
       f.description     AS description,
       o.value           AS overlay_value,
       v.value           AS global_value
     FROM runtime_fields f
     LEFT JOIN runtime_player_overlay o
            ON o.field_id = f.id AND o.player_id = $2
     LEFT JOIN runtime_values v
            ON v.field_id = f.id
     WHERE f.owner_entity_id = $1
     ORDER BY f.id`,
    [entityId, playerId],
  );

  const runtime_fields: RuntimeFieldView[] = ownFields.rows.map(row => {
    const {value, source} = resolveFieldValue(row);
    return {
      field_id: row.field_id,
      field_key: row.field_key,
      value_type: row.value_type,
      value,
      scope_per_player: row.scope_per_player,
      source,
      allowed_values: row.allowed_values,
      description: row.description,
    };
  });

  // 2. Instructions owned by this entity.
  const instrRows = await query<InstructionRow>(
    `SELECT id, priority, applies_when, instruction_json
       FROM entity_instructions
      WHERE owner_entity_id = $1
      ORDER BY priority ASC, id ASC`,
    [entityId],
  );

  // Bulk-resolve every field referenced in applies_when. Instructions
  // can reference fields owned by OTHER entities (a quest's recipe
  // gating on a scene's payment_confirmed flag is the canonical case
  // in the Quickgrin cartridge), so we can't reuse `runtime_fields`
  // above as the lookup map.
  const referencedIds = new Set<number>();
  for (const r of instrRows.rows) {
    for (const c of r.applies_when ?? []) {
      if (typeof c.field_id === 'number') referencedIds.add(c.field_id);
    }
  }
  const refValues = new Map<number, unknown>();
  if (referencedIds.size > 0) {
    const refRows = await query<FieldRow>(
      `SELECT
         f.id              AS field_id,
         f.field_key       AS field_key,
         f.value_type      AS value_type,
         f.scope_per_player AS scope_per_player,
         f.default_value   AS default_value,
         f.allowed_values  AS allowed_values,
         f.description     AS description,
         o.value           AS overlay_value,
         v.value           AS global_value
       FROM runtime_fields f
       LEFT JOIN runtime_player_overlay o
              ON o.field_id = f.id AND o.player_id = $2
       LEFT JOIN runtime_values v
              ON v.field_id = f.id
       WHERE f.id = ANY($1::bigint[])`,
      [Array.from(referencedIds), playerId],
    );
    for (const r of refRows.rows) {
      refValues.set(r.field_id, resolveFieldValue(r).value);
    }
  }

  const instructions: InstructionView[] = [];
  for (const r of instrRows.rows) {
    const text = r.instruction_json?.text;
    if (typeof text !== 'string' || !text.trim()) continue; // skip UI-only action rows
    const conds = r.applies_when ?? [];
    const ok = conds.every(c => compare(refValues.get(c.field_id), c.op, c.value));
    if (!ok) continue;
    instructions.push({id: r.id, priority: r.priority, text});
  }

  return {runtime_fields, instructions};
}
