/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Entity-shaped tools — read & light-touch CRUD on the polymorphic
// entities table. Heavy mutations (XP, skills, equipment) live in
// dedicated modules so their semantics stay tight.

import {z} from 'zod';
import {
  activeCartridgeEntityPredicate,
} from '../cartridgeScope.js';
import {qualitySqlPredicate} from '../contentQuality.js';
import {query, withTransaction} from '../db.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';
import {
  registerTool,
  registerPreToolValidator,
  type ToolContext,
} from './base.js';
import {materializeEntityInventoryItem} from './inventoryCommon.js';
import {getEntityRuntimeContext} from './runtimeContext.js';
import {stripEntityProfileAliases} from '../entities/profileSanitizer.js';
import {
  projectEntityNormalizedColumns,
  stripRetiredProfileKeysForPersist,
  stripRetiredTagsForPersist,
} from '../entities/profileProjection.js';

// ── query_entity ───────────────────────────────────────────────────────

const QueryEntityArgs = z.object({
  /** Numeric id or exact display_name. */
  id_or_name: z.string().describe('Numeric entity id (as string) or exact display name'),
});

registerTool({
  name: 'query_entity',
  description:
    'Look up one entity by id or display name. Returns kind, profile, tags, ' +
    'PLUS its runtime state machine: every runtime_field owned by this entity (with current value, ' +
    'resolved through per-player overlay → global → default), and every entity_instruction whose ' +
    "applies_when conditions match the current state. Cartridge authors put quest recipes, NPC " +
    "behaviour rules and scene narrator briefs into entity_instructions; if you don't read them you'll " +
    'miss critical mechanics (e.g. exact tool sequence to accept payment from a quest-giver). Always call this on ' +
    "the entity you're about to embody, narrate, or transact with. For runtime writes, use only returned field_id values and obey value_type/allowed_values; if a field is absent, do not invent it.",
  paramsSchema: QueryEntityArgs,
  async execute(args, ctx) {
    const rawTarget = args.id_or_name.trim();
    const numericTarget = Number(rawTarget);
    const cartridgeId = await resolveActivePlayerCartridgeId(ctx.playerId);
    const params: unknown[] = [cartridgeId];
    const targetPredicate =
      Number.isInteger(numericTarget) && numericTarget > 0
        ? (() => {
            params.push(numericTarget);
            return `id = $${params.length}`;
          })()
        : (() => {
            params.push(rawTarget);
            return `display_name = $${params.length}`;
          })();
    const r = await query<{
      id: number;
      kind: string;
      display_name: string;
      summary: string | null;
      profile: Record<string, unknown>;
      tags: string[];
    }>(
      `SELECT id, kind, display_name, summary, profile, tags
         FROM entities
        WHERE ${targetPredicate}
          AND ${activeCartridgeEntityPredicate('entities', '$1')}
        ORDER BY id
        LIMIT 1`,
      params,
    );
    if (r.rows.length === 0) return {found: false};
    const id = r.rows[0]!.id;
    const ctxData = await getEntityRuntimeContext(id, ctx.playerId);
    const row = r.rows[0]!;
    return {
      found: true,
      ...row,
      profile: stripEntityProfileAliases(row.profile),
      ...ctxData,
    };
  },
});

// ── search_entities ────────────────────────────────────────────────────
// Cheap LIKE-search by name + optional kind filter. A dedicated tool
// (vs query_entity) so the AI can ask "what NPCs are nearby" without
// guessing exact ids.

