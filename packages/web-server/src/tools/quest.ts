/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Quest tools — per-player progress on quest entities.
//
// Quests themselves are defined in entities[kind='quest'] (immutable
// catalog). Players advance through them via `player_quests` rows.

import {z} from 'zod';
import {
  activeCartridgeEntityPredicate,
} from '../cartridgeScope.js';
import {playerScopedChatPredicate} from '../chatHistoryScope.js';
import {query} from '../db.js';
import {insertQuestRewardMemory} from '../domain/memory/index.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import {emitFieldChange} from '../runtimeFieldEvents.js';
import {validateRuntimeFieldValue} from '../runtimeFieldValidation.js';
import {
  stringEdgeId,
  stringIntensityForCount,
  stringKindForCount,
  stringValenceForCount,
} from '../stringsContract.js';
import {
  projectEntityNormalizedColumns,
  stripRetiredProfileKeysForPersist,
  stripRetiredTagsForPersist,
} from '../entities/profileProjection.js';
import {cappedPathTakenExpr} from '../quest/pathTaken.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';
import {setCompanionState} from './companion.js';
import {
  emitPlayerInventoryEvents,
  materializeEntityInventoryItem,
  resolveInventoryItem,
} from './inventoryCommon.js';
import {applyMaterializersForTrigger} from './materializer.js';
import {applyPatchRaw} from './runtime.js';
import {addString, bandFor, readStrings} from './strings.js';
import {
  isLegacyCurrentPlayerToken,
  registerTool,
  resolveEntityId,
  resolvePlayerTarget,
  type ToolContext,
  ToolExecutionError,
} from './base.js';

export interface QuestTargetResolution {
  questId: number;
  resolutionSource: 'quest_id' | 'quest';
}

function readQuestStages(profile: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(profile['stages'])
    ? (profile['stages'] as Array<Record<string, unknown>>)
    : [];
}

function initialAccumulatedStateForStage(
  profile: Record<string, unknown>,
  stageId: string | null,
): Record<string, unknown> {
  if (!stageId) return {};
  const stage = readQuestStages(profile).find(s => s['id'] === stageId);
  const turns = Number(stage?.['turns_remaining']);
  if (Number.isInteger(turns) && turns > 0) {
    return {turns_remaining: turns};
  }
  return {};
}

async function loadQuestProfile(questId: number): Promise<Record<string, unknown>> {
  const questRow = await query<{profile: unknown}>(
    `SELECT profile FROM entities WHERE id = $1`,
    [questId],
  );
  const profile = questRow.rows[0]?.profile;
  return profile && typeof profile === 'object' && !Array.isArray(profile)
    ? (profile as Record<string, unknown>)
    : {};
}

async function questSourceSlug(questId: number): Promise<string | null> {
  const row = await query<{source_slug: string | null}>(
    `SELECT profile->>'source_slug' AS source_slug
       FROM entities
      WHERE id = $1
        AND kind = 'quest'`,
    [questId],
  );
  const slug = row.rows[0]?.source_slug?.trim();
  return slug ? slug : null;
}

async function applyQuestStageMaterializersForTool(
  ctx: ToolContext,
  playerId: number,
  questId: number,
): Promise<void> {
  const sourceSlug = await questSourceSlug(questId);
  if (!sourceSlug) return;
  await applyMaterializersForTrigger(
    {...ctx, playerId},
    'quest_stage',
    {sourceSlug},
  );
}

async function emitQuestCard(
  sessionId: string,
  playerId: number,
  turnId: string | undefined,
  type: 'quest:created' | 'quest:started' | 'quest:advanced' | 'quest:completed',
  questId: number,
  extra: Record<string, unknown>,
) {
  const r = await query<{display_name: string; summary: string | null; tags: string[] | null}>(
    `SELECT display_name, summary, tags FROM entities WHERE id = $1`,
    [questId],
  );
  const meta = r.rows[0];
  if (!meta) return;
  await emitGuiEventForSession(sessionId, type, {
    questId,
    title: meta.display_name,
    summary: meta.summary,
    tags: meta.tags ?? [],
    ...extra,
  }, {
    playerId,
    turnId: turnId ?? null,
    phase: 'mutation',
  });
}

export async function resolveQuestTarget(args: {
  quest_id?: number | null;
  quest?: string | number | null;
  player_id?: number | null;
}): Promise<QuestTargetResolution> {
  let questId: number | null = null;
  let resolutionSource: QuestTargetResolution['resolutionSource'] = 'quest';
  const playerId =
    Number.isInteger(args.player_id) && Number(args.player_id) > 0
      ? Number(args.player_id)
      : null;
  const cartridgeId =
    playerId != null ? await resolveActivePlayerCartridgeId(playerId) : null;

  if (Number.isInteger(args.quest_id) && Number(args.quest_id) > 0) {
    questId = Number(args.quest_id);
    resolutionSource = 'quest_id';
  } else if (args.quest != null && String(args.quest).trim().length > 0) {
    questId = await resolveQuestIdInCartridge(args.quest, cartridgeId);
    resolutionSource = 'quest';
  }

  if (questId == null) {
    throw new ToolExecutionError('quest_id or quest is required', {
      rejected: true,
      suggestion: {quest_id: '<numeric quest entity id>', reason: 'use_quest_id'},
    });
  }

  const questRow = await query<{id: number; kind: string}>(
    `SELECT id, kind
       FROM entities
      WHERE id = $1
        ${cartridgeId != null ? `AND ${activeCartridgeEntityPredicate('entities', '$2')}` : ''}
      LIMIT 1`,
    cartridgeId != null ? [questId, cartridgeId] : [questId],
  );
  const row = questRow.rows[0];
  if (!row || row.kind !== 'quest') {
    throw new ToolExecutionError(`entity ${questId} is not an active-cartridge quest`, {
      rejected: true,
      suggestion: {quest_id: '<numeric quest entity id>', reason: 'target_must_be_quest'},
    });
  }

  return {questId, resolutionSource};
}

async function resolveQuestIdInCartridge(
  input: string | number,
  cartridgeId: string | null,
): Promise<number | null> {
  if (typeof input === 'number') return input;
  const trimmed = input.trim();
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && numeric > 0) return numeric;
  if (cartridgeId == null) return await resolveEntityId(trimmed);
  const r = await query<{id: number}>(
    `SELECT id
       FROM entities
      WHERE kind = 'quest'
        AND display_name = $1
        AND ${activeCartridgeEntityPredicate('entities', '$2')}
      ORDER BY id
      LIMIT 1`,
    [trimmed, cartridgeId],
  );
  return r.rows[0]?.id ?? null;
}

