/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {type AdventureKind} from './adventureTables.js';

export const SITUATION_BLUEPRINT_SCHEMA_VERSION = 'situation.blueprint.v1';

// Bounded text fields used by the LLM-facing materializer schema.
// LLM occasionally produces overflow (e.g. 245-char `causeSources[].claim`)
// which previously rejected the entire blueprint and silently dropped the
// adventure roll when no deterministic fallback covered the adventure kind.
// Preprocess-truncate is forgiving: schema still enforces non-empty + max
// bound for any code path that constructs a blueprint manually, but LLM
// overflow gets trimmed to the limit instead of rejected.
const truncatedString = (max: number) =>
  z.preprocess(
    value => (typeof value === 'string' ? value.trim().slice(0, max) : value),
    z.string().min(1).max(max),
  );
const Text120 = truncatedString(120);
const Text240 = truncatedString(240);
const Text500 = truncatedString(500);
const Text900 = truncatedString(900);

const blankOrNullToUndefined = (value: unknown): unknown => {
  if (value == null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
};

const OptionalPositiveInt = z.preprocess(
  blankOrNullToUndefined,
  z.number().int().positive().optional(),
);
const OptionalStageId = z.preprocess(
  blankOrNullToUndefined,
  z.string().trim().min(1).max(40).optional(),
);
const OptionalText120 = z.preprocess(blankOrNullToUndefined, Text120.optional());
const OptionalText240 = z.preprocess(blankOrNullToUndefined, Text240.optional());

function optionalArray<T extends z.ZodTypeAny>(
  item: T,
  max: number,
) {
  return z.preprocess(blankOrNullToUndefined, z.array(item).max(max).optional());
}

const CauseKindSchema = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'location' ||
    normalized === 'scene' ||
    normalized === 'item' ||
    normalized === 'person' ||
    normalized === 'npc' ||
    normalized === 'event' ||
    normalized === 'service'
  ) {
    return 'entity';
  }
  return normalized;
}, z.enum([
  'entity',
  'quest',
  'memory',
  'tool',
  'chat',
  'clock',
  'cartridge',
]));

export const SituationPressureTypeSchema = z.enum([
  'social_pressure',
  'exploration_secret',
  'location_discovery',
  'item_trace',
  'hazard_clock',
  'ambush_setup',
  'quest_complication',
  'downtime_rumor',
  'faction_motion',
]);

export type SituationPressureType = z.infer<typeof SituationPressureTypeSchema>;

export const SituationProximitySchema = z.enum([
  'offscreen',
  'unrelated_nearby',
  'nearby_visible',
  'caused_by_player',
  'targets_player',
]);

const StageSchema = z.object({
  id: z.string().trim().min(1).max(40),
  title: Text120,
  next_stage: OptionalStageId,
});

export const QuestProjectionModeSchema = z.enum([
  'create_new',
  'attach_existing',
  'advance_existing',
]);

