/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — typed Character State snapshot service.
//
// The Character State surface (P hotkey) replaces the prior
// FEAT-SHELL placeholder that parsed hero status / state strings
// rendered into the rail. This service owns the typed read model
// the surface will consume. All data flows from structured
// tables only — no prose parsing, no chat-text scraping, no
// rail-string decoding:
//
//   * identity / vitals — `players` joined with `entities` for
//     the player's own display name, plus a class lookup on
//     `entities` keyed by `players.class_id`;
//   * XP math — `xp_required_for_level` from migration 0002 so
//     `thisLevelFloor`, `nextLevelXp`, and `progress` agree with
//     the rest of the codebase;
//   * stats / skills — `player_stats`, `player_proficient_skills`,
//     and `player_skills` joined with the skill entity for the
//     ranked-skill name;
//   * equipment summary — delegated to `InventoryReadService` so
//     this surface and the Inventory surface render the same
//     `equipped_slot` / `rarity` / `iconKey` info;
//   * titles — `player_titles` (FEAT-STATE-1 migration 0121);
//   * progression — `player_progression_tracks` joined with the
//     `progression_tracks` catalog plus the per-player
//     `player_progression_wallets` row;
//   * recent XP log — newest 20 rows of `player_xp_log`;
//   * conditions / trauma — `runtime_values` joined with
//     `runtime_fields` where `field_key IN ('conditions',
//     'trauma')`, matching the canonical reader already used by
//     `objectiveEvaluators.ts` and the combat tool.
//
// Returns `null` for unknown players (route surfaces 404).

import {query} from '../db.js';
import {HeroContinuityLedgerService} from './HeroContinuityLedgerService.js';
import {InventoryReadService} from './InventoryReadService.js';

export interface CharacterStateIdentity {
  publicId: string;
  displayName: string;
  profileCreated: boolean;
  classId: number | null;
  className: string | null;
  preferredLanguage: string | null;
}

export interface CharacterStateVitals {
  hp: {current: number; max: number};
  xp: {
    total: number;
    level: number;
    thisLevelFloor: number;
    nextLevelXp: number | null;
    progress: number;
  };
}

export interface CharacterStateStat {
  key: string;
  base: number;
  current: number;
}

export interface CharacterStateProficientSkill {
  skillName: string;
  proficiencyLevel: number;
}

export interface CharacterStateRankedSkill {
  skillEntityId: number;
  name: string;
  rank: number;
  unlockedAt: string;
  metadata: Record<string, unknown>;
}

export interface CharacterStateEquipmentItem {
  id: string;
  name: string;
  slug: string | null;
  slot: string | null;
  rarity: string | null;
  iconKey: string | null;
}

export interface CharacterStateEquipment {
  equippedCount: number;
  items: CharacterStateEquipmentItem[];
}

export interface CharacterStateTitle {
  id: number;
  titleKey: string;
  displayName: string;
  description: string | null;
  source: string | null;
  awardedAt: string;
  isEquipped: boolean;
  metadata: Record<string, unknown>;
}