// Spec 38 follow-up — dynamic quest creation. NPCs assign tasks
// in dialogue ("find the lampwright", "bring me proof") that should
// land as real, tracked quests. Without this tool, every NPC-issued
// errand evaporates into prose. Quest entities created here use
// kind='quest' and tag 'dynamic' so the cartridge's authored quests
// remain distinguishable from runtime-spawned ones.
const CreateQuestArgs = z.object({
  /** Player-facing title. 4–80 chars. */
  title: z.string().min(4).max(80),
  /** 1-2 sentence description; surfaces in QuestPanel. */
  summary: z.string().min(8).max(400),
  /** NPC display_name issuing the quest (or self-issuing). */
  giver: z.string(),
  /** Who's doing the work. Omit for the active player. For self-issued
   *  NPC plans (Mikka decides she'll find a missing lampwright on her
   *  own) pass the NPC's display_name. */
  beneficiary: z.string().optional(),
  /** Concrete success condition phrased so the broker can later
   *  decide complete_quest vs advance_quest. E.g. "find the silent
   *  lampwright in Quickgrin Lane and report back to Mikka". If omitted
   *  the tool derives a conservative player-facing goal from title,
   *  summary, first stage, giver/beneficiary, and recent context. */
  goal_text: z.string().max(600).optional(),
  /** Optional ordered stage list. If omitted: single implicit stage
   *  "open" → quest auto-advances on complete_quest. */
  stages: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().min(2).max(120),
        next_stage: z.string().optional(),
      }),
    )
    .max(8)
    .optional(),
  /** Optional reward block; same shape as cartridge quests. */
  rewards: z
    .object({
      xp: z.number().int().min(0).max(2000).optional(),
      strings: z
        .array(
          z.object({npc: z.string(), delta: z.number().int().min(-3).max(3)}),
        )
        .max(5)
        .optional(),
    })
    .optional(),
  /** Tags surfaced via entity i18n / for narrator filtering. */
  tags: z.array(z.string().max(40)).max(8).default([]),
  /** If true (default), immediately call start_quest for the
   *  beneficiary so the QuestPanel shows it on the next turn. */
  auto_start: z.boolean().default(true),
  /** Spec 38 follow-up — atomic batch-spawn of supporting entities.
   *  When the quest implies new places, NPCs, items or scenes, list
   *  them here and they get inserted in the SAME tool call as the
   *  quest. The returned `spawned` map (name → entity_id) lets the
   *  caller @-mention the new entities in the same narrate that
   *  announces the quest. Each entry mirrors create_entity args. */
  spawn_entities: z
    .array(
      z.object({
        kind: z.enum(['location', 'scene', 'item', 'person', 'event', 'service']),
        display_name: z.string().min(1).max(120),
        summary: z.string().max(400).optional(),
        tags: z.array(z.string().max(40)).max(8).optional(),
        profile: z.record(z.unknown()).optional(),
        /**
         * Spec 38 follow-up — gate the entity behind a quest stage.
         * While the quest's current stage hasn't reached this id, the
         * entity is HIDDEN: not in turnContext preamble's nearby/exits
         * lists, no `@`-mention click → travel, no item interaction.
         * advance_quest(to_stage=<id>) reveals all entities whose
         * hidden_until_stage matches. Use null/omit for entities the
         * player can interact with from the moment the quest starts.
         */
        hidden_until_stage: z.string().min(1).max(40).optional(),
      }),
    )
    .max(8)
    .optional(),
});

interface CreateQuestInput {
  title: string;
  summary: string;
  giver: string;
  beneficiary?: string;
  goal_text?: string;
  stages?: Array<{title?: string}>;
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampGoalText(text: string): string {
  const compact = compactText(text);
  if (compact.length <= 600) return compact;
  return compact.slice(0, 597).trimEnd() + '...';
}

async function displayNameForEntity(entityId: number): Promise<string | null> {
  const r = await query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [entityId],
  );
  return r.rows[0]?.display_name ?? null;
}

function readSpawnedEntityIds(profile: Record<string, unknown>): number[] {
  const spawned = profile['spawned_entities'];
  if (!spawned || typeof spawned !== 'object' || Array.isArray(spawned)) {
    return [];
  }
  return Object.values(spawned as Record<string, unknown>)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0);
}

