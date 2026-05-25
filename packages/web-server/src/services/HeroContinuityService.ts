/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-1 (2026-05-17) — read-only state taxonomy and
// continuity preview.
//
// This service does NOT mutate rows. Its single job in this pass is
// to classify what a hero would carry into a target cartridge
// (`hero_core` global progression, equipped/awarded titles) and what
// would stay local to that cartridge's universe (inventory, quests,
// notices, NPC memories, relationship strings, current location,
// scene, companions in `players.metadata.companions[]`), then produce
// a player-facing `ContinuityPreview` packet that the existing
// `CartridgePlaythroughService.preview()` can hand back to the
// Worlds & Heroes GUI as an additive field.
//
// Continuity classification follows
// `docs/specs/hero-continuity-parallel-universes.md`:
//
//   hero_core         — carries by default (level, XP, base stats,
//                       skills, titles, progression tracks/wallets).
//   universe_local    — stays in source world (location, scene,
//                       quests, local NPC memories, relationship
//                       strings, local faction reputation, journal).
//   portable_artifact — carries only if whitelisted (none today; the
//                       artifact ledger lands in HERO-CONTINUITY-3).
//   portable_companion— carries only if contracted (none today; the
//                       companion bond ledger lands in HERO-CONTINUITY-3).
//   cartridge_static  — never carried (cartridge install pipeline).
//   derived_projection — recomputed from canonical rows.
//
// Cartridge-side opt-in lives at `cartridge_meta_scoped.key =
// 'hero_continuity_policy'`. When absent, this service falls back to
// the documented default policy: level/titles visible, inventory /
// quests / relationships / memories / companions local-only.
//
// NEVER copies raw NPC memory text, private relationship text, local
// quest state, or local inventory into the preview. The preview's
// `localState` field carries only counts plus a stable warning code,
// not row contents.

import {query} from '../db.js';
import {
  HeroContinuityLedgerService,
  type HeroCompanionBond,
  type HeroPortableArtifact,
} from './HeroContinuityLedgerService.js';

export type ContinuityClass =
  | 'hero_core'
  | 'universe_local'
  | 'portable_artifact'
  | 'portable_companion'
  | 'cartridge_static'
  | 'derived_projection';

export type ContinuityCompanionStatus =
  | 'native_local'
  | 'portable_companion'
  | 'world_bound'
  | 'requires_adapter'
  | 'suppressed';

export interface ContinuityHeroCore {
  /** Public-facing player id (`entities.id` of the `kind='player'`
   *  row). UI may show this as a debug id. */
  playerId: number;
  displayName: string;
  /** `players.current_level` clamped to a non-negative integer. */
  level: number;
  /** `players.current_xp` clamped to a non-negative integer. */
  xp: number;
  /** Sum of `player_stats.current` across all stat keys; gives the
   *  GUI a one-glance "power" number without leaking the per-stat
   *  shape. */
  statTotal: number;
  /** Distinct skill_name count from `player_proficient_skills`. */
  proficientSkillCount: number;
  /** Distinct skill_entity_id count from `player_skills`. */
  rankedSkillCount: number;
  /** Equipped-title display names, deduped, alphabetical. */
  equippedTitles: string[];
  /** Total awarded `player_titles` row count. */
  ownedTitleCount: number;
  /** Active progression tracks ({trackKey, level, max}). */
  progressionTracks: Array<{
    trackKey: string;
    displayName: string;
    level: number;
    maxLevel: number;
  }>;
  /** `player_progression_wallets` snapshot (stat / skill / title slot
   *  points). Zero-filled when the row is absent. */
  wallet: {
    statPoints: number;
    skillPoints: number;
    titleSlots: number;
  };
}

