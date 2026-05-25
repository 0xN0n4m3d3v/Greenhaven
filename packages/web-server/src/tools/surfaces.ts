/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// apply_surface — broker spawns environmental effects in a location.
// On collision with a compatible existing surface, the cartridge's
// combo rules fire instead of simple stacking.

import {z} from 'zod';
import {getMeta} from '../cartridge.js';
import {query, withTransaction} from '../db.js';
import {emitFieldChangesById} from '../runtimeFieldEvents.js';
import {sessionManager, type ToolHistoryEntry} from '../sessionManager.js';
import {
  registerPreToolValidator,
  registerTool,
  resolveEntityId,
  type ToolContext,
} from './base.js';
import {applyPatchRawWithClient} from './runtime.js';

const SurfaceArgs = z.object({
  location: z.string(),
  type: z.enum([
    'fire',
    'oil',
    'water',
    'ice',
    'poison',
    'blood',
    'electricity',
    'smoke',
    'web',
  ]),
  severity: z.number().int().min(1).max(3).default(1),
  area: z
    .enum(['central', 'scattered', 'saturating'])
    .default('scattered'),
  source: z.string().optional(),
  /** Override the default lifetime from cartridge_meta.surface_decay. */
  lifetime_turns: z.number().int().min(1).max(20).optional(),
});

interface ComboRule {
  a: string;
  b: string;
  result: string;
  side_effects: unknown[];
  narrate_hint?: string;
}

interface DecayRule {
  default_lifetime_turns: number;
  severity_decay_per_turn: number;
}

registerTool({
  name: 'apply_surface',
  description:
    'Spawn an environmental surface in a location: fire, oil, water, ice, poison, blood, electricity, smoke, web. ' +
    'Severity 1-3. Area determines narrative scope (central / scattered / saturating). ' +
    'If a compatible surface already exists, a combo fires (oil+fire=explosion, water+electric=shocked, etc.) — ' +
    "the engine returns combo_fired + narrate_hint + side_effects; you fire the indicated tools and describe.",
  paramsSchema: SurfaceArgs,
  async execute(args, ctx) {
    const locId = await resolveEntityId(args.location);
    if (!locId) return {ok: false, error: `unknown location: ${args.location}`};

    // Pre-fetch read-only cartridge data (doesn't change mid-session)
    const combos = (await getMeta<ComboRule[]>('surface_combo_rules')) ?? [];
    const decay = (await getMeta<Record<string, DecayRule>>('surface_decay')) ?? {};

    // Wrap surface read+combo-detect+write in a transaction with
    // FOR UPDATE. Prevents TOCTOU race where concurrent apply_surface
    // calls both read the same array and miss combos (GH-BUG-083).
    return withTransaction(async client => {
      const fieldRow = await client.query<{id: number}>(
        `SELECT rf.id FROM runtime_fields rf
          WHERE rf.owner_entity_id = $1 AND rf.field_key = 'active_surfaces'`,
        [locId],
      );
      if (fieldRow.rows.length === 0) {
        return {ok: false, error: 'location has no surfaces field'};
      }
      const fieldId = fieldRow.rows[0]!.id;
      const valueRow = await client.query<{value: unknown}>(
        `SELECT value FROM runtime_values
          WHERE field_id = $1
          FOR UPDATE`,
        [fieldId],
      );
      const existing = Array.isArray(valueRow.rows[0]?.value)
        ? (valueRow.rows[0]!.value as Array<Record<string, unknown>>)
        : [];

      const turnRow = await client.query<{turn_no: number}>(
        `SELECT COALESCE(MAX(turn_index), 0) AS turn_no
           FROM chat_messages WHERE session_id = $1`,
        [ctx.sessionId],
      );
      const currentTurn = Number(turnRow.rows[0]?.turn_no ?? 0);

      const collision = existing.find(s =>
        combos.some(
          r =>
            (r.a === s['type'] && r.b === args.type) ||
            (r.b === s['type'] && r.a === args.type),
        ),
      );
      if (collision) {
        const rule = combos.find(
          r =>
            (r.a === collision['type'] && r.b === args.type) ||
            (r.b === collision['type'] && r.a === args.type),
        )!;
        return {
          ok: true,
          combo_fired: rule.result,
          narrate_hint: rule.narrate_hint ?? null,
          side_effects: rule.side_effects,
          consumed_surface: collision['type'],
          applied_surface: args.type,
        };
      }

      const defaultLife = decay[args.type]?.default_lifetime_turns ?? 3;
      const lifetime = args.lifetime_turns ?? defaultLife;
      const entry = {
        type: args.type,
        severity: args.severity,
        applied_turn: currentTurn,
        expires_turn: currentTurn + lifetime,
        source: args.source ?? null,
        area: args.area,
      };
      await applyPatchRawWithClient(client, fieldId, entry, 'append', 'apply_surface');
      await emitFieldChangesById(ctx.sessionId, [
        {field_id: fieldId, source: 'apply_surface'},
      ]);
      return {
        ok: true,
        applied_surface: args.type,
        expires_turn: entry.expires_turn,
      };
    });
  },
});

