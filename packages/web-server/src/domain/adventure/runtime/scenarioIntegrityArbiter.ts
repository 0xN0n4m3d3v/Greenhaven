/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../../../db.js';
import {
  ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
  type AdventureBlueprint,
} from './adventureBlueprint.js';
import {type AdventureQueueRow} from './adventureQueue.js';
import {
  parseSituationBlueprint,
  pressureMatchesAdventureKind,
  SITUATION_BLUEPRINT_SCHEMA_VERSION,
  type SituationBlueprint,
} from './situationBlueprint.js';

export type ScenarioIntegrityReason =
  | 'schema_invalid'
  | 'queue_mismatch'
  | 'kind_mismatch'
  | 'unknown_entity_reference'
  | 'unsupported_private_access'
  | 'unsupported_item_provenance'
  | 'unsupported_npc_knowledge'
  | 'missing_location_owner'
  | 'missing_topology_parent'
  | 'missing_clue_route'
  | 'player_gravity_event'
  | 'quest_giver_not_present_or_reachable'
  | 'situation_cause_missing';

export interface ScenarioIntegrityVerdict {
  ok: boolean;
  reason?: ScenarioIntegrityReason;
  message?: string;
  situation?: SituationBlueprint;
  details?: Record<string, unknown>;
}

const PRIVATE_POLICIES = new Set(['staff_only', 'locked', 'secret', 'hostile']);
const CLUE_REQUIRED_PRESSURES = new Set([
  'exploration_secret',
  'location_discovery',
  'item_trace',
]);

export async function validateSituationBlueprint(args: {
  queue: AdventureQueueRow;
  situation: unknown;
  playerId: number;
}): Promise<ScenarioIntegrityVerdict> {
  const parsed = parseSituationBlueprint(args.situation);
  if (!parsed.ok) {
    return {ok: false, reason: 'schema_invalid', message: parsed.reason};
  }
  const situation = parsed.situation;
  if (situation.queueId !== args.queue.id) {
    return {
      ok: false,
      reason: 'queue_mismatch',
      message: `situation queueId ${situation.queueId} != queue ${args.queue.id}`,
    };
  }
  if (!pressureMatchesAdventureKind(situation.pressureType, args.queue.adventureKind)) {
    return {
      ok: false,
      reason: 'kind_mismatch',
      message:
        `pressure ${situation.pressureType} is not compatible with ${args.queue.adventureKind}`,
    };
  }
  if (situation.causeSources.length <= 0) {
    return {
      ok: false,
      reason: 'situation_cause_missing',
      message: 'situation must include at least one in-world cause source',
    };
  }

  const referencedIds = collectEntityIds(situation);
  const missingIds = await findMissingEntityIds(referencedIds);
  if (missingIds.length > 0) {
    return {
      ok: false,
      reason: 'unknown_entity_reference',
      message: `unknown entity ids: ${missingIds.join(', ')}`,
      details: {missingIds},
    };
  }

  const locationFailure = validateLocationIntegrity(situation);
  if (locationFailure) return locationFailure;

  const visibleCauseFailure = validateVisibleCausePresence(
    situation,
    args.queue,
  );
  if (visibleCauseFailure) return visibleCauseFailure;

  const itemFailure = validateItemIntegrity(
    situation,
    args.playerId,
    args.queue,
  );
  if (itemFailure) return itemFailure;

  const secretFailure = validateSecretIntegrity(situation);
  if (secretFailure) return secretFailure;

  const questFailure = validateQuestProjectionIntegrity(situation);
  if (questFailure) return questFailure;

  if (
    situation.proximity === 'targets_player' &&
    !situation.causeSources.some(source =>
      source.kind === 'quest' ||
      source.kind === 'memory' ||
      source.kind === 'tool' ||
      source.kind === 'chat' ||
      source.kind === 'clock'
    )
  ) {
    return {
      ok: false,
      reason: 'player_gravity_event',
      message:
        'player-targeted pressure requires prior player action, memory, quest, tool, chat, or clock cause',
    };
  }

  return {ok: true, situation};
}