async function findExactSpawnEntity(
  kind: string,
  displayName: string,
): Promise<number | null> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM entities
      WHERE kind = $1
        AND LOWER(display_name) = LOWER($2)
      ORDER BY id
      LIMIT 1`,
    [kind, displayName],
  );
  return r.rows[0]?.id ?? null;
}

async function stampSpawnedEntitiesWithQuest(
  questId: number,
  spawned: Record<string, number>,
): Promise<void> {
  const spawnedIds = Object.values(spawned)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0);
  if (spawnedIds.length === 0) return;
  await query(
    `UPDATE entities
        SET profile = jsonb_set(
              COALESCE(profile, '{}'::jsonb),
              '{source_quest_id}',
              to_jsonb($2::text),
              true
            )
      WHERE id = ANY($1::bigint[])`,
    [spawnedIds, String(questId)],
  );
}

async function revealEntitiesForQuestStage(
  ctx: ToolContext,
  questId: number,
  stageId: string | null,
): Promise<number> {
  if (!stageId) return 0;
  const questRow = await query<{profile: Record<string, unknown> | null}>(
    `SELECT profile
       FROM entities
      WHERE id = $1
        AND kind = 'quest'`,
    [questId],
  );
  const profile = questRow.rows[0]?.profile ?? {};
  const spawnedIds = readSpawnedEntityIds(profile);
  const reveal = await query<{id: number; display_name: string}>(
    `UPDATE entities
        SET profile = profile - 'hidden_until_stage',
            tags = array_remove(tags, 'hidden')
      WHERE profile->>'hidden_until_stage' = $2
        AND (
          (array_length($1::bigint[], 1) IS NOT NULL AND id = ANY($1::bigint[]))
          OR profile->>'source_quest_id' = $3
        )
      RETURNING id, display_name`,
    [spawnedIds, stageId, String(questId)],
  );
  for (const ent of reveal.rows) {
    await emitGuiEventForSession(ctx.sessionId, 'entity:revealed', {
      entityId: ent.id,
      entityName: ent.display_name,
      stageId,
      questId,
    }, {
      playerId: ctx.playerId,
      turnId: ctx.turnId ?? null,
      phase: 'mutation',
    });
  }
  return reveal.rowCount ?? 0;
}

async function loadRecentQuestContext(
  sessionId: string,
  playerId: number,
): Promise<string | null> {
  const r = await query<{text: string}>(
    `SELECT cm.text
       FROM chat_messages cm
      WHERE cm.session_id = $1
        AND cm.tone = 'player'
        AND cm.text <> ''
        AND ${playerScopedChatPredicate('cm', 2)}
      ORDER BY id DESC
      LIMIT 1`,
    [sessionId, playerId],
  );
  const text = compactText(r.rows[0]?.text ?? '');
  if (!text) return null;
  return text.length > 160 ? text.slice(0, 157).trimEnd() + '...' : text;
}

async function deriveGoalText(
  args: CreateQuestInput,
  ctx: {sessionId: string; playerId: number},
  giverId: number,
  beneficiaryId: number,
): Promise<{goalText: string; generated: boolean}> {
  const explicit = compactText(args.goal_text ?? '');
  if (explicit.length >= 8) {
    return {goalText: clampGoalText(explicit), generated: false};
  }

  const giverName = (await displayNameForEntity(giverId)) ?? args.giver;
  const beneficiaryName =
    beneficiaryId === ctx.playerId
      ? null
      : (await displayNameForEntity(beneficiaryId)) ?? args.beneficiary ?? null;
  const firstStageTitle = compactText(args.stages?.[0]?.title ?? '');
  const stagePart =
    firstStageTitle && firstStageTitle.toLowerCase() !== 'open'
      ? ` - ${firstStageTitle}`
      : '';
  const recent = await loadRecentQuestContext(ctx.sessionId, ctx.playerId);
  const recentPart = recent ? ` - ${recent}` : '';
  const beneficiaryPart =
    beneficiaryName && beneficiaryName !== giverName
      ? ` -> ${beneficiaryName}`
      : '';
  const generated = clampGoalText(
    `${args.title} (${giverName}${beneficiaryPart}): ${args.summary}${stagePart}${recentPart}`,
  );
  return {
    goalText:
      generated.length >= 8
        ? generated
        : clampGoalText(`${args.title}: ${args.summary}`),
    generated: true,
  };
}

registerTool({
  name: 'create_quest',
  description:
    'goal_text is optional; when omitted, the tool derives and returns a deterministic player-facing goal from title, summary, stage, giver, beneficiary, and recent context. ' +
    "Spawn a NEW quest entity at runtime when an NPC assigns a task in dialogue (or commits to one themselves). REQUIRED whenever an NPC says \"find X\", \"bring me Y\", \"go check Z\" — without this call the promise vanishes after the bubble. Omit beneficiary for player-bound quests, or pass the NPC's display_name for self-issued plans the NPC tracks alone. auto_start=true (default) immediately marks the quest active.",
  paramsSchema: CreateQuestArgs,
  async execute(args, ctx) {
    const giverId = await resolveEntityId(args.giver);
    if (giverId == null) throw new Error(`unknown giver: ${args.giver}`);
    // Omitted beneficiary means the active player for this session.
    const beneficiary = args.beneficiary;
    let beneficiaryId: number | null;
    if (beneficiary == null || isLegacyCurrentPlayerToken(beneficiary)) {
      beneficiaryId = ctx.playerId;
    } else {
      beneficiaryId = await resolveEntityId(beneficiary, {playerId: ctx.playerId});
    }
    if (beneficiaryId == null) {
      throw new Error(`unknown beneficiary: ${beneficiary}`);
    }
    const {goalText, generated: goalTextGenerated} = await deriveGoalText(
      args,
      ctx,
      giverId,
      beneficiaryId,
    );

    // Spec 38 follow-up — spawn supporting entities BEFORE the quest
    // row exists, in parallel via Promise.all. The returned map gets
    // attached to the quest's profile.spawned_entities so the
    // narrator can @-mention them in the same prose beat.
    const spawned: Record<string, number> = {};
    const spawnedInventoryItems: Record<string, unknown> = {};
    if (args.spawn_entities && args.spawn_entities.length > 0) {
      const inserts = await Promise.all(
        args.spawn_entities.map(async spec => {
          // Encode the gate inline in profile so other readers
          // (turnContext, travel resolver, click handler) can check
          // without joining tables.
          const profile = {
            ...(spec.profile ?? {}),
            ...(spec.hidden_until_stage
              ? {hidden_until_stage: spec.hidden_until_stage}
              : {}),
          };
          const tags = [
            ...(spec.tags ?? []),
            'dynamic',
            'spawned-with-quest',
            ...(spec.hidden_until_stage ? ['hidden'] : []),
          ];
          const existingId = await findExactSpawnEntity(
            spec.kind,
            spec.display_name,
          );
          if (existingId != null) {
            // ARCH-19 Phase 4 (migrations 0123/0124) — the existing row
            // already carries authoritative `cartridge_id` and
            // `dynamic_origin` column values. Merging the duplicate-spawn
            // payload must NOT downgrade those (post-strip, tags no
            // longer contain `'dynamic'` and the JSONB origin key is
            // gone, so the previous OR-on-legacy recompute would flip
            // dynamic_origin to false and trip
            // `entities_cartridge_id_required_ck`). Only refresh the
            // profile + topology_parent_id; cartridge_id only upgrades
            // when the incoming payload provides one.
            await query(
              `UPDATE entities
                  SET cartridge_id = COALESCE(
                        NULLIF(
                          TRIM((COALESCE(profile, '{}'::jsonb) || $2::jsonb)->>'cartridge_id'),
                          ''
                        ),
                        cartridge_id
                      ),
                      topology_parent_id = (
                        SELECT inner_e.id
                          FROM entities inner_e
                         WHERE inner_e.id = safe_to_bigint(
                                 (COALESCE(profile, '{}'::jsonb) || $2::jsonb)->>'topology_parent_id'
                               )
                           AND inner_e.kind IN ('location', 'district')
                      ),
                      profile = (COALESCE(profile, '{}'::jsonb) || $2::jsonb)
                                  - ARRAY['cartridge_id', 'topology_parent_id', 'origin']::text[],
                      updated_at = now()
                WHERE id = $1`,
              [existingId, JSON.stringify(profile)],
            );
            const inventoryItem = await materializeEntityInventoryItem({query}, {
              entityId: existingId,
              kind: spec.kind,
              displayName: spec.display_name,
              profile,
              tags,
            });
            return {id: existingId, inventoryItem};
          }
          const projected = projectEntityNormalizedColumns({profile, tags});
          const profileForPersist = stripRetiredProfileKeysForPersist(profile);
          const tagsForPersist = stripRetiredTagsForPersist(tags);
          const inserted = await query<{id: number}>(
            `INSERT INTO entities (
               kind, display_name, summary, profile, tags,
               cartridge_id, topology_parent_id, dynamic_origin
             )
               VALUES (
                 $1, $2, $3, $4, $5,
                 $6,
                 (SELECT inner_e.id FROM entities inner_e
                    WHERE inner_e.id = $7::bigint
                      AND inner_e.kind IN ('location', 'district')),
                 $8
               )
             RETURNING id`,
            [
              spec.kind,
              spec.display_name,
              spec.summary ?? null,
              JSON.stringify(profileForPersist),
              tagsForPersist,
              projected.cartridge_id,
              projected.topology_parent_id,
              projected.dynamic_origin,
            ],
          );
          const id = inserted.rows[0]!.id;
          const inventoryItem = await materializeEntityInventoryItem({query}, {
            entityId: id,
            kind: spec.kind,
            displayName: spec.display_name,
            profile,
            tags,
          });
          return {id, inventoryItem};
        }),
      );
      for (let i = 0; i < args.spawn_entities.length; i++) {
        const spec = args.spawn_entities[i]!;
        const id = inserts[i]!.id;
        spawned[spec.display_name] = id;
        if (inserts[i]!.inventoryItem) {
          spawnedInventoryItems[spec.display_name] = inserts[i]!.inventoryItem;
        }
      }
    }

    // Stage tracking: default single 'open' stage so advance/complete
    // work without authoring stages on every dynamic quest.
    const stages =
      args.stages && args.stages.length > 0
        ? args.stages
        : [{id: 'open', title: 'Open'}];
    const profile: Record<string, unknown> = {
      stages,
      goal: goalText,
      giver_entity_id: giverId,
      beneficiary_entity_id: beneficiaryId,
      origin: 'dynamic',
    };
    if (args.rewards) profile['rewards'] = args.rewards;
    if (Object.keys(spawned).length > 0) profile['spawned_entities'] = spawned;

    // Insert as kind='quest' with BIGSERIAL id auto-allocated. Tag
    // 'dynamic' makes runtime-spawned quests grep-distinguishable
    // from cartridge-authored ones for diagnostics + filtering.
    const questTags = ['quest', 'dynamic', ...(args.tags ?? [])];
    const questProjected = projectEntityNormalizedColumns({
      profile,
      tags: questTags,
    });
    const questProfileForPersist = stripRetiredProfileKeysForPersist(profile);
    const questTagsForPersist = stripRetiredTagsForPersist(questTags);
    const inserted = await query<{id: number}>(
      `INSERT INTO entities (
         kind, display_name, summary, profile, tags,
         cartridge_id, topology_parent_id, dynamic_origin
       )
         VALUES (
           'quest', $1, $2, $3, $4,
           $5,
           (SELECT inner_e.id FROM entities inner_e
              WHERE inner_e.id = $6::bigint
                AND inner_e.kind IN ('location', 'district')),
           $7
         )
       RETURNING id`,
      [
        args.title,
        args.summary,
        JSON.stringify(questProfileForPersist),
        questTagsForPersist,
        questProjected.cartridge_id,
        questProjected.topology_parent_id,
        questProjected.dynamic_origin,
      ],
    );
    const questId = inserted.rows[0]!.id;
    await stampSpawnedEntitiesWithQuest(questId, spawned);

    let started = false;
    let currentStageId: string | null = null;
    if (args.auto_start) {
      const firstStage = stages[0]?.id ?? 'open';
      const initialAccumulatedState = initialAccumulatedStateForStage(
        profile,
        firstStage,
      );
      // Same UPSERT shape as start_quest.
      await query(
        `INSERT INTO player_quests (
           player_id, quest_entity_id, status, current_phase,
           current_stage_id, accumulated_state, started_at
         )
         VALUES ($1, $2, 'active', 1, $3, $4::jsonb, now())
         ON CONFLICT (player_id, quest_entity_id) DO NOTHING`,
        [
          beneficiaryId,
          questId,
          firstStage,
          JSON.stringify(initialAccumulatedState),
        ],
      );
      started = true;
      currentStageId = firstStage;
      await revealEntitiesForQuestStage(ctx, questId, firstStage);
    }

    // Emit a card-friendly event for the UI's SystemEvent feed.
    const giverRow = await query<{display_name: string}>(
      `SELECT display_name FROM entities WHERE id = $1`,
      [giverId],
    );
    await emitQuestCard(ctx.sessionId, ctx.playerId, ctx.turnId, 'quest:created', questId, {
      giverId,
      giverName: giverRow.rows[0]?.display_name ?? null,
      beneficiaryId,
      goal: goalText,
      rewards: args.rewards ?? null,
      autoStarted: started,
    });

    return {
      quest_id: questId,
      giver_entity_id: giverId,
      beneficiary_entity_id: beneficiaryId,
      started,
      current_stage_id: currentStageId,
      origin: 'dynamic',
      goal_text: goalText,
      goal_text_generated: goalTextGenerated,
      spawned,
      ...(Object.keys(spawnedInventoryItems).length > 0
        ? {spawned_inventory_items: spawnedInventoryItems}
        : {}),
    };
  },
});

const StartQuestArgs = z.object({
  quest_id: z.number().int().positive().optional(),
  /** Legacy display-name/string target. Prefer quest_id. */
  quest: z.union([z.string(), z.number()]).optional(),
  player_id: z.number().int().positive().optional(),
  /** Legacy string target. Prefer player_id or omit for current player. */
  player: z.string().optional(),
});

registerTool({
  name: 'start_quest',
  description:
    "Mark a quest as 'active' for the player. Prefer quest_id; legacy quest title/id strings still work. Idempotent: re-running on an active quest is a no-op. Defaults the player to the current session.",
  paramsSchema: StartQuestArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    const {questId, resolutionSource} = await resolveQuestTarget({
      ...args,
      player_id: playerId,
    });

    const existing = await query<{
      status: string;
      current_phase: number | null;
      current_stage_id: string | null;
    }>(
      `SELECT status, current_phase, current_stage_id
         FROM player_quests
        WHERE player_id = $1 AND quest_entity_id = $2`,
      [playerId, questId],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      const terminal = row.status === 'completed' || row.status === 'failed';
      return {
        player_id: playerId,
        quest_id: questId,
        quest_resolution: resolutionSource,
        status: row.status,
        current_phase: row.current_phase,
        current_stage_id: row.current_stage_id,
        changed: false,
        no_op: true,
        reason: terminal ? 'terminal' : 'already_active',
      };
    }

    // Spec 21 — read profile.stages[0].id so we initialise the new
    // stage-tracking column on first start. Quests authored without
    // stages keep current_stage_id = NULL (legacy behaviour).
    const profile = await loadQuestProfile(questId);
    const stages = readQuestStages(profile);
    const firstStageId =
      stages.length > 0 && typeof stages[0]?.['id'] === 'string'
        ? (stages[0]!['id'] as string)
        : null;
    const initialAccumulatedState = initialAccumulatedStateForStage(
      profile,
      firstStageId,
    );

    const started = await query<{
      status: string;
      current_phase: number | null;
      current_stage_id: string | null;
    }>(
      `INSERT INTO player_quests (
         player_id, quest_entity_id, status, current_phase,
         current_stage_id, accumulated_state, started_at
       )
       VALUES ($1, $2, 'active', 1, $3, $4::jsonb, now())
       ON CONFLICT (player_id, quest_entity_id) DO NOTHING
       RETURNING status, current_phase, current_stage_id`,
      [
        playerId,
        questId,
        firstStageId,
        JSON.stringify(initialAccumulatedState),
      ],
    );
    const state = started.rows[0] ?? {
      status: 'active',
      current_phase: 1,
      current_stage_id: firstStageId,
    };
    await revealEntitiesForQuestStage(ctx, questId, firstStageId);
    await emitQuestCard(ctx.sessionId, ctx.playerId, ctx.turnId, 'quest:started', questId, {playerId});
    await applyQuestStageMaterializersForTool(ctx, playerId, questId);
    return {
      player_id: playerId,
      quest_id: questId,
      quest_resolution: resolutionSource,
      status: state.status,
      current_phase: state.current_phase,
      current_stage_id: state.current_stage_id,
      changed: true,
      no_op: false,
    };
  },
});

const AdvanceQuestArgs = z.object({
  quest_id: z.number().int().positive().optional(),
  /** Legacy display-name/string target. Prefer quest_id. */
  quest: z.union([z.string(), z.number()]).optional(),
  /** Spec 21 (preferred): target stage id from quest.profile.stages[].id. */
  to_stage: z.string().optional(),
  /** Legacy numeric phase. Preserved for backward compat with cartridges
   *  that haven't migrated to the stage schema. */
  to_phase: z.number().int().min(1).optional(),
  player_id: z.number().int().positive().optional(),
  /** Legacy string target. Prefer player_id or omit for current player. */
  player: z.string().optional(),
});

registerTool({
  name: 'advance_quest',
  description:
    "Move a player's quest forward. Prefer quest_id and to_stage with the next stage id from quest.profile.stages; falls back to legacy quest/to_phase when needed.",
  paramsSchema: AdvanceQuestArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    const {questId, resolutionSource} = await resolveQuestTarget({
      ...args,
      player_id: playerId,
    });

    const existingState = await query<{
      current_phase: number;
      status: string;
      current_stage_id: string | null;
    }>(
      `SELECT current_phase, status, current_stage_id
         FROM player_quests
        WHERE player_id = $1 AND quest_entity_id = $2`,
      [playerId, questId],
    );
    if (existingState.rows.length === 0) {
      throw new Error('quest not started for this player; call start_quest first');
    }
    const current = existingState.rows[0]!;
    if (current.status !== 'active') {
      return {
        player_id: playerId,
        quest_id: questId,
        quest_resolution: resolutionSource,
        current_phase: current.current_phase,
        status: current.status,
        current_stage_id: current.current_stage_id,
        entities_revealed: 0,
        changed: false,
        no_op: true,
        reason:
          current.status === 'completed' || current.status === 'failed'
            ? 'quest_already_terminal'
            : 'quest_not_active',
      };
    }

    // Resolve target stage id. Priority:
    //   1. Explicit to_stage.
    //   2. to_phase mapped via quest.profile.stages (1-indexed).
    //   3. quest.profile.stages[ position(current_stage) ].next_stage.
    let targetStageId: string | null = args.to_stage ?? null;
    let nextPhase: number | undefined;
    if (!targetStageId && (args.to_phase != null || args.to_stage == null)) {
      const profileRow = await query<{profile: unknown; current_stage_id: string | null}>(
        `SELECT e.profile, pq.current_stage_id
           FROM entities e
           LEFT JOIN player_quests pq
             ON pq.quest_entity_id = e.id AND pq.player_id = $2
          WHERE e.id = $1`,
        [questId, playerId],
      );
      const profile = (profileRow.rows[0]?.profile ?? {}) as Record<string, unknown>;
      const stages = readQuestStages(profile);
      if (args.to_phase != null && stages.length > 0) {
        const idx = args.to_phase - 1;
        if (idx >= 0 && idx < stages.length) {
          targetStageId = (stages[idx]!['id'] as string) ?? null;
        }
        nextPhase = args.to_phase;
      } else if (args.to_phase == null && stages.length > 0) {
        const cur = profileRow.rows[0]?.current_stage_id;
        const curIdx = stages.findIndex(s => s['id'] === cur);
        const nextStage =
          curIdx >= 0 && stages[curIdx]?.['next_stage'];
        if (typeof nextStage === 'string') targetStageId = nextStage;
      }
    }
    if (nextPhase == null && args.to_phase != null) nextPhase = args.to_phase;
    const targetAccumulatedState =
      targetStageId != null
        ? initialAccumulatedStateForStage(
            await loadQuestProfile(questId),
            targetStageId,
          )
        : {};

    const stageUnchanged =
      targetStageId == null || targetStageId === current.current_stage_id;
    const phaseUnchanged =
      nextPhase == null || nextPhase === current.current_phase;
    if (stageUnchanged && phaseUnchanged) {
      return {
        player_id: playerId,
        quest_id: questId,
        quest_resolution: resolutionSource,
        current_phase: current.current_phase,
        status: current.status,
        current_stage_id: current.current_stage_id,
        entities_revealed: 0,
        changed: false,
        no_op: true,
        reason: targetStageId == null && nextPhase == null
          ? 'no_target_change'
          : 'already_at_target',
      };
    }

    const r = await query<{current_phase: number; status: string; current_stage_id: string | null}>(
      `UPDATE player_quests
          SET current_phase = COALESCE($3, current_phase),
              current_stage_id = COALESCE($4, current_stage_id),
              accumulated_state = CASE
                WHEN $5::boolean THEN
                  ((COALESCE(accumulated_state, '{}'::jsonb)
                      - 'turns_remaining'
                      - 'timeout_failure'
                      - 'pending_choice'
                      - 'awaiting_choice')
                    || $6::jsonb)
                ELSE accumulated_state
              END,
              path_taken = ${cappedPathTakenExpr(
                "jsonb_build_object('at', now()::text, 'stage', COALESCE($4, current_stage_id))",
              )}
        WHERE player_id = $1
          AND quest_entity_id = $2
          AND status = 'active'
        RETURNING current_phase, status, current_stage_id`,
      [
        playerId,
        questId,
        nextPhase ?? null,
        targetStageId,
        targetStageId != null,
        JSON.stringify(targetAccumulatedState),
      ],
    );
    if (r.rows.length === 0) {
      return {
        player_id: playerId,
        quest_id: questId,
        quest_resolution: resolutionSource,
        current_phase: current.current_phase,
        status: current.status,
        current_stage_id: current.current_stage_id,
        entities_revealed: 0,
        changed: false,
        no_op: true,
        reason: 'quest_not_active',
      };
    }

    // Spec 38 follow-up — reveal any entities gated behind THIS stage.
    // Entities created via create_quest's spawn_entities[] with
    // hidden_until_stage set get their flag cleared (and 'hidden' tag
    // stripped) when the quest reaches the matching stage. They become
    // visible in turnContext preamble + clickable for travel.
    let revealedCount = 0;
    const reachedStage = r.rows[0]!.current_stage_id;
    if (reachedStage) {
      revealedCount = await revealEntitiesForQuestStage(ctx, questId, reachedStage);
    }

    await emitQuestCard(ctx.sessionId, ctx.playerId, ctx.turnId, 'quest:advanced', questId, {
      playerId,
      stageId: reachedStage,
      phase: r.rows[0]!.current_phase,
      entities_revealed: revealedCount,
    });
    await applyQuestStageMaterializersForTool(ctx, playerId, questId);
    return {
      player_id: playerId,
      quest_id: questId,
      quest_resolution: resolutionSource,
      ...r.rows[0]!,
      entities_revealed: revealedCount,
      changed: true,
      no_op: false,
    };
  },
});

const CompleteQuestArgs = z.object({
  quest_id: z.number().int().positive().optional(),
  /** Legacy display-name/string target. Prefer quest_id. */
  quest: z.union([z.string(), z.number()]).optional(),
  outcome: z.enum(['completed', 'failed']).default('completed'),
  player_id: z.number().int().positive().optional(),
  /** Legacy string target. Prefer player_id or omit for current player. */
  player: z.string().optional(),
});

registerTool({
  name: 'complete_quest',
  description:
    'Finalise a quest as completed or failed. Prefer quest_id; legacy quest title/id strings still work.',
  paramsSchema: CompleteQuestArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    const {questId, resolutionSource} = await resolveQuestTarget({
      ...args,
      player_id: playerId,
    });

    const before = await query<{status: string}>(
      `SELECT status
         FROM player_quests
        WHERE player_id = $1 AND quest_entity_id = $2`,
      [playerId, questId],
    );
    if (before.rows.length === 0)
      throw new Error('quest not started for this player');
    const previousStatus = before.rows[0]!.status;
    if (previousStatus === 'completed' || previousStatus === 'failed') {
      return {
        player_id: playerId,
        quest_id: questId,
        quest_resolution: resolutionSource,
        outcome: previousStatus,
        requested_outcome: args.outcome,
        rewards_applied: {},
        sex_move_fired: null,
        changed: false,
        no_op: true,
        reason:
          previousStatus === args.outcome
            ? 'already_terminal'
            : 'terminal_outcome_conflict',
      };
    }

    const updated = await query<{new_status: string}>(
      `UPDATE player_quests
          SET status = $3,
              completed_at = CASE
                WHEN $3 = 'completed' THEN now()
                ELSE completed_at
              END
        WHERE player_id = $1
          AND quest_entity_id = $2
          AND status = 'active'
        RETURNING status AS new_status`,
      [playerId, questId, args.outcome],
    );

    // Spec 21 — apply reward block. Guard against double-reward from
    // concurrent auto-complete in questEngine (GH-BUG-098): if the
    // UPDATE found no row (questEngine already completed it), skip.
    const weMadeTheChange = updated.rows.length > 0;
    let rewardsApplied: Record<string, unknown> = {};
    if (weMadeTheChange && args.outcome === 'completed') {
      rewardsApplied = await applyQuestRewards(playerId, questId, ctx);
    }

    // Spec 20 — sex_move trigger. If the closed quest has tag
    // 'intimacy' AND the partner NPC's profile has a sex_move with
    // trigger='post_climax', emit a sex_move:fired SSE event so the
    // broker reads it next turn and calls the named effect_tool.
    let sexMoveFired: unknown = null;
    if (args.outcome === 'completed') {
      const questRow = await query<{tags: string[] | null; profile: unknown}>(
        `SELECT tags, profile FROM entities WHERE id = $1 AND kind = 'quest'`,
        [questId],
      );
      const tags = questRow.rows[0]?.tags ?? [];
      const profile = (questRow.rows[0]?.profile ?? {}) as Record<string, unknown>;
      const partnerName =
        typeof profile['partner'] === 'string' ? (profile['partner'] as string) : null;
      if (
        Array.isArray(tags) &&
        tags.includes('intimacy') &&
        partnerName != null
      ) {
        const partnerRow = await query<{id: number; profile: unknown}>(
          `SELECT id, profile FROM entities WHERE display_name = $1 AND kind = 'person' LIMIT 1`,
          [partnerName],
        );
        const partner = partnerRow.rows[0];
        const partnerProfile = (partner?.profile ?? {}) as Record<string, unknown>;
        const sexMove = partnerProfile['sex_move'] as
          | Record<string, unknown>
          | undefined;
        if (sexMove && sexMove['trigger'] === 'post_climax' && partner) {
          const payload = {
            partnerId: partner.id,
            partnerName,
            narrate_hint: sexMove['narrate_hint'] ?? null,
            effect_tool: sexMove['effect_tool'] ?? null,
            effect_args: sexMove['effect_args'] ?? null,
          };
          await emitGuiEventForSession(ctx.sessionId, 'sex_move:fired', payload, {
            playerId: ctx.playerId,
            turnId: ctx.turnId ?? null,
            phase: 'mutation',
          });
          sexMoveFired = payload;
        }
      }
    }

    await emitQuestCard(ctx.sessionId, ctx.playerId, ctx.turnId, 'quest:completed', questId, {
      playerId,
      outcome: args.outcome,
      rewardsApplied,
    });
    if (weMadeTheChange) {
      await applyQuestStageMaterializersForTool(ctx, playerId, questId);
    }

    return {
      player_id: playerId,
      quest_id: questId,
      quest_resolution: resolutionSource,
      outcome: args.outcome,
      rewards_applied: rewardsApplied,
      sex_move_fired: sexMoveFired,
      changed: true,
      no_op: false,
    };
  },
});

/**
 * Spec 22 — extracted reward application path. Called by both the
 * `complete_quest` tool (when broker explicitly closes a quest) and by
 * `questEngine.evaluateActiveQuests` (auto-complete on the last
 * stage). Tolerant of missing schema — quests authored without a
 * `rewards` block return an empty applied map without erroring.
 */
export async function applyQuestRewards(
  playerId: number,
  questId: number,
  ctx?: ToolContext,
): Promise<Record<string, unknown>> {
  const applied: Record<string, unknown> = {};
  const prRow = await query<{profile: unknown}>(
    `SELECT profile FROM entities WHERE id = $1`,
    [questId],
  );
  const prof = (prRow.rows[0]?.profile ?? {}) as Record<string, unknown>;
  const rewards = (prof['rewards'] ?? {}) as Record<string, unknown>;

  if (typeof rewards['xp'] === 'number') {
    await query(
      `UPDATE players
          SET current_xp = current_xp + $1,
              current_level = level_for_xp((current_xp + $1)::bigint),
              last_seen = now()
        WHERE entity_id = $2`,
      [rewards['xp'], playerId],
    );
    await query(
      `INSERT INTO player_xp_log (player_id, amount, reason, awarded_by_tool, metadata)
       VALUES ($1, $2, $3, 'complete_quest', jsonb_build_object('quest_id', $4::bigint))`,
      [playerId, rewards['xp'], 'quest reward', questId],
    );
    applied['xp'] = rewards['xp'];
  }
  if (Array.isArray(rewards['strings'])) {
    const grants: Array<{npc: string; delta: number}> = [];
    for (const entry of rewards['strings'] as Array<Record<string, unknown>>) {
      const npcName = entry['npc'];
      const delta = entry['delta'];
      if (typeof npcName !== 'string' || typeof delta !== 'number') continue;
      const npcId = await resolveEntityId(npcName);
      if (npcId == null) continue;
      const remaining = await addString(npcId, playerId, delta);
      if (ctx) {
        const sourceSlug = await sourceSlugForEntity(npcId);
        if (sourceSlug) {
          await applyMaterializersForTrigger(ctx, 'relationship', {sourceSlug});
        }
      }
      if (ctx) {
        const strings = await readStrings(npcId);
        emitFieldChange(ctx.sessionId, {
          owner_entity_id: npcId,
          field_key: 'strings',
          value: strings,
          source: 'quest_reward',
        });
        await emitGuiEventForSession(
          ctx.sessionId,
          'string:changed',
          {
            stringId: stringEdgeId(playerId, npcId),
            from: playerId,
            to: npcId,
            kind: stringKindForCount(remaining),
            intensity: stringIntensityForCount(remaining),
            valence: stringValenceForCount(remaining),
            turnId: ctx.turnId ?? null,
            npcId,
            npcName,
            delta,
            newValue: remaining,
            band: bandFor(remaining),
            reason:
              typeof entry['reason'] === 'string'
                ? entry['reason']
                : 'quest reward',
            summary:
              typeof entry['reason'] === 'string'
                ? entry['reason']
                : `Quest reward changed strings with ${npcName}.`,
            source: 'quest_reward',
            questId,
          },
          {
            playerId,
            turnId: ctx.turnId ?? null,
            phase: 'mutation',
          },
        );
      }
      grants.push({npc: npcName, delta});
    }
    applied['strings'] = grants;
  }
  if (Array.isArray(rewards['items'])) {
    const items: Array<{item: string; item_id: number; count: number}> = [];
    for (const entry of rewards['items'] as Array<Record<string, unknown>>) {
      const rawItem = entry['item'] ?? entry['item_slug'];
      const count = boundedPositiveInt(entry['count'], 1, 99) ?? 1;
      if (typeof rawItem !== 'string') continue;
      const item = await resolveRewardInventoryItem(rawItem);
      if (!item) continue;
      await query(
        `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (player_id, item_id) WHERE equipped = false
         DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity`,
        [playerId, item.id, count],
      );
      if (ctx) {
        await emitPlayerInventoryEvents(ctx.sessionId, playerId, item);
      }
      items.push({item: rawItem, item_id: item.id, count});
    }
    if (items.length > 0) applied['items'] = items;
  }
  if (Array.isArray(rewards['statuses'])) {
    const statuses: Array<{
      actor: string;
      actor_id: number;
      status_kind: string;
      status_value: string;
      intensity: number;
    }> = [];
    for (const entry of rewards['statuses'] as Array<Record<string, unknown>>) {
      const actor = entry['actor'];
      const statusKind = normalizeRewardStatusKind(entry['status_kind']);
      const statusValue =
        typeof entry['status_value'] === 'string'
          ? entry['status_value'].trim()
          : '';
      const intensity =
        typeof entry['intensity'] === 'number'
          ? Math.max(0, Math.min(1, entry['intensity']))
          : 0.5;
      if (typeof actor !== 'string' || !statusKind || !statusValue) continue;
      const actorId = await resolveEntityId(actor, {playerId});
      if (actorId == null) continue;
      await query(
        `INSERT INTO actor_statuses
           (player_id, actor_entity_id, status_kind, status_value, intensity,
            source, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'quest_reward', $6::jsonb, now())
         ON CONFLICT (player_id, actor_entity_id, status_kind) DO UPDATE SET
           status_value = EXCLUDED.status_value,
           intensity = EXCLUDED.intensity,
           source = EXCLUDED.source,
           metadata = actor_statuses.metadata || EXCLUDED.metadata,
           updated_at = now()`,
        [
          playerId,
          actorId,
          statusKind,
          statusValue,
          intensity,
          JSON.stringify({
            quest_id: questId,
            reason:
              typeof entry['reason'] === 'string' ? entry['reason'] : null,
            turn_id: ctx?.turnId ?? null,
          }),
        ],
      );
      if (ctx) {
        await emitGuiEventForSession(
          ctx.sessionId,
          'actor:status_changed',
          {
            actorId,
            actorName: actor,
            statusKind,
            statusValue,
            intensity,
            reason:
              typeof entry['reason'] === 'string'
                ? entry['reason']
                : 'quest reward',
          },
          {
            playerId,
            turnId: ctx.turnId ?? null,
            phase: 'mutation',
          },
        );
      }
      statuses.push({
        actor,
        actor_id: actorId,
        status_kind: statusKind,
        status_value: statusValue,
        intensity,
      });
    }
    if (statuses.length > 0) applied['statuses'] = statuses;
  }
  if (Array.isArray(rewards['companions'])) {
    const companions: Array<{
      npc: string;
      npc_id: number;
      action: string;
      already: boolean;
    }> = [];
    for (const entry of rewards['companions'] as Array<Record<string, unknown>>) {
      const npcName = entry['npc'];
      const action = entry['action'] === 'stop_following' ? 'stop_following' : 'follow';
      if (typeof npcName !== 'string') continue;
      const result = await setCompanionState(
        {
          npc: npcName,
          action,
          reason:
            typeof entry['reason'] === 'string'
              ? entry['reason']
              : 'quest reward',
        },
        ctx ?? {playerId},
      );
      companions.push({
        npc: result.npc,
        npc_id: result.npcId,
        action: result.action,
        already: result.already,
      });
    }
    if (companions.length > 0) applied['companions'] = companions;
  }
  if (Array.isArray(rewards['memories'])) {
    const memories: Array<{
      owner_entity_id: number;
      about_entity_id: number | null;
      importance: number;
    }> = [];
    for (const entry of rewards['memories'] as Array<Record<string, unknown>>) {
      if (typeof entry['text'] !== 'string') continue;
      const ownerId =
        Number.isInteger(entry['owner_entity_id']) &&
        Number(entry['owner_entity_id']) > 0
          ? Number(entry['owner_entity_id'])
          : typeof entry['owner'] === 'string'
            ? await resolveEntityId(entry['owner'], {playerId})
            : null;
      if (ownerId == null) continue;
      const aboutId =
        Number.isInteger(entry['about_entity_id']) &&
        Number(entry['about_entity_id']) > 0
          ? Number(entry['about_entity_id'])
          : typeof entry['about'] === 'string'
            ? isLegacyCurrentPlayerToken(entry['about']) ||
              entry['about'].trim().toLowerCase() === 'current_player'
              ? playerId
              : await resolveEntityId(entry['about'], {playerId})
            : playerId;
      const importance =
        typeof entry['importance'] === 'number' ? entry['importance'] : 0.6;
      await insertQuestRewardMemory({
        ownerEntityId: ownerId,
        aboutEntityId: aboutId,
        text: entry['text'],
        importance,
        tags: ['quest-reward', 'quest-reward-memory'],
      });
      memories.push({
        owner_entity_id: ownerId,
        about_entity_id: aboutId,
        importance,
      });
    }
    if (memories.length > 0) applied['memories'] = memories;
  }
  const mem = rewards['memory'] as Record<string, unknown> | undefined;
  if (mem && typeof mem['text'] === 'string') {
    const ownerId =
      Number.isInteger(mem['owner_entity_id']) && Number(mem['owner_entity_id']) > 0
        ? Number(mem['owner_entity_id'])
        : typeof mem['owner'] === 'string'
          ? await resolveEntityId(mem['owner'] as string, {playerId})
          : playerId;
    const aboutId =
      Number.isInteger(mem['about_entity_id']) && Number(mem['about_entity_id']) > 0
        ? Number(mem['about_entity_id'])
        : typeof mem['about'] === 'string'
          ? await resolveEntityId(mem['about'] as string, {playerId})
          : null;
    if (ownerId != null) {
      await insertQuestRewardMemory({
        ownerEntityId: ownerId,
        aboutEntityId: aboutId,
        text: mem['text'] as string,
        importance:
          typeof mem['importance'] === 'number' ? mem['importance'] : 0.7,
        tags: ['quest-reward'],
      });
      applied['memory'] = {
        owner_entity_id: ownerId,
        about_entity_id: aboutId,
        importance: mem['importance'],
      };
    }
  }
  if (Array.isArray(rewards['permanent_field_patches'])) {
    const list: Array<{owner_entity_id: number; field_key: string}> = [];
    for (const p of rewards['permanent_field_patches'] as Array<
      Record<string, unknown>
    >) {
      const ownerId = Number(p['owner_entity_id']);
      const fieldKey = p['field_key'];
      if (!Number.isInteger(ownerId) || typeof fieldKey !== 'string') continue;
      const fieldRow = await query<{id: number}>(
        `SELECT id FROM runtime_fields
          WHERE owner_entity_id = $1 AND field_key = $2`,
        [ownerId, fieldKey],
      );
      const fieldId = fieldRow.rows[0]?.id;
      if (fieldId == null) continue;
      await applyPatchRaw(fieldId, p['value'], 'set', 'quest_reward');
      list.push({owner_entity_id: ownerId, field_key: fieldKey});
    }
    applied['permanent_field_patches'] = list;
  }

  // Spec 24 — clear specific condition tags from named targets.
  const runtimeFieldPatches = await applyRewardRuntimeFieldPatches(
    playerId,
    rewards['runtime_field_patches'],
  );
  if (runtimeFieldPatches.length > 0) {
    applied['runtime_field_patches'] = runtimeFieldPatches;
  }

  if (Array.isArray(rewards['condition_removals'])) {
    const removed: Array<{owner_entity_id: number; tag: string}> = [];
    for (const cr of rewards['condition_removals'] as Array<
      Record<string, unknown>
    >) {
      const ownerId = Number(cr['owner_entity_id']);
      const tag = cr['tag'];
      if (!Number.isInteger(ownerId) || typeof tag !== 'string') continue;
      await query(
        `UPDATE runtime_values rv
            SET value = (
              SELECT COALESCE(jsonb_agg(c), '[]'::jsonb)
                FROM jsonb_array_elements(rv.value) AS c
               WHERE c->>'tag' <> $1
            ),
                updated_at = now()
           FROM runtime_fields rf
          WHERE rv.field_id = rf.id
            AND rf.owner_entity_id = $2
            AND rf.field_key = 'conditions'
            AND jsonb_typeof(rv.value) = 'array'`,
        [tag, ownerId],
      );
      removed.push({owner_entity_id: ownerId, tag});
    }
    applied['condition_removals'] = removed;
  }

  // Spec 24 — append a trauma tag to the player's trauma runtime_field.
  // Rare: failure outcomes mostly. trauma is at owner_entity_id=playerId,
  // field_key='trauma' (per spec 20 layout).
  if (Array.isArray(rewards['trauma_awards'])) {
    const awarded: string[] = [];
    for (const tw of rewards['trauma_awards'] as Array<Record<string, unknown>>) {
      const tag = tw['tag'];
      if (typeof tag !== 'string') continue;
      const fieldRow = await query<{id: number}>(
        `SELECT id FROM runtime_fields
          WHERE owner_entity_id = $1 AND field_key = 'trauma'`,
        [playerId],
      );
      const fieldId = fieldRow.rows[0]?.id;
      if (fieldId == null) continue;
      await applyPatchRaw(fieldId, tag, 'append', 'quest_reward_trauma');
      awarded.push(tag);
    }
    applied['trauma_awards'] = awarded;
  }
  return applied;
}

function boundedPositiveInt(
  value: unknown,
  min: number,
  max: number,
): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function normalizeRewardStatusKind(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return [
    'trust',
    'fear',
    'hostile',
    'wounded',
    'missing',
    'dead',
    'companion',
  ].includes(normalized)
    ? normalized
    : null;
}

async function sourceSlugForEntity(entityId: number): Promise<string | null> {
  const row = await query<{source_slug: string | null}>(
    `SELECT profile->>'source_slug' AS source_slug
       FROM entities
      WHERE id = $1`,
    [entityId],
  );
  const sourceSlug = row.rows[0]?.source_slug?.trim().toLowerCase();
  return sourceSlug || null;
}

async function resolveRewardInventoryItem(
  item: string,
): Promise<Awaited<ReturnType<typeof resolveInventoryItem>>> {
  const direct = await resolveInventoryItem(item);
  if (direct) return direct;
  const withoutAt = item.trim().startsWith('@') ? item.trim().slice(1) : item;
  if (withoutAt !== item) {
    const stripped = await resolveInventoryItem(withoutAt);
    if (stripped) return stripped;
  }
  return null;
}

interface RewardRuntimeFieldMeta {
  id: number;
  owner_entity_id: number;
  field_key: string;
  value_type: string;
  allowed_values: unknown[] | null;
  scope_per_player: boolean;
}

async function applyRewardRuntimeFieldPatches(
  playerId: number,
  rawPatches: unknown,
): Promise<
  Array<{
    field_id: number;
    owner_entity_id: number;
    field_key: string;
    scope: string;
  }>
> {
  if (!Array.isArray(rawPatches)) return [];
  const applied: Array<{
    field_id: number;
    owner_entity_id: number;
    field_key: string;
    scope: string;
  }> = [];

  for (const patch of rawPatches) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    const p = patch as Record<string, unknown>;
    const op = typeof p['op'] === 'string' ? p['op'] : 'set';
    if (op !== 'set') continue;
    const field = await resolveRewardRuntimeField(p);
    if (!field) continue;
    const validation = validateRuntimeFieldValue(field, p['value']);
    if (!validation.ok) {
      throw new Error(
        `invalid quest reward runtime_field_patches value for field ${field.id}: ${validation.reason ?? 'invalid'}`,
      );
    }

    if (field.scope_per_player) {
      await query(
        `INSERT INTO runtime_player_overlay (field_id, player_id, value, source, updated_at)
         VALUES ($1, $2, $3::jsonb, 'quest_reward', now())
         ON CONFLICT (field_id, player_id)
         DO UPDATE SET value = EXCLUDED.value,
                       source = EXCLUDED.source,
                       updated_at = now()`,
        [field.id, playerId, JSON.stringify(p['value'])],
      );
      applied.push({
        field_id: field.id,
        owner_entity_id: field.owner_entity_id,
        field_key: field.field_key,
        scope: 'per_player',
      });
      continue;
    }

    await applyPatchRaw(field.id, p['value'], 'set', 'quest_reward');
    applied.push({
      field_id: field.id,
      owner_entity_id: field.owner_entity_id,
      field_key: field.field_key,
      scope: 'global',
    });
  }

  return applied;
}

async function resolveRewardRuntimeField(
  patch: Record<string, unknown>,
): Promise<RewardRuntimeFieldMeta | null> {
  const fieldId = Number(patch['field_id']);
  if (Number.isInteger(fieldId) && fieldId > 0) {
    const byId = await query<RewardRuntimeFieldMeta>(
      `SELECT id, owner_entity_id, field_key, value_type, allowed_values, scope_per_player
         FROM runtime_fields
        WHERE id = $1`,
      [fieldId],
    );
    return byId.rows[0] ?? null;
  }

  const ownerId = Number(patch['owner_entity_id']);
  const fieldKey = patch['field_key'];
  if (!Number.isInteger(ownerId) || ownerId <= 0 || typeof fieldKey !== 'string') {
    return null;
  }
  const byOwner = await query<RewardRuntimeFieldMeta>(
    `SELECT id, owner_entity_id, field_key, value_type, allowed_values, scope_per_player
       FROM runtime_fields
      WHERE owner_entity_id = $1 AND field_key = $2`,
    [ownerId, fieldKey],
  );
  return byOwner.rows[0] ?? null;
}
