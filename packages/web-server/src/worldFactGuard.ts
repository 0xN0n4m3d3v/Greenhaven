/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from './db.js';

export interface DynamicWorldFactSpawn {
  kind: string;
  display_name: string;
  summary?: string | null;
  profile?: unknown;
  hidden_until_stage?: string | null;
  tags?: string[] | null;
}

export interface WorldFactGuardContext {
  playerId?: number | null;
  currentLocationId?: number | null;
}

export type WorldFactGuardVerdict =
  | {ok: true}
  | {ok: false; reason: string; suggestion?: Record<string, unknown>};

interface EntityRef {
  id: number;
  kind: string;
  displayName: string;
  profile: Record<string, unknown>;
  // ARCH-19 pre-Phase-4 hardening — normalized parent column (from
  // 0105) so reachability validation does not consult the
  // soon-to-be-dropped `profile.topology_parent_id` JSONB key.
  topologyParentId: number | null;
}

const PRIVATE_POLICIES = new Set(['staff_only', 'locked', 'secret', 'hostile']);
const LOCATION_PARENT_KINDS = new Set(['location', 'scene', 'district']);
const LOCATION_OWNER_KINDS = new Set(['person', 'faction', 'service', 'location', 'district']);

export async function validateDynamicWorldFactSpawn(
  spawn: DynamicWorldFactSpawn,
  ctx: WorldFactGuardContext = {},
): Promise<WorldFactGuardVerdict> {
  if (spawn.kind === 'location') {
    return validateLocationSpawn(spawn, ctx);
  }
  if (spawn.kind === 'item') {
    return validateItemSpawn(spawn, ctx);
  }
  return {ok: true};
}

async function validateLocationSpawn(
  spawn: DynamicWorldFactSpawn,
  ctx: WorldFactGuardContext,
): Promise<WorldFactGuardVerdict> {
  const profile = asRecord(spawn.profile);
  const topologyParentId = readPositiveId(profile['topology_parent_id']);
  const currentLocationId = ctx.currentLocationId ?? await currentLocationIdForPlayer(ctx.playerId);

  if (topologyParentId == null) {
    return {
      ok: false,
      reason: `location_spawn_missing_topology: @${spawn.display_name} needs profile.topology_parent_id`,
      suggestion: {
        profile: {
          topology_parent_id: currentLocationId ?? '<current location id>',
        },
        reason: 'new locations must be attached to an existing parent location/scene',
      },
    };
  }

  const parent = await loadEntity(topologyParentId);
  if (!parent) {
    return {
      ok: false,
      reason: `location_spawn_unknown_topology: topology_parent_id ${topologyParentId} does not exist`,
      suggestion: {profile: {topology_parent_id: currentLocationId ?? '<known location id>'}},
    };
  }
  if (!LOCATION_PARENT_KINDS.has(parent.kind)) {
    return {
      ok: false,
      reason:
        `location_spawn_invalid_topology: topology_parent_id ${topologyParentId} is kind=${parent.kind}`,
      suggestion: {profile: {topology_parent_id: currentLocationId ?? '<location id>'}},
    };
  }
  if (
    currentLocationId != null &&
    !(await topologyParentIsReachable(currentLocationId, topologyParentId))
  ) {
    return {
      ok: false,
      reason:
        `location_spawn_parent_not_reachable: @${spawn.display_name} parent @${parent.displayName} is not current, adjacent, or nested from the player's current location`,
      suggestion: {
        profile: {topology_parent_id: currentLocationId},
        reason: 'spawn a new place under the current scene or a listed exit, not an unrelated offscreen parent',
      },
    };
  }

  const hiddenUntilStage = readText(spawn.hidden_until_stage) ??
    readText(profile['hidden_until_stage']);
  const accessPolicy = readText(profile['access_policy']) ?? 'public';
  const requiresControlledAccess =
    hiddenUntilStage != null || PRIVATE_POLICIES.has(accessPolicy);
  if (!requiresControlledAccess) return {ok: true};

  const ownerEntityId = readPositiveId(profile['owner_entity_id']);
  const accessReason = readText(profile['access_reason']);
  if (ownerEntityId == null) {
    return {
      ok: false,
      reason: `private_location_missing_owner: @${spawn.display_name} needs profile.owner_entity_id`,
      suggestion: {
        profile: {owner_entity_id: readPositiveId(parent.profile['owner_entity_id']) ?? '<owner entity id>'},
        reason: 'hidden/private locations need an in-world owner or controlling source',
      },
    };
  }
  if (!accessReason) {
    return {
      ok: false,
      reason: `private_location_missing_access_reason: @${spawn.display_name} needs profile.access_reason`,
      suggestion: {
        profile: {
          access_reason: 'who grants access, why, and how the player can discover it',
        },
      },
    };
  }

  const owner = await loadEntity(ownerEntityId);
  if (!owner) {
    return {
      ok: false,
      reason: `private_location_unknown_owner: owner_entity_id ${ownerEntityId} does not exist`,
      suggestion: {profile: {owner_entity_id: '<known owner entity id>'}},
    };
  }
  if (!LOCATION_OWNER_KINDS.has(owner.kind)) {
    return {
      ok: false,
      reason:
        `private_location_invalid_owner: owner_entity_id ${ownerEntityId} is kind=${owner.kind}`,
      suggestion: {profile: {owner_entity_id: '<person/faction/service/location id>'}},
    };
  }

  const parentOwnerId = readPositiveId(parent.profile['owner_entity_id']);
  if (parentOwnerId != null && parentOwnerId !== ownerEntityId) {
    const authorizerId =
      readPositiveId(profile['access_authorizer_entity_id']) ??
      readPositiveId(profile['access_grantor_entity_id']) ??
      readPositiveId(profile['permission_entity_id']);
    if (authorizerId !== parentOwnerId) {
      const parentOwner = await loadEntity(parentOwnerId);
      return {
        ok: false,
        reason:
          `private_location_owner_mismatch: @${spawn.display_name} is owned by @${owner.displayName}, but parent @${parent.displayName} is controlled by @${parentOwner?.displayName ?? parentOwnerId}`,
        suggestion: {
          profile: {
            owner_entity_id: parentOwnerId,
            access_authorizer_entity_id: parentOwnerId,
            access_reason:
              `explain how @${parentOwner?.displayName ?? parentOwnerId} grants or reveals access`,
          },
          reason:
            'a hidden/private room inside another owner\'s place needs that parent owner in the causal chain',
        },
      };
    }
  }

  return {ok: true};
}

