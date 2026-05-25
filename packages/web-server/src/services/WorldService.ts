/**
 * World overview and entity inspector service.
 *
 * Extracted from routes/world.ts (GH-BUG-081 / ARCH-18).
 */

import {query} from '../db.js';

export interface WorldOverview {
  cartridge_meta: Record<string, {value: unknown; description: unknown}>;
  entities_by_kind: Record<string, number>;
  totals: Record<string, unknown>;
}

export interface WorldEntityDetail {
  entity: Record<string, unknown>;
  runtime: {
    fields: Record<string, unknown>[];
    overlays: Record<string, unknown>[];
  };
  instructions: Record<string, unknown>[];
  transitions_owned: Record<string, unknown>[];
  stats: Record<string, unknown>[];
  inventory: {
    held_by_this_entity: Record<string, unknown>[];
    this_entity_held_by: Record<string, unknown>[];
  };
  recent_invocations: Record<string, unknown>[];
}

export class WorldService {
  static async overview(): Promise<WorldOverview> {
    const meta = await query<{
      key: string;
      value: unknown;
      description: unknown;
    }>(`SELECT key, value, description FROM cartridge_meta ORDER BY key`);
    const byKind = await query<{kind: string; n: number}>(
      `SELECT kind, COUNT(*)::int AS n FROM entities GROUP BY kind ORDER BY kind`,
    );
    const totals = await query<Record<string, unknown>>(`
      SELECT (SELECT COUNT(*)::int FROM runtime_fields) AS runtime_fields,
             (SELECT COUNT(*)::int FROM runtime_values) AS runtime_values,
             (SELECT COUNT(*)::int FROM transitions)    AS transitions,
             (SELECT COUNT(*)::int FROM players)        AS players,
             (SELECT COUNT(*)::int FROM sessions)       AS sessions,
             (SELECT COUNT(*)::int FROM tool_invocations) AS tool_invocations
    `);

    return {
      cartridge_meta: meta.rows.reduce(
        (acc: Record<string, {value: unknown; description: unknown}>, row) => {
          acc[row.key] = {value: row.value, description: row.description};
          return acc;
        },
        {},
      ),
      entities_by_kind: byKind.rows.reduce(
        (acc: Record<string, number>, row) => {
          acc[row.kind] = Number(row.n);
          return acc;
        },
        {},
      ),
      totals: totals.rows[0] ?? {},
    };
  }

  static async entity(entityId: number): Promise<WorldEntityDetail | null> {
    const entityRow = await query<Record<string, unknown>>(
      `SELECT id, kind, display_name, summary, profile, tags, i18n FROM entities WHERE id = $1`,
      [entityId],
    );
    if (entityRow.rows.length === 0) return null;

    const entity = entityRow.rows[0]!;

    const fields = await query<Record<string, unknown>>(
      `SELECT f.id AS field_id, f.field_key, f.value_type, f.scope_per_player,
              f.default_value,
              v.value AS current_value, v.source, v.updated_at
         FROM runtime_fields f
         LEFT JOIN runtime_values v ON v.field_id = f.id
        WHERE f.owner_entity_id = $1
        ORDER BY f.id`,
      [entityId],
    );

    const fieldIds = fields.rows
      .map(field => Number(field['field_id']))
      .filter(Number.isSafeInteger);
    const overlays =
      fieldIds.length > 0
        ? await query<Record<string, unknown>>(
            `SELECT field_id, player_id, value, updated_at
               FROM runtime_player_overlay
              WHERE field_id = ANY($1::bigint[])
              ORDER BY field_id, player_id`,
            [fieldIds],
          )
        : {rows: []};

    const instructions = await query<Record<string, unknown>>(
      `SELECT id, priority, applies_when, instruction_json, i18n
         FROM entity_instructions WHERE owner_entity_id = $1 ORDER BY priority DESC, id`,
      [entityId],
    );

    const transitions = await query<Record<string, unknown>>(
      `SELECT id, description, when_json, set_json, priority
         FROM transitions WHERE owner_entity_id = $1 ORDER BY priority DESC, id`,
      [entityId],
    );

    const stats = await query<Record<string, unknown>>(
      `SELECT stat_key, base, current FROM npc_stats WHERE npc_entity_id = $1
        ORDER BY CASE stat_key
          WHEN 'STR' THEN 1 WHEN 'DEX' THEN 2 WHEN 'CON' THEN 3
          WHEN 'INT' THEN 4 WHEN 'WIS' THEN 5 WHEN 'CHA' THEN 6 ELSE 7
        END`,
      [entityId],
    );

    const heldHere = await query<Record<string, unknown>>(
      `SELECT i.item_entity_id, e.display_name AS item_name, i.count
         FROM inventory_entries i
         JOIN entities e ON e.id = i.item_entity_id
        WHERE i.holder_entity_id = $1
        ORDER BY e.display_name`,
      [entityId],
    );

    const heldByOthers = await query<Record<string, unknown>>(
      `SELECT i.holder_entity_id, e.display_name AS holder_name, i.count
         FROM inventory_entries i
         JOIN entities e ON e.id = i.holder_entity_id
        WHERE i.item_entity_id = $1
        ORDER BY e.display_name`,
      [entityId],
    );

    const recent = await query<Record<string, unknown>>(
      `SELECT player_id, tool_name, args, result, error, invoked_at
         FROM tool_invocations
        WHERE args::text LIKE '%' || $1::text || '%'
           OR result::text LIKE '%' || $1::text || '%'
        ORDER BY invoked_at DESC LIMIT 20`,
      [String(entityId)],
    );

    return {
      entity,
      runtime: {
        fields: fields.rows,
        overlays: overlays.rows,
      },
      instructions: instructions.rows,
      transitions_owned: transitions.rows,
      stats: stats.rows,
      inventory: {
        held_by_this_entity: heldHere.rows,
        this_entity_held_by: heldByOthers.rows,
      },
      recent_invocations: recent.rows,
    };
  }
}
