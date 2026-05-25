/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — Character State bridge.
//
// Owns the `/api/player/:id/character-state` read surface so the
// future `CharacterStateSurface` body and the
// `useCharacterState` hook never call `fetch(...)` directly.
// Mirrors the bridge shape used by inventory / quest dashboard /
// notice journal.

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
}

/**
 * Returns `null` when the endpoint replies non-2xx so the hook
 * can surface a focused error state without leaking HTTP details
 * to the surface body.
 */
export async function fetchCharacterState(args: {
  playerId: number;
  language?: string | null;
  baseUrl?: string;
}): Promise<CharacterStateSnapshot | null> {
  const params = args.language
    ? `?language=${encodeURIComponent(args.language)}`
    : '';
  const r = await fetch(
    `${args.baseUrl ?? ''}/api/player/${args.playerId}/character-state${params}`,
    {credentials: 'include'},
  );
  if (!r.ok) return null;
  return (await r.json()) as CharacterStateSnapshot;
}

// FEAT-STATE-1 mutation helpers. The surface dispatches title
// equip/unequip + stat/skill point spend through this single
// `postCharacterStateAction` helper; the server endpoint routes
// them into the existing `equip_title` / `spend_stat_point` /
// `spend_skill_point` tools so validation, transactional state
// mutation, and the `character:*` SSE fan-out are all shared
// with the LLM-driven path. The `{ok, error?}` shape lets the
// surface render a focused error chip without exposing HTTP
// details.
//
// `award_progression_xp` and `award_title` are intentionally NOT
// exposed here — those are broker / GM concerns, not
// player-clickable actions.

export type CharacterStateActionKind =
  | 'equip_title'
  | 'unequip_title'
  | 'spend_stat_point'
  | 'spend_skill_point';

export interface CharacterStateActionRequest {
  playerId: number;
  sessionId: string;
  action: CharacterStateActionKind;
  /** Required for `equip_title` / `unequip_title`. */
  titleKey?: string;
  /** Required for `spend_stat_point`. */
  statKey?: string;
  /** Optional audit string for `spend_stat_point`. */
  reason?: string;
  /** Required for `spend_skill_point`. */
  skill?: string;
  baseUrl?: string;
}

export interface CharacterStateActionResult {
  ok: boolean;
  action: CharacterStateActionKind;
  error?: string;
  result?: unknown;
}

export async function postCharacterStateAction(
  req: CharacterStateActionRequest,
): Promise<CharacterStateActionResult> {
  const body: Record<string, unknown> = {
    action: req.action,
    sessionId: req.sessionId,
  };
  if (req.action === 'equip_title' || req.action === 'unequip_title') {
    body.titleKey = req.titleKey ?? '';
  } else if (req.action === 'spend_stat_point') {
    body.statKey = req.statKey ?? '';
    if (req.reason) body.reason = req.reason;
  } else if (req.action === 'spend_skill_point') {
    body.skill = req.skill ?? '';
  }
  const r = await fetch(
    `${req.baseUrl ?? ''}/api/player/${req.playerId}/character-state/action`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'include',
      body: JSON.stringify(body),
    },
  );
  let payload: Partial<CharacterStateActionResult> & {error?: string} = {};
  try {
    payload = (await r.json()) as typeof payload;
  } catch {
    // Server returned no JSON body. The status code below is what
    // the UI keys off, not the payload.
  }
  if (!r.ok || payload.ok === false) {
    return {
      ok: false,
      action: req.action,
      error: payload.error ?? `character_state_action_failed_${r.status}`,
    };
  }
  return {
    ok: true,
    action: req.action,
    result: payload.result ?? null,
  };
}
