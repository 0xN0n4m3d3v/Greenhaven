/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-3 (2026-05-17) — durable ledger reader/writer for
// the cross-world hero continuity tables landed by migration 0130:
//
//   hero_continuity_events           append-only audit ledger
//   hero_portable_artifacts          (player_id, artifact_key) dedupe
//   hero_companion_bonds             (player_id, companion_key) dedupe
//   companion_universe_projections   (bond_id, universe_instance_id)
//   hero_companion_capsules          (bond_id, capsule_version)
//
// This service is intentionally narrow: typed read models, idempotent
// upserts, capsule construction. Launch/new-game carryover and
// companion materialization belong to FEAT-HERO-CONTINUITY-4.
//
// The capsule builder pulls **only** state owned by the contracted
// companion entity:
//
//   * entity identity (display_name, persona_slug, profile/i18n);
//   * `npc_stats` rows keyed on the companion entity;
//   * `actor_statuses` rows whose `actor_entity_id` is the companion;
//   * `runtime_fields`/`runtime_values` owned by the companion (this
//     covers strings, profile flags, condition counters, etc. that the
//     game persists on the NPC row);
//   * `inventory_entries` whose `holder_entity_id` is the companion;
//   * companion-owned `npc_memories` (rows where `owner_entity_id` is
//     the companion). Only memories `about` the hero are surfaced as
//     the "companion's memories of the hero" subset; the full owner
//     slice is included for cross-world resume context. Raw text is
//     copied here intentionally because the contracted companion is
//     the only allowed transfer path for memory content
//     (see `docs/specs/hero-continuity-parallel-universes.md`).
//   * the relationship-string value the companion holds *toward* the
//     hero, read from the companion's own `runtime_fields(field_key=
//     'strings')` JSON map.
//
// Unrelated source-world NPC relationships, source-world quest stages,
// arbitrary world consequences, and memories owned by OTHER NPCs are
// **not** included. In particular, the companion's `strings` runtime
// field is reduced to the hero entry only by
// `sanitizeCapsuleRuntimeField()` so foreign NPC ids and relationship
// values never leak through `payload.runtimeFields`; the canonical
// hero string still rides on `payload.stringTowardHero`.

import {query} from '../db.js';

// ── Typed row shapes ──────────────────────────────────────────────

