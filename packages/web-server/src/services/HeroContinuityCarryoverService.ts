/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-4 (2026-05-17) — backend launch / new-game
// carryover policy.
//
// This service is the **mutating** companion of `HeroContinuityService`
// (which is strictly read-only). It runs inside the existing
// `CartridgePlaythroughService.launch()` / `.newGame()` transactions
// and applies the cross-world identity contract laid out in
// `docs/specs/hero-continuity-parallel-universes.md`:
//
//   1. Snapshot the departing world's live roster
//      (`players.metadata.companions[]`) into the source
//      `hero_cartridge_states.world_snapshot` so it can be restored on
//      a future return to that world. The source row is the previous
//      `status='active'` row for this player; the playthrough service
//      flips it to `available` immediately before invoking us.
//   2. Build the new live roster for the target world:
//        - LAUNCH continue (target was previously visited): restore
//          the target row's `world_snapshot.companions[]` after
//          filtering each id to the target cartridge scope; then
//          append accepted portable-companion projection ids.
//        - LAUNCH first_spawn / NEW_GAME: live roster starts empty;
//          only accepted projection ids are appended.
//   3. For each hero_companion_bond, classify against the target
//      cartridge policy (`cartridge_meta_scoped.hero_continuity_policy`):
//        - bond.portability === 'portable' AND bond.status !==
//          'suppressed' AND target policy allows
//          `companions: 'portable_contracts'` → accepted/traveling.
//        - otherwise → suppressed for this world; no projection,
//          summary outcome includes the reason.
//   4. For each accepted bond:
//        a. Build (or reuse a fresh) companion capsule via
//           `HeroContinuityLedgerService.buildCompanionCapsule()`.
//        b. Ensure/upsert a target projection `entities(kind='person',
//           dynamic_origin=true, cartridge_id=target)` row keyed off
//           `companion_universe_projections.projection_entity_id`.
//           Identity-only copy: `display_name`, `persona_slug`,
//           `summary`, `i18n` come from the capsule; profile/i18n
//           keys that reference source-world ids are NOT copied here
//           (deferred to FEAT-HERO-CONTINUITY-5+).
//        c. Apply safe capsule slices to the projection entity:
//             * stats (`npc_stats(npc_entity_id = projection)`)
//             * relationship string toward the hero
//               (`runtime_fields(field_key='strings')` on the
//                projection, value = `{ [heroId]: stringTowardHero }`).
//             * about-hero memories
//               (`npc_memories(owner=projection, about=heroId)`).
//           Inventory entries are **not** copied in this pass;
//           `arrival_payload.deferred` records the count so a future
//           pass can wire safe item resolution.
//        d. Upsert `companion_universe_projections` with status
//           `following`, `projection_entity_id`, and a structured
//           `arrival_payload` capturing the capsule id/version, the
//           copied/deferred slice counts, and the leak guard markers.
//        e. Write `actor_statuses(status_kind='companion',
//           status_value='following')` for `(playerId, projection)`.
//   5. Write `players.metadata.companions = newRoster` so subsequent
//      gameplay reads pick up projection ids (NOT source-world ids).
//   6. Record a `hero_continuity_events` row summarizing the launch.
//   7. Return a typed `ContinuityCarryoverSummary` so the caller can
//      surface `continuityCarryover` on the playthrough result.
//
// What this service does NOT do:
//
//   * Never touches the cartridge import/apply or static cartridge
//     tables.
//   * Never mutates `HeroContinuityService.previewTransfer()` — the
//     read-only preview is unchanged.
//   * Never copies player inventory, quest progress, player-owned
//     `npc_memories`, current scene, relationship strings the hero
//     holds toward other NPCs, map state, or ordinary NPCs across
//     cartridges.
//   * Never deletes a different hero's row or roster.

import {query} from '../db.js';
import {
  HeroContinuityLedgerService,
  type CompanionCapsule,
  type HeroCompanionBond,
  type HeroPortableArtifact,
} from './HeroContinuityLedgerService.js';

export type ContinuityCarryoverLaunchMode =
  | 'launch_first_spawn'
  | 'launch_continue'
  | 'new_game';

export interface ContinuityCarryoverCompanionOutcome {
  bondId: number;
  companionKey: string;
  /** Target-world projection entity id (only present when accepted). */
  projectionEntityId: number | null;
  /** Source-world `entities.id` if the bond carried one; useful for
   *  the GUI when explaining where this companion travelled from. */
  sourceEntityId: number | null;
  /** Per-companion verdict. */
  status:
    | 'traveling'
    | 'suppressed'
    | 'world_bound'
    | 'requires_adapter'
    | 'no_contract';
  /** Stable reason code so the GUI never has to invent copy. */
  reason: string;
  /** Capsule version applied to the projection (when accepted). */
  capsuleVersion: number | null;
}