export interface ContinuityLocalSummary {
  /** Stable continuity class. Always `'universe_local'` for the rows
   *  this section enumerates. */
  classification: 'universe_local';
  /** Stable summary code, mapped to UI copy in
   *  `ui.surface.bonds.*` / future `ui.surface.continuity.*`. Never
   *  raw row payload. */
  code:
    | 'inventory'
    | 'quests'
    | 'notices'
    | 'npc_memories'
    | 'relationship_strings'
    | 'current_location'
    | 'current_scene'
    | 'companions_roster';
  /** Approximate count of rows that stay in the source world. */
  count: number;
  /** Whether this summary is at least suggestive of state that the
   *  hero would lose by entering a foreign cartridge. */
  nonEmpty: boolean;
}

export interface ContinuityCompanionEntry {
  /** Source-world NPC entity id. Foreign keys to the source
   *  cartridge's NPC entity; **not** a portable identity. */
  sourceEntityId: number;
  /** Display name as resolved from the source-cartridge `entities`
   *  row. Falls back to `'?'` if the row no longer exists. */
  displayName: string;
  /** Per-companion continuity verdict. FEAT-HERO-CONTINUITY-1 only
   *  emits `'native_local'` — companion bonds and portability
   *  contracts land in HERO-CONTINUITY-3. */
  status: ContinuityCompanionStatus;
  /** Reason code the GUI can localize. Always present so the player
   *  knows why the companion does or does not travel. */
  reason: string;
}

export interface ContinuityWarning {
  /** Stable code. Localized client-side. */
  code: string;
  /** Severity hint for the GUI. */
  severity: 'info' | 'warn';
}

export interface ContinuityPolicy {
  /** Stable schema version of the loaded policy. */
  schemaVersion: string;
  /** `true` when no scoped policy row exists and the documented
   *  default policy is in effect. */
  isDefault: boolean;
  /** Convenience flags for the GUI. */
  carry: {
    xpLevel: 'visible' | 'hidden';
    titles: 'visible' | 'hidden';
    inventory: 'local_only';
    quests: 'local_only';
    relationships: 'local_only';
    memories: 'summary_only' | 'local_only';
    companions: 'local_only' | 'portable_contracts';
  };
  /** Raw policy payload when the cartridge supplied one (so future
   *  passes can read fields this version of the service does not
   *  understand yet). Null when the default policy is in effect. */
  raw: Record<string, unknown> | null;
}

/**
 * FEAT-HERO-CONTINUITY-3 — portable artifact summary surfaced to the
 * preview. Keys mirror `hero_portable_artifacts` minus the timestamps,
 * which the preview does not need to render.
 */
export interface ContinuityPortableArtifactSummary {
  artifactKey: string;
  kind: HeroPortableArtifact['kind'];
  portability: HeroPortableArtifact['portability'];
  powerRating: number;
  sourceCartridgeId: string | null;
  sourceUniverseInstanceId: string | null;
}

/**
 * FEAT-HERO-CONTINUITY-3 — companion carryover candidate row. Combines
 * the current-world roster entry (read from
 * `players.metadata.companions[]`) with the persistent
 * `hero_companion_bonds` row when one exists. Roster-only entries are
 * still classified `native_local` to match FEAT-HERO-CONTINUITY-1's
 * contract.
 */
export interface ContinuityCompanionCandidate {
  sourceEntityId: number;
  displayName: string;
  /** Bond classification translated from `hero_companion_bonds`. */
  status: ContinuityCompanionStatus;
  /** Stable reason code the GUI can localize. */
  reason: string;
  /** True when a `hero_companion_bonds` row exists for this hero +
   *  source entity id. Roster-only entries report `false`. */
  hasBond: boolean;
  /** Companion key from the bond row, or `null` when roster-only. */
  companionKey: string | null;
}