export function projectSituationToAdventureBlueprint(args: {
  queue: AdventureQueueRow;
  situation: SituationBlueprint;
}): AdventureBlueprint {
  const situation = args.situation;
  const questProjection = situation.questProjection;
  const questMode = questProjection?.mode ?? 'create_new';
  const defaultStage = [
    {id: 'notice', title: 'Notice the situation', next_stage: 'resolve'},
    {id: 'resolve', title: 'Resolve the situation'},
  ];
  const projectedSpawns = projectSituationSpawns(situation, questProjection);
  const suggestedQuest = {
    title: situation.projectedHook.title.slice(0, 80),
    summary: situation.projectedHook.playerFacingHook.slice(0, 400),
    goal_text: questProjection?.goalText ?? situation.projectedHook.acceptCondition,
    stages: questProjection?.stages ?? defaultStage,
    tags: [
      'situation',
      situation.pressureType,
      ...(questProjection?.tags ?? []),
    ].slice(0, 8),
    source: questProjection?.source ?? 'location_situation',
    mode: questMode,
    existingQuestId: questProjection?.existingQuestId,
    giverEntityId: questProjection?.giverEntityId,
    sourceEntityId: questProjection?.sourceEntityId,
    toStage: questProjection?.toStage,
    bridgeSummary: questProjection?.bridgeSummary,
    ...(projectedSpawns.length > 0 ? {spawn_entities: projectedSpawns} : {}),
  } satisfies NonNullable<AdventureBlueprint['suggestedQuest']>;

  const itemPlacements = (situation.items ?? [])
    .filter(item => item.proposedName && item.holderEntityId != null)
    .map(item => ({
      itemDisplayName: item.proposedName!,
      holderEntityId: item.holderEntityId!,
      count: item.count,
      hiddenUntilStage: item.hiddenUntilStage,
    }));

  return {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    queueId: args.queue.id,
    adventureKind: args.queue.adventureKind,
    title: situation.projectedHook.title,
    summary: summarizeSituation(situation),
    playerFacingHook: situation.projectedHook.playerFacingHook,
    danger: situation.danger,
    suggestedQuest,
    ...(itemPlacements.length > 0 ? {itemPlacements} : {}),
    scenario: {
      schemaVersion: SITUATION_BLUEPRINT_SCHEMA_VERSION,
      pressureType: situation.pressureType,
      proximity: situation.proximity,
      causeSources: situation.causeSources,
      ...(situation.clocks?.length ? {clocks: situation.clocks} : {}),
    },
  };
}

function validateLocationIntegrity(
  situation: SituationBlueprint,
): ScenarioIntegrityVerdict | null {
  for (const location of situation.locations ?? []) {
    const isNewLocation = location.entityId == null && location.proposedName;
    const requiresControlledAccess =
      PRIVATE_POLICIES.has(location.accessPolicy) || location.hiddenUntilStage != null;
    if (isNewLocation && location.topologyParentId == null) {
      return {
        ok: false,
        reason: 'missing_topology_parent',
        message:
          `new location ${location.proposedName ?? '<new>'} has no topologyParentId`,
      };
    }
    if (!requiresControlledAccess) continue;
    if (location.ownerEntityId == null) {
      return {
        ok: false,
        reason: 'missing_location_owner',
        message:
          `private or hidden location ${location.proposedName ?? location.entityId ?? '<unknown>'} has no ownerEntityId`,
      };
    }
    if (location.topologyParentId == null && location.entityId == null) {
      return {
        ok: false,
        reason: 'missing_topology_parent',
        message:
          `private or hidden location ${location.proposedName ?? '<new>'} has no topologyParentId`,
      };
    }
    if (!location.accessReason?.trim()) {
      return {
        ok: false,
        reason: 'unsupported_private_access',
        message:
          `private or hidden location ${location.proposedName ?? location.entityId} has no accessReason`,
      };
    }
  }
  return null;
}

function validateItemIntegrity(
  situation: SituationBlueprint,
  playerId: number,
  queue: AdventureQueueRow,
): ScenarioIntegrityVerdict | null {
  const reachableIds = reachableEntityIds(queue);
  for (const item of situation.items ?? []) {
    if (item.holderEntityId == null) {
      return {
        ok: false,
        reason: 'unsupported_item_provenance',
        message:
          `item ${item.proposedName ?? item.entityId ?? '<unknown>'} has no holderEntityId`,
      };
    }
    if (item.holderEntityId === playerId) {
      return {
        ok: false,
        reason: 'unsupported_item_provenance',
        message: 'situation item placement cannot grant directly to the player',
      };
    }
    if (!reachableIds.has(item.holderEntityId)) {
      return {
        ok: false,
        reason: 'unsupported_item_provenance',
        message:
          `item holder ${item.holderEntityId} is not present/reachable for this visible hook`,
      };
    }
    if (!item.provenance.trim()) {
      return {
        ok: false,
        reason: 'unsupported_item_provenance',
        message:
          `item ${item.proposedName ?? item.entityId ?? '<unknown>'} has no provenance`,
      };
    }
  }
  return null;
}