export interface ContinuityCarryoverPortableArtifactOutcome {
  artifactKey: string;
  kind: HeroPortableArtifact['kind'];
  portability: HeroPortableArtifact['portability'];
  powerRating: number;
  /** `'carried'` when the artifact's portability + policy allow it
   *  in the target; `'suppressed'` otherwise. The artifact ledger
   *  rows are never mutated here — this is a per-launch verdict the
   *  GUI can render. */
  outcome: 'carried' | 'suppressed';
  reason: string;
}

export interface ContinuityCarryoverSummary {
  schemaVersion: 'greenhaven.hero_continuity_carryover.v1';
  mode: ContinuityCarryoverLaunchMode;
  sourceCartridgeId: string | null;
  sourceUniverseInstanceId: string | null;
  targetCartridgeId: string;
  targetUniverseInstanceId: string;
  playthroughId: string;
  resetGeneration: number;
  /** Companions accepted into the target world. Always a subset of
   *  `companions`. The live roster on `players.metadata.companions`
   *  ends with `projectionEntityIds` for these companions + any
   *  restored same-world local ids from a prior visit. */
  companions: ContinuityCarryoverCompanionOutcome[];
  portableArtifacts: ContinuityCarryoverPortableArtifactOutcome[];
  /** Final live roster after carryover. NEVER contains source-world
   *  entity ids unless they belonged to the target world's prior
   *  visit and survived the cartridge-scope filter. */
  liveRosterAfter: number[];
  /** Snapshot of the departing live roster BEFORE carryover. Empty
   *  on a fresh hero. */
  departingRosterBefore: number[];
  /** The continuity event row id this carryover wrote. */
  continuityEventId: number;
}

interface CarryoverInput {
  playerId: number;
  /** The departing world's cartridge id, or null if the hero had no
   *  prior active row. */
  sourceCartridgeId: string | null;
  targetCartridgeId: string;
  targetUniverseInstanceId: string;
  playthroughId: string;
  resetGeneration: number;
  mode: ContinuityCarryoverLaunchMode;
  /**
   * FEAT-HERO-CONTINUITY-4-FOLLOWUP — true when the target row was
   * `status='active'` for this hero BEFORE the launch (i.e. the
   * hero is re-launching the same already-active world, not
   * switching from a different world). When set, the carryover
   * keeps the live roster as the restore base instead of
   * re-hydrating from a potentially-stale target `world_snapshot`.
   */
  targetAlreadyActive?: boolean;
}

interface TargetPolicy {
  allowsPortableContracts: boolean;
}

async function loadTargetPolicy(cartridgeId: string): Promise<TargetPolicy> {
  const r = await query<{value: unknown}>(
    `SELECT value
       FROM cartridge_meta_scoped
      WHERE cartridge_id = $1
        AND key = 'hero_continuity_policy'
      LIMIT 1`,
    [cartridgeId],
  );
  const raw = r.rows[0]?.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {allowsPortableContracts: false};
  }
  const obj = raw as Record<string, unknown>;
  const carry = obj['carry'];
  if (!carry || typeof carry !== 'object' || Array.isArray(carry)) {
    return {allowsPortableContracts: false};
  }
  const companions = (carry as Record<string, unknown>)['companions'];
  if (companions === 'portable_contracts') {
    return {allowsPortableContracts: true};
  }
  if (
    companions &&
    typeof companions === 'object' &&
    !Array.isArray(companions) &&
    (companions as Record<string, unknown>)['portable_contracts'] === 'allow'
  ) {
    return {allowsPortableContracts: true};
  }
  return {allowsPortableContracts: false};
}

