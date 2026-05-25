/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../../../db.js';
import {dispatch, type ToolContext} from '../../../tools/base.js';
import {similarityScore} from '../../../agents/catalogueScout.js';
import {validateDynamicWorldFactSpawn} from '../../../worldFactGuard.js';
import {
  ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
  parseAdventureBlueprint,
  type AdventureBlueprint,
} from './adventureBlueprint.js';
import {
  getAdventureQueueRow,
  markAdventureAccepted,
  type AdventureQueueRow,
} from './adventureQueue.js';

export type AdventureArbiterReason =
  | 'schema_invalid'
  | 'queue_mismatch'
  | 'kind_mismatch'
  | 'existing_quest_invalid'
  | 'duplicate_entity_name'
  | 'item_granted_to_player'
  | 'encounter_without_setup'
  | 'ambush_without_visible_roll'
  | 'danger_budget_invalid'
  | 'ungated_location_not_hooked'
  | 'unsupported_world_fact'
  | 'empty_blueprint'
  | 'queue_not_ready'
  | 'tool_application_failed';

export interface AdventureArbiterVerdict {
  ok: boolean;
  reason?: AdventureArbiterReason;
  message?: string;
  blueprint?: AdventureBlueprint;
  details?: Record<string, unknown>;
}

export async function validateAdventureBlueprint(args: {
  queue: AdventureQueueRow;
  blueprint: unknown;
  playerId: number;
}): Promise<AdventureArbiterVerdict> {
  const parsed = parseAdventureBlueprint(args.blueprint);
  if (!parsed.ok) {
    return {ok: false, reason: 'schema_invalid', message: parsed.reason};
  }
  const blueprint = withImplicitDeliveryItemPlacement(
    parsed.blueprint,
    args.playerId,
  );
  if (blueprint.queueId !== args.queue.id) {
    return {
      ok: false,
      reason: 'queue_mismatch',
      message: `blueprint queueId ${blueprint.queueId} != queue ${args.queue.id}`,
    };
  }
  if (blueprint.adventureKind !== args.queue.adventureKind) {
    return {
      ok: false,
      reason: 'kind_mismatch',
      message: `blueprint kind ${blueprint.adventureKind} != queue kind ${args.queue.adventureKind}`,
    };
  }
  if (
    !blueprint.suggestedQuest &&
    !blueprint.standaloneSpawns?.length &&
    !blueprint.itemPlacements?.length &&
    !blueprint.encounterPlan
  ) {
    return {
      ok: false,
      reason: 'empty_blueprint',
      message: 'blueprint has no quest, spawn, item placement, or encounter plan',
    };
  }
  const duplicate = await findDuplicateSpawn(blueprint);
  if (duplicate) {
    return {
      ok: false,
      reason: 'duplicate_entity_name',
      message: `near-duplicate of existing @${duplicate.existingName}`,
      details: duplicate,
    };
  }
  const questLinkFailure = await validateSuggestedQuestLink(blueprint);
  if (questLinkFailure) return questLinkFailure;
  if (
    blueprint.itemPlacements?.some(
      placement => placement.holderEntityId === args.playerId,
    )
  ) {
    return {
      ok: false,
      reason: 'item_granted_to_player',
      message: 'item placements cannot grant directly to the player at hook time',
    };
  }
  if (
    blueprint.encounterPlan?.encounterType === 'ambush' &&
    !blueprint.encounterPlan.enemies?.length
  ) {
    return {
      ok: false,
      reason: 'encounter_without_setup',
      message: 'ambush blueprints must define at least one enemy setup',
    };
  }
  if (
    blueprint.encounterPlan?.encounterType === 'ambush' &&
    blueprint.encounterPlan.requiredVisibleRoll !== true
  ) {
    return {
      ok: false,
      reason: 'ambush_without_visible_roll',
      message: 'ambush blueprints must require a visible roll before damage',
    };
  }
  if (
    blueprint.danger === 'deadly' &&
    blueprint.encounterPlan?.encounterType !== 'ambush'
  ) {
    return {
      ok: false,
      reason: 'danger_budget_invalid',
      message: 'deadly danger must be tied to an encounter setup',
    };
  }
  const worldFactFailure = await validateBlueprintWorldFacts(
    blueprint,
    args.playerId,
  );
  if (worldFactFailure) return worldFactFailure;
  const ungated = ungatedUnhookedLocation(blueprint);
  if (ungated) {
    return {
      ok: false,
      reason: 'ungated_location_not_hooked',
      message:
        `new visible location @${ungated.display_name} must be hidden by stage or mentioned in playerFacingHook`,
    };
  }
  return {
    ok: true,
    blueprint: {
      schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
      ...blueprint,
    },
  };
}