function validateVisibleCausePresence(
  situation: SituationBlueprint,
  queue: AdventureQueueRow,
): ScenarioIntegrityVerdict | null {
  if (
    situation.proximity !== 'nearby_visible' &&
    situation.proximity !== 'caused_by_player' &&
    situation.proximity !== 'targets_player'
  ) {
    return null;
  }
  const reachableIds = reachableEntityIds(queue);
  for (const source of situation.causeSources) {
    if (source.kind !== 'entity' || typeof source.id !== 'number') continue;
    if (reachableIds.has(source.id)) continue;
    return {
      ok: false,
      reason: 'situation_cause_missing',
      message:
        `visible entity cause ${source.id} is not present/reachable; use chat or memory cause for historical mentions`,
    };
  }
  return null;
}

function validateSecretIntegrity(
  situation: SituationBlueprint,
): ScenarioIntegrityVerdict | null {
  const actorIds = new Set(
    (situation.actors ?? [])
      .map(actor => actor.entityId)
      .filter((id): id is number => id != null),
  );
  const entityCauseIds = new Set(
    situation.causeSources
      .map(source =>
        source.kind === 'entity' && typeof source.id === 'number'
          ? source.id
          : null,
      )
      .filter((id): id is number => id != null),
  );
  for (const secret of situation.secrets ?? []) {
    if (secret.knownByEntityIds.length <= 0) {
      return {
        ok: false,
        reason: 'unsupported_npc_knowledge',
        message: 'secret has no knowing NPC/entity',
      };
    }
    for (const knownById of secret.knownByEntityIds) {
      if (actorIds.has(knownById) || entityCauseIds.has(knownById)) continue;
      return {
        ok: false,
        reason: 'unsupported_npc_knowledge',
        message:
          `secret knower ${knownById} is not listed as actor or entity cause with knowledge provenance`,
      };
    }
  }
  if (CLUE_REQUIRED_PRESSURES.has(situation.pressureType)) {
    const clueCount = (situation.secrets ?? []).reduce(
      (sum, secret) => sum + secret.clues.length,
      0,
    );
    if (clueCount < 3) {
      return {
        ok: false,
        reason: 'missing_clue_route',
        message:
          `${situation.pressureType} needs at least three clue carriers before projection`,
      };
    }
  }
  return null;
}

function validateQuestProjectionIntegrity(
  situation: SituationBlueprint,
): ScenarioIntegrityVerdict | null {
  const quest = situation.questProjection;
  if (!quest) return null;
  const mode = quest.mode ?? 'create_new';
  if (mode === 'create_new' && (!quest.stages || quest.stages.length <= 0)) {
    return {
      ok: false,
      reason: 'quest_giver_not_present_or_reachable',
      message: 'create_new projection requires stages',
    };
  }
  if (mode !== 'create_new') {
    if (quest.existingQuestId == null) {
      return {
        ok: false,
        reason: 'quest_giver_not_present_or_reachable',
        message: `${mode} projection requires existingQuestId`,
      };
    }
    if (
      !situation.causeSources.some(
        source => source.kind === 'quest' && source.id === quest.existingQuestId,
      )
    ) {
      return {
        ok: false,
        reason: 'situation_cause_missing',
        message:
          `${mode} projection must include causeSources[{kind:"quest", id: existingQuestId}]`,
      };
    }
    if (mode === 'advance_existing' && !quest.toStage) {
      return {
        ok: false,
        reason: 'quest_giver_not_present_or_reachable',
        message: 'advance_existing projection requires toStage',
      };
    }
  }
  if (quest.source === 'npc_giver') {
    if (quest.giverEntityId == null) {
      return {
        ok: false,
        reason: 'quest_giver_not_present_or_reachable',
        message: 'npc_giver projection requires giverEntityId',
      };
    }
    const actorIds = new Set(
      (situation.actors ?? [])
        .map(actor => actor.entityId)
        .filter((id): id is number => id != null),
    );
    const causeIds = new Set(
      situation.causeSources
        .map(source => typeof source.id === 'number' ? source.id : null)
        .filter((id): id is number => id != null),
    );
    if (!actorIds.has(quest.giverEntityId) && !causeIds.has(quest.giverEntityId)) {
      return {
        ok: false,
        reason: 'quest_giver_not_present_or_reachable',
        message:
          `quest giver ${quest.giverEntityId} is not listed as actor or cause source`,
      };
    }
  }
  if (
    quest.source !== 'npc_giver' &&
    quest.source !== 'player_goal' &&
    mode === 'create_new' &&
    quest.sourceEntityId == null
  ) {
    return {
      ok: false,
      reason: 'quest_giver_not_present_or_reachable',
      message: `${quest.source} projection requires sourceEntityId`,
    };
  }
  return null;
}

