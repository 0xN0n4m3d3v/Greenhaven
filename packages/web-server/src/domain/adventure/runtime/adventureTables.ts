/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export const ADVENTURE_TABLE_ID = 'greenhaven.adventure.mvp.v1';

export type AdventureKind =
  | 'social_hook'
  | 'exploration_clue'
  | 'hidden_location'
  | 'item_discovery'
  | 'hazard'
  | 'ambush'
  | 'quest_complication'
  | 'downtime_rumor';

export type AdventureMode =
  | 'exploration'
  | 'dialogue'
  | 'travel'
  | 'rest'
  | 'combat_aftermath';

export type AdventureDanger = 'safe' | 'risky' | 'deadly';

export interface AdventureTableEntry {
  kind: AdventureKind;
  weight: number;
  minLevel?: number;
  maxActiveQuests?: number;
  cooldownTurns?: number;
  allowedModes: AdventureMode[];
  requiresLocation: boolean;
  maxDanger: AdventureDanger;
}

export interface AdventureTableContext {
  playerLevel: number;
  currentLocationId: number | null;
  mode: AdventureMode;
  activeQuestCount: number;
  recentCombat: boolean;
  recentDanger: AdventureDanger | null;
  cooldownKinds: Set<AdventureKind>;
}

export interface AdventureCandidate extends AdventureTableEntry {
  tableId: string;
}

export interface AdventureRejection {
  kind: AdventureKind;
  reason:
    | 'below_min_level'
    | 'quest_load'
    | 'mode'
    | 'missing_location'
    | 'recent_danger'
    | 'cooldown';
}

export const ADVENTURE_TABLE: AdventureTableEntry[] = [
  {
    kind: 'social_hook',
    weight: 18,
    allowedModes: ['dialogue', 'exploration', 'rest'],
    requiresLocation: true,
    maxDanger: 'safe',
  },
  {
    kind: 'exploration_clue',
    weight: 18,
    allowedModes: ['exploration', 'travel', 'combat_aftermath'],
    requiresLocation: true,
    maxDanger: 'safe',
  },
  {
    kind: 'hidden_location',
    weight: 12,
    maxActiveQuests: 5,
    cooldownTurns: 3,
    allowedModes: ['exploration', 'travel'],
    requiresLocation: true,
    maxDanger: 'risky',
  },
  {
    kind: 'item_discovery',
    weight: 14,
    cooldownTurns: 2,
    allowedModes: ['exploration', 'travel', 'combat_aftermath'],
    requiresLocation: true,
    maxDanger: 'safe',
  },
  {
    kind: 'hazard',
    weight: 10,
    minLevel: 1,
    cooldownTurns: 2,
    allowedModes: ['exploration', 'travel', 'combat_aftermath'],
    requiresLocation: true,
    maxDanger: 'risky',
  },
  {
    kind: 'ambush',
    weight: 8,
    minLevel: 2,
    maxActiveQuests: 4,
    cooldownTurns: 4,
    allowedModes: ['travel', 'combat_aftermath'],
    requiresLocation: true,
    maxDanger: 'deadly',
  },
  {
    kind: 'quest_complication',
    weight: 8,
    maxActiveQuests: 3,
    cooldownTurns: 2,
    allowedModes: ['dialogue', 'exploration', 'travel', 'combat_aftermath'],
    requiresLocation: false,
    maxDanger: 'risky',
  },
  {
    kind: 'downtime_rumor',
    weight: 12,
    allowedModes: ['dialogue', 'rest'],
    requiresLocation: true,
    maxDanger: 'safe',
  },
];

export function eligibleAdventureEntries(ctx: AdventureTableContext): {
  candidates: AdventureCandidate[];
  rejected: AdventureRejection[];
} {
  const rejected: AdventureRejection[] = [];
  const candidates: AdventureCandidate[] = [];

  for (const entry of ADVENTURE_TABLE) {
    if (entry.minLevel != null && ctx.playerLevel < entry.minLevel) {
      rejected.push({kind: entry.kind, reason: 'below_min_level'});
      continue;
    }
    if (
      entry.maxActiveQuests != null &&
      ctx.activeQuestCount > entry.maxActiveQuests
    ) {
      rejected.push({kind: entry.kind, reason: 'quest_load'});
      continue;
    }
    if (!entry.allowedModes.includes(ctx.mode)) {
      rejected.push({kind: entry.kind, reason: 'mode'});
      continue;
    }
    if (entry.requiresLocation && ctx.currentLocationId == null) {
      rejected.push({kind: entry.kind, reason: 'missing_location'});
      continue;
    }
    if (
      (ctx.recentCombat || ctx.recentDanger === 'deadly') &&
      entry.maxDanger === 'deadly'
    ) {
      rejected.push({kind: entry.kind, reason: 'recent_danger'});
      continue;
    }
    if (entry.cooldownTurns && ctx.cooldownKinds.has(entry.kind)) {
      rejected.push({kind: entry.kind, reason: 'cooldown'});
      continue;
    }
    candidates.push({...entry, tableId: ADVENTURE_TABLE_ID});
  }

  return {candidates, rejected};
}

export function toAdventureMode(mode: string | null | undefined): AdventureMode {
  if (mode === 'dialogue') return 'dialogue';
  if (mode === 'travel') return 'travel';
  if (mode === 'rest') return 'rest';
  if (mode === 'combat' || mode === 'combat_aftermath') return 'combat_aftermath';
  return 'exploration';
}