export async function applyReadyAdventureBlueprint(
  queueId: number,
  ctx: ToolContext,
): Promise<{
  ok: boolean;
  questResult?: unknown;
  spawnResults?: unknown[];
  reason?: AdventureArbiterReason;
  message?: string;
}> {
  const queue = await getAdventureQueueRow(queueId);
  if (
    !queue ||
    (queue.status !== 'ready' && queue.status !== 'materializing') ||
    !queue.blueprint
  ) {
    return {
      ok: false,
      reason: 'queue_not_ready',
      message: 'queue row is missing, not ready, or has no blueprint',
    };
  }
  const verdict = await validateAdventureBlueprint({
    queue,
    blueprint: queue.blueprint,
    playerId: ctx.playerId,
  });
  if (!verdict.ok || !verdict.blueprint) {
    return {
      ok: false,
      reason: verdict.reason,
      message: verdict.message,
    };
  }

  const blueprint = verdict.blueprint;
  const spawnResults: unknown[] = [];
  const questItemLinks: AdventureQuestItemLink[] = [];
  const questSpawnIds = new Map<string, number>();
  let questResult: unknown;
  let linkedQuestId: number | null = null;

  if (blueprint.suggestedQuest) {
    const questMode = blueprint.suggestedQuest.mode ?? 'create_new';
    if (questMode === 'create_new') {
      const giverName = await adventureQuestGiverName(blueprint, ctx.playerId);
      const result = await dispatch(
        'create_quest',
        {
          title: blueprint.suggestedQuest.title,
          summary: blueprint.suggestedQuest.summary,
          giver: giverName,
          goal_text: blueprint.suggestedQuest.goal_text,
          stages: blueprint.suggestedQuest.stages,
          rewards: blueprint.suggestedQuest.rewards,
          tags: ['adventure', ...(blueprint.suggestedQuest.tags ?? [])],
          auto_start: true,
          spawn_entities: blueprint.suggestedQuest.spawn_entities ?? [],
        },
        ctx,
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: 'tool_application_failed',
          message: result.error ?? 'create_quest failed',
        };
      }
      questResult = result.data;
      linkedQuestId = readQuestEntityId(result.data);
      for (const [name, id] of readSpawnedEntityMap(result.data)) {
        questSpawnIds.set(name, id);
      }
    } else {
      const existingQuestId = blueprint.suggestedQuest.existingQuestId;
      if (existingQuestId == null) {
        return {
          ok: false,
          reason: 'existing_quest_invalid',
          message: `${questMode} missing existingQuestId`,
        };
      }
      const started = await dispatch(
        'start_quest',
        {quest_id: existingQuestId},
        ctx,
      );
      if (!started.ok) {
        return {
          ok: false,
          reason: 'tool_application_failed',
          message: started.error ?? 'start_quest failed',
        };
      }
      let advanced: unknown;
      if (questMode === 'advance_existing') {
        const toStage = blueprint.suggestedQuest.toStage;
        if (!toStage) {
          return {
            ok: false,
            reason: 'existing_quest_invalid',
            message: 'advance_existing missing toStage',
          };
        }
        const advancedResult = await dispatch(
          'advance_quest',
          {quest_id: existingQuestId, to_stage: toStage},
          ctx,
        );
        if (!advancedResult.ok) {
          return {
            ok: false,
            reason: 'tool_application_failed',
            message: advancedResult.error ?? 'advance_quest failed',
          };
        }
        advanced = advancedResult.data;
      }
      questResult = {
        mode: questMode,
        quest_id: existingQuestId,
        started: started.data,
        ...(advanced ? {advanced} : {}),
      };
      linkedQuestId = existingQuestId;
      await linkSituationToExistingQuest(existingQuestId, blueprint, queue);
      for (const spawn of blueprint.suggestedQuest.spawn_entities ?? []) {
        const result = await applyStandaloneSpawn(spawn, ctx, ['linked-quest']);
        if (!result.ok) return result;
        spawnResults.push(result.data);
      }
    }
  }

  for (const spawn of blueprint.standaloneSpawns ?? []) {
    const result = await applyStandaloneSpawn(spawn, ctx);
    if (!result.ok) return result;
    spawnResults.push(result.data);
  }

  for (const placement of blueprint.itemPlacements ?? []) {
    const result = await dispatch(
      'create_entity',
      {
        kind: 'item',
        display_name: placement.itemDisplayName,
        summary: 'An adventure item placed for discovery.',
        profile: {
          home_id: String(placement.holderEntityId),
          count: placement.count,
          ...(placement.hiddenUntilStage
            ? {hidden_until_stage: placement.hiddenUntilStage}
            : {}),
        },
        tags: ['adventure', 'placed'],
      },
      ctx,
    );
    if (!result.ok) {
      return {
        ok: false,
        reason: 'tool_application_failed',
        message: result.error ?? 'create_entity item placement failed',
      };
    }
    spawnResults.push(result.data);
    const link = questItemLinkFromCreateEntityResult(
      result.data,
      placement,
      queue,
    );
    if (link) questItemLinks.push(link);
  }

  if (blueprint.encounterPlan?.enemies?.length) {
    const currentLocationId = await currentLocationIdForPlayer(ctx.playerId);
    for (const enemy of blueprint.encounterPlan.enemies) {
      const budget = encounterBudgetStats(blueprint.encounterPlan.budget);
      const count = Math.max(1, Number(enemy.count ?? 1));
      const questSpawnId = questSpawnIds.get(normalizeSpawnName(enemy.display_name));
      if (questSpawnId != null) {
        await stampQuestSpawnAsEncounterEnemy(questSpawnId, {
          queue,
          enemy,
          blueprintTitle: blueprint.title,
          encounterType: blueprint.encounterPlan.encounterType,
          requiredVisibleRoll: blueprint.encounterPlan.requiredVisibleRoll,
          currentLocationId,
          count,
        });
        await ensureEncounterCombatFields(questSpawnId, {
          currentHp: budget.hp * count,
          maxHp: budget.hp * count,
          armorClass: budget.ac,
        });
        spawnResults.push({
          id: questSpawnId,
          kind: 'person',
          display_name: enemy.display_name,
          reused_from_quest_spawn: true,
        });
        continue;
      }
      const result = await dispatch(
        'create_entity',
        {
          kind: 'person',
          display_name: enemy.display_name,
          summary:
            `${enemy.role} introduced by adventure encounter "${blueprint.title}".`,
          profile: {
            ...(currentLocationId != null
              ? {home_id: String(currentLocationId)}
              : {}),
            adventure_queue_id: String(queue.id),
            encounter_type: blueprint.encounterPlan.encounterType,
            combat_role: enemy.role,
            count,
            required_visible_roll: blueprint.encounterPlan.requiredVisibleRoll,
            status: 'pending_visible_roll',
          },
          tags: [
            'adventure',
            'encounter',
            blueprint.encounterPlan.encounterType,
            sanitizeTag(enemy.role),
          ],
        },
        ctx,
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: 'tool_application_failed',
          message: result.error ?? 'create_entity encounter enemy failed',
        };
      }
      spawnResults.push(result.data);
      const enemyId = readCreatedEntityId(result.data);
      if (enemyId != null) {
        await ensureEncounterCombatFields(enemyId, {
          currentHp: budget.hp * count,
          maxHp: budget.hp * count,
          armorClass: budget.ac,
        });
      }
    }
  }

  if (linkedQuestId != null && questItemLinks.length > 0) {
    await attachAdventureQuestItems(linkedQuestId, questItemLinks);
  }

  await markAdventureAccepted(queue.id);
  return {ok: true, questResult, spawnResults};
}