export const SituationBlueprintSchema = z.object({
  schemaVersion: z.literal(SITUATION_BLUEPRINT_SCHEMA_VERSION).optional(),
  queueId: z.number().int().positive(),
  pressureType: SituationPressureTypeSchema,
  proximity: SituationProximitySchema,
  danger: z.enum(['safe', 'risky', 'deadly']),
  causeSources: z
    .array(
      z.object({
        kind: CauseKindSchema,
        id: z.preprocess(
          blankOrNullToUndefined,
          z.union([z.number().int().positive(), Text120]).optional(),
        ),
        claim: Text240,
      }),
    )
    .min(1)
    .max(12),
  actors: optionalArray(
    z.object({
      entityId: OptionalPositiveInt,
      proposedName: OptionalText120,
      role: Text120,
      motive: Text240,
      knowledgeSource: Text240,
    }),
    12,
  ),
  locations: optionalArray(
    z.object({
      entityId: OptionalPositiveInt,
      proposedName: OptionalText120,
      topologyParentId: OptionalPositiveInt,
      ownerEntityId: OptionalPositiveInt,
      accessPolicy: z.enum([
        'public',
        'staff_only',
        'locked',
        'secret',
        'hostile',
      ]),
      accessReason: OptionalText240,
      whyHere: Text240,
      hiddenUntilStage: OptionalStageId,
    }),
    12,
  ),
  items: optionalArray(
    z.object({
      entityId: OptionalPositiveInt,
      proposedName: OptionalText120,
      holderEntityId: OptionalPositiveInt,
      ownerEntityId: OptionalPositiveInt,
      count: z.number().int().positive().max(99),
      provenance: Text240,
      hiddenUntilStage: OptionalStageId,
    }),
    12,
  ),
  clocks: optionalArray(
    z.object({
      key: z.string().trim().min(1).max(80),
      label: Text120,
      segments: z.union([
        z.literal(4),
        z.literal(6),
        z.literal(8),
        z.literal(10),
        z.literal(12),
      ]),
      filled: z.number().int().min(0).max(12),
      impulse: Text240,
      tickOn: z.array(Text120).min(1).max(8),
    }),
    8,
  ),
  secrets: optionalArray(
    z.object({
      text: Text500,
      knownByEntityIds: z.array(z.number().int().positive()).min(1).max(8),
      clues: z
        .array(
          z.object({
            carrier: z.enum(['npc', 'item', 'location', 'event', 'memory']),
            carrierEntityId: OptionalPositiveInt,
            clueText: Text240,
          }),
        )
        .max(8),
    }),
    8,
  ),
  forbiddenMoves: optionalArray(Text120, 12),
  projectedHook: z.object({
    title: Text120,
    playerFacingHook: Text900,
    acceptCondition: Text240,
  }),
  questProjection: z
    .object({
      source: z.enum([
        'npc_giver',
        'location_situation',
        'faction_motion',
        'player_goal',
      ]),
      mode: z.preprocess(blankOrNullToUndefined, QuestProjectionModeSchema.optional()),
      existingQuestId: OptionalPositiveInt,
      giverEntityId: OptionalPositiveInt,
      sourceEntityId: OptionalPositiveInt,
      toStage: OptionalStageId,
      bridgeSummary: OptionalText240,
      goalText: z.string().trim().min(8).max(600),
      stages: z.preprocess(
        blankOrNullToUndefined,
        z.array(StageSchema).min(1).max(8).optional(),
      ),
      tags: optionalArray(z.string().max(40), 8),
    })
    .optional(),
});

export type SituationBlueprint = z.infer<typeof SituationBlueprintSchema>;

export function parseSituationBlueprint(input: unknown): {
  ok: true;
  situation: SituationBlueprint;
} | {
  ok: false;
  reason: string;
} {
  const parsed = SituationBlueprintSchema.safeParse(input);
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
    situation: {
      schemaVersion: SITUATION_BLUEPRINT_SCHEMA_VERSION,
      ...parsed.data,
    },
  };
}

const PRESSURE_KIND_COMPATIBILITY: Record<SituationPressureType, AdventureKind[]> = {
  social_pressure: ['social_hook'],
  exploration_secret: ['exploration_clue'],
  location_discovery: ['hidden_location'],
  item_trace: ['item_discovery'],
  hazard_clock: ['hazard'],
  ambush_setup: ['ambush'],
  quest_complication: ['quest_complication'],
  downtime_rumor: ['downtime_rumor'],
  faction_motion: ['downtime_rumor', 'quest_complication', 'social_hook'],
};

export function pressureMatchesAdventureKind(
  pressureType: SituationPressureType,
  adventureKind: AdventureKind,
): boolean {
  return PRESSURE_KIND_COMPATIBILITY[pressureType].includes(adventureKind);
}

export function defaultPressureForAdventureKind(
  adventureKind: AdventureKind,
): SituationPressureType {
  switch (adventureKind) {
    case 'social_hook':
      return 'social_pressure';
    case 'exploration_clue':
      return 'exploration_secret';
    case 'hidden_location':
      return 'location_discovery';
    case 'item_discovery':
      return 'item_trace';
    case 'hazard':
      return 'hazard_clock';
    case 'ambush':
      return 'ambush_setup';
    case 'quest_complication':
      return 'quest_complication';
    case 'downtime_rumor':
      return 'downtime_rumor';
  }
}
