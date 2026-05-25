/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 139 - explicit living-world tools.
// These are small wrappers around existing state owners so the broker does not
// need to remember low-level storage details when making a location feel alive.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {
  inferMemoryCategory,
  memoryFamilyForCategory,
  MEMORY_CATEGORIES,
  assignMemoryCluster,
  attachMemoryToThread,
  insertNpcMemory,
} from '../domain/memory/index.js';
import {registerTool, resolveEntityId} from './base.js';

const RecordLocationMemoryArgs = z.object({
  /** Location display_name or entity id. Omit to use player's current location. */
  location: z.union([z.string(), z.number().int().positive()]).optional(),
  text: z.string().min(1).max(1600),
  importance: z.number().min(0).max(1).default(0.55),
  tags: z.array(z.string()).max(16).default([]),
  kind: z.enum(MEMORY_CATEGORIES).optional(),
  /** When true, the memory is about the current player; otherwise ambient. */
  about_player: z.boolean().default(false),
});

registerTool({
  name: 'record_location_memory',
  description:
    'Persist a location-owned memory after the player changes or discovers something local: overturned barrel, dead/moved NPC, opened route, burned surface, solved clue, broken promise, or failed approach. Omit location to use the current location. Use this instead of only narrating changed local state.',
  paramsSchema: RecordLocationMemoryArgs,
  async execute(args, ctx) {
    const locationId =
      args.location == null
        ? await currentLocationId(ctx.playerId)
        : await resolveEntityId(args.location);
    if (locationId == null) {
      throw new Error('record_location_memory requires a known location');
    }
    const loc = await query<{kind: string; display_name: string}>(
      `SELECT kind, display_name FROM entities WHERE id = $1`,
      [locationId],
    );
    const location = loc.rows[0];
    if (!location || (location.kind !== 'location' && location.kind !== 'district')) {
      throw new Error(
        `record_location_memory target must be kind='location' or 'district'; got ${location?.kind ?? 'missing'}`,
      );
    }
    const tags = uniqueTags([
      ...(args.tags ?? []),
      'location',
      `location:${locationId}`,
      ctx.turnId ? `turn:${ctx.turnId}` : '',
    ]);
    const kind = inferMemoryCategory({
      explicitCategory: args.kind,
      tags,
      text: args.text,
    });
    const family = memoryFamilyForCategory(kind);
    const importance = args.importance ?? 0.55;
    const salience = importance * 0.9 + 0.1;
    const inserted = await insertNpcMemory({
      ownerEntityId: locationId,
      aboutEntityId: args.about_player ? ctx.playerId : null,
      text: args.text,
      importance,
      tags,
      sensitive: false,
      salience,
      memoryKind: kind,
      memoryFamily: family,
      sourceTurnId: ctx.turnId ?? null,
      sourceTool: 'record_location_memory',
      metadata: null,
    });
    const memoryId = inserted.id;
    await attachMemoryToThread({
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      memoryId,
    }).catch(err => {
      // CATCH-WARN-OK: post-INSERT archival side effect; the memory row at line ~90 has already committed and `attachMemoryToThread` surfaces its own thread-write telemetry.
      console.warn(
        '[record_location_memory] thread attach skipped:',
        err instanceof Error ? err.message : err,
      );
    });
    await assignMemoryCluster(memoryId).catch(err => {
      // CATCH-WARN-OK: clustering is a post-commit enrichment; the memory INSERT has already succeeded and `assignMemoryCluster` records its own clustering telemetry.
      console.warn(
        '[record_location_memory] cluster assignment skipped:',
        err instanceof Error ? err.message : err,
      );
    });
    await emitGuiEvent(ctx, 'location:memory_added', {
      memoryId,
      locationId,
      locationName: location.display_name,
      text: args.text,
      kind,
      family,
      importance,
      tags,
    });
    return {
      ok: true,
      memoryId,
      locationId,
      locationName: location.display_name,
      kind,
      family,
    };
  },
});

// ARCH-6 — domain-specific NPC status enum. `status_kind` keeps its
// public wire/DB column name; only the TypeScript surface gets a
// dedicated `NpcStatusKind` / `NPC_STATUS_KINDS` pair so future
// readers don't conflate it with entity/quest/memory `kind`.
const NPC_STATUS_KINDS = [
  'trust',
  'fear',
  'hostile',
  'wounded',
  'missing',
  'dead',
  'companion',
] as const;
type NpcStatusKind = (typeof NPC_STATUS_KINDS)[number];

const SetActorStatusArgs = z.object({
  actor: z.union([z.string(), z.number().int().positive()]),
  status_kind: z.enum(NPC_STATUS_KINDS).default('trust'),
  status_value: z.string().min(1).max(80),
  intensity: z.number().min(0).max(1).default(0.5),
  reason: z.string().max(240).optional(),
});

// Reserve the type for future direct consumers without dead-code TS
// errors (e.g. agency evaluators that pattern-match on the union).
export type {NpcStatusKind};

registerTool({
  name: 'set_actor_status',
  description:
    'Set a compact player-scoped status for an NPC: trust, fear, hostile, wounded, missing, dead, or companion. This status appears in PEOPLE HERE and should mirror durable consequences already justified by tools or narration.',
  paramsSchema: SetActorStatusArgs,
  async execute(args, ctx) {
    const actorId = await resolveEntityId(args.actor);
    if (actorId == null) throw new Error(`unknown actor: ${args.actor}`);
    const actor = await query<{kind: string; display_name: string}>(
      `SELECT kind, display_name FROM entities WHERE id = $1`,
      [actorId],
    );
    const row = actor.rows[0];
    if (!row || row.kind !== 'person') {
      throw new Error(
        `set_actor_status target must be kind='person'; got ${row?.kind ?? 'missing'}`,
      );
    }
    await query(
      `INSERT INTO actor_statuses
         (player_id, actor_entity_id, status_kind, status_value, intensity,
          source, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'set_actor_status', $6::jsonb, now())
       ON CONFLICT (player_id, actor_entity_id, status_kind) DO UPDATE SET
         status_value = EXCLUDED.status_value,
         intensity = EXCLUDED.intensity,
         source = EXCLUDED.source,
         metadata = actor_statuses.metadata || EXCLUDED.metadata,
         updated_at = now()`,
      [
        ctx.playerId,
        actorId,
        args.status_kind,
        args.status_value,
        args.intensity,
        JSON.stringify({reason: args.reason ?? null, turn_id: ctx.turnId ?? null}),
      ],
    );
    await emitGuiEvent(ctx, 'actor:status_changed', {
      actorId,
      actorName: row.display_name,
      statusKind: args.status_kind,
      statusValue: args.status_value,
      intensity: args.intensity,
      reason: args.reason ?? null,
    });
    return {
      ok: true,
      actorId,
      actorName: row.display_name,
      statusKind: args.status_kind,
      statusValue: args.status_value,
      intensity: args.intensity,
    };
  },
});

async function currentLocationId(playerId: number): Promise<number | null> {
  const row = await query<{current_location_id: number | string | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const value = row.rows[0]?.current_location_id;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 16);
}
