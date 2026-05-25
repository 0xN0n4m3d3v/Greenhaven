/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {type AdventureKind} from './adventureTables.js';

export const ADVENTURE_BLUEPRINT_SCHEMA_VERSION = 'adventure.blueprint.v1';

export const AdventureKindSchema = z.enum([
  'social_hook',
  'exploration_clue',
  'hidden_location',
  'item_discovery',
  'hazard',
  'ambush',
  'quest_complication',
  'downtime_rumor',
]);

const SpawnKindSchema = z.enum([
  'location',
  'scene',
  'item',
  'person',
  'event',
  'service',
]);

const StageSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(2).max(120),
  next_stage: z.string().min(1).max(40).optional(),
});

const SpawnSchema = z.object({
  kind: SpawnKindSchema,
  display_name: z.string().min(1).max(120),
  summary: z.string().min(1).max(400),
  tags: z.array(z.string().max(40)).max(8).optional(),
  profile: z.record(z.unknown()).optional(),
  hidden_until_stage: z.string().min(1).max(40).optional(),
});

export const AdventureBlueprintSchema = z.object({
  schemaVersion: z.literal(ADVENTURE_BLUEPRINT_SCHEMA_VERSION).optional(),
  queueId: z.number().int().positive(),
  adventureKind: AdventureKindSchema,
  title: z.string().min(4).max(120),
  summary: z.string().min(8).max(500),
  playerFacingHook: z.string().min(8).max(900),
  danger: z.enum(['safe', 'risky', 'deadly']),
  suggestedQuest: z
    .object({
      title: z.string().min(4).max(80),
      summary: z.string().min(8).max(400),
      goal_text: z.string().min(8).max(600),
      stages: z.array(StageSchema).min(1).max(8),
      rewards: z.record(z.unknown()).optional(),
      tags: z.array(z.string().max(40)).max(8).optional(),
      source: z
        .enum(['npc_giver', 'location_situation', 'faction_motion', 'player_goal'])
        .optional(),
      mode: z
        .enum(['create_new', 'attach_existing', 'advance_existing'])
        .optional(),
      existingQuestId: z.number().int().positive().optional(),
      giverEntityId: z.number().int().positive().optional(),
      sourceEntityId: z.number().int().positive().optional(),
      toStage: z.string().min(1).max(40).optional(),
      bridgeSummary: z.string().min(1).max(240).optional(),
      spawn_entities: z.array(SpawnSchema).max(8).optional(),
    })
    .optional(),
  standaloneSpawns: z.array(SpawnSchema).max(8).optional(),
  itemPlacements: z
    .array(
      z.object({
        itemDisplayName: z.string().min(1).max(120),
        holderEntityId: z.number().int().positive(),
        count: z.number().int().positive().max(99),
        hiddenUntilStage: z.string().min(1).max(40).optional(),
      }),
    )
    .max(8)
    .optional(),
  encounterPlan: z
    .object({
      encounterType: z.enum(['ambush', 'hazard', 'social', 'discovery']),
      budget: z.enum(['trivial', 'easy', 'medium', 'hard']),
      enemies: z
        .array(
          z.object({
            display_name: z.string().min(1).max(120),
            role: z.string().min(1).max(80),
            count: z.number().int().positive().max(6),
          }),
        )
        .max(6)
        .optional(),
      requiredVisibleRoll: z.boolean(),
    })
    .optional(),
  scenario: z
    .object({
      schemaVersion: z.string().max(80).optional(),
      pressureType: z.string().max(80).optional(),
      proximity: z.string().max(80).optional(),
      causeSources: z.array(z.record(z.unknown())).max(12).optional(),
      clocks: z.array(z.record(z.unknown())).max(8).optional(),
    })
    .optional(),
});

export type AdventureBlueprint = z.infer<typeof AdventureBlueprintSchema> & {
  adventureKind: AdventureKind;
};

export function parseAdventureBlueprint(input: unknown): {
  ok: true;
  blueprint: AdventureBlueprint;
} | {
  ok: false;
  reason: string;
} {
  const parsed = AdventureBlueprintSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .slice(0, 4)
        .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    };
  }
  return {
    ok: true,
    blueprint: {
      schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
      ...parsed.data,
    } as AdventureBlueprint,
  };
}