export interface ContinuityPreview {
  /** Schema version of this preview shape. Mirrors the policy
   *  schema family so future GUI changes can gate on it. */
  schemaVersion: 'greenhaven.hero_continuity.preview.v1';
  /** The cartridge id this preview was built against. */
  targetCartridgeId: string;
  /** The hero this preview was built for. */
  hero: ContinuityHeroCore;
  /** Active continuity policy for the target cartridge. */
  policy: ContinuityPolicy;
  /** Things that carry with the hero by default. The taxonomy
   *  classes are explicit so a future GUI can group them. */
  carriesWithHero: Array<{
    classification: Extract<ContinuityClass, 'hero_core'>;
    code:
      | 'level_xp'
      | 'stats'
      | 'skills'
      | 'titles'
      | 'progression'
      | 'wallet';
    summary: string;
  }>;
  /** Things that stay in whichever world they live in. */
  staysInSourceWorld: ContinuityLocalSummary[];
  /** Companion roster classification — purely informational in this
   *  pass; every entry is `'native_local'` until
   *  `hero_companion_bonds` lands. */
  companions: ContinuityCompanionEntry[];
  /**
   * FEAT-HERO-CONTINUITY-3 — portable artifacts ledger snapshot.
   * Empty until callers (FEAT-HERO-CONTINUITY-4 launch carryover or
   * future explicit awards) start writing
   * `hero_portable_artifacts` rows.
   */
  portableArtifacts: ContinuityPortableArtifactSummary[];
  /**
   * FEAT-HERO-CONTINUITY-3 — additive carryover candidate list that
   * merges the live `players.metadata.companions[]` roster with
   * persistent `hero_companion_bonds` rows. Read-only: this list is
   * a derived projection and never writes back to either source.
   */
  companionCandidates: ContinuityCompanionCandidate[];
  /** Stable warning codes the GUI can render. */
  warnings: ContinuityWarning[];
  /** Read-path audit so future agents (and tests) can verify this
   *  service is read-only and consults the expected sources. */
  audit: {
    readsFrom: string[];
    mutatesRows: false;
  };
}

const DEFAULT_POLICY: ContinuityPolicy = {
  schemaVersion: 'greenhaven.hero_continuity_policy.v1',
  isDefault: true,
  carry: {
    xpLevel: 'visible',
    titles: 'visible',
    inventory: 'local_only',
    quests: 'local_only',
    relationships: 'local_only',
    memories: 'summary_only',
    companions: 'local_only',
  },
  raw: null,
};

async function loadContinuityPolicy(
  cartridgeId: string,
): Promise<ContinuityPolicy> {
  const rows = await query<{value: unknown}>(
    `SELECT value
       FROM cartridge_meta_scoped
      WHERE cartridge_id = $1
        AND key = 'hero_continuity_policy'
      LIMIT 1`,
    [cartridgeId],
  );
  const raw = rows.rows[0]?.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  const schemaVersion =
    typeof obj['schema_version'] === 'string'
      ? (obj['schema_version'] as string)
      : DEFAULT_POLICY.schemaVersion;
  const carryObj =
    obj['carry'] && typeof obj['carry'] === 'object' && !Array.isArray(obj['carry'])
      ? (obj['carry'] as Record<string, unknown>)
      : {};
  const carry: ContinuityPolicy['carry'] = {
    xpLevel: carryObj['xp_level'] === 'hidden' ? 'hidden' : 'visible',
    titles: carryObj['titles'] === 'hidden' ? 'hidden' : 'visible',
    inventory: 'local_only',
    quests: 'local_only',
    relationships: 'local_only',
    memories:
      carryObj['memories'] === 'local_only' ? 'local_only' : 'summary_only',
    companions:
      carryObj['companions'] === 'portable_contracts' ||
      (typeof carryObj['companions'] === 'object' &&
        (carryObj['companions'] as Record<string, unknown>)['portable_contracts'] === 'allow')
        ? 'portable_contracts'
        : 'local_only',
  };
  return {
    schemaVersion,
    isDefault: false,
    carry,
    raw: obj,
  };
}

interface PlayerRow {
  entity_id: number;
  display_name: string;
  current_xp: string | number;
  current_level: number | string;
}