function collectEntityIds(situation: SituationBlueprint): number[] {
  const ids = new Set<number>();
  for (const source of situation.causeSources) {
    if (
      typeof source.id === 'number' &&
      (source.kind === 'entity' ||
        source.kind === 'quest' ||
        source.kind === 'cartridge')
    ) {
      ids.add(source.id);
    }
  }
  for (const actor of situation.actors ?? []) addOptional(ids, actor.entityId);
  for (const location of situation.locations ?? []) {
    addOptional(ids, location.entityId);
    addOptional(ids, location.topologyParentId);
    addOptional(ids, location.ownerEntityId);
  }
  for (const item of situation.items ?? []) {
    addOptional(ids, item.entityId);
    addOptional(ids, item.holderEntityId);
    addOptional(ids, item.ownerEntityId);
  }
  for (const secret of situation.secrets ?? []) {
    for (const id of secret.knownByEntityIds) ids.add(id);
    for (const clue of secret.clues) addOptional(ids, clue.carrierEntityId);
  }
  addOptional(ids, situation.questProjection?.giverEntityId);
  addOptional(ids, situation.questProjection?.sourceEntityId);
  addOptional(ids, situation.questProjection?.existingQuestId);
  return [...ids];
}

function addOptional(ids: Set<number>, id: number | null | undefined): void {
  if (id != null) ids.add(id);
}

function reachableEntityIds(queue: AdventureQueueRow): Set<number> {
  const ids = new Set<number>();
  const currentLocationId = Number(queue.contextSnapshot['currentLocationId']);
  if (Number.isInteger(currentLocationId) && currentLocationId > 0) {
    ids.add(currentLocationId);
  }
  const nearby = queue.contextSnapshot['nearbyEntityIds'];
  if (Array.isArray(nearby)) {
    for (const value of nearby) {
      const id = Number(value);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  return ids;
}

async function findMissingEntityIds(ids: number[]): Promise<number[]> {
  if (ids.length <= 0) return [];
  const unique = [...new Set(ids)];
  const rows = await query<{id: number | string}>(
    `SELECT id FROM entities WHERE id = ANY($1::bigint[])`,
    [unique],
  );
  const found = new Set(rows.rows.map(row => Number(row.id)));
  return unique.filter(id => !found.has(id));
}

function summarizeSituation(situation: SituationBlueprint): string {
  const cause = situation.causeSources[0]?.claim ?? situation.projectedHook.acceptCondition;
  return `${situation.pressureType}: ${cause}`.slice(0, 500);
}

function projectSituationSpawns(
  situation: SituationBlueprint,
  questProjection: SituationBlueprint['questProjection'],
): NonNullable<NonNullable<AdventureBlueprint['suggestedQuest']>['spawn_entities']> {
  const questId = questProjection?.existingQuestId;
  return (situation.locations ?? [])
    .filter(location => location.entityId == null && location.proposedName)
    .map(location => ({
      kind: 'location' as const,
      display_name: location.proposedName!,
      summary: location.whyHere,
      tags: [
        'situation',
        'quest-location',
        situation.pressureType,
        location.accessPolicy,
      ],
      profile: {
        ...(location.topologyParentId != null
          ? {topology_parent_id: String(location.topologyParentId)}
          : {}),
        ...(location.ownerEntityId != null
          ? {owner_entity_id: String(location.ownerEntityId)}
          : {}),
        access_policy: location.accessPolicy,
        ...(location.accessReason
          ? {access_reason: location.accessReason}
          : {}),
        why_here: location.whyHere,
        situation_pressure_type: situation.pressureType,
        ...(questId != null ? {source_quest_id: String(questId)} : {}),
      },
      ...(location.hiddenUntilStage
        ? {hidden_until_stage: location.hiddenUntilStage}
        : {}),
    }));
}