interface AdventureQuestItemLink {
  entity_id: number;
  display_name: string;
  item_id: number | null;
  slug: string | null;
  holder_entity_id: number | null;
  placed_count: number | null;
  source: 'adventure_item_placement';
  queue_id: number;
  adventure_kind: string;
}

async function displayNameForEntity(entityId: number): Promise<string> {
  const row = await query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [entityId],
  );
  return row.rows[0]?.display_name ?? String(entityId);
}

async function attachAdventureQuestItems(
  questId: number,
  links: AdventureQuestItemLink[],
): Promise<void> {
  await query(
    // M-6: safe_jsonb_array collapses missing / non-array
    // quest_items into '[]' so the append is consistent with the
    // previous CASE-branched behavior without a runtime-undefined
    // object-||-array result.
    `UPDATE entities
        SET profile = jsonb_set(
          COALESCE(profile, '{}'::jsonb),
          '{quest_items}',
          safe_jsonb_array(profile->'quest_items') || $2::jsonb,
          true
        )
      WHERE id = $1
        AND kind = 'quest'`,
    [questId, JSON.stringify(links)],
  );
}

async function validateSuggestedQuestLink(
  blueprint: AdventureBlueprint,
): Promise<AdventureArbiterVerdict | null> {
  const quest = blueprint.suggestedQuest;
  if (!quest) return null;
  const mode = quest.mode ?? 'create_new';
  if (mode === 'create_new') {
    if (quest.existingQuestId != null) {
      return {
        ok: false,
        reason: 'existing_quest_invalid',
        message: 'create_new suggestedQuest must not include existingQuestId',
      };
    }
    return null;
  }
  if (quest.existingQuestId == null) {
    return {
      ok: false,
      reason: 'existing_quest_invalid',
      message: `${mode} suggestedQuest requires existingQuestId`,
    };
  }
  if (mode === 'advance_existing' && !quest.toStage) {
    return {
      ok: false,
      reason: 'existing_quest_invalid',
      message: 'advance_existing suggestedQuest requires toStage',
    };
  }
  const rows = await query<{kind: string}>(
    `SELECT kind FROM entities WHERE id = $1`,
    [quest.existingQuestId],
  );
  if (rows.rows[0]?.kind !== 'quest') {
    return {
      ok: false,
      reason: 'existing_quest_invalid',
      message: `existingQuestId ${quest.existingQuestId} is not a quest`,
    };
  }
  return null;
}

