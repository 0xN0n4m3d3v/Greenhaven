/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// D&D 5e skill list. Canonical names + tied ability. Used by dice_check
// for proficiency-aware modifier resolution AND by the wizard for
// per-class skill picker validation.

export type Ability = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA';

export interface Skill {
  name: string;
  ability: Ability;
  description: string;
}

export const SKILLS: Skill[] = [
  {name: 'Athletics',       ability: 'STR', description: 'Climbing, jumping, swimming, raw shoving.'},
  {name: 'Acrobatics',      ability: 'DEX', description: 'Balance, tumbling, escaping ropes.'},
  {name: 'Sleight of Hand', ability: 'DEX', description: 'Pickpocketing, planting, palming.'},
  {name: 'Stealth',         ability: 'DEX', description: 'Moving unseen, ambushing, slipping past.'},
  {name: 'Arcana',          ability: 'INT', description: 'Magical theory, planar lore, identifying spells.'},
  {name: 'History',         ability: 'INT', description: 'Past events, dead empires, who built that.'},
  {name: 'Investigation',   ability: 'INT', description: 'Searching for clues, deducing from evidence.'},
  {name: 'Nature',          ability: 'INT', description: 'Wild flora and fauna, weather patterns, terrain.'},
  {name: 'Religion',        ability: 'INT', description: 'Pantheons, rites, the politics of priesthoods.'},
  {name: 'Animal Handling', ability: 'WIS', description: 'Calming beasts, riding, reading their mood.'},
  {name: 'Insight',         ability: 'WIS', description: 'Reading people, catching lies, gauging intent.'},
  {name: 'Medicine',        ability: 'WIS', description: 'Stabilising the dying, diagnosing illness.'},
  {name: 'Perception',      ability: 'WIS', description: "Spotting things others miss, hearing the wrong silence."},
  {name: 'Survival',        ability: 'WIS', description: 'Tracking, foraging, weathering the wild.'},
  {name: 'Deception',       ability: 'CHA', description: 'Lies that hold up. Confidence games. Disguise.'},
  {name: 'Intimidation',    ability: 'CHA', description: 'Pressing your weight on someone — overt or implied.'},
  {name: 'Performance',     ability: 'CHA', description: 'Music, oratory, bedroom arts, anything before an audience.'},
  {name: 'Persuasion',      ability: 'CHA', description: 'Honest argument, charm, rallying allies.'},
];

export const SKILL_BY_NAME: Record<string, Skill> = Object.fromEntries(
  SKILLS.map(s => [s.name, s]),
);

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export const STANDARD_ARRAY: number[] = [15, 14, 13, 12, 10, 8];

export const POINT_BUY_COSTS: Record<number, number> = {
  8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
};

export const POINT_BUY_BUDGET = 27;

export function pointBuyCostFor(score: number): number | null {
  return POINT_BUY_COSTS[score] ?? null;
}

export function totalPointBuyCost(scores: Record<Ability, number>): number {
  return (Object.values(scores) as number[]).reduce(
    (sum, s) => sum + (POINT_BUY_COSTS[s] ?? Infinity),
    0,
  );
}

export function rollFourD6DropLowest(): number {
  const rolls = [0, 0, 0, 0].map(() => 1 + Math.floor(Math.random() * 6));
  rolls.sort((a, b) => a - b);
  return rolls[1]! + rolls[2]! + rolls[3]!;
}

/**
 * Spec 27 — proficiency bonus is hard-coded to 2 (level 1). Spec 36
 * replaces with an xp_thresholds lookup that scales by character
 * level. Until then, every player's prof bonus is +2.
 */
export const PROFICIENCY_BONUS_LEVEL_1 = 2;