async function loadRoster(playerId: number): Promise<number[]> {
  const r = await query<{companions: unknown}>(
    `SELECT metadata->'companions' AS companions
       FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const raw = r.rows[0]?.companions;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

async function writeRoster(playerId: number, ids: number[]): Promise<void> {
  await query(
    `UPDATE players
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('companions', $1::jsonb)
      WHERE entity_id = $2`,
    [JSON.stringify(ids), playerId],
  );
}

async function snapshotDepartingRoster(
  playerId: number,
  sourceCartridgeId: string | null,
  roster: number[],
): Promise<void> {
  if (!sourceCartridgeId) return;
  // FEAT-HERO-CONTINUITY-4-FOLLOWUP — write `world_snapshot.companions`
  // even when the live roster is empty. Without the explicit empty
  // write a stale companions array from a prior departure would
  // re-hydrate when the hero returns later.
  await query(
    `UPDATE hero_cartridge_states
        SET world_snapshot = COALESCE(world_snapshot, '{}'::jsonb)
                          || jsonb_build_object(
                               'companions', $1::jsonb,
                               'companions_snapshotted_at',
                               to_jsonb(now())
                             ),
            updated_at = now()
      WHERE player_id = $2 AND cartridge_id = $3`,
    [JSON.stringify(roster), playerId, sourceCartridgeId],
  );
}

async function loadTargetWorldSnapshotCompanions(
  playerId: number,
  cartridgeId: string,
): Promise<number[]> {
  const r = await query<{companions: unknown}>(
    `SELECT world_snapshot->'companions' AS companions
       FROM hero_cartridge_states
      WHERE player_id = $1 AND cartridge_id = $2`,
    [playerId, cartridgeId],
  );
  const raw = r.rows[0]?.companions;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * FEAT-HERO-CONTINUITY-4-FOLLOWUP — restore filter scoped to either
 * the target cartridge OR an existing companion projection for the
 * exact target universe. A foreign `dynamic_origin` source-world
 * person — even though it satisfies the cartridge-id NOT-NULL
 * CHECK — must NOT pass: that was the leak the previous
 * `dynamic_origin = true` permissive clause allowed.
 */
async function filterRestoredRosterIds(
  ids: number[],
  targetCartridgeId: string,
  targetUniverseInstanceId: string,
): Promise<number[]> {
  if (ids.length === 0) return [];
  const r = await query<{id: number | string}>(
    `SELECT e.id
       FROM entities e
      WHERE e.id = ANY($1::bigint[])
        AND e.kind = 'person'
        AND (
          e.cartridge_id = $2
          OR e.id IN (
            SELECT projection_entity_id
              FROM companion_universe_projections
             WHERE universe_instance_id = $3::uuid
               AND projection_entity_id IS NOT NULL
          )
        )`,
    [ids, targetCartridgeId, targetUniverseInstanceId],
  );
  const allowed = new Set(r.rows.map(row => Number(row.id)));
  return ids.filter(id => allowed.has(id));
}

interface CapsuleSliceCounts {
  stats: number;
  aboutHeroMemories: number;
  /** Non-`strings` runtime fields successfully copied. */
  appliedRuntimeFields: number;
  /** Runtime fields the carryover refused to copy (e.g.
   *  `value_type='entity_ref'` that could leak source ids). */
  suppressedRuntimeFields: number;
  /** Companion-owned inventory entries that resolved to a safe
   *  target-cartridge item id and were copied. */
  appliedInventory: number;
  /** Companion-owned inventory entries that did not resolve in the
   *  target world and were dropped. */
  suppressedInventory: number;
  /** Non-`companion` actor_statuses rows copied to the projection. */
  appliedStatuses: number;
  /** Non-`companion` actor_statuses skipped because the metadata
   *  carried unsafe source-world references that could not be
   *  sanitized. */
  suppressedStatuses: number;
}

async function applyCapsuleToProjection(
  capsule: CompanionCapsule,
  projectionEntityId: number,
  heroId: number,
  targetCartridgeId: string,
): Promise<CapsuleSliceCounts> {
  const payload = capsule.payload;
  // Stats — replace any existing rows for the projection so a re-
  // applied capsule version is deterministic.
  await query(`DELETE FROM npc_stats WHERE npc_entity_id = $1`, [
    projectionEntityId,
  ]);
  for (const stat of payload.stats) {
    await query(
      `INSERT INTO npc_stats (npc_entity_id, stat_key, base, current)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (npc_entity_id, stat_key) DO UPDATE SET
         base = EXCLUDED.base,
         current = EXCLUDED.current`,
      [projectionEntityId, stat.statKey, stat.base, stat.current],
    );
  }

  const runtimeCounts = await applyRuntimeFieldsToProjection(
    payload.runtimeFields,
    projectionEntityId,
    heroId,
    payload.stringTowardHero,
  );

  // About-hero memories — only the slices the capsule already
  // sanitized. Replace any existing about-hero rows owned by the
  // projection so repeat applies stay deterministic; memories about
  // other NPCs (none should exist) are left alone.
  await query(
    `DELETE FROM npc_memories
       WHERE owner_entity_id = $1 AND about_entity_id = $2`,
    [projectionEntityId, heroId],
  );
  for (const mem of payload.memories.aboutHero) {
    await query(
      `INSERT INTO npc_memories
         (owner_entity_id, about_entity_id, text, importance, tags,
          sensitive, metadata)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7::jsonb)`,
      [
        projectionEntityId,
        heroId,
        mem.text,
        mem.importance,
        mem.tags,
        mem.sensitive,
        JSON.stringify(mem.metadata ?? {}),
      ],
    );
  }

  const inventoryCounts = await applyInventoryToProjection(
    payload.inventory,
    projectionEntityId,
    targetCartridgeId,
  );
  const statusCounts = await applyActorStatusesToProjection(
    payload.statuses,
    projectionEntityId,
    heroId,
  );

  return {
    stats: payload.stats.length,
    aboutHeroMemories: payload.memories.aboutHero.length,
    appliedRuntimeFields: runtimeCounts.applied,
    suppressedRuntimeFields: runtimeCounts.suppressed,
    appliedInventory: inventoryCounts.applied,
    suppressedInventory: inventoryCounts.suppressed,
    appliedStatuses: statusCounts.applied,
    suppressedStatuses: statusCounts.suppressed,
  };
}

/**
 * FEAT-HERO-CONTINUITY-4-FOLLOWUP — apply non-`strings` runtime
 * fields from the capsule onto the projection. The `strings` field
 * is always reset to the hero-only sanitized map (so it can be
 * called repeatedly without leaking foreign entity ids). Fields with
 * `value_type='entity_ref'` are skipped because they would carry
 * source-world ids; their count is reported as suppressed.
 */
async function applyRuntimeFieldsToProjection(
  fields: CompanionCapsule['payload']['runtimeFields'],
  projectionEntityId: number,
  heroId: number,
  stringTowardHero: number,
): Promise<{applied: number; suppressed: number}> {
  // Strings — hero-only sanitized map.
  const stringMap: Record<string, number> = {};
  if (stringTowardHero !== 0) stringMap[String(heroId)] = stringTowardHero;
  await upsertRuntimeField(
    projectionEntityId,
    'strings',
    'json',
    JSON.stringify(stringMap),
  );

  let applied = 0;
  let suppressed = 0;
  for (const field of fields) {
    if (field.fieldKey === 'strings') continue;
    // entity_ref values reference source-world ids; skip wholesale.
    if (field.valueType === 'entity_ref') {
      suppressed += 1;
      continue;
    }
    await upsertRuntimeField(
      projectionEntityId,
      field.fieldKey,
      field.valueType,
      JSON.stringify(field.value ?? null),
    );
    applied += 1;
  }
  return {applied, suppressed};
}

async function upsertRuntimeField(
  ownerEntityId: number,
  fieldKey: string,
  valueType: string,
  jsonValue: string,
): Promise<void> {
  const rfRows = await query<{id: number | string}>(
    `SELECT id FROM runtime_fields
      WHERE owner_entity_id = $1 AND field_key = $2
      LIMIT 1`,
    [ownerEntityId, fieldKey],
  );
  let fieldId: number;
  const existing = rfRows.rows[0];
  if (existing) {
    fieldId = Number(existing.id);
  } else {
    const inserted = await query<{id: number | string}>(
      `INSERT INTO runtime_fields (owner_entity_id, field_key, value_type, scope)
       VALUES ($1, $2, $3, 'permanent')
       RETURNING id`,
      [ownerEntityId, fieldKey, valueType],
    );
    fieldId = Number(inserted.rows[0]!.id);
  }
  await query(
    `INSERT INTO runtime_values (field_id, value, source)
     VALUES ($1, $2::jsonb, 'hero_continuity_carryover')
     ON CONFLICT (field_id) DO UPDATE SET
       value = EXCLUDED.value,
       source = EXCLUDED.source,
       updated_at = now()`,
    [fieldId, jsonValue],
  );
}

/**
 * FEAT-HERO-CONTINUITY-4-FOLLOWUP — resolve each companion-owned
 * inventory entry against the TARGET cartridge before copying. The
 * resolver order is:
 *
 *   1. `cartridge_records(target_cartridge_id, kind='item',
 *      slug=item.sourceSlug)` — the stable cross-cartridge identity
 *      key; matches re-imported clones of the same authored item.
 *   2. `entities.profile->>'source_slug' = sourceSlug` scoped to the
 *      target cartridge — covers items the target cartridge
 *      authored under the same slug without a record row.
 *
 * If neither resolves, the entry is dropped and counted as
 * `suppressedInventory`. The previous projection's
 * `inventory_entries` are cleared first so re-applies converge.
 */
async function applyInventoryToProjection(
  inventory: CompanionCapsule['payload']['inventory'],
  projectionEntityId: number,
  targetCartridgeId: string,
): Promise<{applied: number; suppressed: number}> {
  await query(
    `DELETE FROM inventory_entries WHERE holder_entity_id = $1`,
    [projectionEntityId],
  );
  let applied = 0;
  let suppressed = 0;
  for (const entry of inventory) {
    const targetItemId = await resolveInventoryItemForTarget(
      entry.item.sourceSlug,
      targetCartridgeId,
    );
    if (targetItemId == null) {
      suppressed += 1;
      continue;
    }
    await query(
      `INSERT INTO inventory_entries
         (holder_entity_id, item_entity_id, count, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (holder_entity_id, item_entity_id) DO UPDATE SET
         count = EXCLUDED.count,
         metadata = EXCLUDED.metadata`,
      [
        projectionEntityId,
        targetItemId,
        Math.max(0, Math.trunc(entry.count)),
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
    applied += 1;
  }
  return {applied, suppressed};
}

async function resolveInventoryItemForTarget(
  sourceSlug: string | null,
  targetCartridgeId: string,
): Promise<number | null> {
  if (!sourceSlug) return null;
  // 1) cartridge_records is the canonical stable key.
  const recordRows = await query<{imported_entity_id: number | string | null}>(
    `SELECT imported_entity_id
       FROM cartridge_records
      WHERE cartridge_id = $1
        AND kind = 'item'
        AND slug = $2
        AND status = 'active'
      LIMIT 1`,
    [targetCartridgeId, sourceSlug],
  );
  const recordHit = recordRows.rows[0]?.imported_entity_id;
  if (recordHit != null) return Number(recordHit);
  // 2) Fallback: a target-cartridge item entity whose profile
  // pinned the same source_slug.
  const entityRows = await query<{id: number | string}>(
    `SELECT id FROM entities
      WHERE cartridge_id = $1
        AND kind = 'item'
        AND profile->>'source_slug' = $2
      LIMIT 1`,
    [targetCartridgeId, sourceSlug],
  );
  const entityHit = entityRows.rows[0]?.id;
  return entityHit != null ? Number(entityHit) : null;
}

/**
 * FEAT-HERO-CONTINUITY-4-FOLLOWUP — copy non-`companion`
 * `actor_statuses` from the capsule onto the projection. The
 * `companion='following'` row is authored separately by
 * `writeFollowingStatus()`; everything else (combat-style flags,
 * mood overlays, condition counters etc.) carries with sanitized
 * metadata. Metadata is dropped wholesale if it contains an
 * entity-id-like key in the project-wide DENY list.
 */
async function applyActorStatusesToProjection(
  statuses: CompanionCapsule['payload']['statuses'],
  projectionEntityId: number,
  heroId: number,
): Promise<{applied: number; suppressed: number}> {
  let applied = 0;
  let suppressed = 0;
  for (const status of statuses) {
    if (status.statusKind === 'companion') continue;
    const sanitizedMetadata = sanitizeStatusMetadata(status.metadata);
    if (sanitizedMetadata === null) {
      suppressed += 1;
      continue;
    }
    await query(
      `INSERT INTO actor_statuses
         (player_id, actor_entity_id, status_kind, status_value, intensity,
          source, metadata)
       VALUES ($1, $2, $3, $4, $5, 'hero_continuity_carryover', $6::jsonb)
       ON CONFLICT (player_id, actor_entity_id, status_kind) DO UPDATE SET
         status_value = EXCLUDED.status_value,
         intensity = EXCLUDED.intensity,
         source = EXCLUDED.source,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [
        heroId,
        projectionEntityId,
        status.statusKind,
        status.statusValue,
        Math.max(0, Math.min(1, Number(status.intensity) || 0)),
        JSON.stringify(sanitizedMetadata),
      ],
    );
    applied += 1;
  }
  return {applied, suppressed};
}

function sanitizeStatusMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  // Drop entries that look like source-world entity refs. If the
  // shape is unusual (e.g. array root), bail out entirely — the
  // status will be counted as suppressed.
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (PROFILE_DENY_KEYS.has(key)) continue;
    if (/(_ids?$|^entity$|^participants$)/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

async function ensureProjectionEntity(
  bond: HeroCompanionBond,
  capsule: CompanionCapsule,
  targetCartridgeId: string,
  targetUniverseInstanceId: string,
): Promise<number> {
  // FEAT-HERO-CONTINUITY-4-FOLLOWUP — projection reuse is keyed by
  // the exact `(bond_id, target_universe_instance_id)` pair, not by
  // bond+cartridge. Two universes that share a cartridge (e.g.
  // future `local_party` + `local_single_player` over the same
  // template) must each get their own projection entity.
  const proj = await query<{projection_entity_id: number | string | null}>(
    `SELECT projection_entity_id
       FROM companion_universe_projections
      WHERE companion_bond_id = $1
        AND universe_instance_id = $2::uuid
      LIMIT 1`,
    [bond.id, targetUniverseInstanceId],
  );
  const existingId = proj.rows[0]?.projection_entity_id;
  const payload = capsule.payload;
  const sanitizedProfile = sanitizeProfileForProjection(
    payload.identity.profile,
  );
  if (existingId != null) {
    const id = Number(existingId);
    // Reuse — refresh identity + sanitized profile from the latest
    // capsule snapshot so a re-applied capsule keeps the projection
    // in step.
    await query(
      `UPDATE entities
          SET display_name = $1,
              persona_slug = COALESCE($2, persona_slug),
              summary = $3,
              profile = $4::jsonb,
              i18n = $5::jsonb
        WHERE id = $6`,
      [
        payload.identity.displayName,
        payload.identity.personaSlug,
        payload.identity.summary,
        JSON.stringify(sanitizedProfile),
        JSON.stringify(payload.identity.i18n),
        id,
      ],
    );
    return id;
  }
  // Create a fresh projection entity in the target cartridge with
  // `dynamic_origin = true`. The profile is sanitized through
  // `sanitizeProfileForProjection` — safe trait/voice/mood/persona
  // keys carry; source-world location/scene/entity refs are dropped
  // so the projection never holds a foreign-world id.
  const r = await query<{id: number | string}>(
    `INSERT INTO entities
       (kind, display_name, persona_slug, summary, profile, i18n,
        cartridge_id, dynamic_origin)
     VALUES ('person', $1, $2, $3, $4::jsonb, $5::jsonb, $6, true)
     RETURNING id`,
    [
      payload.identity.displayName,
      payload.identity.personaSlug,
      payload.identity.summary,
      JSON.stringify(sanitizedProfile),
      JSON.stringify(payload.identity.i18n),
      targetCartridgeId,
    ],
  );
  return Number(r.rows[0]!.id);
}

/**
 * FEAT-HERO-CONTINUITY-4-FOLLOWUP — strip source-world references
 * from an arbitrary `entities.profile` JSON before it lands on a
 * target-world projection. Deny-keys cover the well-known location/
 * scene/quest/entity-id surfaces; the rest of the profile (traits,
 * voice, mood, tone, oath, summary, personality flags, etc.) carries
 * verbatim because that's the cross-world identity the spec wants
 * to preserve.
 */
const PROFILE_DENY_KEYS = new Set<string>([
  'home_id',
  'location_id',
  'current_location_id',
  'scene_id',
  'current_scene_id',
  'exits',
  'participant_entity_ids',
  'dialogue_partner_id',
  'target_entity_id',
  'target_id',
  'entity_id',
  'npc_id',
  'quest_id',
  'active_quest_id',
  'source_id',
  'source_entity_id',
  'source_location_id',
  'depart_when',
  'companion_of',
]);

export function sanitizeProfileForProjection(
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (PROFILE_DENY_KEYS.has(key)) continue;
    // Drop any keys that LOOK like entity-id arrays (e.g.
    // `companions`, `participants`, `*_ids`) — even if not in the
    // deny list, an int-or-int-array under such a name almost
    // certainly references a source-world entity.
    if (
      /(_ids?$|^companions$|^participants$|^locations?$|^scenes?$|^quests?$)/i.test(
        key,
      )
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

async function upsertProjection(
  bondId: number,
  universeInstanceId: string,
  projectionEntityId: number,
  arrivalPayload: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO companion_universe_projections
       (companion_bond_id, universe_instance_id, projection_entity_id,
        status, arrival_payload)
     VALUES ($1, $2::uuid, $3, 'following', $4::jsonb)
     ON CONFLICT (companion_bond_id, universe_instance_id) DO UPDATE SET
       projection_entity_id = EXCLUDED.projection_entity_id,
       status = 'following',
       arrival_payload = EXCLUDED.arrival_payload,
       updated_at = now()`,
    [bondId, universeInstanceId, projectionEntityId, JSON.stringify(arrivalPayload)],
  );
}

async function writeFollowingStatus(
  playerId: number,
  projectionEntityId: number,
  bondId: number,
): Promise<void> {
  await query(
    `INSERT INTO actor_statuses
       (player_id, actor_entity_id, status_kind, status_value, intensity,
        source, metadata)
     VALUES ($1, $2, 'companion', 'following', 1.0, 'hero_continuity_carryover',
             $3::jsonb)
     ON CONFLICT (player_id, actor_entity_id, status_kind) DO UPDATE SET
       status_value = EXCLUDED.status_value,
       intensity = EXCLUDED.intensity,
       source = EXCLUDED.source,
       metadata = EXCLUDED.metadata,
       updated_at = now()`,
    [
      playerId,
      projectionEntityId,
      JSON.stringify({bond_id: bondId, applied_at: new Date().toISOString()}),
    ],
  );
}

function classifyArtifactOutcome(
  artifact: HeroPortableArtifact,
  policy: TargetPolicy,
): ContinuityCarryoverPortableArtifactOutcome {
  // FEAT-HERO-CONTINUITY-4 keeps artifact carryover policy minimal:
  // a portable+non-suppressed artifact rides whenever the artifact
  // ledger says so. A future pass may add per-cartridge whitelists
  // (`carry.portable_artifacts === 'allow'` etc.); for now any
  // `'portable'` artifact carries, the rest are suppressed for the
  // target world. The artifact ledger rows themselves are NOT
  // mutated; this is only the per-launch verdict.
  if (artifact.portability === 'portable') {
    return {
      artifactKey: artifact.artifactKey,
      kind: artifact.kind,
      portability: artifact.portability,
      powerRating: artifact.powerRating,
      outcome: 'carried',
      reason: 'portable',
    };
  }
  if (artifact.portability === 'requires_adapter') {
    return {
      artifactKey: artifact.artifactKey,
      kind: artifact.kind,
      portability: artifact.portability,
      powerRating: artifact.powerRating,
      outcome: 'suppressed',
      reason: 'requires_adapter',
    };
  }
  return {
    artifactKey: artifact.artifactKey,
    kind: artifact.kind,
    portability: artifact.portability,
    powerRating: artifact.powerRating,
    outcome: 'suppressed',
    reason: artifact.portability,
  };
  // Note: `policy.allowsPortableContracts` is currently only
  // consulted for companions; artifact-level policy lives in a
  // future pass.
  void policy;
}

export class HeroContinuityCarryoverService {
  /**
   * Apply the FEAT-HERO-CONTINUITY-4 launch carryover policy. Must
   * be called from inside the existing `withTransaction()` block
   * the playthrough service opens — `query()` routes through the
   * active transaction automatically.
   */
  static async applyLaunchCarryover(
    input: CarryoverInput,
  ): Promise<ContinuityCarryoverSummary> {
    const {
      playerId,
      sourceCartridgeId,
      targetCartridgeId,
      targetUniverseInstanceId,
      playthroughId,
      resetGeneration,
      mode,
      targetAlreadyActive,
    } = input;

    // 1) Snapshot the departing roster into the source row's
    //    world_snapshot so a future return restores it. Snapshot
    //    runs even when the live roster is empty so a stale prior
    //    snapshot can never re-hydrate from this world later.
    const departingRoster = await loadRoster(playerId);
    await snapshotDepartingRoster(
      playerId,
      sourceCartridgeId,
      departingRoster,
    );

    // 2) Pick the base roster for the target world.
    //    `launch_continue` AND a real world switch → restore the
    //    target row's world_snapshot.
    //    `launch_continue` AND target was already active → keep
    //    the live roster as-is (filtered to target scope) so a
    //    re-launch of the same world does not blow it away from a
    //    stale snapshot.
    //    `launch_first_spawn` / `new_game` → start empty.
    let nextRoster: number[] = [];
    if (mode === 'launch_continue') {
      if (targetAlreadyActive) {
        nextRoster = await filterRestoredRosterIds(
          departingRoster,
          targetCartridgeId,
          targetUniverseInstanceId,
        );
      } else {
        const candidates = await loadTargetWorldSnapshotCompanions(
          playerId,
          targetCartridgeId,
        );
        nextRoster = await filterRestoredRosterIds(
          candidates,
          targetCartridgeId,
          targetUniverseInstanceId,
        );
      }
    }

    // 3) Read ledger: bonds + portable artifacts + target policy.
    const [policy, bonds, artifacts, sourceUniverseRow] = await Promise.all([
      loadTargetPolicy(targetCartridgeId),
      HeroContinuityLedgerService.listCompanionBonds(playerId),
      HeroContinuityLedgerService.listPortableArtifacts(playerId),
      sourceCartridgeId
        ? query<{universe_instance_id: string | null}>(
            `SELECT universe_instance_id::text AS universe_instance_id
               FROM hero_cartridge_states
              WHERE player_id = $1 AND cartridge_id = $2
              LIMIT 1`,
            [playerId, sourceCartridgeId],
          )
        : Promise.resolve({rows: [] as {universe_instance_id: string | null}[]}),
    ]);
    const sourceUniverseInstanceId =
      sourceUniverseRow.rows[0]?.universe_instance_id ?? null;

    // 4) Classify each bond, build capsule for accepted, materialize
    //    projection, apply slices, write follow status.
    const companionOutcomes: ContinuityCarryoverCompanionOutcome[] = [];
    for (const bond of bonds) {
      const outcome = await processBond(
        bond,
        playerId,
        targetCartridgeId,
        targetUniverseInstanceId,
        policy,
      );
      companionOutcomes.push(outcome);
      if (
        outcome.status === 'traveling' &&
        outcome.projectionEntityId != null
      ) {
        nextRoster.push(outcome.projectionEntityId);
      }
    }
    // De-dupe while preserving order.
    const seen = new Set<number>();
    const dedupedRoster: number[] = [];
    for (const id of nextRoster) {
      if (seen.has(id)) continue;
      seen.add(id);
      dedupedRoster.push(id);
    }

    // 5) Write the new roster.
    await writeRoster(playerId, dedupedRoster);

    // 6) Per-launch artifact verdicts (ledger rows untouched).
    const artifactOutcomes: ContinuityCarryoverPortableArtifactOutcome[] =
      artifacts.map(a => classifyArtifactOutcome(a, policy));

    // 7) Record the continuity event.
    const event = await HeroContinuityLedgerService.recordContinuityEvent({
      playerId,
      sourceUniverseInstanceId,
      targetUniverseInstanceId,
      sourceCartridgeId,
      targetCartridgeId,
      eventType:
        mode === 'new_game'
          ? 'continuity:new_game'
          : 'continuity:launch',
      payload: {
        schema_version: 'greenhaven.hero_continuity_carryover.v1',
        mode,
        playthrough_id: playthroughId,
        reset_generation: resetGeneration,
        companions: companionOutcomes,
        portable_artifacts: artifactOutcomes,
        live_roster_after: dedupedRoster,
        departing_roster_before: departingRoster,
      },
    });

    return {
      schemaVersion: 'greenhaven.hero_continuity_carryover.v1',
      mode,
      sourceCartridgeId,
      sourceUniverseInstanceId,
      targetCartridgeId,
      targetUniverseInstanceId,
      playthroughId,
      resetGeneration,
      companions: companionOutcomes,
      portableArtifacts: artifactOutcomes,
      liveRosterAfter: dedupedRoster,
      departingRosterBefore: departingRoster,
      continuityEventId: event.id,
    };
  }
}

async function processBond(
  bond: HeroCompanionBond,
  playerId: number,
  targetCartridgeId: string,
  targetUniverseInstanceId: string,
  policy: TargetPolicy,
): Promise<ContinuityCarryoverCompanionOutcome> {
  // Classify first — the spec requires both the bond AND the target
  // policy to allow portable contracts before the projection is
  // materialized.
  if (bond.status === 'suppressed' || bond.portability === 'suppressed') {
    return {
      bondId: bond.id,
      companionKey: bond.companionKey,
      projectionEntityId: null,
      sourceEntityId: bond.sourceEntityId,
      status: 'suppressed',
      reason: 'bond_suppressed',
      capsuleVersion: null,
    };
  }
  if (bond.portability === 'requires_adapter') {
    return {
      bondId: bond.id,
      companionKey: bond.companionKey,
      projectionEntityId: null,
      sourceEntityId: bond.sourceEntityId,
      status: 'requires_adapter',
      reason: 'requires_adapter',
      capsuleVersion: null,
    };
  }
  if (bond.status === 'world_bound' || bond.portability === 'local_locked') {
    return {
      bondId: bond.id,
      companionKey: bond.companionKey,
      projectionEntityId: null,
      sourceEntityId: bond.sourceEntityId,
      status: 'world_bound',
      reason: 'world_bound',
      capsuleVersion: null,
    };
  }
  if (bond.portability !== 'portable') {
    return {
      bondId: bond.id,
      companionKey: bond.companionKey,
      projectionEntityId: null,
      sourceEntityId: bond.sourceEntityId,
      status: 'no_contract',
      reason: 'no_contract',
      capsuleVersion: null,
    };
  }
  if (!policy.allowsPortableContracts) {
    return {
      bondId: bond.id,
      companionKey: bond.companionKey,
      projectionEntityId: null,
      sourceEntityId: bond.sourceEntityId,
      status: 'suppressed',
      reason: 'target_policy_disallows_portable_contracts',
      capsuleVersion: null,
    };
  }
  if (bond.sourceEntityId == null) {
    // Defensive — buildCompanionCapsule throws unknown_companion_entity
    // in this case; surface it as suppressed rather than aborting.
    return {
      bondId: bond.id,
      companionKey: bond.companionKey,
      projectionEntityId: null,
      sourceEntityId: null,
      status: 'suppressed',
      reason: 'bond_has_no_source_entity',
      capsuleVersion: null,
    };
  }

  // Build (or rebuild) the capsule so we get the latest sanitized
  // state. `buildCompanionCapsule` inserts a new versioned row.
  // CATCH-WARN-OK: per-bond capsule build failure must NOT abort
  // the rest of carryover; surface as suppressed with the failure
  // reason and log a warning so telemetry/operators can see it.
  let capsule: CompanionCapsule;
  try {
    capsule = await HeroContinuityLedgerService.buildCompanionCapsule(bond.id);
  } catch (err) {
    console.warn(
      `[hero-continuity-4] capsule build failed for bond ${bond.id}:`,
      err instanceof Error ? err.message : err,
    );
    return {
      bondId: bond.id,
      companionKey: bond.companionKey,
      projectionEntityId: null,
      sourceEntityId: bond.sourceEntityId,
      status: 'suppressed',
      reason: 'capsule_build_failed',
      capsuleVersion: null,
    };
  }

  const projectionEntityId = await ensureProjectionEntity(
    bond,
    capsule,
    targetCartridgeId,
    targetUniverseInstanceId,
  );
  const sliceCounts = await applyCapsuleToProjection(
    capsule,
    projectionEntityId,
    playerId,
    targetCartridgeId,
  );
  await upsertProjection(
    bond.id,
    targetUniverseInstanceId,
    projectionEntityId,
    {
      schema_version: 'greenhaven.companion_arrival.v2',
      capsule_id: capsule.id,
      capsule_version: capsule.capsuleVersion,
      state_hash: capsule.stateHash,
      applied_slices: [
        'identity',
        'profile',
        'stats',
        'strings',
        'about_hero_memories',
        'runtime_fields',
        'inventory',
        'general_statuses',
      ],
      slice_counts: sliceCounts,
    },
  );
  await writeFollowingStatus(playerId, projectionEntityId, bond.id);

  return {
    bondId: bond.id,
    companionKey: bond.companionKey,
    projectionEntityId,
    sourceEntityId: bond.sourceEntityId,
    status: 'traveling',
    reason: 'portable_contract',
    capsuleVersion: capsule.capsuleVersion,
  };
}