function withImplicitDeliveryItemPlacement(
  blueprint: AdventureBlueprint,
  playerId: number,
): AdventureBlueprint {
  const implicit = inferImplicitDeliveryItemPlacement(blueprint, playerId);
  if (!implicit) return blueprint;
  return {
    ...blueprint,
    itemPlacements: [...(blueprint.itemPlacements ?? []), implicit],
  };
}

function inferImplicitDeliveryItemPlacement(
  blueprint: AdventureBlueprint,
  playerId: number,
): NonNullable<AdventureBlueprint['itemPlacements']>[number] | null {
  const quest = blueprint.suggestedQuest;
  if (!quest) return null;
  if ((blueprint.itemPlacements?.length ?? 0) > 0) return null;
  if ((quest.spawn_entities ?? []).some(spawn => spawn.kind === 'item')) {
    return null;
  }

  const holderEntityId = quest.giverEntityId ?? quest.sourceEntityId ?? null;
  if (holderEntityId == null || holderEntityId === playerId) return null;

  const evidence = [
    blueprint.title,
    blueprint.summary,
    blueprint.playerFacingHook,
    quest.title,
    quest.summary,
    quest.goal_text,
    ...(quest.tags ?? []),
    ...quest.stages.flatMap(stage => [stage.id, stage.title]),
  ].join(' ');
  if (!looksLikeDeliveryQuest(evidence, quest.tags ?? [])) return null;

  const itemDisplayName = inferDeliveryItemDisplayName(evidence);
  if (!itemDisplayName) return null;
  return {itemDisplayName, holderEntityId, count: 1};
}

// LANGUAGE-REGEX-OK: adventure-arbiter cartridge-content routing for the implicit delivery-item placement step. Operates on the broker-emitted blueprint's `title` / `summary` / `playerFacingHook` / `quest.title` / `quest.summary` / `quest.goal_text` / `quest.tags` / `stage` titles — NOT raw player input. The Greenhaven Tier 8 cartridges are English+Russian content, and these tokens map blueprint vocabulary onto the canonical Greenhaven cartridge item names (`Sealed Envelope` / `Запечатанный конверт` / etc) so the arbiter can synthesise an implicit `ItemPlacement` when the broker forgot to add one. Carry-forward: extending `AdventureBlueprint` with a structured `implicitDeliveryItemName` field would let the broker emit the intent directly, retiring this heuristic.
const DELIVERY_QUEST_RE =
  /\b(deliver|delivery|courier|carry|bring|letter|envelope|parcel|package)\b|достав|переда|отнес|нести|письм|конверт|посылк/i;