async function validateItemSpawn(
  spawn: DynamicWorldFactSpawn,
  ctx: WorldFactGuardContext,
): Promise<WorldFactGuardVerdict> {
  const profile = asRecord(spawn.profile);
  const holderEntityId =
    readPositiveId(profile['holder_entity_id']) ??
    readPositiveId(profile['home_id']);
  if (ctx.playerId != null && holderEntityId === ctx.playerId) {
    return {
      ok: false,
      reason: `item_spawn_direct_player_holder: @${spawn.display_name} cannot be created directly in the player's inventory`,
      suggestion: {
        profile: {
          holder_entity_id:
            ctx.currentLocationId ??
            await currentLocationIdForPlayer(ctx.playerId) ??
            '<location or NPC id>',
        },
        reason:
          'spawn/materialize the item in the world first, then use inventory_transfer to move it to the active player',
      },
    };
  }
  const hiddenUntilStage = readText(spawn.hidden_until_stage) ??
    readText(profile['hidden_until_stage']);
  if (!hiddenUntilStage) return {ok: true};

  const provenance = readText(profile['provenance']);
  if (holderEntityId == null) {
    return {
      ok: false,
      reason: `hidden_item_missing_holder: @${spawn.display_name} needs profile.holder_entity_id or profile.home_id`,
      suggestion: {
        profile: {holder_entity_id: ctx.currentLocationId ?? await currentLocationIdForPlayer(ctx.playerId) ?? '<holder entity id>'},
      },
    };
  }
  if (ctx.playerId != null && holderEntityId === ctx.playerId) {
    return {
      ok: false,
      reason: `hidden_item_direct_player_grant: @${spawn.display_name} cannot be hidden directly on the player`,
      suggestion: {
        profile: {holder_entity_id: ctx.currentLocationId ?? '<location or NPC id>'},
        reason: 'the player must discover or earn the item in-world before it enters inventory',
      },
    };
  }
  if (!provenance) {
    return {
      ok: false,
      reason: `hidden_item_missing_provenance: @${spawn.display_name} needs profile.provenance`,
      suggestion: {
        profile: {provenance: 'who placed it, why it is here, and how it can be discovered'},
      },
    };
  }
  const holder = await loadEntity(holderEntityId);
  if (!holder) {
    return {
      ok: false,
      reason: `hidden_item_unknown_holder: holder/home id ${holderEntityId} does not exist`,
      suggestion: {profile: {holder_entity_id: '<known holder entity id>'}},
    };
  }
  return {ok: true};
}

async function topologyParentIsReachable(
  currentLocationId: number,
  topologyParentId: number,
): Promise<boolean> {
  if (currentLocationId === topologyParentId) return true;
  const current = await loadEntity(currentLocationId);
  const parent = await loadEntity(topologyParentId);
  if (!current || !parent) return false;
  // ARCH-19 pre-Phase-4 hardening — both directional parent checks
  // read the normalized `entities.topology_parent_id` column so the
  // upcoming JSONB drop cannot silently flip reachability to false.
  if (parent.topologyParentId === currentLocationId) {
    return true;
  }
  if (current.topologyParentId === topologyParentId) {
    return true;
  }
  const currentExits = readIdArray(current.profile['exits']);
  if (currentExits.has(topologyParentId)) return true;
  const parentExits = readIdArray(parent.profile['exits']);
  return parentExits.has(currentLocationId);
}

async function currentLocationIdForPlayer(
  playerId: number | null | undefined,
): Promise<number | null> {
  if (playerId == null) return null;
  const row = await query<{current_location_id: number | string | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return readPositiveId(row.rows[0]?.current_location_id);
}

async function loadEntity(id: number): Promise<EntityRef | null> {
  const row = await query<{
    id: number | string;
    kind: string;
    display_name: string;
    profile: unknown;
    topology_parent_id: number | string | null;
  }>(
    `SELECT id, kind, display_name, profile, topology_parent_id
       FROM entities WHERE id = $1`,
    [id],
  );
  const entity = row.rows[0];
  if (!entity) return null;
  return {
    id: Number(entity.id),
    kind: entity.kind,
    displayName: entity.display_name,
    profile: asRecord(entity.profile),
    topologyParentId: readPositiveId(entity.topology_parent_id),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readPositiveId(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readIdArray(value: unknown): Set<number> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map(readExitId)
      .filter(item => Number.isInteger(item) && item > 0),
  );
}

function readExitId(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Number((value as Record<string, unknown>)['id']);
  }
  return Number(value);
}