export interface CharacterStateProgressionTrack {
  trackKey: string;
  displayName: string;
  description: string | null;
  xp: number;
  level: number;
  maxLevel: number;
  sortOrder: number;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface CharacterStateWallet {
  statPoints: number;
  skillPoints: number;
  titleSlots: number;
  updatedAt: string;
}

export interface CharacterStateProgression {
  tracks: CharacterStateProgressionTrack[];
  wallet: CharacterStateWallet;
}

export interface CharacterStateXpLogEntry {
  id: number;
  amount: number;
  reason: string;
  awardedByTool: string | null;
  awardedAt: string;
  metadata: Record<string, unknown>;
}

export interface CharacterStateRuntimeField {
  key: string;
  value: unknown;
}

/**
 * FEAT-HERO-CONTINUITY-3 — additive continuity section. Lists the
 * hero's portable artifacts and traveling/world-bound companion
 * bonds separately from the active local-world progression rows
 * above. UI must render these as "story / history" (hero core), not
 * as active in-world equipment, conditions, or trauma.
 */
export interface CharacterStateContinuityArtifact {
  artifactKey: string;
  kind:
    | 'title'
    | 'scar'
    | 'achievement'
    | 'memory_summary'
    | 'relic'
    | 'skill_mark';
  portability:
    | 'portable'
    | 'local_locked'
    | 'suppressed'
    | 'requires_adapter';
  powerRating: number;
  sourceCartridgeId: string | null;
}

export interface CharacterStateContinuityCompanion {
  companionKey: string;
  sourceEntityId: number | null;
  status:
    | 'bonded'
    | 'traveling'
    | 'world_bound'
    | 'departed'
    | 'suppressed';
  portability:
    | 'portable'
    | 'local_locked'
    | 'requires_adapter'
    | 'suppressed';
  publicSummary: string | null;
}

export interface CharacterStateContinuity {
  /** Stable schema version so the GUI can gate. */
  schemaVersion: 'greenhaven.character_state_continuity.v1';
  portableArtifacts: CharacterStateContinuityArtifact[];
  /** Bonds whose `portability === 'portable'` and `status !== 'suppressed'`. */
  travelingCompanions: CharacterStateContinuityCompanion[];
  /** Bonds whose `status === 'world_bound'` or whose portability
   *  prevents travel. Surfaced separately so the UI can render
   *  "stays in their world" copy. */
  worldBoundCompanions: CharacterStateContinuityCompanion[];
}

export interface CharacterStateSnapshot {
  playerId: number;
  identity: CharacterStateIdentity;
  vitals: CharacterStateVitals;
  stats: CharacterStateStat[];
  proficientSkills: CharacterStateProficientSkill[];
  rankedSkills: CharacterStateRankedSkill[];
  equipment: CharacterStateEquipment;
  titles: CharacterStateTitle[];
  progression: CharacterStateProgression;
  recentXpLog: CharacterStateXpLogEntry[];
  conditions: CharacterStateRuntimeField[];
  trauma: CharacterStateRuntimeField[];
  /** FEAT-HERO-CONTINUITY-3 — additive cross-world identity section. */
  continuity: CharacterStateContinuity;
}

interface PlayerRow {
  entity_id: number;
  public_id: string;
  display_name: string | null;
  class_id: number | null;
  class_name: string | null;
  current_xp: number | string;
  current_level: number;
  current_hp: number;
  max_hp: number;
  preferred_language: string | null;
  profile: Record<string, unknown> | null;
}

interface StatRow {
  stat_key: string;
  base: number;
  current: number;
}

interface ProficientSkillRow {
  skill_name: string;
  proficiency_level: number;
}

interface RankedSkillRow {
  skill_entity_id: number;
  display_name: string;
  rank: number;
  unlocked_at: string;
  metadata: Record<string, unknown> | null;
}

interface TitleRow {
  id: number;
  title_key: string;
  display_name: string;
  description: string | null;
  source: string | null;
  awarded_at: string;
  is_equipped: boolean;
  metadata: Record<string, unknown> | null;
}

interface ProgressionRow {
  track_key: string;
  display_name: string;
  description: string | null;
  xp: number | string;
  level: number;
  max_level: number;
  sort_order: number;
  metadata: Record<string, unknown> | null;
  updated_at: string;
}

interface WalletRow {
  stat_points: number;
  skill_points: number;
  title_slots: number;
  updated_at: string;
}

interface XpLogRow {
  id: number;
  amount: number;
  reason: string;
  awarded_by_tool: string | null;
  awarded_at: string;
  metadata: Record<string, unknown> | null;
}

interface RuntimeFieldRow {
  field_key: string;
  value: unknown;
}

const DEFAULT_WALLET: CharacterStateWallet = {
  statPoints: 0,
  skillPoints: 0,
  titleSlots: 1,
  updatedAt: new Date(0).toISOString(),
};

const RECENT_XP_LIMIT = 20;

export class CharacterStateService {
  /**
   * Build the typed Character State snapshot for the requested
   * player. The optional `language` argument is reserved for a
   * later i18n pass that will localize titles / track names /
   * stat labels through a translation table; today's snapshot
   * returns raw `display_name` values so the contract is pinned
   * even though the implementation does not consume the
   * parameter yet.
   */
  static async snapshot(
    playerId: number,
    _language?: string | null,
  ): Promise<CharacterStateSnapshot | null> {
    const playerRows = await query<PlayerRow>(
      `SELECT p.entity_id,
              p.public_id::text AS public_id,
              e.display_name AS display_name,
              p.class_id,
              cls.display_name AS class_name,
              p.current_xp,
              p.current_level,
              p.current_hp,
              p.max_hp,
              p.preferred_language,
              e.profile AS profile
         FROM players p
         JOIN entities e ON e.id = p.entity_id
         LEFT JOIN entities cls
           ON cls.id = p.class_id AND cls.kind = 'class'
        WHERE p.entity_id = $1`,
      [playerId],
    );
    const playerRow = playerRows.rows[0];
    if (!playerRow) return null;

    const [
      stats,
      proficientSkills,
      rankedSkills,
      titles,
      progression,
      wallet,
      xpLog,
      runtimeFields,
      inventory,
      xpLevelFloors,
      portableArtifacts,
      companionBonds,
    ] = await Promise.all([
      readStats(playerId),
      readProficientSkills(playerId),
      readRankedSkills(playerId),
      readTitles(playerId),
      readProgression(playerId),
      readWallet(playerId),
      readXpLog(playerId),
      readRuntimeFields(playerId),
      InventoryReadService.snapshot(playerId, _language ?? null),
      readXpLevelFloors(Number(playerRow.current_level)),
      HeroContinuityLedgerService.listPortableArtifacts(playerId),
      HeroContinuityLedgerService.listCompanionBonds(playerId),
    ]);

    const equipment: CharacterStateEquipment = {
      equippedCount: inventory.totals.equippedCount,
      items: inventory.equipment.map((item) => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        slot: item.equippedSlot,
        rarity: item.rarity,
        iconKey: item.iconKey,
      })),
    };