// LANGUAGE-REGEX-OK: same arbiter cartridge-content allowlist as `DELIVERY_QUEST_RE`; matches the @-mention vocabulary the broker uses for delivery-item names so the arbiter can pick the cartridge item name from an explicit blueprint mention. Not player text.
const DELIVERY_ITEM_TOKEN_RE =
  /\b(envelope|letter|parcel|package|crate|box)\b|конверт|письм|посылк|ящик/i;

function looksLikeDeliveryQuest(text: string, tags: readonly string[]): boolean {
  if (
    tags.some(tag =>
      ['delivery', 'courier', 'quest-item', 'quest_item'].includes(
        tag.trim().toLowerCase(),
      ),
    )
  ) {
    return true;
  }
  return DELIVERY_QUEST_RE.test(text);
}

function inferDeliveryItemDisplayName(text: string): string | null {
  const mentioned = inferMentionedDeliveryItemName(text);
  if (mentioned) return mentioned;

  return matchDeliveryItemNameFromBlueprint(text);
}

// X-3 — split the delivery-item lookup into its own function so the
// `// LANGUAGE-REGEX-OK` annotation directly above each block of
// patterns sits inside the rule's 4-line lookback window. Each block
// matches the broker-emitted blueprint vocabulary onto the canonical
// Greenhaven Tier 8 cartridge item name; see the `DELIVERY_QUEST_RE`
// header for the full cartridge-content-routing rationale.
function matchDeliveryItemNameFromBlueprint(text: string): string | null {
  // LANGUAGE-REGEX-OK: cartridge-content routing — sealed-envelope / sealed-letter English blueprint tokens map to the Greenhaven `Sealed Envelope` / `Sealed Letter` cartridge items. Matches broker blueprint evidence, not player text.
  if (/sealed\s+envelope/i.test(text)) return 'Sealed Envelope';
  if (/sealed\s+letter/i.test(text)) return 'Sealed Letter';
  // LANGUAGE-REGEX-OK: cartridge-content routing — bare-English delivery-noun fallbacks; each token picks the canonical Greenhaven cartridge item name.
  if (/\benvelope\b/i.test(text)) return 'Sealed Envelope';
  if (/\bletter\b/i.test(text)) return 'Sealed Letter';
  if (/\bparcel\b/i.test(text)) return 'Delivery Parcel';
  if (/\bpackage\b/i.test(text)) return 'Delivery Package';
  // LANGUAGE-REGEX-OK: cartridge-content routing — remaining English crate/box fallbacks for the same cartridge delivery-item family.
  if (/\bcrate\b/i.test(text)) return 'Delivery Crate';
  if (/\bbox\b/i.test(text)) return 'Delivery Box';
  // LANGUAGE-REGEX-OK: cartridge-content routing — Russian sealed-envelope / sealed-letter inflections map to the `Запечатанный конверт` / `Запечатанное письмо` cartridge items.
  if (/запечатанн(?:ый|ого|ому|ым|ом|ую)?\s+конверт/i.test(text)) return 'Запечатанный конверт';
  if (/конверт/i.test(text)) return 'Запечатанный конверт';
  if (/запечатанн(?:ое|ого|ому|ым|ом|ую)?\s+письм[оа]?/i.test(text)) return 'Запечатанное письмо';
  // LANGUAGE-REGEX-OK: cartridge-content routing — remaining Russian fallbacks (`письмо` / `посылка` / `ящик`) for the same cartridge delivery-item family.
  if (/письм[оа]?/i.test(text)) return 'Запечатанное письмо';
  if (/посылк[ауи]?/i.test(text)) return 'Посылка';
  if (/ящик/i.test(text)) return 'Ящик для доставки';
  return null;
}

function inferMentionedDeliveryItemName(text: string): string | null {
  const mentionRe = /@([^@\n\r,.;:]{1,120})/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRe.exec(text)) !== null) {
    const name = match[1]?.replace(/\s+/g, ' ').trim();
    if (name && DELIVERY_ITEM_TOKEN_RE.test(name)) return name;
  }
  return null;
}

async function validateBlueprintWorldFacts(
  blueprint: AdventureBlueprint,
  playerId: number,
): Promise<AdventureArbiterVerdict | null> {
  const spawns = [
    ...(blueprint.suggestedQuest?.spawn_entities ?? []),
    ...(blueprint.standaloneSpawns ?? []),
  ];
  for (const spawn of spawns) {
    const verdict = await validateDynamicWorldFactSpawn(spawn, {playerId});
    if (!verdict.ok) {
      return {
        ok: false,
        reason: 'unsupported_world_fact',
        message: verdict.reason,
        details: verdict.suggestion,
      };
    }
  }
  return null;
}