registerPreToolValidator('apply_surface', async (_toolName, rawArgs, ctx) => {
  if (ctx.toolHistorySource !== 'ai_sdk' && ctx.toolHistorySource !== 'batch_child') {
    return {ok: true};
  }
  const args = rawArgs as z.infer<typeof SurfaceArgs>;
  const source = args.source?.trim() ?? '';
  if (!source) return rejectSurfaceSource(args, null, 'surface source is required');

  const locId = await resolveEntityId(args.location);
  if (!locId) return {ok: true};

  if (
    (await sourceMatchesLocationItem(source, locId)) ||
    (await sourceMatchesExistingSurface(source, locId)) ||
    (await sourceMatchesLocationEvidence(source, locId)) ||
    sourceMatchesSuccessfulTool(source, ctx)
  ) {
    return {ok: true};
  }

  return rejectSurfaceSource(
    args,
    locId,
    'surface source is not a present item, existing surface, location evidence, or successful same-turn tool result',
  );
});

function rejectSurfaceSource(
  args: z.infer<typeof SurfaceArgs>,
  locationId: number | null,
  reason: string,
): {ok: false; reason: string; suggestion: Record<string, unknown>} {
  return {
    ok: false,
    reason: `surface_source_ungrounded: ${reason}`,
    suggestion: {
      guard: 'surface_source_grounding',
      location: args.location,
      location_id: locationId,
      surface_type: args.type,
      source: args.source ?? null,
      retry:
        'Pass source as an exact present item/display name, existing active surface type, current location evidence, or a successful same-turn tool name/result such as damage. Unsupported environmental props remain narration only, not canon surfaces.',
    },
  };
}

async function sourceMatchesLocationItem(
  source: string,
  locationId: number,
): Promise<boolean> {
  const normalized = normalizeSurfaceSource(source);
  if (!normalized) return false;
  const rows = await query<{display_name: string; slug: string | null}>(
    `SELECT e.display_name, i.slug
       FROM inventory_entries ie
       JOIN entities e ON e.id = ie.item_entity_id
       LEFT JOIN items i ON i.legacy_entity_id = e.id
      WHERE ie.holder_entity_id = $1
        AND ie.count > 0
      LIMIT 50`,
    [locationId],
  );
  return rows.rows.some(row =>
    [row.display_name, row.slug ?? ''].some(value =>
      normalized === normalizeSurfaceSource(value),
    ),
  );
}

async function sourceMatchesExistingSurface(
  source: string,
  locationId: number,
): Promise<boolean> {
  const normalized = normalizeSurfaceSource(source);
  if (!normalized) return false;
  const rows = await query<{value: unknown}>(
    `SELECT COALESCE(rv.value, rf.default_value) AS value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = $1
        AND rf.field_key = 'active_surfaces'
      LIMIT 1`,
    [locationId],
  );
  const value = rows.rows[0]?.value;
  const surfaces = Array.isArray(value) ? value : value ? [value] : [];
  return surfaces.some(surface => {
    if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
      return false;
    }
    const type = (surface as Record<string, unknown>)['type'];
    return typeof type === 'string' && normalized === normalizeSurfaceSource(type);
  });
}

async function sourceMatchesLocationEvidence(
  source: string,
  locationId: number,
): Promise<boolean> {
  const normalized = normalizeSurfaceSource(source);
  if (normalized.length < 3) return false;
  const rows = await query<{
    display_name: string;
    summary: string | null;
    profile: unknown;
  }>(
    `SELECT display_name, summary, profile
       FROM entities
      WHERE id = $1
      LIMIT 1`,
    [locationId],
  );
  const row = rows.rows[0];
  if (!row) return false;
  if (normalized === normalizeSurfaceSource(row.display_name)) return true;
  const evidence = normalizeSurfaceSource(
    `${row.summary ?? ''} ${JSON.stringify(row.profile ?? {})}`,
  );
  return evidence.includes(normalized);
}

function sourceMatchesSuccessfulTool(source: string, ctx: ToolContext): boolean {
  const normalized = normalizeSurfaceSource(source);
  if (!normalized) return false;
  const active = sessionManager.get(ctx.sessionId)?.activeTurn;
  if (!active) return false;
  if (
    ctx.turnId &&
    active.turnId !== ctx.turnId &&
    !ctx.turnId.startsWith(`${active.turnId}:`)
  ) {
    return false;
  }
  return (active.toolHistory ?? []).some(entry => {
    if (!entry.ok) return false;
    return (
      normalized === normalizeSurfaceSource(entry.name) ||
      normalized === normalizeSurfaceSource(entry.operation_id ?? '') ||
      resultContainsSource(entry, normalized)
    );
  });
}

function resultContainsSource(entry: ToolHistoryEntry, normalized: string): boolean {
  const seen: unknown[] = [entry.result, entry.args];
  while (seen.length > 0) {
    const value = seen.shift();
    if (typeof value === 'string' && normalizeSurfaceSource(value) === normalized) {
      return true;
    }
    if (Array.isArray(value)) {
      seen.push(...value.slice(0, 30));
    } else if (value && typeof value === 'object') {
      seen.push(...Object.values(value as Record<string, unknown>).slice(0, 30));
    }
  }
  return false;
}

function normalizeSurfaceSource(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/["'`]/g, '')
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}