    const conditions = runtimeFields
      .filter((row) => row.field_key === 'conditions')
      .map((row) => toRuntimeFieldList(row));
    const trauma = runtimeFields
      .filter((row) => row.field_key === 'trauma')
      .map((row) => toRuntimeFieldList(row));

    const travelingCompanions: CharacterStateContinuityCompanion[] = [];
    const worldBoundCompanions: CharacterStateContinuityCompanion[] = [];
    for (const bond of companionBonds) {
      const row: CharacterStateContinuityCompanion = {
        companionKey: bond.companionKey,
        sourceEntityId: bond.sourceEntityId,
        status: bond.status,
        portability: bond.portability,
        publicSummary: bond.publicSummary,
      };
      const isPortable =
        bond.portability === 'portable' && bond.status !== 'suppressed';
      if (isPortable) travelingCompanions.push(row);
      else worldBoundCompanions.push(row);
    }
    const continuity: CharacterStateContinuity = {
      schemaVersion: 'greenhaven.character_state_continuity.v1',
      portableArtifacts: portableArtifacts.map((row) => ({
        artifactKey: row.artifactKey,
        kind: row.kind,
        portability: row.portability,
        powerRating: row.powerRating,
        sourceCartridgeId: row.sourceCartridgeId,
      })),
      travelingCompanions,
      worldBoundCompanions,
    };

    return {
      playerId,
      identity: buildIdentity(playerRow),
      vitals: buildVitals(playerRow, xpLevelFloors),
      stats,
      proficientSkills,
      rankedSkills,
      equipment,
      titles,
      progression: {tracks: progression.tracks, wallet},
      recentXpLog: xpLog,
      conditions: flattenRuntimeArray(conditions),
      trauma: flattenRuntimeArray(trauma),
      continuity,
    };
  }
}

function buildIdentity(row: PlayerRow): CharacterStateIdentity {
  const profile = (row.profile ?? {}) as Record<string, unknown>;
  const created = profile['created'] === true;
  return {
    publicId: row.public_id,
    displayName: row.display_name ?? `Player ${row.entity_id}`,
    profileCreated: created,
    classId: row.class_id ?? null,
    className: row.class_name ?? null,
    preferredLanguage: row.preferred_language ?? null,
  };
}