async function adventureQuestGiverName(
  blueprint: AdventureBlueprint,
  playerId: number,
): Promise<string> {
  const quest = blueprint.suggestedQuest;
  if (quest?.source === 'player_goal') return displayNameForEntity(playerId);
  if (quest?.giverEntityId != null) return displayNameForEntity(quest.giverEntityId);
  if (quest?.sourceEntityId != null) return displayNameForEntity(quest.sourceEntityId);
  const currentLocationId = await currentLocationIdForPlayer(playerId);
  if (currentLocationId != null) return displayNameForEntity(currentLocationId);
  return displayNameForEntity(playerId);
}

async function linkSituationToExistingQuest(
  questId: number,
  blueprint: AdventureBlueprint,
  queue: AdventureQueueRow,
): Promise<void> {
  const quest = blueprint.suggestedQuest;
  if (!quest || (quest.mode ?? 'create_new') === 'create_new') return;
  const link = {
    queue_id: queue.id,
    adventure_kind: queue.adventureKind,
    mode: quest.mode ?? 'attach_existing',
    title: blueprint.title,
    summary: blueprint.summary,
    player_facing_hook: blueprint.playerFacingHook,
    bridge_summary: quest.bridgeSummary ?? null,
    to_stage: quest.toStage ?? null,
    pressure_type: blueprint.scenario?.pressureType ?? null,
    proximity: blueprint.scenario?.proximity ?? null,
    cause_sources: blueprint.scenario?.causeSources ?? [],
    clocks: blueprint.scenario?.clocks ?? [],
    spawned_names: (quest.spawn_entities ?? []).map(spawn => ({
      kind: spawn.kind,
      display_name: spawn.display_name,
      hidden_until_stage: spawn.hidden_until_stage ?? null,
    })),
  };
  await query(
    `UPDATE entities
        SET profile = jsonb_set(
          COALESCE(profile, '{}'::jsonb),
          '{situation_links}',
          -- M-6: safe_jsonb_array keeps the append shape stable when
          -- profile.situation_links is missing or non-array.
          safe_jsonb_array(profile->'situation_links') || jsonb_build_array($2::jsonb),
          true
        )
      WHERE id = $1
        AND kind = 'quest'`,
    [questId, JSON.stringify(link)],
  );
}

async function applyStandaloneSpawn(
  spawn: NonNullable<AdventureBlueprint['standaloneSpawns']>[number],
  ctx: ToolContext,
  extraTags: string[] = [],
): Promise<
  | {ok: true; data: unknown}
  | {ok: false; reason: AdventureArbiterReason; message: string}
> {
  const result = await dispatch(
    'create_entity',
    {
      kind: spawn.kind,
      display_name: spawn.display_name,
      summary: spawn.summary,
      profile: {
        ...(spawn.profile ?? {}),
        ...(spawn.hidden_until_stage
          ? {hidden_until_stage: spawn.hidden_until_stage}
          : {}),
      },
      tags: [
        'adventure',
        ...extraTags,
        ...(spawn.hidden_until_stage ? ['hidden'] : []),
        ...(spawn.tags ?? []),
      ],
    },
    ctx,
  );
  if (!result.ok) {
    return {
      ok: false,
      reason: 'tool_application_failed',
      message: result.error ?? 'create_entity failed',
    };
  }
  return {ok: true, data: result.data};
}