export interface HeroContinuityEvent {
  id: number;
  playerId: number;
  sourceUniverseInstanceId: string | null;
  targetUniverseInstanceId: string | null;
  sourceCartridgeId: string | null;
  targetCartridgeId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type PortableArtifactKind =
  | 'title'
  | 'scar'
  | 'achievement'
  | 'memory_summary'
  | 'relic'
  | 'skill_mark';

export type PortabilityState =
  | 'portable'
  | 'local_locked'
  | 'suppressed'
  | 'requires_adapter';

export interface HeroPortableArtifact {
  id: number;
  playerId: number;
  artifactKey: string;
  kind: PortableArtifactKind;
  portability: PortabilityState;
  sourceUniverseInstanceId: string | null;
  sourceCartridgeId: string | null;
  powerRating: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type CompanionBondStatus =
  | 'bonded'
  | 'traveling'
  | 'world_bound'
  | 'departed'
  | 'suppressed';

export interface HeroCompanionBond {
  id: number;
  playerId: number;
  companionKey: string;
  sourceEntityId: number | null;
  sourceUniverseInstanceId: string | null;
  sourceCartridgeId: string | null;
  status: CompanionBondStatus;
  portability: PortabilityState;
  publicSummary: string | null;
  privateSummary: string | null;
  bondPayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type CompanionProjectionStatus =
  | 'available'
  | 'following'
  | 'waiting'
  | 'suppressed'
  | 'departed';

export interface CompanionUniverseProjection {
  id: number;
  companionBondId: number;
  universeInstanceId: string;
  projectionEntityId: number | null;
  status: CompanionProjectionStatus;
  arrivalPayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionCapsule {
  id: number;
  companionBondId: number;
  capsuleVersion: number;
  sourceUniverseInstanceId: string | null;
  sourceProjectionId: number | null;
  stateHash: string;
  payload: CompanionCapsulePayload;
  createdAt: string;
}

/**
 * Server-canonical companion capsule contents. Future networking can
 * reconcile by re-applying a capsule against a target world. Field
 * shapes are stable; null/empty arrays are normal when the source
 * world simply did not record that slice yet.
 */
export interface CompanionCapsulePayload {
  schemaVersion: 'greenhaven.companion_capsule.v1';
  companionEntityId: number;
  identity: {
    displayName: string;
    personaSlug: string | null;
    summary: string | null;
    profile: Record<string, unknown>;
    i18n: Record<string, unknown>;
  };
  stats: Array<{statKey: string; base: number; current: number}>;
  statuses: Array<{
    playerId: number;
    statusKind: string;
    statusValue: string;
    intensity: number;
    source: string;
    metadata: Record<string, unknown>;
  }>;
  runtimeFields: Array<{
    fieldKey: string;
    valueType: string;
    value: unknown;
  }>;
  inventory: Array<{
    /** Source-world entity id of the item. Useful for diagnostics
     *  and capsule-diff comparison; the target world cannot look
     *  this up directly. */
    itemEntityId: number;
    count: number;
    metadata: Record<string, unknown>;
    /**
     * FEAT-HERO-CONTINUITY-4-FOLLOWUP — stable item identity so the
     * carryover service can resolve the item against the target
     * cartridge via `cartridge_records(kind='item', slug)` or
     * `entities.profile->>'source_slug'` without trusting the
     * source-world id directly. All fields are optional because
     * older cartridges may not have populated them.
     */
    item: {
      displayName: string;
      kind: string;
      personaSlug: string | null;
      /** `profile.source_slug` when present; this is the most
       *  reliable cross-cartridge identity key. */
      sourceSlug: string | null;
      /** Sanitized identity-relevant profile keys (no location/
       *  entity refs). */
      profile: Record<string, unknown>;
      i18n: Record<string, unknown>;
    };
  }>;
  memories: {
    /** Companion-owned memories where the subject is the hero. */
    aboutHero: Array<{
      id: number;
      text: string;
      importance: number;
      tags: string[];
      sensitive: boolean;
      metadata: Record<string, unknown>;
      createdAt: string;
    }>;
    /** Companion-owned memories not about the hero. Surface count
     *  only so the capsule does not lift unrelated world prose. */
    otherCount: number;
  };
  /** Relationship-string value the companion holds toward the hero,
   *  clamped to [-10, 10] like the live `string_value` band. */
  stringTowardHero: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function jsonObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function jsonStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) if (typeof v === 'string') out.push(v);
  return out;
}

interface EventRow {
  id: number | string;
  player_id: number | string;
  source_universe_instance_id: string | null;
  target_universe_instance_id: string | null;
  source_cartridge_id: string | null;
  target_cartridge_id: string | null;
  event_type: string;
  payload: unknown;
  created_at: string;
}

function rowToEvent(row: EventRow): HeroContinuityEvent {
  return {
    id: Number(row.id),
    playerId: Number(row.player_id),
    sourceUniverseInstanceId: row.source_universe_instance_id,
    targetUniverseInstanceId: row.target_universe_instance_id,
    sourceCartridgeId: row.source_cartridge_id,
    targetCartridgeId: row.target_cartridge_id,
    eventType: row.event_type,
    payload: jsonObject(row.payload),
    createdAt: row.created_at,
  };
}

interface ArtifactRow {
  id: number | string;
  player_id: number | string;
  artifact_key: string;
  kind: string;
  portability: string;
  source_universe_instance_id: string | null;
  source_cartridge_id: string | null;
  power_rating: number | string;
  payload: unknown;
  created_at: string;
  updated_at: string;
}

function rowToArtifact(row: ArtifactRow): HeroPortableArtifact {
  return {
    id: Number(row.id),
    playerId: Number(row.player_id),
    artifactKey: row.artifact_key,
    kind: row.kind as PortableArtifactKind,
    portability: row.portability as PortabilityState,
    sourceUniverseInstanceId: row.source_universe_instance_id,
    sourceCartridgeId: row.source_cartridge_id,
    powerRating: Number(row.power_rating) || 0,
    payload: jsonObject(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface BondRow {
  id: number | string;
  player_id: number | string;
  companion_key: string;
  source_entity_id: number | string | null;
  source_universe_instance_id: string | null;
  source_cartridge_id: string | null;
  status: string;
  portability: string;
  public_summary: string | null;
  private_summary: string | null;
  bond_payload: unknown;
  created_at: string;
  updated_at: string;
}

function rowToBond(row: BondRow): HeroCompanionBond {
  return {
    id: Number(row.id),
    playerId: Number(row.player_id),
    companionKey: row.companion_key,
    sourceEntityId:
      row.source_entity_id == null ? null : Number(row.source_entity_id),
    sourceUniverseInstanceId: row.source_universe_instance_id,
    sourceCartridgeId: row.source_cartridge_id,
    status: row.status as CompanionBondStatus,
    portability: row.portability as PortabilityState,
    publicSummary: row.public_summary,
    privateSummary: row.private_summary,
    bondPayload: jsonObject(row.bond_payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Input shapes ──────────────────────────────────────────────────

export interface RecordContinuityEventInput {
  playerId: number;
  sourceUniverseInstanceId?: string | null;
  targetUniverseInstanceId?: string | null;
  sourceCartridgeId?: string | null;
  targetCartridgeId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface UpsertArtifactInput {
  playerId: number;
  artifactKey: string;
  kind: PortableArtifactKind;
  portability?: PortabilityState;
  sourceUniverseInstanceId?: string | null;
  sourceCartridgeId?: string | null;
  powerRating?: number;
  payload?: Record<string, unknown>;
}

export interface UpsertCompanionBondInput {
  playerId: number;
  companionKey: string;
  sourceEntityId?: number | null;
  sourceUniverseInstanceId?: string | null;
  sourceCartridgeId?: string | null;
  status?: CompanionBondStatus;
  portability?: PortabilityState;
  publicSummary?: string | null;
  privateSummary?: string | null;
  bondPayload?: Record<string, unknown>;
}

export class HeroContinuityLedgerServiceError extends Error {
  constructor(
    public code:
      | 'unknown_player'
      | 'unknown_cartridge'
      | 'unknown_bond'
      | 'unknown_companion_entity'
      | 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'HeroContinuityLedgerServiceError';
  }
}

function assertPositiveInt(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HeroContinuityLedgerServiceError(
      'invalid_input',
      `${name} must be a positive integer (got ${String(value)})`,
    );
  }
  return n;
}

// ── Service ───────────────────────────────────────────────────────

export class HeroContinuityLedgerService {
  /**
   * Append a continuity event row. FEAT-HERO-CONTINUITY-4 will call
   * this from launch/new-game; FEAT-HERO-CONTINUITY-3 surfaces it
   * via tests + by future explicit awards.
   */
  static async recordContinuityEvent(
    input: RecordContinuityEventInput,
  ): Promise<HeroContinuityEvent> {
    const playerId = assertPositiveInt(input.playerId, 'playerId');
    if (!input.eventType || input.eventType.length === 0) {
      throw new HeroContinuityLedgerServiceError(
        'invalid_input',
        'eventType is required',
      );
    }
    const r = await query<EventRow>(
      `INSERT INTO hero_continuity_events
         (player_id, source_universe_instance_id, target_universe_instance_id,
          source_cartridge_id, target_cartridge_id, event_type, payload)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb))
       RETURNING id, player_id, source_universe_instance_id,
                 target_universe_instance_id, source_cartridge_id,
                 target_cartridge_id, event_type, payload,
                 created_at::text AS created_at`,
      [
        playerId,
        input.sourceUniverseInstanceId ?? null,
        input.targetUniverseInstanceId ?? null,
        input.sourceCartridgeId ?? null,
        input.targetCartridgeId ?? null,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return rowToEvent(r.rows[0]!);
  }

  /** Return the hero's continuity event ledger, newest first. */
  static async listHeroUniverseTimeline(
    playerId: number,
    opts: {limit?: number} = {},
  ): Promise<HeroContinuityEvent[]> {
    const pid = assertPositiveInt(playerId, 'playerId');
    const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
    const r = await query<EventRow>(
      `SELECT id, player_id, source_universe_instance_id,
              target_universe_instance_id, source_cartridge_id,
              target_cartridge_id, event_type, payload,
              created_at::text AS created_at
         FROM hero_continuity_events
        WHERE player_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}`,
      [pid],
    );
    return r.rows.map(rowToEvent);
  }

  /** Idempotent upsert: `(player_id, artifact_key)` is the dedupe key. */
  static async upsertPortableArtifact(
    input: UpsertArtifactInput,
  ): Promise<HeroPortableArtifact> {
    const playerId = assertPositiveInt(input.playerId, 'playerId');
    if (!input.artifactKey)
      throw new HeroContinuityLedgerServiceError(
        'invalid_input',
        'artifactKey is required',
      );
    const r = await query<ArtifactRow>(
      `INSERT INTO hero_portable_artifacts
         (player_id, artifact_key, kind, portability,
          source_universe_instance_id, source_cartridge_id,
          power_rating, payload)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, COALESCE($8::jsonb, '{}'::jsonb))
       ON CONFLICT (player_id, artifact_key) DO UPDATE
         SET kind = EXCLUDED.kind,
             portability = EXCLUDED.portability,
             source_universe_instance_id = EXCLUDED.source_universe_instance_id,
             source_cartridge_id = EXCLUDED.source_cartridge_id,
             power_rating = EXCLUDED.power_rating,
             payload = EXCLUDED.payload,
             updated_at = now()
       RETURNING id, player_id, artifact_key, kind, portability,
                 source_universe_instance_id, source_cartridge_id,
                 power_rating, payload,
                 created_at::text AS created_at,
                 updated_at::text AS updated_at`,
      [
        playerId,
        input.artifactKey,
        input.kind,
        input.portability ?? 'portable',
        input.sourceUniverseInstanceId ?? null,
        input.sourceCartridgeId ?? null,
        Math.max(0, Math.trunc(input.powerRating ?? 0)),
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return rowToArtifact(r.rows[0]!);
  }

  /** List the hero's portable artifacts (newest update first). */
  static async listPortableArtifacts(
    playerId: number,
  ): Promise<HeroPortableArtifact[]> {
    const pid = assertPositiveInt(playerId, 'playerId');
    const r = await query<ArtifactRow>(
      `SELECT id, player_id, artifact_key, kind, portability,
              source_universe_instance_id, source_cartridge_id,
              power_rating, payload,
              created_at::text AS created_at,
              updated_at::text AS updated_at
         FROM hero_portable_artifacts
        WHERE player_id = $1
        ORDER BY updated_at DESC, id DESC`,
      [pid],
    );
    return r.rows.map(rowToArtifact);
  }

  /** Idempotent upsert: `(player_id, companion_key)` is the dedupe key. */
  static async upsertCompanionBond(
    input: UpsertCompanionBondInput,
  ): Promise<HeroCompanionBond> {
    const playerId = assertPositiveInt(input.playerId, 'playerId');
    if (!input.companionKey)
      throw new HeroContinuityLedgerServiceError(
        'invalid_input',
        'companionKey is required',
      );
    const r = await query<BondRow>(
      `INSERT INTO hero_companion_bonds
         (player_id, companion_key, source_entity_id,
          source_universe_instance_id, source_cartridge_id,
          status, portability,
          public_summary, private_summary, bond_payload)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9,
               COALESCE($10::jsonb, '{}'::jsonb))
       ON CONFLICT (player_id, companion_key) DO UPDATE
         SET source_entity_id = EXCLUDED.source_entity_id,
             source_universe_instance_id = EXCLUDED.source_universe_instance_id,
             source_cartridge_id = EXCLUDED.source_cartridge_id,
             status = EXCLUDED.status,
             portability = EXCLUDED.portability,
             public_summary = EXCLUDED.public_summary,
             private_summary = EXCLUDED.private_summary,
             bond_payload = EXCLUDED.bond_payload,
             updated_at = now()
       RETURNING id, player_id, companion_key, source_entity_id,
                 source_universe_instance_id, source_cartridge_id,
                 status, portability,
                 public_summary, private_summary, bond_payload,
                 created_at::text AS created_at,
                 updated_at::text AS updated_at`,
      [
        playerId,
        input.companionKey,
        input.sourceEntityId ?? null,
        input.sourceUniverseInstanceId ?? null,
        input.sourceCartridgeId ?? null,
        input.status ?? 'bonded',
        input.portability ?? 'local_locked',
        input.publicSummary ?? null,
        input.privateSummary ?? null,
        JSON.stringify(input.bondPayload ?? {}),
      ],
    );
    return rowToBond(r.rows[0]!);
  }

  /** List the hero's companion bonds (latest update first). */
  static async listCompanionBonds(
    playerId: number,
  ): Promise<HeroCompanionBond[]> {
    const pid = assertPositiveInt(playerId, 'playerId');
    const r = await query<BondRow>(
      `SELECT id, player_id, companion_key, source_entity_id,
              source_universe_instance_id, source_cartridge_id,
              status, portability,
              public_summary, private_summary, bond_payload,
              created_at::text AS created_at,
              updated_at::text AS updated_at
         FROM hero_companion_bonds
        WHERE player_id = $1
        ORDER BY updated_at DESC, id DESC`,
      [pid],
    );
    return r.rows.map(rowToBond);
  }

  /**
   * Read-only projection of `players.metadata.companions[]` into a
   * classified candidate list. **Does not mutate** the metadata roster
   * and does not write to `hero_companion_bonds`. Each entry is paired
   * with the existing bond row (if any) so the caller can render
   * status/portability without re-querying.
   */
  static async listCompanionCarryoverCandidates(
    playerId: number,
  ): Promise<
    Array<{
      sourceEntityId: number;
      displayName: string;
      bond: HeroCompanionBond | null;
    }>
  > {
    const pid = assertPositiveInt(playerId, 'playerId');
    const rosterRow = await query<{companions: unknown}>(
      `SELECT metadata->'companions' AS companions
         FROM players WHERE entity_id = $1`,
      [pid],
    );
    const raw = rosterRow.rows[0]?.companions;
    const ids: number[] = [];
    if (Array.isArray(raw)) {
      for (const v of raw) {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) ids.push(n);
      }
    }
    if (ids.length === 0) return [];
    const [entityRows, bondRows] = await Promise.all([
      query<{id: number | string; display_name: string}>(
        `SELECT id, display_name FROM entities WHERE id = ANY($1::bigint[])`,
        [ids],
      ),
      query<BondRow>(
        `SELECT id, player_id, companion_key, source_entity_id,
                source_universe_instance_id, source_cartridge_id,
                status, portability,
                public_summary, private_summary, bond_payload,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM hero_companion_bonds
          WHERE player_id = $1
            AND source_entity_id = ANY($2::bigint[])`,
        [pid, ids],
      ),
    ]);
    const nameById = new Map<number, string>();
    for (const row of entityRows.rows) nameById.set(Number(row.id), row.display_name);
    const bondBySourceId = new Map<number, HeroCompanionBond>();
    for (const row of bondRows.rows) {
      const bond = rowToBond(row);
      if (bond.sourceEntityId != null) {
        bondBySourceId.set(bond.sourceEntityId, bond);
      }
    }
    return ids.map(id => ({
      sourceEntityId: id,
      displayName: nameById.get(id) ?? '?',
      bond: bondBySourceId.get(id) ?? null,
    }));
  }

  /**
   * Build a `companion_capsule.v1` payload from canonical state owned
   * by the contracted companion entity. The capsule snapshots only
   * what the spec authorises: identity, npc_stats, actor_statuses,
   * runtime fields/values, companion-owned inventory, companion-owned
   * memories, and the relationship string the companion holds toward
   * the hero. Does **not** include source-world quest stages, source-
   * world map state, or memories owned by other NPCs.
   *
   * This method is intentionally read-only for the donor rows; it
   * inserts exactly one new `hero_companion_capsules` row at the next
   * available version number for the bond.
   */
  static async buildCompanionCapsule(
    companionBondId: number,
    opts: {
      sourceUniverseInstanceId?: string | null;
      sourceProjectionId?: number | null;
    } = {},
  ): Promise<CompanionCapsule> {
    const bondId = assertPositiveInt(companionBondId, 'companionBondId');
    const bondRows = await query<BondRow>(
      `SELECT id, player_id, companion_key, source_entity_id,
              source_universe_instance_id, source_cartridge_id,
              status, portability,
              public_summary, private_summary, bond_payload,
              created_at::text AS created_at,
              updated_at::text AS updated_at
         FROM hero_companion_bonds WHERE id = $1`,
      [bondId],
    );
    const bond = bondRows.rows[0];
    if (!bond) {
      throw new HeroContinuityLedgerServiceError(
        'unknown_bond',
        `companion bond ${bondId} not found`,
      );
    }
    if (bond.source_entity_id == null) {
      throw new HeroContinuityLedgerServiceError(
        'unknown_companion_entity',
        `bond ${bondId} has no source_entity_id; cannot build capsule`,
      );
    }
    const companionEntityId = Number(bond.source_entity_id);
    const heroId = Number(bond.player_id);

    // Identity comes from the companion's entity row.
    interface EntityRow {
      display_name: string;
      persona_slug: string | null;
      summary: string | null;
      profile: unknown;
      i18n: unknown;
    }
    const entityRows = await query<EntityRow>(
      `SELECT display_name, persona_slug, summary, profile, i18n
         FROM entities WHERE id = $1`,
      [companionEntityId],
    );
    const entity = entityRows.rows[0];
    if (!entity) {
      throw new HeroContinuityLedgerServiceError(
        'unknown_companion_entity',
        `companion entity ${companionEntityId} not found`,
      );
    }

    interface StatRow {
      stat_key: string;
      base: number | string;
      current: number | string;
    }
    interface StatusRow {
      player_id: number | string;
      status_kind: string;
      status_value: string;
      intensity: number | string;
      source: string;
      metadata: unknown;
    }
    interface RuntimeRow {
      field_key: string;
      value_type: string;
      value: unknown;
    }
    interface InvRow {
      item_entity_id: number | string;
      count: number | string;
      metadata: unknown;
      item_display_name: string | null;
      item_kind: string | null;
      item_persona_slug: string | null;
      item_profile: unknown;
      item_i18n: unknown;
    }
    interface MemRow {
      id: number | string;
      about_entity_id: number | string | null;
      text: string;
      importance: number | string;
      tags: unknown;
      sensitive: boolean;
      metadata: unknown;
      created_at: string;
    }

    const [statRows, statusRows, runtimeRows, invRows, memRows] =
      await Promise.all([
        query<StatRow>(
          `SELECT stat_key, base, current
             FROM npc_stats WHERE npc_entity_id = $1
             ORDER BY stat_key`,
          [companionEntityId],
        ),
        query<StatusRow>(
          `SELECT player_id, status_kind, status_value, intensity,
                  source, metadata
             FROM actor_statuses
            WHERE actor_entity_id = $1
            ORDER BY status_kind, status_value`,
          [companionEntityId],
        ),
        query<RuntimeRow>(
          `SELECT rf.field_key,
                  rf.value_type,
                  COALESCE(rv.value, rf.default_value) AS value
             FROM runtime_fields rf
             LEFT JOIN runtime_values rv ON rv.field_id = rf.id
            WHERE rf.owner_entity_id = $1
            ORDER BY rf.field_key`,
          [companionEntityId],
        ),
        query<InvRow>(
          `SELECT ie.item_entity_id, ie.count, ie.metadata,
                  e.display_name AS item_display_name,
                  e.kind         AS item_kind,
                  e.persona_slug AS item_persona_slug,
                  e.profile      AS item_profile,
                  e.i18n         AS item_i18n
             FROM inventory_entries ie
             LEFT JOIN entities e ON e.id = ie.item_entity_id
            WHERE ie.holder_entity_id = $1
            ORDER BY ie.item_entity_id`,
          [companionEntityId],
        ),
        query<MemRow>(
          `SELECT id, about_entity_id, text, importance, tags,
                  sensitive, metadata,
                  created_at::text AS created_at
             FROM npc_memories
            WHERE owner_entity_id = $1
            ORDER BY created_at DESC, id DESC`,
          [companionEntityId],
        ),
      ]);

    // Relationship string the companion holds *toward the hero*. The
    // canonical store is `runtime_fields(field_key='strings')` on the
    // companion's runtime fields; we read the JSON map and pick the
    // entry keyed on the hero's `entity_id`. Unrelated source-world
    // ids in the same map are NEVER lifted into the capsule —
    // `sanitizeCapsuleRuntimeField` below strips them before the
    // `runtimeFields` slice is serialized.
    let stringTowardHero = 0;
    let stringTowardHeroPresent = false;
    for (const row of runtimeRows.rows) {
      if (row.field_key !== 'strings') continue;
      const map = row.value;
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        const value = (map as Record<string, unknown>)[String(heroId)];
        const n = Number(value);
        if (Number.isFinite(n)) {
          stringTowardHero = Math.max(-10, Math.min(10, Math.trunc(n)));
          stringTowardHeroPresent = true;
        }
      }
    }

    const aboutHero = memRows.rows
      .filter(row => row.about_entity_id != null && Number(row.about_entity_id) === heroId)
      .map(row => ({
        id: Number(row.id),
        text: row.text,
        importance: Number(row.importance) || 0,
        tags: jsonStringArray(row.tags),
        sensitive: row.sensitive === true,
        metadata: jsonObject(row.metadata),
        createdAt: row.created_at,
      }));
    const otherCount = memRows.rows.length - aboutHero.length;

    const payload: CompanionCapsulePayload = {
      schemaVersion: 'greenhaven.companion_capsule.v1',
      companionEntityId,
      identity: {
        displayName: entity.display_name,
        personaSlug: entity.persona_slug,
        summary: entity.summary,
        profile: jsonObject(entity.profile),
        i18n: jsonObject(entity.i18n),
      },
      stats: statRows.rows.map(row => ({
        statKey: row.stat_key,
        base: Number(row.base) || 0,
        current: Number(row.current) || 0,
      })),
      statuses: statusRows.rows.map(row => ({
        playerId: Number(row.player_id),
        statusKind: row.status_kind,
        statusValue: row.status_value,
        intensity: Number(row.intensity) || 0,
        source: row.source,
        metadata: jsonObject(row.metadata),
      })),
      runtimeFields: runtimeRows.rows.map(row =>
        sanitizeCapsuleRuntimeField(row, heroId, {
          present: stringTowardHeroPresent,
          value: stringTowardHero,
        }),
      ),
      inventory: invRows.rows.map(row => ({
        itemEntityId: Number(row.item_entity_id),
        count: Number(row.count) || 0,
        metadata: jsonObject(row.metadata),
        item: {
          displayName: row.item_display_name ?? '',
          kind: row.item_kind ?? '',
          personaSlug: row.item_persona_slug ?? null,
          // FEAT-HERO-CONTINUITY-4-FOLLOWUP — `profile.source_slug`
          // is the stable cross-cartridge identity key the carryover
          // service uses to resolve items in the target world.
          sourceSlug:
            (() => {
              const p = jsonObject(row.item_profile);
              const v = p['source_slug'];
              return typeof v === 'string' && v.length > 0 ? v : null;
            })(),
          profile: jsonObject(row.item_profile),
          i18n: jsonObject(row.item_i18n),
        },
      })),
      memories: {aboutHero, otherCount: Math.max(0, otherCount)},
      stringTowardHero,
    };
    // Deterministic state_hash so future capsule diffs can detect
    // identical snapshots without reading the payload. Keys are
    // already sorted via the SELECTs above; JSON.stringify on the
    // composed payload then produces a stable string for sha256.
    const stateHash = await sha256Hex(JSON.stringify(payload));

    // Use the next available version. The unique constraint
    // (companion_bond_id, capsule_version) protects against
    // concurrent writers.
    const versionRows = await query<{next: number | string | null}>(
      `SELECT COALESCE(MAX(capsule_version), 0) + 1 AS next
         FROM hero_companion_capsules
        WHERE companion_bond_id = $1`,
      [bondId],
    );
    const nextVersion = Math.max(
      1,
      Number(versionRows.rows[0]?.next ?? 1),
    );

    interface CapsuleRow {
      id: number | string;
      companion_bond_id: number | string;
      capsule_version: number | string;
      source_universe_instance_id: string | null;
      source_projection_id: number | string | null;
      state_hash: string;
      payload: unknown;
      created_at: string;
    }
    const inserted = await query<CapsuleRow>(
      `INSERT INTO hero_companion_capsules
         (companion_bond_id, capsule_version,
          source_universe_instance_id, source_projection_id,
          state_hash, payload)
       VALUES ($1, $2, $3::uuid, $4, $5, $6::jsonb)
       RETURNING id, companion_bond_id, capsule_version,
                 source_universe_instance_id, source_projection_id,
                 state_hash, payload,
                 created_at::text AS created_at`,
      [
        bondId,
        nextVersion,
        opts.sourceUniverseInstanceId ??
          bond.source_universe_instance_id ??
          null,
        opts.sourceProjectionId ?? null,
        stateHash,
        JSON.stringify(payload),
      ],
    );
    const row = inserted.rows[0]!;
    return {
      id: Number(row.id),
      companionBondId: Number(row.companion_bond_id),
      capsuleVersion: Number(row.capsule_version),
      sourceUniverseInstanceId: row.source_universe_instance_id,
      sourceProjectionId:
        row.source_projection_id == null
          ? null
          : Number(row.source_projection_id),
      stateHash: row.state_hash,
      payload: row.payload as CompanionCapsulePayload,
      createdAt: row.created_at,
    };
  }

  /** Return the latest capsule for a bond, or null. */
  static async getLatestCapsule(
    companionBondId: number,
  ): Promise<CompanionCapsule | null> {
    const bondId = assertPositiveInt(companionBondId, 'companionBondId');
    interface CapsuleRow {
      id: number | string;
      companion_bond_id: number | string;
      capsule_version: number | string;
      source_universe_instance_id: string | null;
      source_projection_id: number | string | null;
      state_hash: string;
      payload: unknown;
      created_at: string;
    }
    const r = await query<CapsuleRow>(
      `SELECT id, companion_bond_id, capsule_version,
              source_universe_instance_id, source_projection_id,
              state_hash, payload,
              created_at::text AS created_at
         FROM hero_companion_capsules
        WHERE companion_bond_id = $1
        ORDER BY capsule_version DESC
        LIMIT 1`,
      [bondId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      companionBondId: Number(row.companion_bond_id),
      capsuleVersion: Number(row.capsule_version),
      sourceUniverseInstanceId: row.source_universe_instance_id,
      sourceProjectionId:
        row.source_projection_id == null
          ? null
          : Number(row.source_projection_id),
      stateHash: row.state_hash,
      payload: row.payload as CompanionCapsulePayload,
      createdAt: row.created_at,
    };
  }
}

async function sha256Hex(input: string): Promise<string> {
  const {createHash} = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

/**
 * FEAT-HERO-CONTINUITY-3 corrective (2026-05-17) — strip unrelated
 * source-world entries from the companion's `strings` runtime field
 * before it lands in `payload.runtimeFields`. The companion-owned
 * `runtime_fields(field_key='strings')` JSON map can carry
 * relationship values toward arbitrary source-world NPCs; only the
 * hero-keyed entry is allowed to travel inside the capsule. The
 * canonical hero relationship value still rides separately on
 * `payload.stringTowardHero` so future carryover can use a single
 * source of truth.
 *
 * Non-`strings` runtime fields pass through unchanged — they cover
 * companion-owned profile/runtime parameters (mood, statuses,
 * condition counters, voice flags, etc.) that the spec explicitly
 * allows inside the contracted-companion path.
 */
interface CapsuleRuntimeRow {
  field_key: string;
  value_type: string;
  value: unknown;
}
function sanitizeCapsuleRuntimeField(
  row: CapsuleRuntimeRow,
  heroId: number,
  heroString: {present: boolean; value: number},
): {fieldKey: string; valueType: string; value: unknown} {
  if (row.field_key !== 'strings') {
    return {
      fieldKey: row.field_key,
      valueType: row.value_type,
      value: row.value ?? null,
    };
  }
  // `strings` is a JSON map keyed by NPC entity id → relationship
  // value. Reduce it to at most a single entry — the hero's. When
  // the hero key is absent (companion never recorded a string with
  // the hero) emit an empty object so the field's existence is still
  // observable but no foreign ids leak.
  if (!heroString.present) return {
    fieldKey: row.field_key,
    valueType: row.value_type,
    value: {},
  };
  return {
    fieldKey: row.field_key,
    valueType: row.value_type,
    value: {[String(heroId)]: heroString.value},
  };
}