const SearchEntitiesArgs = z.object({
  /** Substring to match against display_name. */
  query: z.string().min(1).max(120),
  /** Optional filter on entity kind. */
  kind: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

registerTool({
  name: 'search_entities',
  description:
    'Search entities by display-name substring, optionally filtered by kind ' +
    "('person' / 'location' / 'item' / 'scene' / 'quest' / 'class' / 'skill' / 'faction').",
  paramsSchema: SearchEntitiesArgs,
  async execute(args, ctx) {
    const cartridgeId = await resolveActivePlayerCartridgeId(ctx.playerId);
    const where: string[] = ['display_name ILIKE $1'];
    const params: unknown[] = [`%${args.query}%`];
    if (args.kind) {
      params.push(args.kind);
      where.push(`kind = $${params.length}`);
    }
    params.push(cartridgeId);
    where.push(activeCartridgeEntityPredicate('entities', `$${params.length}`));
    where.push(qualitySqlPredicate('entities'));
    params.push(args.limit);
    const r = await query<{
      id: number;
      kind: string;
      display_name: string;
      tags: string[];
    }>(
      `SELECT id, kind, display_name, tags
         FROM entities
        WHERE ${where.join(' AND ')}
        ORDER BY length(display_name) ASC
        LIMIT $${params.length}`,
      params,
    );
    return {entities: r.rows};
  },
});

// ── create_entity ──────────────────────────────────────────────────────
// Lets the AI spawn NPCs, locations, items mid-story. Cartridge
// authors can also call this; it's the same path.

const CreateEntityArgs = z.object({
  kind: z.enum([
    'person',
    'location',
    'item',
    'scene',
    'quest',
    'event',
    'service',
    'thread',
    'district',
    'class',
    'skill',
    'faction',
  ]),
  display_name: z.string().min(1).max(120),
  summary: z.string().optional(),
  profile: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

registerTool({
  name: 'create_entity',
  description:
    'Create a new entity (NPC, location, item, scene, quest, …). Returns the new entity id. ' +
    'For kind=item, non-fixture items are linked into the inventory item catalogue; ' +
    'profile.holder_entity_id/home_id places them in a non-player holder inventory. ' +
    "Use this when the story introduces something that doesn't exist yet. " +
    'NEVER call this on a player-prose turn — only NPC dialogue / scene beats / quest beats may author new entities.',
  paramsSchema: CreateEntityArgs,
  async execute(args, ctx) {
    const profile: Record<string, unknown> = stripEntityProfileAliases({
      ...(args.profile ?? {}),
      origin: 'dynamic',
    });
    const tags = Array.from(new Set(['dynamic', ...(args.tags ?? [])]));

    // Spec 139 v2 — for new locations, auto-pin onto the map near the
    // player's current location and add a bidirectional exit edge.
    // Without this the new location is unreachable except via free-text.
    let exitFromId: number | null = null;
    if (args.kind === 'location' && !profile['map_position']) {
      const placement = await derivePlacementFromPlayer(ctx.playerId);
      if (placement) {
        profile['map_position'] = placement.position;
        profile['topology_parent_id'] = placement.parentId;
        exitFromId = placement.fromId;
      }
    }

    const projected = projectEntityNormalizedColumns({profile, tags});
    // ARCH-19 Phase 4 (migration 0123) — the normalized columns are
    // the canonical home for cartridge_id / topology_parent_id /
    // origin and the 'dynamic' tag. Strip them from the persisted
    // JSONB / tags so the row no longer carries the retired markers.
    const profileForPersist = stripRetiredProfileKeysForPersist(profile);
    const tagsForPersist = stripRetiredTagsForPersist(tags);
    return withTransaction(async client => {
      const r = await client.query<{id: number}>(
        `INSERT INTO entities (
           kind, display_name, summary, profile, tags,
           cartridge_id, topology_parent_id, dynamic_origin
         )
         VALUES (
           $1, $2, $3, $4, $5,
           $6,
           (SELECT inner_e.id FROM entities inner_e
              WHERE inner_e.id = $7::bigint
                AND inner_e.kind IN ('location', 'district')),
           $8
         )
         RETURNING id`,
        [
          args.kind,
          args.display_name,
          args.summary ?? null,
          JSON.stringify(profileForPersist),
          tagsForPersist,
          projected.cartridge_id,
          projected.topology_parent_id,
          projected.dynamic_origin,
        ],
      );
      const id = r.rows[0]!.id;

      // Spec 139 v2 — wire a bidirectional exit edge so the new location
      // is reachable from where the player just was.
      if (args.kind === 'location' && exitFromId) {
        await addBidirectionalExit(client, exitFromId, id);
      }

      const inventoryItem = await materializeEntityInventoryItem(client, {
        entityId: id,
        kind: args.kind,
        displayName: args.display_name,
        profile,
        tags,
      });
      return {
        id,
        kind: args.kind,
        display_name: args.display_name,
        ...(inventoryItem ? {inventory_item: inventoryItem} : {}),
      };
    });
  },
});

/** Spec 139 v2 — pick a map_position next to the player's current
 *  location so new entities are visible + reachable. */
async function derivePlacementFromPlayer(
  playerId: number,
): Promise<{position: {x: number; y: number}; parentId: number | null; fromId: number} | null> {
  const r = await query<{
    current_location_id: number | null;
    cur_pos: {x: number; y: number} | null;
    parent_id: number | null;
  }>(
    `SELECT
        p.current_location_id,
        (e.profile->'map_position')::jsonb AS cur_pos,
        e.topology_parent_id AS parent_id
       FROM players p
       LEFT JOIN entities e ON e.id = p.current_location_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  const row = r.rows[0];
  if (!row?.current_location_id) return null;
  const base = row.cur_pos ?? {x: 50, y: 50};
  // Place new node slightly above-right of current; clamp to canvas.
  const x = Math.min(95, Math.max(5, Math.round(base.x + 18)));
  const y = Math.min(95, Math.max(5, Math.round(base.y - 12)));
  return {
    position: {x, y},
    parentId: row.parent_id,
    fromId: row.current_location_id,
  };
}

/** Spec 139 v2 — add an exit edge between two locations.
 *
 * Greenhaven stores exits on each location's `profile.exits[]` as location
 * entity ids. Idempotent: existing entries are left alone. */
interface LocRow {
  id: number;
  profile: Record<string, unknown> | null;
  display_name: string;
}

async function addBidirectionalExit(
  client: {query: <T = unknown>(text: string, values?: unknown[]) => Promise<{rows: T[]}>},
  a: number,
  b: number,
): Promise<void> {
  const both = await client.query<LocRow>(
    `SELECT id, profile, display_name FROM entities WHERE id IN ($1, $2)`,
    [a, b],
  );
  const byId = new Map<number, LocRow>(both.rows.map(r => [r.id, r]));
  const rowA = byId.get(a);
  const rowB = byId.get(b);
  if (!rowA || !rowB) return;

  async function patchExits(here: LocRow, targetId: number, targetName: string): Promise<void> {
    void targetName;
    const existing = readExitIdArray(here.profile?.['exits']);
    if (existing.includes(targetId)) return;
    const next = [...existing, targetId];
    await client.query(
      `UPDATE entities
         SET profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{exits}', $1::jsonb, true),
             updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(next), here.id],
    );
  }

  await patchExits(rowA, b, rowB.display_name);
  await patchExits(rowB, a, rowA.display_name);
}

function readExitIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const item of value) {
    const raw =
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)['id']
        : item;
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

// ── update_entity ──────────────────────────────────────────────────────
// Patch summary, profile (deep-merge), tags. Doesn't allow changing
// `kind` — that would invalidate cross-references.

const UpdateEntityArgs = z.object({
  id: z.number().int().positive(),
  display_name: z.string().min(1).max(120).optional(),
  summary: z.string().optional(),
  profile_patch: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

registerTool({
  name: 'update_entity',
  description:
    'Update an entity. profile_patch deep-merges into the current profile. ' +
    'tags replace the full array. Cannot change kind (delete + recreate if needed).',
  paramsSchema: UpdateEntityArgs,
  async execute(args) {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (args.display_name !== undefined) {
      params.push(args.display_name);
      sets.push(`display_name = $${params.length}`);
    }
    if (args.summary !== undefined) {
      params.push(args.summary);
      sets.push(`summary = $${params.length}`);
    }
    let profilePatchIdx: number | null = null;
    if (args.profile_patch !== undefined) {
      params.push(JSON.stringify(stripEntityProfileAliases(args.profile_patch)));
      profilePatchIdx = params.length;
      sets.push(`profile = profile || $${profilePatchIdx}::jsonb`);
    }
    let tagsIdx: number | null = null;
    if (args.tags !== undefined) {
      params.push(args.tags);
      tagsIdx = params.length;
      sets.push(`tags = $${tagsIdx}`);
    }
    if (sets.length === 0) return {updated: false, reason: 'no fields to update'};

    // ARCH-19 Phase 2A — when profile/tags change, re-derive the
    // normalized columns from the post-patch state so they don't drift
    // from JSONB. `safe_to_bigint` (from migration 0105) plus a
    // location/district existence check guarantee the FK never blocks
    // an otherwise-valid update.
    if (profilePatchIdx !== null || tagsIdx !== null) {
      const profileExpr =
        profilePatchIdx !== null
          ? `(profile || $${profilePatchIdx}::jsonb)`
          : 'profile';
      const tagsExpr = tagsIdx !== null ? `$${tagsIdx}::text[]` : 'tags';
      sets.push(
        `cartridge_id = NULLIF(TRIM(${profileExpr}->>'cartridge_id'), '')`,
      );
      sets.push(
        `topology_parent_id = (
           SELECT inner_e.id
             FROM entities inner_e
            WHERE inner_e.id = safe_to_bigint(${profileExpr}->>'topology_parent_id')
              AND inner_e.kind IN ('location', 'district')
         )`,
      );
      sets.push(
        `dynamic_origin = COALESCE(
           ${profileExpr}->>'origin' = 'dynamic'
           OR 'dynamic' = ANY(${tagsExpr}),
           false
         )`,
      );
    }

    sets.push('updated_at = now()');
    params.push(args.id);
    const r = await query(
      `UPDATE entities SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    return {updated: r.rows.length > 0, id: args.id};
  },
});

// ── Pre-tool validator: entity-creation discipline (spec 139 v2) ──────
//
// The player typing prose can NEVER conjure new entities into the world.
// Only NPC dialogue/action, scene beats, quest beats, and the system
// (boot, cartridge import) may author new locations / persons / quests /
// items / etc.
//
// When the broker is processing a player-prose turn and tries
// create_entity, we reject with a narrative hint: the broker must
// narrate that the player did not find / could not summon the thing,
// and prompt the player to use the map (for movement) or pick a known
// alternative.
//
// Triggered turn kinds that are ALLOWED to create:
//   - scripted (server-initiated, e.g. quest beat trigger)
// All player-driven kinds (prose, action chips, continue) are BLOCKED.

const CREATION_BANNED_KINDS = new Set<string>([
  'person',
  'location',
  'item',
  'scene',
  'quest',
  'event',
  'thread',
  'district',
  'faction',
]);

/**
 * Spec 139 v2 — gate that allows create_entity only when the current turn
 * already has an authoring voice (NPC narrate, scene/quest beat, scripted
 * system turn). The player typing prose alone cannot conjure entities;
 * the broker must first hand authoring to an NPC via narrate, then
 * create.
 *
 * "Has an NPC voice spoken this turn?" is answered by checking
 * chat_messages for rows with this turnId + tone IN ('npc', 'narrator').
 * That covers both direct NPC dialogue and authored narration where the
 * world-voice introduces a place.
 */
async function turnHasAuthoringVoice(turnId: string | undefined): Promise<boolean> {
  if (!turnId) return false;
  const parentTurnId = turnId.includes(':')
    ? turnId.slice(0, turnId.indexOf(':'))
    : turnId;
  const r = await query<{n: number}>(
    `SELECT COUNT(*)::int AS n FROM chat_messages
     WHERE (payload->>'turn_id') = ANY($1::text[])
       AND tone IN ('npc', 'narrator')`,
    [[turnId, parentTurnId]],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

function isPlayerDrivenCreationContext(ctx: ToolContext): boolean {
  if (ctx.turnInputKind === 'scripted') return false;
  if (
    ctx.turnInputKind === 'player_prose' ||
    ctx.turnInputKind === 'player_action' ||
    ctx.turnInputKind === 'continue'
  ) {
    return true;
  }
  return ctx.toolHistorySource === 'ai_sdk';
}

registerPreToolValidator('create_entity', async (_name, args, ctx) => {
  const a = args as {kind?: string; display_name?: string};
  const kind = (a.kind ?? '').toLowerCase();
  if (!CREATION_BANNED_KINDS.has(kind)) return {ok: true};
  if (!isPlayerDrivenCreationContext(ctx)) return {ok: true};
  if (await turnHasAuthoringVoice(ctx.turnId)) return {ok: true};
  return {
    ok: false,
    reason:
      `Refused: create_entity(kind='${kind}', display_name='${a.display_name ?? '(unnamed)'}') ` +
      `cannot be authored from player prose alone. An NPC or the world's narrator must speak first.\n\n` +
      `Fix: BEFORE calling create_entity, call narrate({tone:'npc', author_id:<present NPC>, ...}) ` +
      `OR narrate({tone:'narrator', ...}) describing the thing being introduced. Then call create_entity. ` +
      `If no one is around to introduce it, narrate that the player cannot find / cannot summon it, and ` +
      `propose existing options (map travel, search_entities, ask an NPC).`,
  };
});

registerPreToolValidator('create_quest', async (_name, _args, ctx) => {
  if (!isPlayerDrivenCreationContext(ctx)) return {ok: true};
  if (await turnHasAuthoringVoice(ctx.turnId)) return {ok: true};
  return {
    ok: false,
    reason:
      'Refused: create_quest cannot be authored from player prose alone. ' +
      'A present NPC or the narrator must speak first to introduce the quest. ' +
      'Call narrate(...) with an NPC author voice first, then create_quest.',
  };
});