async function findDuplicateSpawn(
  blueprint: AdventureBlueprint,
): Promise<{
  kind: string;
  requestedName: string;
  existingId: number;
  existingName: string;
  score: number;
} | null> {
  type SpawnCandidate = {
    kind: string;
    display_name: string;
    source: 'encounter_enemy' | 'quest_spawn' | 'standalone_spawn';
  };
  const spawns: SpawnCandidate[] = [
    ...(blueprint.suggestedQuest?.spawn_entities ?? []).map(spawn => ({
      ...spawn,
      source: 'quest_spawn' as const,
    })),
    ...(blueprint.standaloneSpawns ?? []).map(spawn => ({
      ...spawn,
      source: 'standalone_spawn' as const,
    })),
    ...(blueprint.encounterPlan?.enemies ?? []).map(enemy => ({
      kind: 'person',
      display_name: enemy.display_name,
      source: 'encounter_enemy' as const,
    })),
  ];
  const requested = new Map<string, SpawnCandidate>();
  for (const spawn of spawns) {
    const key = `${spawn.kind}:${spawn.display_name.trim().toLowerCase()}`;
    const previous = requested.get(key);
    if (previous && !isQuestEncounterOverlap(previous, spawn)) {
      return {
        kind: spawn.kind,
        requestedName: spawn.display_name,
        existingId: 0,
        existingName: spawn.display_name,
        score: 1,
      };
    }
    requested.set(key, spawn);
    // ARCH-19 pre-Phase-4 hardening — read the normalized
    // `entities.dynamic_origin` column so runtime-spawn detection
    // does not consult the soon-to-be-dropped `profile.origin`
    // JSONB key.
    const rows = await query<{
      id: number;
      display_name: string;
      tags: string[] | null;
      profile: Record<string, unknown> | null;
      dynamic_origin: boolean | null;
    }>(
      `SELECT id, display_name, tags, profile, dynamic_origin
         FROM entities WHERE kind = $1`,
      [spawn.kind],
    );
    for (const row of rows.rows) {
      if (isRuntimeSpawn(row)) continue;
      const score = similarityScore(spawn.display_name, row.display_name);
      if (score >= 0.92) {
        return {
          kind: spawn.kind,
          requestedName: spawn.display_name,
          existingId: Number(row.id),
          existingName: row.display_name,
          score,
        };
      }
    }
  }
  return null;
}

function isQuestEncounterOverlap(
  a: {source: string},
  b: {source: string},
): boolean {
  return new Set([a.source, b.source]).size === 2 &&
    [a.source, b.source].includes('quest_spawn') &&
    [a.source, b.source].includes('encounter_enemy');
}

function isRuntimeSpawn(row: {
  tags: string[] | null;
  profile: Record<string, unknown> | null;
  dynamic_origin: boolean | null;
}): boolean {
  const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
  const profile = row.profile && typeof row.profile === 'object'
    ? row.profile
    : {};
  return (
    // ARCH-19 pre-Phase-4 hardening — prefer the normalized column
    // (0105) over the legacy `profile.origin === 'dynamic'` JSONB
    // read. Tags + adventure_queue_id + source_quest_id remain
    // runtime signals that Phase 4 does not touch.
    row.dynamic_origin === true ||
    tags.includes('dynamic') ||
    tags.includes('adventure') ||
    profile['adventure_queue_id'] != null ||
    profile['source_quest_id'] != null
  );
}

function readCreatedEntityId(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)['id'];
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function readQuestEntityId(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const raw = record['quest_id'] ?? record['quest_entity_id'];
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function readSpawnedEntityMap(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const spawned = (value as Record<string, unknown>)['spawned'];
  if (!spawned || typeof spawned !== 'object' || Array.isArray(spawned)) {
    return out;
  }
  for (const [name, rawId] of Object.entries(spawned)) {
    const id = typeof rawId === 'number' ? rawId : Number(rawId);
    if (Number.isInteger(id) && id > 0) {
      out.set(normalizeSpawnName(name), id);
    }
  }
  return out;
}

function normalizeSpawnName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function questItemLinkFromCreateEntityResult(
  value: unknown,
  placement: NonNullable<AdventureBlueprint['itemPlacements']>[number],
  queue: AdventureQueueRow,
): AdventureQuestItemLink | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const entityId = readPositiveId(record['id']);
  if (entityId == null) return null;
  const inventoryItem = asRecord(record['inventory_item']);
  return {
    entity_id: entityId,
    display_name:
      typeof record['display_name'] === 'string'
        ? record['display_name']
        : placement.itemDisplayName,
    item_id: readPositiveId(inventoryItem['item_id']),
    slug:
      typeof inventoryItem['slug'] === 'string' && inventoryItem['slug'].trim()
        ? inventoryItem['slug'].trim()
        : null,
    holder_entity_id:
      readPositiveId(inventoryItem['holder_entity_id']) ??
      placement.holderEntityId,
    placed_count:
      readPositiveId(inventoryItem['placed_count']) ?? placement.count,
    source: 'adventure_item_placement',
    queue_id: queue.id,
    adventure_kind: queue.adventureKind,
  };
}