function buildVitals(
  row: PlayerRow,
  xpFloors: {thisLevelFloor: number; nextLevelXp: number | null},
): CharacterStateVitals {
  const total = Number(row.current_xp);
  const level = Number(row.current_level);
  const floor = xpFloors.thisLevelFloor;
  const next = xpFloors.nextLevelXp;
  let progress = 0;
  if (next != null && next > floor) {
    const span = next - floor;
    progress = Math.max(0, Math.min(1, (total - floor) / span));
  } else if (next == null) {
    // No further level threshold available — treat the bar as
    // full. The service does not unilaterally cap the curve;
    // `nextLevelXp` is null only when SQL returns NULL itself
    // (e.g. a future schema adds a row-level max-level rule).
    progress = 1;
  }
  return {
    hp: {current: row.current_hp, max: row.max_hp},
    xp: {
      total,
      level,
      thisLevelFloor: floor,
      nextLevelXp: next,
      progress,
    },
  };
}

async function readXpLevelFloors(
  level: number,
): Promise<{thisLevelFloor: number; nextLevelXp: number | null}> {
  // Inverse pair of the canonical curve in migration 0002:
  //
  //   level_for_xp(xp)       = GREATEST(1, FLOOR(SQRT(xp/100)))
  //   xp_required_for_level  = 100 * L^2
  //
  // For level N, the inverse tells us:
  //
  //   level_for_xp(400)   = 2  → level 2 starts at xp 400  = xp_required_for_level(2)
  //   level_for_xp(900)   = 3  → level 3 starts at xp 900  = xp_required_for_level(3)
  //   level_for_xp(40000) = 20 → level 20 starts at 40000 = xp_required_for_level(20)
  //
  // So for any level N >= 2 the canonical floor is
  // `xp_required_for_level(N)` — NOT `(N - 1)`. Level 1 is the
  // only special case: the inverse clamps `level_for_xp(xp) = 1`
  // for all xp < 400, so level 1 floor is 0, not 100.
  //
  // We also do NOT cap `nextLevelXp` in the service. The
  // progression curve is server-canonical and the
  // `xp_thresholds` table (migration 0041) is consulted by
  // tooling elsewhere; capping here would silently disagree
  // with `award_xp` writes that push xp past level 20 on the
  // quadratic curve. The UI surfaces "max level reached" only
  // when a downstream rule actually returns NULL.
  const res = await query<{this_floor: number | string; next_xp: number | string}>(
    `SELECT CASE WHEN $1 <= 1
                 THEN 0::bigint
                 ELSE xp_required_for_level($1)::bigint
            END AS this_floor,
            xp_required_for_level($1 + 1)::bigint AS next_xp`,
    [level],
  );
  const row = res.rows[0];
  return {
    thisLevelFloor: row ? Number(row.this_floor) : 0,
    nextLevelXp: row && row.next_xp != null ? Number(row.next_xp) : null,
  };
}

async function readStats(playerId: number): Promise<CharacterStateStat[]> {
  const rows = await query<StatRow>(
    `SELECT stat_key, base, current
       FROM player_stats
      WHERE player_id = $1
      ORDER BY stat_key`,
    [playerId],
  );
  return rows.rows.map((row) => ({
    key: row.stat_key,
    base: Number(row.base),
    current: Number(row.current),
  }));
}

async function readProficientSkills(
  playerId: number,
): Promise<CharacterStateProficientSkill[]> {
  const rows = await query<ProficientSkillRow>(
    `SELECT skill_name, proficiency_level
       FROM player_proficient_skills
      WHERE player_id = $1
      ORDER BY skill_name`,
    [playerId],
  );
  return rows.rows.map((row) => ({
    skillName: row.skill_name,
    proficiencyLevel: Number(row.proficiency_level),
  }));
}

async function readRankedSkills(
  playerId: number,
): Promise<CharacterStateRankedSkill[]> {
  const rows = await query<RankedSkillRow>(
    `SELECT ps.skill_entity_id,
            e.display_name AS display_name,
            ps.rank,
            ps.unlocked_at::text AS unlocked_at,
            ps.metadata
       FROM player_skills ps
       JOIN entities e ON e.id = ps.skill_entity_id
      WHERE ps.player_id = $1
      ORDER BY ps.rank DESC, e.display_name ASC`,
    [playerId],
  );
  return rows.rows.map((row) => ({
    skillEntityId: Number(row.skill_entity_id),
    name: row.display_name,
    rank: Number(row.rank),
    unlockedAt: row.unlocked_at,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }));
}