async function loadPlayerRow(playerId: number): Promise<PlayerRow | null> {
  const r = await query<PlayerRow>(
    `SELECT p.entity_id,
            e.display_name,
            p.current_xp,
            p.current_level
       FROM players p
       JOIN entities e ON e.id = p.entity_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  return r.rows[0] ?? null;
}

async function loadStatTotal(playerId: number): Promise<number> {
  const r = await query<{total: string | number | null}>(
    `SELECT COALESCE(SUM(current), 0) AS total
       FROM player_stats
      WHERE player_id = $1`,
    [playerId],
  );
  const v = Number(r.rows[0]?.total ?? 0);
  return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

async function loadProficientSkillCount(playerId: number): Promise<number> {
  const r = await query<{n: string | number | null}>(
    `SELECT COUNT(DISTINCT skill_name) AS n
       FROM player_proficient_skills
      WHERE player_id = $1`,
    [playerId],
  );
  const v = Number(r.rows[0]?.n ?? 0);
  return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

async function loadRankedSkillCount(playerId: number): Promise<number> {
  const r = await query<{n: string | number | null}>(
    `SELECT COUNT(DISTINCT skill_entity_id) AS n
       FROM player_skills
      WHERE player_id = $1`,
    [playerId],
  );
  const v = Number(r.rows[0]?.n ?? 0);
  return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

async function loadTitleSummary(playerId: number): Promise<{
  equipped: string[];
  owned: number;
}> {
  const r = await query<{
    display_name: string;
    is_equipped: boolean;
  }>(
    `SELECT display_name, is_equipped
       FROM player_titles
      WHERE player_id = $1
      ORDER BY display_name ASC`,
    [playerId],
  );
  const equipped: string[] = [];
  for (const row of r.rows) {
    if (row.is_equipped) equipped.push(row.display_name);
  }
  // Stable dedupe so the preview never repeats the same equipped
  // title twice if the underlying row has two equipped duplicates.
  const dedup = [...new Set(equipped)].sort();
  return {equipped: dedup, owned: r.rows.length};
}

async function loadProgressionSummary(playerId: number): Promise<
  ContinuityHeroCore['progressionTracks']
> {
  const r = await query<{
    track_key: string;
    display_name: string;
    level: number | string;
    max_level: number | string;
  }>(
    `SELECT pt.track_key,
            t.display_name,
            pt.level,
            t.max_level
       FROM player_progression_tracks pt
       JOIN progression_tracks t ON t.track_key = pt.track_key
      WHERE pt.player_id = $1
      ORDER BY t.sort_order ASC, pt.track_key ASC`,
    [playerId],
  );
  return r.rows.map(row => ({
    trackKey: row.track_key,
    displayName: row.display_name,
    level: Number(row.level) || 0,
    maxLevel: Number(row.max_level) || 0,
  }));
}

async function loadWalletSummary(playerId: number): Promise<
  ContinuityHeroCore['wallet']
> {
  const r = await query<{
    stat_points: number | string | null;
    skill_points: number | string | null;
    title_slots: number | string | null;
  }>(
    `SELECT stat_points, skill_points, title_slots
       FROM player_progression_wallets
      WHERE player_id = $1`,
    [playerId],
  );
  const row = r.rows[0];
  if (!row) return {statPoints: 0, skillPoints: 0, titleSlots: 0};
  return {
    statPoints: Math.max(0, Math.trunc(Number(row.stat_points) || 0)),
    skillPoints: Math.max(0, Math.trunc(Number(row.skill_points) || 0)),
    titleSlots: Math.max(0, Math.trunc(Number(row.title_slots) || 0)),
  };
}

async function countTable(
  table: string,
  whereSql: string,
  params: unknown[],
): Promise<number> {
  const r = await query<{n: string | number | null}>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${whereSql}`,
    params,
  );
  const v = Number(r.rows[0]?.n ?? 0);
  return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

/**
 * FEAT-HERO-CONTINUITY-2 (2026-05-17) — count of the hero's current
 * location / scene anchors. Returns a `1` count when the player row
 * has a non-null id (the hero is somewhere) and `0` when they have
 * never been placed, so the GUI can render
 * "Stays here: current location" deterministically without leaking
 * the location's display name or id.
 */
async function loadCurrentLocationSceneCounts(
  playerId: number,
): Promise<{location: number; scene: number}> {
  const r = await query<{
    current_location_id: number | null;
    current_scene_id: number | null;
  }>(
    `SELECT current_location_id, current_scene_id
       FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const row = r.rows[0];
  if (!row) return {location: 0, scene: 0};
  return {
    location: row.current_location_id != null ? 1 : 0,
    scene: row.current_scene_id != null ? 1 : 0,
  };
}

interface CompanionRow {
  id: number;
  display_name: string;
}

async function loadCompanionRoster(
  playerId: number,
): Promise<CompanionRow[]> {
  // `players.metadata.companions[]` holds NPC entity ids; FEAT-CART-LIB-8
  // confirmed this roster is current-world-only state until
  // `hero_companion_bonds` lands. We resolve display names defensively
  // so a stale id surfaces as `?` rather than aborting the preview.
  const rows = await query<{companions: unknown}>(
    `SELECT metadata->'companions' AS companions
       FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const raw = rows.rows[0]?.companions;
  if (!Array.isArray(raw)) return [];
  const ids: number[] = [];
  for (const value of raw) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) ids.push(n);
  }
  if (ids.length === 0) return [];
  const r = await query<{id: number; display_name: string}>(
    `SELECT id, display_name
       FROM entities
      WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  const byId = new Map<number, string>();
  for (const row of r.rows) byId.set(Number(row.id), row.display_name);
  return ids.map(id => ({
    id,
    display_name: byId.get(id) ?? '?',
  }));
}

function companionStatusFromBond(
  bond: HeroCompanionBond,
): ContinuityCompanionStatus {
  if (bond.portability === 'suppressed' || bond.status === 'suppressed') {
    return 'suppressed';
  }
  if (bond.portability === 'requires_adapter') return 'requires_adapter';
  if (bond.status === 'world_bound') return 'world_bound';
  if (bond.portability === 'portable') return 'portable_companion';
  return 'native_local';
}

function companionReasonFromBond(bond: HeroCompanionBond): string {
  if (bond.status === 'suppressed' || bond.portability === 'suppressed') {
    return 'bond_suppressed';
  }
  if (bond.portability === 'requires_adapter') return 'requires_adapter';
  if (bond.status === 'world_bound') return 'world_bound';
  if (bond.portability === 'portable') return 'portable_contract';
  return 'no_bond_contract';
}

/**
 * Bonds for this hero whose `source_entity_id` is NOT in the active
 * roster. These are usually travelers from another world or
 * world-bound companions left in their source world. Returned in
 * stable bond.updated_at order so the preview is deterministic.
 */
async function loadDanglingBondedCandidates(
  playerId: number,
  alreadyByRosterId: Map<number, ContinuityCompanionCandidate>,
): Promise<ContinuityCompanionCandidate[]> {
  const bonds = await HeroContinuityLedgerService.listCompanionBonds(playerId);
  const out: ContinuityCompanionCandidate[] = [];
  if (bonds.length === 0) return out;
  const danglingEntityIds: number[] = [];
  for (const bond of bonds) {
    if (bond.sourceEntityId == null) continue;
    if (alreadyByRosterId.has(bond.sourceEntityId)) continue;
    danglingEntityIds.push(bond.sourceEntityId);
  }
  const nameById = new Map<number, string>();
  if (danglingEntityIds.length > 0) {
    const r = await query<{id: number | string; display_name: string}>(
      `SELECT id, display_name FROM entities WHERE id = ANY($1::bigint[])`,
      [danglingEntityIds],
    );
    for (const row of r.rows) nameById.set(Number(row.id), row.display_name);
  }
  for (const bond of bonds) {
    if (bond.sourceEntityId == null) continue;
    if (alreadyByRosterId.has(bond.sourceEntityId)) continue;
    out.push({
      sourceEntityId: bond.sourceEntityId,
      displayName: nameById.get(bond.sourceEntityId) ?? '?',
      status: companionStatusFromBond(bond),
      reason: companionReasonFromBond(bond),
      hasBond: true,
      companionKey: bond.companionKey,
    });
  }
  return out;
}

export class HeroContinuityServiceError extends Error {
  constructor(
    public code: 'unknown_player' | 'unknown_cartridge',
    message: string,
  ) {
    super(message);
    this.name = 'HeroContinuityServiceError';
  }
}

export class HeroContinuityService {
  /**
   * Read-only continuity preview for a hero entering a target
   * cartridge. Never mutates rows. Safe to call from
   * `CartridgePlaythroughService.preview()` and from any read-only
   * route.
   */
  static async previewTransfer(
    playerId: number,
    targetCartridgeId: string,
  ): Promise<ContinuityPreview> {
    if (!Number.isInteger(playerId) || playerId <= 0) {
      throw new HeroContinuityServiceError(
        'unknown_player',
        `playerId must be a positive integer (got ${playerId})`,
      );
    }
    if (!targetCartridgeId || targetCartridgeId.length > 256) {
      throw new HeroContinuityServiceError(
        'unknown_cartridge',
        `targetCartridgeId is required`,
      );
    }

    const playerRow = await loadPlayerRow(playerId);
    if (!playerRow) {
      throw new HeroContinuityServiceError(
        'unknown_player',
        `player ${playerId} not found`,
      );
    }
    const cartRows = await query<{id: string}>(
      `SELECT id FROM cartridges WHERE id = $1 LIMIT 1`,
      [targetCartridgeId],
    );
    if (cartRows.rows.length === 0) {
      throw new HeroContinuityServiceError(
        'unknown_cartridge',
        `cartridge ${targetCartridgeId} not found`,
      );
    }

    const [
      policy,
      statTotal,
      proficientSkillCount,
      rankedSkillCount,
      titleSummary,
      progressionTracks,
      wallet,
      inventoryCount,
      questCount,
      noticeCount,
      memoryCount,
      stringsCount,
      companions,
    ] = await Promise.all([
      loadContinuityPolicy(targetCartridgeId),
      loadStatTotal(playerId),
      loadProficientSkillCount(playerId),
      loadRankedSkillCount(playerId),
      loadTitleSummary(playerId),
      loadProgressionSummary(playerId),
      loadWalletSummary(playerId),
      countTable('player_inventory', 'player_id = $1', [playerId]),
      countTable('player_quests', 'player_id = $1', [playerId]),
      countTable('player_journal_entries', 'player_id = $1', [playerId]),
      // Memories owned by the player surface entity (the player's NPC-like
      // memories of the world). Companion-owned memories belong to
      // their own NPC entity id and are not counted here.
      countTable('npc_memories', 'owner_entity_id = $1', [playerId]),
      // Strings keyed *by* the player are stored as `runtime_fields(
      // field_key='strings')` on each NPC, not as a player-keyed table,
      // so an exact local count is non-trivial without joining every
      // NPC. For FEAT-HERO-CONTINUITY-1 we report the count of
      // distinct NPCs with a recorded relationship toward this player
      // through the same gui_events feed `PlayerStringsService`
      // already consumes for `lastEventId` summaries.
      countTable(
        'gui_events',
        `player_id = $1 AND event_type = 'string:changed'`,
        [playerId],
      ),
      loadCompanionRoster(playerId),
    ]);
    // FEAT-HERO-CONTINUITY-2 (2026-05-17) — current location/scene
    // anchor counts. Kept outside the Promise.all above so the
    // returned tuple stays in step with the existing reads.
    const currentAnchors = await loadCurrentLocationSceneCounts(playerId);

    // FEAT-HERO-CONTINUITY-3 (2026-05-17) — portable artifact + companion
    // bond carryover reads. The ledger may be empty (and is on every
    // FEAT-HERO-CONTINUITY-1/-2 install) which is fine; the preview
    // simply surfaces empty arrays in that case.
    const [portableArtifacts, companionCandidates] = await Promise.all([
      HeroContinuityLedgerService.listPortableArtifacts(playerId),
      HeroContinuityLedgerService.listCompanionCarryoverCandidates(playerId),
    ]);
    const bondBySourceId = new Map<number, HeroCompanionBond>();
    for (const candidate of companionCandidates) {
      if (candidate.bond && candidate.bond.sourceEntityId != null) {
        bondBySourceId.set(candidate.bond.sourceEntityId, candidate.bond);
      }
    }

    const heroCore: ContinuityHeroCore = {
      playerId: Number(playerRow.entity_id),
      displayName: playerRow.display_name,
      level: Math.max(0, Math.trunc(Number(playerRow.current_level) || 0)),
      xp: Math.max(0, Math.trunc(Number(playerRow.current_xp) || 0)),
      statTotal,
      proficientSkillCount,
      rankedSkillCount,
      equippedTitles: titleSummary.equipped,
      ownedTitleCount: titleSummary.owned,
      progressionTracks,
      wallet,
    };

    const carriesWithHero: ContinuityPreview['carriesWithHero'] = [
      {
        classification: 'hero_core',
        code: 'level_xp',
        summary: `Lvl ${heroCore.level} · ${heroCore.xp} XP`,
      },
      {
        classification: 'hero_core',
        code: 'stats',
        summary: `Stat total ${heroCore.statTotal}`,
      },
      {
        classification: 'hero_core',
        code: 'skills',
        summary: `${heroCore.proficientSkillCount} proficient + ${heroCore.rankedSkillCount} ranked`,
      },
      {
        classification: 'hero_core',
        code: 'titles',
        summary:
          heroCore.equippedTitles.length > 0
            ? `${heroCore.equippedTitles.length} equipped · ${heroCore.ownedTitleCount} owned`
            : `${heroCore.ownedTitleCount} owned`,
      },
      {
        classification: 'hero_core',
        code: 'progression',
        summary: `${heroCore.progressionTracks.length} track(s) active`,
      },
      {
        classification: 'hero_core',
        code: 'wallet',
        summary: `${heroCore.wallet.statPoints}/${heroCore.wallet.skillPoints}/${heroCore.wallet.titleSlots} pts`,
      },
    ];

    const staysInSourceWorld: ContinuityLocalSummary[] = [
      {
        classification: 'universe_local',
        code: 'current_location',
        count: currentAnchors.location,
        nonEmpty: currentAnchors.location > 0,
      },
      {
        classification: 'universe_local',
        code: 'current_scene',
        count: currentAnchors.scene,
        nonEmpty: currentAnchors.scene > 0,
      },
      {
        classification: 'universe_local',
        code: 'inventory',
        count: inventoryCount,
        nonEmpty: inventoryCount > 0,
      },
      {
        classification: 'universe_local',
        code: 'quests',
        count: questCount,
        nonEmpty: questCount > 0,
      },
      {
        classification: 'universe_local',
        code: 'notices',
        count: noticeCount,
        nonEmpty: noticeCount > 0,
      },
      {
        classification: 'universe_local',
        code: 'npc_memories',
        count: memoryCount,
        nonEmpty: memoryCount > 0,
      },
      {
        classification: 'universe_local',
        code: 'relationship_strings',
        count: stringsCount,
        nonEmpty: stringsCount > 0,
      },
      {
        classification: 'universe_local',
        code: 'companions_roster',
        count: companions.length,
        nonEmpty: companions.length > 0,
      },
    ];

    // FEAT-HERO-CONTINUITY-3 — companion classification now consults
    // `hero_companion_bonds`. Roster entries without a bond row stay
    // `native_local` (matches the FEAT-HERO-CONTINUITY-1 contract);
    // bonded entries surface the bond's `status`/`portability` so the
    // GUI can render "travels with hero" / "world-bound" / etc.
    const companionEntries: ContinuityCompanionEntry[] = companions.map(
      row => {
        const bond = bondBySourceId.get(row.id);
        if (!bond) {
          return {
            sourceEntityId: row.id,
            displayName: row.display_name,
            status: 'native_local',
            reason: 'no_bond_contract',
          };
        }
        return {
          sourceEntityId: row.id,
          displayName: row.display_name,
          status: companionStatusFromBond(bond),
          reason: companionReasonFromBond(bond),
        };
      },
    );

    // Build the additive carryover candidate list. Roster entries are
    // the primary surface (so the GUI keeps showing the player's
    // current companions even if no bond exists yet); bonds without a
    // roster entry are appended so a `traveling` bond from another
    // world still shows up in the target world's preview.
    const candidatesBySourceId = new Map<number, ContinuityCompanionCandidate>();
    for (const row of companions) {
      const bond = bondBySourceId.get(row.id);
      candidatesBySourceId.set(row.id, {
        sourceEntityId: row.id,
        displayName: row.display_name,
        status: bond ? companionStatusFromBond(bond) : 'native_local',
        reason: bond ? companionReasonFromBond(bond) : 'no_bond_contract',
        hasBond: bond != null,
        companionKey: bond?.companionKey ?? null,
      });
    }
    // Bonded companions not in the active roster — usually travelers
    // visiting from another world or world-bound companions left
    // behind on the source side.
    const bondedCandidates = await loadDanglingBondedCandidates(
      playerId,
      candidatesBySourceId,
    );
    for (const entry of bondedCandidates) {
      candidatesBySourceId.set(entry.sourceEntityId, entry);
    }
    const companionCandidatesOut: ContinuityCompanionCandidate[] = [
      ...candidatesBySourceId.values(),
    ];

    const portableArtifactsOut: ContinuityPortableArtifactSummary[] =
      portableArtifacts.map(artifact => ({
        artifactKey: artifact.artifactKey,
        kind: artifact.kind,
        portability: artifact.portability,
        powerRating: artifact.powerRating,
        sourceCartridgeId: artifact.sourceCartridgeId,
        sourceUniverseInstanceId: artifact.sourceUniverseInstanceId,
      }));

    const warnings: ContinuityWarning[] = [];
    if (currentAnchors.location > 0)
      warnings.push({code: 'current_location_local_only', severity: 'info'});
    if (inventoryCount > 0)
      warnings.push({code: 'inventory_local_only', severity: 'info'});
    if (questCount > 0)
      warnings.push({code: 'quests_local_only', severity: 'info'});
    if (stringsCount > 0)
      warnings.push({code: 'relationships_local_only', severity: 'info'});
    if (memoryCount > 0)
      warnings.push({code: 'memories_summary_only', severity: 'info'});
    if (companions.length > 0)
      warnings.push({code: 'companions_local_only', severity: 'info'});

    return {
      schemaVersion: 'greenhaven.hero_continuity.preview.v1',
      targetCartridgeId,
      hero: heroCore,
      policy,
      carriesWithHero,
      staysInSourceWorld,
      companions: companionEntries,
      portableArtifacts: portableArtifactsOut,
      companionCandidates: companionCandidatesOut,
      warnings,
      audit: {
        readsFrom: [
          'players',
          'entities',
          'player_stats',
          'player_proficient_skills',
          'player_skills',
          'player_titles',
          'player_progression_tracks',
          'player_progression_wallets',
          'player_inventory',
          'player_quests',
          'player_journal_entries',
          'npc_memories',
          'gui_events',
          'cartridge_meta_scoped',
          // FEAT-HERO-CONTINUITY-3 read sources. The ledger is empty
          // until launch carryover (HERO-CONTINUITY-4) writes to it.
          'hero_portable_artifacts',
          'hero_companion_bonds',
        ],
        mutatesRows: false,
      },
    };
  }
}