async function currentLocationIdForPlayer(playerId: number): Promise<number | null> {
  const row = await query<{current_location_id: number | string | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const raw = row.rows[0]?.current_location_id;
  if (raw == null) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function stampQuestSpawnAsEncounterEnemy(
  entityId: number,
  opts: {
    queue: AdventureQueueRow;
    enemy: {display_name: string; role: string};
    blueprintTitle: string;
    encounterType: string;
    requiredVisibleRoll: boolean;
    currentLocationId: number | null;
    count: number;
  },
): Promise<void> {
  const profilePatch = {
    ...(opts.currentLocationId != null
      ? {home_id: String(opts.currentLocationId)}
      : {}),
    adventure_queue_id: String(opts.queue.id),
    encounter_type: opts.encounterType,
    combat_role: opts.enemy.role,
    count: opts.count,
    required_visible_roll: opts.requiredVisibleRoll,
    status: 'pending_visible_roll',
  };
  await query(
    `UPDATE entities
        SET summary = COALESCE(summary, $2),
            profile = COALESCE(profile, '{}'::jsonb) || $3::jsonb,
            tags = COALESCE(tags, ARRAY[]::text[]) || $4::text[]
      WHERE id = $1`,
    [
      entityId,
      `${opts.enemy.role} introduced by adventure encounter "${opts.blueprintTitle}".`,
      JSON.stringify(profilePatch),
      [
        'adventure',
        'encounter',
        opts.encounterType,
        sanitizeTag(opts.enemy.role),
      ],
    ],
  );
}

function encounterBudgetStats(
  budget: NonNullable<AdventureBlueprint['encounterPlan']>['budget'],
): {hp: number; ac: number} {
  switch (budget) {
    case 'hard':
      return {hp: 24, ac: 14};
    case 'medium':
      return {hp: 16, ac: 13};
    case 'easy':
      return {hp: 10, ac: 12};
    case 'trivial':
    default:
      return {hp: 6, ac: 11};
  }
}

function sanitizeTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'threat';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPositiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function ensureEncounterCombatFields(
  enemyId: number,
  stats: {currentHp: number; maxHp: number; armorClass: number},
): Promise<void> {
  const fields = [
    {
      key: 'current_hp',
      valueType: 'int',
      value: stats.currentHp,
      description: 'Adventure encounter current HP.',
    },
    {
      key: 'max_hp',
      valueType: 'int',
      value: stats.maxHp,
      description: 'Adventure encounter max HP.',
    },
    {
      key: 'armor_class',
      valueType: 'int',
      value: stats.armorClass,
      description: 'Adventure encounter armor class.',
    },
    {
      key: 'conditions',
      valueType: 'json',
      value: [],
      description: 'Adventure encounter combat conditions.',
    },
  ];
  for (const field of fields) {
    await query(
      `INSERT INTO runtime_fields
         (owner_entity_id, field_key, value_type, default_value, allowed_values,
          scope, scope_per_player, description)
       VALUES ($1, $2, $3, $4::jsonb, NULL, 'session', false, $5)
       ON CONFLICT (owner_entity_id, field_key) DO NOTHING`,
      [
        enemyId,
        field.key,
        field.valueType,
        JSON.stringify(field.value),
        field.description,
      ],
    );
    await query(
      `INSERT INTO runtime_values (field_id, value, source)
       SELECT id, default_value, 'adventure_encounter'
         FROM runtime_fields
        WHERE owner_entity_id = $1
          AND field_key = $2
       ON CONFLICT (field_id) DO NOTHING`,
      [enemyId, field.key],
    );
  }
  const statsRows = [
    ['STR', 10],
    ['DEX', 12],
    ['CON', 12],
    ['INT', 9],
    ['WIS', 10],
    ['CHA', 8],
  ] as const;
  for (const [stat, value] of statsRows) {
    await query(
      `INSERT INTO npc_stats (npc_entity_id, stat_key, base, current)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (npc_entity_id, stat_key) DO NOTHING`,
      [enemyId, stat, value],
    );
  }
}

function ungatedUnhookedLocation(
  blueprint: AdventureBlueprint,
): {display_name: string} | null {
  const spawns = [
    ...(blueprint.suggestedQuest?.spawn_entities ?? []),
    ...(blueprint.standaloneSpawns ?? []),
  ];
  for (const spawn of spawns) {
    if (spawn.kind !== 'location') continue;
    if (spawn.hidden_until_stage) continue;
    if (blueprint.playerFacingHook.includes(`@${spawn.display_name}`)) continue;
    return {display_name: spawn.display_name};
  }
  return null;
}