async function readTitles(playerId: number): Promise<CharacterStateTitle[]> {
  const rows = await query<TitleRow>(
    `SELECT id,
            title_key,
            display_name,
            description,
            source,
            awarded_at::text AS awarded_at,
            is_equipped,
            metadata
       FROM player_titles
      WHERE player_id = $1
      ORDER BY is_equipped DESC, awarded_at DESC, id DESC`,
    [playerId],
  );
  return rows.rows.map((row) => ({
    id: Number(row.id),
    titleKey: row.title_key,
    displayName: row.display_name,
    description: row.description ?? null,
    source: row.source ?? null,
    awardedAt: row.awarded_at,
    isEquipped: Boolean(row.is_equipped),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }));
}

async function readProgression(
  playerId: number,
): Promise<CharacterStateProgression> {
  const rows = await query<ProgressionRow>(
    `SELECT pt.track_key,
            t.display_name,
            t.description,
            pt.xp,
            pt.level,
            t.max_level,
            t.sort_order,
            pt.metadata,
            pt.updated_at::text AS updated_at
       FROM player_progression_tracks pt
       JOIN progression_tracks t ON t.track_key = pt.track_key
      WHERE pt.player_id = $1
      ORDER BY t.sort_order ASC, pt.track_key ASC`,
    [playerId],
  );
  const tracks: CharacterStateProgressionTrack[] = rows.rows.map((row) => ({
    trackKey: row.track_key,
    displayName: row.display_name,
    description: row.description ?? null,
    xp: Number(row.xp),
    level: Number(row.level),
    maxLevel: Number(row.max_level),
    sortOrder: Number(row.sort_order),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    updatedAt: row.updated_at,
  }));
  return {tracks, wallet: DEFAULT_WALLET};
}

async function readWallet(playerId: number): Promise<CharacterStateWallet> {
  const rows = await query<WalletRow>(
    `SELECT stat_points, skill_points, title_slots,
            updated_at::text AS updated_at
       FROM player_progression_wallets
      WHERE player_id = $1`,
    [playerId],
  );
  const row = rows.rows[0];
  if (!row) return {...DEFAULT_WALLET};
  return {
    statPoints: Number(row.stat_points),
    skillPoints: Number(row.skill_points),
    titleSlots: Number(row.title_slots),
    updatedAt: row.updated_at,
  };
}

async function readXpLog(playerId: number): Promise<CharacterStateXpLogEntry[]> {
  const rows = await query<XpLogRow>(
    `SELECT id,
            amount,
            reason,
            awarded_by_tool,
            awarded_at::text AS awarded_at,
            metadata
       FROM player_xp_log
      WHERE player_id = $1
      ORDER BY awarded_at DESC, id DESC
      LIMIT $2`,
    [playerId, RECENT_XP_LIMIT],
  );
  return rows.rows.map((row) => ({
    id: Number(row.id),
    amount: Number(row.amount),
    reason: row.reason,
    awardedByTool: row.awarded_by_tool ?? null,
    awardedAt: row.awarded_at,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }));
}

async function readRuntimeFields(
  playerId: number,
): Promise<RuntimeFieldRow[]> {
  const rows = await query<RuntimeFieldRow>(
    `SELECT rf.field_key, rv.value
       FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1
        AND rf.field_key IN ('conditions', 'trauma')`,
    [playerId],
  );
  return rows.rows;
}

function toRuntimeFieldList(row: RuntimeFieldRow): unknown[] {
  if (Array.isArray(row.value)) return row.value as unknown[];
  return [];
}

// Conditions/trauma are JSONB arrays of structured tags. We
// expose each entry as `{key, value}` — for an object entry the
// `tag` field is the canonical key, for a primitive entry the
// value itself is also surfaced as the key.
function flattenRuntimeArray(
  raw: unknown[][],
): CharacterStateRuntimeField[] {
  const out: CharacterStateRuntimeField[] = [];
  for (const list of raw) {
    for (const entry of list) {
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>;
        const tag = typeof obj['tag'] === 'string' ? (obj['tag'] as string) : null;
        out.push({key: tag ?? '', value: entry});
      } else if (typeof entry === 'string') {
        out.push({key: entry, value: entry});
      } else {
        out.push({key: '', value: entry});
      }
    }
  }
  return out;
}

export const __FOR_TESTS = {
  buildIdentity,
  buildVitals,
  flattenRuntimeArray,
};
