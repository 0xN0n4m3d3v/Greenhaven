/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  buildAdventureHookPayload,
  emitAdventureHook,
  nextAdventureSequence,
  type AdventureQueueRow,
  type AdventureQueueSource,
  type AdventureQueueStatus,
  ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
  type AdventureKind,
} from '../domain/adventure/index.js';
import { query, withTransaction, type TxClient } from '../db.js';
import {
  LIVE_PLAYTEST_NPC_MEMORIES_KEY,
  insertLivePlaytestDebugMemory,
  selectLivePlaytestDebugMemoryRows,
} from '../domain/memory/index.js';
import {
  projectEntityNormalizedColumns,
  stripRetiredProfileKeysForPersist,
  stripRetiredTagsForPersist,
} from '../entities/profileProjection.js';
import {
  emitGuiEventForSession,
  type GuiEventLane,
  type GuiEventPhase,
} from '../guiEventOutbox.js';
import { currentPresentationBarrier } from '../presentationScheduler.js';
import { validateRuntimeFieldValue } from '../runtimeFieldValidation.js';
import { sessionManager, type Session } from '../sessionManager.js';
import {
  inventorySlugForDisplayName,
  materializeEntityInventoryItem,
} from '../tools/inventoryCommon.js';
import { captureStateSnapshot } from './stateSnapshot.js';

export const LIVE_PLAYTEST_STATE_SCHEMA = 'greenhaven.live_playtest_state.v1';

export interface LivePlaytestStateOptions {
  playerId: number;
  sessionId?: string;
  limit?: number;
}

export interface LivePlaytestMutationOptions extends LivePlaytestStateOptions {
  ops: unknown[];
}

export interface LivePlaytestPresetOptions extends LivePlaytestStateOptions {
  preset: string;
  options?: unknown;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;
const CHAT_TONES = new Set(['player', 'npc', 'system', 'narrator']);
const QUEST_STATUSES = new Set([
  'unseen',
  'offered',
  'active',
  'completed',
  'failed',
]);
const ITEM_CATEGORIES = new Set([
  'weapon',
  'armor',
  'consumable',
  'tool',
  'quest',
  'material',
  'currency',
]);
const ADVENTURE_KINDS = new Set([
  'social_hook',
  'exploration_clue',
  'hidden_location',
  'item_discovery',
  'hazard',
  'ambush',
  'quest_complication',
  'downtime_rumor',
]);
const TURN_QUEUE_STATUSES = new Set([
  'queued',
  'starting',
  'running',
  'done',
  'cancelled',
  'failed',
]);
const GUI_EVENT_LANES = new Set([
  'chat',
  'pre_response',
  'response',
  'post_response',
  'status',
  'rail',
]);
const GUI_EVENT_PHASES = new Set([
  'pre_turn',
  'mutation',
  'narration',
  'post_turn',
  'support',
]);

export async function captureLivePlaytestState(
  opts: LivePlaytestStateOptions,
): Promise<Record<string, unknown>> {
  const playerId = positiveInt(opts.playerId, 'playerId');
  const limit = clampLimit(opts.limit);
  const sessionId = opts.sessionId || (await latestSessionId(playerId));
  const baseSnapshot = await captureStateSnapshot({
    playerId,
    sessionId,
    limit,
  });
  const [
    inMemorySessions,
    guiEvents,
    turnIngressQueue,
    adventureQueue,
    turnTelemetry,
    telemetryEvents,
    performanceEvents,
    nearbyEntities,
    npcMemories,
  ] = await Promise.all([
    liveSessionSummaries(playerId, sessionId),
    loadGuiEvents(playerId, sessionId, limit),
    loadTurnIngressQueue(playerId, sessionId, limit),
    loadAdventureQueue(playerId, sessionId, limit),
    loadTurnTelemetry(playerId, sessionId, limit),
    loadTelemetryEvents(playerId, sessionId, limit),
    loadPerformanceEvents(playerId, sessionId, limit),
    loadNearbyEntities(playerId, limit),
    loadNpcMemories(playerId, limit),
  ]);

  return {
    schema: LIVE_PLAYTEST_STATE_SCHEMA,
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    scope: { playerId, sessionId: sessionId ?? null, limit },
    baseSnapshot,
    live: {
      in_memory_sessions: inMemorySessions,
      gui_events: guiEvents,
      turn_ingress_queue: turnIngressQueue,
      adventure_queue: adventureQueue,
      turn_telemetry: turnTelemetry,
      telemetry_events: telemetryEvents,
      performance_events: performanceEvents,
      nearby_entities: nearbyEntities,
      [LIVE_PLAYTEST_NPC_MEMORIES_KEY]: npcMemories,
    },
  };
}

export async function applyLivePlaytestOperations(
  opts: LivePlaytestMutationOptions,
): Promise<Record<string, unknown>> {
  const playerId = positiveInt(opts.playerId, 'playerId');
  const limit = clampLimit(opts.limit);
  if (!Array.isArray(opts.ops)) {
    throw new Error('ops must be an array');
  }
  const sessionId = await ensureSession(playerId, opts.sessionId);
  const results: unknown[] = [];
  await withTransaction(async (tx) => {
    await assertPlayerExists(tx, playerId);
    for (const rawOp of opts.ops) {
      results.push(
        await applyLivePlaytestOperation(tx, playerId, sessionId, rawOp),
      );
    }
  });
  return {
    ok: true,
    playerId,
    sessionId,
    operations: results,
    state: await captureLivePlaytestState({ playerId, sessionId, limit }),
  };
}

export async function applyLivePlaytestPreset(
  opts: LivePlaytestPresetOptions,
): Promise<Record<string, unknown>> {
  const playerId = positiveInt(opts.playerId, 'playerId');
  const limit = clampLimit(opts.limit);
  const sessionId = await ensureSession(playerId, opts.sessionId);
  const options = asRecord(opts.options) ?? {};
  const npcId =
    readPositiveInt(options['npcEntityId']) ??
    readPositiveInt(options['giverEntityId']) ??
    (await resolveDefaultNpcId(playerId));
  const preset = readNonEmptyString(opts.preset, 'preset');
  const ops = buildPresetOperations(preset, {
    playerId,
    sessionId,
    npcId,
    options,
  });
  return applyLivePlaytestOperations({ playerId, sessionId, limit, ops });
}

async function applyLivePlaytestOperation(
  tx: TxClient,
  playerId: number,
  sessionId: string,
  rawOp: unknown,
): Promise<Record<string, unknown>> {
  const op = asRecordRequired(rawOp, 'operation');
  const type = readNonEmptyString(op['type'], 'operation.type');
  switch (type) {
    case 'insert_chat':
      return insertChat(tx, playerId, sessionId, op);
    case 'set_location':
      return setLocation(tx, playerId, op);
    case 'set_dialogue_partner':
      return setDialoguePartner(tx, playerId, op);
    case 'create_debug_npc':
      return createDebugNpc(tx, playerId, op);
    case 'create_debug_quest':
      return createDebugQuest(tx, playerId, op);
    case 'set_quest_status':
      return setQuestStatus(tx, playerId, op);
    case 'add_npc_memory':
      return addNpcMemory(tx, playerId, op);
    case 'grant_item':
      return grantItem(tx, playerId, op);
    case 'clear_item_holders':
      return clearItemHolders(tx, op);
    case 'set_holder_item_count':
      return setHolderItemCount(tx, op);
    case 'move_item':
      return moveItem(tx, playerId, op);
    case 'enqueue_adventure':
      return enqueueAdventure(tx, playerId, sessionId, op);
    case 'set_runtime_field':
      return setRuntimeField(tx, playerId, op);
    case 'set_entity_location':
      return setEntityLocation(tx, op);
    case 'queue_player_turn':
      return queuePlayerTurn(tx, playerId, sessionId, op);
    case 'emit_gui_event':
      return emitDebugGuiEvent(playerId, sessionId, op);
    default:
      throw new Error(`unsupported live playtest operation: ${type}`);
  }
}

async function insertChat(
  tx: TxClient,
  playerId: number,
  sessionId: string,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const text = readNonEmptyString(op['text'], 'insert_chat.text');
  const tone = readString(op['tone']) ?? 'system';
  if (!CHAT_TONES.has(tone)) throw new Error(`unsupported chat tone: ${tone}`);
  const player = await loadPlayerRuntime(tx, playerId);
  const authorEntityId =
    readPositiveInt(op['authorEntityId']) ??
    (tone === 'player'
      ? playerId
      : tone === 'narrator'
        ? player.currentLocationId
        : tone === 'npc'
          ? player.dialoguePartnerId
          : null);
  const npcEntityId =
    readNullablePositiveInt(op['npcEntityId']) ??
    (tone === 'npc' ? authorEntityId : player.dialoguePartnerId);
  const locationEntityId =
    readNullablePositiveInt(op['locationEntityId']) ?? player.currentLocationId;
  const payload = {
    source: 'debug.live_playtest_control_plane',
    turn_id: readString(op['turnId']) ?? `debug:${randomUUID()}`,
    ...(asRecord(op['payload']) ?? {}),
  };
  const nextTurn = await tx.query<{ turn_index: number | string }>(
    `SELECT COALESCE(MAX(turn_index), -1) + 1 AS turn_index
       FROM chat_messages
      WHERE session_id = $1`,
    [sessionId],
  );
  const turnIndex = Number(nextTurn.rows[0]?.turn_index ?? 0);
  const inserted = await tx.query<{ id: number | string }>(
    `INSERT INTO chat_messages
       (session_id, player_id, author_entity_id, tone, text, turn_index,
        payload, location_entity_id, npc_entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     RETURNING id`,
    [
      sessionId,
      playerId,
      authorEntityId,
      tone,
      text,
      turnIndex,
      JSON.stringify(payload),
      locationEntityId,
      npcEntityId,
    ],
  );
  return {
    type: 'insert_chat',
    id: Number(inserted.rows[0]!.id),
    tone,
    turnIndex,
    turnId: payload.turn_id,
  };
}

async function setLocation(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const locationId = positiveInt(op['locationEntityId'], 'locationEntityId');
  await assertEntityExists(tx, locationId, ['location', 'scene']);
  const sceneId = readNullablePositiveInt(op['sceneEntityId']);
  if (sceneId != null) await assertEntityExists(tx, sceneId, ['scene']);
  await tx.query(
    `UPDATE players
        SET current_location_id = $2,
            current_scene_id = COALESCE($3, current_scene_id),
            dialogue_partner_id = CASE WHEN $4 THEN dialogue_partner_id ELSE NULL END
      WHERE entity_id = $1`,
    [playerId, locationId, sceneId, op['preserveDialogue'] === true],
  );
  return {
    type: 'set_location',
    locationEntityId: locationId,
    sceneEntityId: sceneId,
  };
}

async function setDialoguePartner(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const partnerId = readNullablePositiveInt(op['npcEntityId']);
  if (partnerId != null) await assertEntityExists(tx, partnerId, ['person']);
  await tx.query(
    `UPDATE players SET dialogue_partner_id = $2 WHERE entity_id = $1`,
    [playerId, partnerId],
  );
  return { type: 'set_dialogue_partner', npcEntityId: partnerId };
}

async function createDebugNpc(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const displayName = readNonEmptyString(
    op['displayName'],
    'create_debug_npc.displayName',
  );
  const player = await loadPlayerRuntime(tx, playerId);
  const locationEntityId =
    readPositiveInt(op['locationEntityId']) ?? player.currentLocationId;
  if (locationEntityId != null) {
    await assertEntityExists(tx, locationEntityId, ['location', 'scene']);
  }
  const summary =
    readString(op['summary']) ??
    'Debug NPC created by the live playtest control plane.';
  const profile = {
    origin: 'debug.live_playtest_control_plane',
    ...(locationEntityId != null
      ? {
          home_id: String(locationEntityId),
          current_location_id: String(locationEntityId),
        }
      : {}),
    ...(asRecord(op['profile']) ?? {}),
  };
  const tags = uniqueTags([
    'person',
    'dynamic',
    'debug',
    'live_playtest',
    ...readStringArray(op['tags']),
  ]);
  const projected = projectEntityNormalizedColumns({ profile, tags });
  const inserted = await tx.query<{ id: number | string }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, topology_parent_id, dynamic_origin
     )
     VALUES (
       'person', $1, $2, $3::jsonb, $4,
       $5,
       (SELECT inner_e.id FROM entities inner_e
          WHERE inner_e.id = $6::bigint
            AND inner_e.kind IN ('location', 'district')),
       $7
     )
     RETURNING id`,
    [
      displayName,
      summary,
      JSON.stringify(stripRetiredProfileKeysForPersist(profile)),
      stripRetiredTagsForPersist(tags),
      projected.cartridge_id,
      projected.topology_parent_id,
      projected.dynamic_origin,
    ],
  );
  const npcEntityId = Number(inserted.rows[0]!.id);
  const hp = readPositiveInt(op['currentHp']) ?? readPositiveInt(op['hp']);
  const maxHp = readPositiveInt(op['maxHp']) ?? hp;
  if (hp != null) {
    await setRuntimeField(tx, playerId, {
      type: 'set_runtime_field',
      ownerEntityId: npcEntityId,
      fieldKey: 'current_hp',
      value: hp,
      createIfMissing: true,
      valueType: 'int',
      lifetime: 'session',
      description: 'Debug NPC current HP for live combat probes.',
    });
  }
  if (maxHp != null) {
    await setRuntimeField(tx, playerId, {
      type: 'set_runtime_field',
      ownerEntityId: npcEntityId,
      fieldKey: 'max_hp',
      value: maxHp,
      createIfMissing: true,
      valueType: 'int',
      lifetime: 'session',
      description: 'Debug NPC max HP for live combat probes.',
    });
  }
  const armorClass =
    readPositiveInt(op['armorClass']) ?? readPositiveInt(op['ac']);
  if (armorClass != null) {
    await setRuntimeField(tx, playerId, {
      type: 'set_runtime_field',
      ownerEntityId: npcEntityId,
      fieldKey: 'armor_class',
      value: armorClass,
      createIfMissing: true,
      valueType: 'int',
      lifetime: 'session',
      description: 'Debug NPC armor class for live combat probes.',
    });
  }
  return {
    type: 'create_debug_npc',
    npcEntityId,
    displayName,
    locationEntityId: locationEntityId ?? null,
    currentHp: hp ?? null,
    maxHp: maxHp ?? null,
    armorClass: armorClass ?? null,
  };
}

async function createDebugQuest(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const title = readNonEmptyString(op['title'], 'create_debug_quest.title');
  const summary =
    readString(op['summary']) ??
    'Debug quest created by the live playtest control plane.';
  const goalText =
    readString(op['goalText']) ?? readString(op['goal_text']) ?? summary;
  const stageId = readString(op['stageId']) ?? 'debug-open';
  const giverEntityId = readPositiveInt(op['giverEntityId']);
  const profile = {
    origin: 'debug.live_playtest_control_plane',
    goal: goalText,
    giver_entity_id: giverEntityId ?? null,
    stages: [
      {
        id: stageId,
        title: readString(op['stageTitle']) ?? 'Debug stage',
        description: goalText,
        objectives: [],
        // QE-6 — debug stages with no objectives use the documented
        // `all_objectives_complete` value (an empty AND is true) so
        // the cartridge validator accepts the shape. The previous
        // `'manual_debug'` literal was synthetic and never honoured
        // by the runtime.
        advance_on: 'all_objectives_complete',
        next_stage: null,
      },
    ],
    ...(asRecord(op['profile']) ?? {}),
  };
  const tags = uniqueTags([
    'quest',
    'dynamic',
    'debug',
    ...readStringArray(op['tags']),
  ]);
  const projected = projectEntityNormalizedColumns({ profile, tags });
  const inserted = await tx.query<{ id: number | string }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, topology_parent_id, dynamic_origin
     )
     VALUES (
       'quest', $1, $2, $3::jsonb, $4,
       $5,
       (SELECT inner_e.id FROM entities inner_e
          WHERE inner_e.id = $6::bigint
            AND inner_e.kind IN ('location', 'district')),
       $7
     )
     RETURNING id`,
    [
      title,
      summary,
      JSON.stringify(stripRetiredProfileKeysForPersist(profile)),
      stripRetiredTagsForPersist(tags),
      projected.cartridge_id,
      projected.topology_parent_id,
      projected.dynamic_origin,
    ],
  );
  const questEntityId = Number(inserted.rows[0]!.id);
  const status = readQuestStatus(op['status']) ?? 'active';
  await upsertQuestStatus(tx, playerId, questEntityId, status, stageId, {
    source: 'debug.live_playtest_control_plane',
    ...(asRecord(op['metadata']) ?? {}),
  });
  return { type: 'create_debug_quest', questEntityId, title, status, stageId };
}

async function setQuestStatus(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const questEntityId = positiveInt(op['questEntityId'], 'questEntityId');
  await assertEntityExists(tx, questEntityId, ['quest']);
  const status = readQuestStatus(op['status']) ?? 'active';
  const stageId = readString(op['stageId']) ?? undefined;
  await upsertQuestStatus(tx, playerId, questEntityId, status, stageId, {
    source: 'debug.live_playtest_control_plane',
    ...(asRecord(op['metadata']) ?? {}),
  });
  return {
    type: 'set_quest_status',
    questEntityId,
    status,
    stageId: stageId ?? null,
  };
}

async function addNpcMemory(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ownerEntityId =
    readPositiveInt(op['ownerEntityId']) ??
    readPositiveInt(op['npcEntityId']) ??
    (await resolveDefaultNpcId(playerId, tx));
  const aboutEntityId =
    readNullablePositiveInt(op['aboutEntityId']) ?? playerId;
  await assertEntityExists(tx, ownerEntityId, ['person']);
  if (aboutEntityId != null) await assertEntityExists(tx, aboutEntityId);
  const text = readNonEmptyString(op['text'], 'add_npc_memory.text');
  const importance = clampNumber(readNumber(op['importance']) ?? 0.75, 0, 1);
  const tags = uniqueTags([
    'debug',
    'live_playtest',
    ...readStringArray(op['tags']),
  ]);
  // AsyncLocalStorage routes the helper's `query()` through the
  // outer `withTransaction(...)` so the INSERT still lands inside the
  // caller's per-op transaction.
  void tx;
  const inserted = await insertLivePlaytestDebugMemory({
    ownerEntityId,
    aboutEntityId,
    text,
    importance,
    tags,
    metadata: { source: 'debug.live_playtest_control_plane' },
  });
  return {
    type: 'add_npc_memory',
    memoryId: inserted.id,
    ownerEntityId,
    aboutEntityId,
  };
}

async function grantItem(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const displayName = readNonEmptyString(
    op['displayName'],
    'grant_item.displayName',
  );
  const quantity = readPositiveInt(op['quantity']) ?? 1;
  const category = readString(op['category']) ?? 'quest';
  if (!ITEM_CATEGORIES.has(category))
    throw new Error(`unsupported item category: ${category}`);
  const summary =
    readString(op['summary']) ??
    'Debug item granted by the live playtest control plane.';
  const profile = {
    category,
    quantity,
    inventory_item: true,
    ...(asRecord(op['profile']) ?? {}),
  };
  const tags = uniqueTags([
    'item',
    'dynamic',
    'debug',
    category,
    ...readStringArray(op['tags']),
  ]);
  const projected = projectEntityNormalizedColumns({ profile, tags });
  const entity = await tx.query<{ id: number | string }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, topology_parent_id, dynamic_origin
     )
     VALUES (
       'item', $1, $2, $3::jsonb, $4,
       $5,
       (SELECT inner_e.id FROM entities inner_e
          WHERE inner_e.id = $6::bigint
            AND inner_e.kind IN ('location', 'district')),
       $7
     )
     RETURNING id`,
    [
      displayName,
      summary,
      JSON.stringify(stripRetiredProfileKeysForPersist(profile)),
      stripRetiredTagsForPersist(tags),
      projected.cartridge_id,
      projected.topology_parent_id,
      projected.dynamic_origin,
    ],
  );
  const itemEntityId = Number(entity.rows[0]!.id);
  const materialized = await materializeEntityInventoryItem(tx, {
    entityId: itemEntityId,
    kind: 'item',
    displayName,
    profile,
    tags,
  });
  if (!materialized) throw new Error('failed to materialize debug item');
  const ledgerEntityId = materialized.legacy_entity_id ?? itemEntityId;
  await tx.query(
    `INSERT INTO inventory_entries
       (holder_entity_id, item_entity_id, count, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (holder_entity_id, item_entity_id)
     DO UPDATE SET count = inventory_entries.count + EXCLUDED.count,
                   metadata = COALESCE(inventory_entries.metadata, '{}'::jsonb) ||
                              EXCLUDED.metadata`,
    [
      playerId,
      ledgerEntityId,
      quantity,
      JSON.stringify({ source: 'debug.live_playtest_control_plane' }),
    ],
  );
  await tx.query(
    `INSERT INTO player_inventory (player_id, item_id, quantity, equipped, meta)
     VALUES ($1, $2, $3, false, $4::jsonb)
     ON CONFLICT (player_id, item_id) WHERE equipped = false
     DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity,
                   meta = COALESCE(player_inventory.meta, '{}'::jsonb) ||
                          EXCLUDED.meta`,
    [
      playerId,
      materialized.item_id,
      quantity,
      JSON.stringify({ source: 'debug.live_playtest_control_plane' }),
    ],
  );
  return {
    type: 'grant_item',
    itemEntityId: ledgerEntityId,
    createdEntityId: itemEntityId,
    itemId: materialized.item_id,
    slug: materialized.slug,
    quantity,
  };
}

async function clearItemHolders(
  tx: TxClient,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const displayName = readNonEmptyString(
    op['itemDisplayName'] ?? op['displayName'],
    'clear_item_holders.itemDisplayName',
  );
  const rows = await tx.query<{
    entity_id: number | string;
    item_id: number | string | null;
  }>(
    `SELECT e.id AS entity_id, i.id AS item_id
       FROM entities e
       LEFT JOIN items i ON i.legacy_entity_id = e.id
      WHERE e.kind = 'item'
        AND LOWER(e.display_name) = LOWER($1)
        AND ('debug' = ANY(e.tags) OR e.dynamic_origin = true)`,
    [displayName],
  );
  const entityIds = rows.rows.map((row) => Number(row.entity_id));
  const itemIds = rows.rows
    .map((row) => (row.item_id == null ? null : Number(row.item_id)))
    .filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
  let legacyRows = 0;
  let playerRows = 0;
  if (entityIds.length > 0) {
    const deletedLegacy = await tx.query<{ count: number | string }>(
      `WITH deleted AS (
         DELETE FROM inventory_entries
          WHERE item_entity_id = ANY($1::int[])
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM deleted`,
      [entityIds],
    );
    legacyRows = Number(deletedLegacy.rows[0]?.count ?? 0);
  }
  if (itemIds.length > 0) {
    const deletedPlayer = await tx.query<{ count: number | string }>(
      `WITH deleted AS (
         DELETE FROM player_inventory
          WHERE item_id = ANY($1::int[])
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM deleted`,
      [itemIds],
    );
    playerRows = Number(deletedPlayer.rows[0]?.count ?? 0);
  }
  return {
    type: 'clear_item_holders',
    displayName,
    matchedEntities: entityIds.length,
    legacyRows,
    playerRows,
  };
}

async function setHolderItemCount(
  tx: TxClient,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const holderEntityId = readPositiveInt(op['holderEntityId']);
  if (holderEntityId == null) {
    throw new Error('set_holder_item_count.holderEntityId required');
  }
  const count = readPositiveInt(op['count']) ?? 0;
  if (count < 0) throw new Error('set_holder_item_count.count must be >= 0');
  await assertEntityExists(tx, holderEntityId);
  const item = await resolveItemRef(tx, op);
  if (count === 0) {
    await tx.query(
      `DELETE FROM inventory_entries
        WHERE holder_entity_id = $1
          AND item_entity_id = $2`,
      [holderEntityId, item.entityId],
    );
    if (await isPlayerEntity(tx, holderEntityId)) {
      await tx.query(
        `DELETE FROM player_inventory
          WHERE player_id = $1
            AND item_id = $2
            AND equipped = false`,
        [holderEntityId, item.itemId],
      );
    }
  } else {
    await tx.query(
      `INSERT INTO inventory_entries
         (holder_entity_id, item_entity_id, count, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (holder_entity_id, item_entity_id)
       DO UPDATE SET count = EXCLUDED.count,
                     metadata = EXCLUDED.metadata`,
      [
        holderEntityId,
        item.entityId,
        count,
        JSON.stringify({ source: 'debug.live_playtest_control_plane' }),
      ],
    );
    if (await isPlayerEntity(tx, holderEntityId)) {
      await tx.query(
        `INSERT INTO player_inventory (player_id, item_id, quantity, equipped, meta)
         VALUES ($1, $2, $3, false, $4::jsonb)
         ON CONFLICT (player_id, item_id) WHERE equipped = false
         DO UPDATE SET quantity = EXCLUDED.quantity,
                       meta = EXCLUDED.meta`,
        [
          holderEntityId,
          item.itemId,
          count,
          JSON.stringify({ source: 'debug.live_playtest_control_plane' }),
        ],
      );
    }
  }
  return {
    type: 'set_holder_item_count',
    holderEntityId,
    itemEntityId: item.entityId,
    itemId: item.itemId,
    slug: item.slug,
    count,
  };
}

async function enqueueAdventure(
  tx: TxClient,
  playerId: number,
  sessionId: string,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const adventureKind = readAdventureKind(op['adventureKind']) ?? 'social_hook';
  const title = readString(op['title']) ?? 'Debug Opportunity';
  const summary =
    readString(op['summary']) ?? 'A debug opportunity waits for the player.';
  const playerFacingHook =
    readString(op['playerFacingHook']) ??
    readString(op['hook']) ??
    'A controlled debug hook asks whether the player will follow it.';
  const danger = readDanger(op['danger']) ?? 'safe';
  // AQ-2 — per-(session, player) atomic counter shared with
  // production adventure enqueue. Debug rows must not regress the
  // counter, so every devtools insert allocates via the same upsert
  // path that maybeEnqueueAdventureOpportunity uses.
  const sequence = await nextAdventureSequence(sessionId, playerId, tx);
  const seed = readString(op['seed']) ?? `debug-${randomUUID()}`;
  const dedupeKey = readString(op['dedupeKey']) ?? `debug:${seed}`;
  const nowTurnId = readString(op['turnId']) ?? null;
  const inserted = await tx.query<AdventureQueueDbRow>(
    `INSERT INTO adventure_queue
       (session_id, player_id, turn_id, status, source, adventure_kind,
        priority, seed, sequence, table_id, roll_result, context_snapshot,
        blueprint, dedupe_key, available_after_turn_id, expires_at)
     VALUES ($1, $2, $3, 'queued', 'manual_debug', $4,
             $5, $6, $7, $8, $9::jsonb, $10::jsonb,
             NULL, $11, $12, $13::timestamptz)
     ON CONFLICT (session_id, player_id, dedupe_key)
       WHERE dedupe_key IS NOT NULL
     DO UPDATE SET updated_at = now()
     RETURNING id, session_id, player_id, turn_id, status, source,
               adventure_kind, priority, seed, sequence, table_id,
               roll_result, context_snapshot, blueprint, dedupe_key,
               available_after_turn_id, created_at::text AS created_at,
               updated_at::text AS updated_at`,
    [
      sessionId,
      playerId,
      nowTurnId,
      adventureKind,
      readPositiveInt(op['priority']) ?? 80,
      seed,
      sequence,
      readString(op['tableId']) ?? 'debug.live_playtest',
      JSON.stringify({
        die: 'debug',
        raw_roll: readPositiveInt(op['roll']) ?? 1,
        selected_kind: adventureKind,
      }),
      JSON.stringify({ source: 'debug.live_playtest_control_plane' }),
      dedupeKey,
      readString(op['availableAfterTurnId']) ?? null,
      readString(op['expiresAt']) ?? null,
    ],
  );
  const queued = mapAdventureRow(inserted.rows[0]!);
  const giverEntityId =
    readPositiveInt(op['giverEntityId']) ??
    (await resolveDefaultNpcId(playerId, tx));
  const blueprint = {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    queueId: queued.id,
    adventureKind,
    title,
    summary,
    playerFacingHook,
    danger,
    suggestedQuest:
      op['suggestedQuest'] === false
        ? undefined
        : {
            title: readString(op['questTitle']) ?? title,
            summary,
            goal_text: readString(op['goalText']) ?? summary,
            stages: [
              {
                id: readString(op['stageId']) ?? 'debug-open',
                title: readString(op['stageTitle']) ?? 'Debug opening',
              },
            ],
            tags: ['debug', 'live-playtest'],
            source: 'npc_giver',
            mode: 'create_new',
            giverEntityId,
          },
    ...(asRecord(op['blueprintPatch']) ?? {}),
  };
  const updated = await tx.query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'ready',
            blueprint = $2::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING id, session_id, player_id, turn_id, status, source,
                adventure_kind, priority, seed, sequence, table_id,
                roll_result, context_snapshot, blueprint, dedupe_key,
                available_after_turn_id, created_at::text AS created_at,
                updated_at::text AS updated_at`,
    [queued.id, JSON.stringify(blueprint)],
  );
  const ready = mapAdventureRow(updated.rows[0]!);
  let hookPayload: Record<string, unknown> | null = null;
  if (op['emit'] !== false) {
    await emitAdventureHook(ready, undefined);
    hookPayload = await buildAdventureHookPayload(ready);
  }
  return {
    type: 'enqueue_adventure',
    queueId: ready.id,
    status: ready.status,
    title,
    hookPayload,
  };
}

async function moveItem(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const count =
    readPositiveInt(op['count']) ?? readPositiveInt(op['quantity']) ?? 1;
  const fromEntityId =
    op['fromEntityId'] === null
      ? null
      : (readPositiveInt(op['fromEntityId']) ?? playerId);
  const toEntityId =
    op['toEntityId'] === null ? null : readPositiveInt(op['toEntityId']);
  const item = await resolveItemRef(tx, op, {
    preferredHolderEntityId: fromEntityId,
  });
  if (fromEntityId == null && toEntityId == null) {
    throw new Error('move_item requires fromEntityId or toEntityId');
  }
  if (fromEntityId != null) await assertEntityExists(tx, fromEntityId);
  if (toEntityId != null) await assertEntityExists(tx, toEntityId);
  if (fromEntityId != null) {
    const removed = await tx.query<{ count: number | string }>(
      `UPDATE inventory_entries
          SET count = count - $3
        WHERE holder_entity_id = $1
          AND item_entity_id = $2
          AND count >= $3
        RETURNING count`,
      [fromEntityId, item.entityId, count],
    );
    if (removed.rows.length === 0 && op['allowMissing'] !== true) {
      throw new Error(
        `holder ${fromEntityId} does not have ${count} of item entity ${item.entityId}`,
      );
    }
    await tx.query(
      `DELETE FROM inventory_entries
        WHERE holder_entity_id = $1
          AND item_entity_id = $2
          AND count <= 0`,
      [fromEntityId, item.entityId],
    );
    if (await isPlayerEntity(tx, fromEntityId)) {
      await decrementPlayerInventory(tx, fromEntityId, item.itemId, count);
    }
  }
  if (toEntityId != null) {
    await tx.query(
      `INSERT INTO inventory_entries
         (holder_entity_id, item_entity_id, count, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (holder_entity_id, item_entity_id)
       DO UPDATE SET count = inventory_entries.count + EXCLUDED.count,
                     metadata = COALESCE(inventory_entries.metadata, '{}'::jsonb) ||
                                EXCLUDED.metadata`,
      [
        toEntityId,
        item.entityId,
        count,
        JSON.stringify({ source: 'debug.live_playtest_control_plane' }),
      ],
    );
    if (await isPlayerEntity(tx, toEntityId)) {
      await incrementPlayerInventory(tx, toEntityId, item.itemId, count);
    }
  }
  return {
    type: 'move_item',
    itemEntityId: item.entityId,
    itemId: item.itemId,
    slug: item.slug,
    fromEntityId,
    toEntityId,
    count,
  };
}

async function setRuntimeField(
  tx: TxClient,
  playerId: number,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const value = op['value'];
  if (value === undefined) throw new Error('set_runtime_field.value required');
  const field = await resolveRuntimeField(tx, op, value);
  const allowedValues = Array.isArray(field.allowed_values)
    ? field.allowed_values
    : null;
  const validation = validateRuntimeFieldValue(
    {
      id: Number(field.id),
      field_key: field.field_key,
      value_type: field.value_type,
      allowed_values: allowedValues,
    },
    value,
  );
  if (!validation.ok) {
    throw new Error(
      `invalid runtime field value for ${field.field_key}: ${validation.reason}`,
    );
  }
  const scope =
    readRuntimeScope(op['scope']) ??
    (field.scope_per_player ? 'per_player' : 'global');
  const source =
    readString(op['source']) ?? 'debug.live_playtest_control_plane';
  if (scope === 'per_player') {
    await tx.query(
      `INSERT INTO runtime_player_overlay
         (field_id, player_id, value, source, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (field_id, player_id)
       DO UPDATE SET value = EXCLUDED.value,
                     source = EXCLUDED.source,
                     updated_at = now()`,
      [field.id, playerId, JSON.stringify(value), source],
    );
  } else {
    await tx.query(
      `INSERT INTO runtime_values (field_id, value, source, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (field_id)
       DO UPDATE SET value = EXCLUDED.value,
                     source = EXCLUDED.source,
                     updated_at = now()`,
      [field.id, JSON.stringify(value), source],
    );
  }
  return {
    type: 'set_runtime_field',
    fieldId: Number(field.id),
    ownerEntityId: Number(field.owner_entity_id),
    fieldKey: field.field_key,
    scope,
    value,
  };
}

async function setEntityLocation(
  tx: TxClient,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const entityId = positiveInt(op['entityId'], 'entityId');
  const locationId = readNullablePositiveInt(op['locationEntityId']);
  const key = readString(op['profileKey']) ?? 'home_id';
  if (!['home_id', 'location_id', 'current_location_id'].includes(key)) {
    throw new Error(`unsupported entity location profile key: ${key}`);
  }
  await assertEntityExists(tx, entityId);
  if (locationId != null)
    await assertEntityExists(tx, locationId, ['location', 'scene']);
  if (locationId == null) {
    await tx.query(
      `UPDATE entities
          SET profile = COALESCE(profile, '{}'::jsonb) - $2
        WHERE id = $1`,
      [entityId, key],
    );
  } else {
    await tx.query(
      `UPDATE entities
          SET profile = COALESCE(profile, '{}'::jsonb) ||
                        jsonb_build_object($2::text, $3::text)
        WHERE id = $1`,
      [entityId, key, String(locationId)],
    );
  }
  return {
    type: 'set_entity_location',
    entityId,
    profileKey: key,
    locationEntityId: locationId ?? null,
  };
}

async function queuePlayerTurn(
  tx: TxClient,
  playerId: number,
  sessionId: string,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const text = readNonEmptyString(op['text'], 'queue_player_turn.text');
  const status = readString(op['status']) ?? 'queued';
  if (!TURN_QUEUE_STATUSES.has(status)) {
    throw new Error(`unsupported turn queue status: ${status}`);
  }
  const idx = await tx.query<{ queue_index: number | string }>(
    `SELECT COALESCE(MAX(queue_index), 0) + 1 AS queue_index
       FROM turn_ingress_queue
      WHERE session_id = $1`,
    [sessionId],
  );
  const queueIndex = Number(idx.rows[0]?.queue_index ?? 1);
  const turnId =
    readString(op['turnId']) ?? `debug-turn-${randomUUID().slice(0, 8)}`;
  const inserted = await tx.query<{ id: number | string }>(
    `INSERT INTO turn_ingress_queue
       (session_id, player_id, turn_id, status, text, action_id, language,
        client_request_id, queue_index, visible_after_turn_id, started_at,
        finished_at, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $4 IN ('starting', 'running') THEN now() ELSE NULL END,
             CASE WHEN $4 IN ('done', 'cancelled', 'failed') THEN now() ELSE NULL END,
             $11)
     RETURNING id`,
    [
      sessionId,
      playerId,
      turnId,
      status,
      text,
      readString(op['actionId']) ?? null,
      readString(op['language']) ?? null,
      readString(op['clientRequestId']) ?? null,
      queueIndex,
      readString(op['visibleAfterTurnId']) ?? null,
      readString(op['error']) ?? null,
    ],
  );
  return {
    type: 'queue_player_turn',
    queueId: Number(inserted.rows[0]!.id),
    turnId,
    status,
    queueIndex,
  };
}

async function emitDebugGuiEvent(
  playerId: number,
  sessionId: string,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const eventType = readNonEmptyString(
    op['eventType'],
    'emit_gui_event.eventType',
  );
  const lane = readString(op['lane']) ?? 'post_response';
  if (!GUI_EVENT_LANES.has(lane))
    throw new Error(`unsupported GUI lane: ${lane}`);
  const phase = readString(op['phase']) ?? 'support';
  if (!GUI_EVENT_PHASES.has(phase))
    throw new Error(`unsupported GUI phase: ${phase}`);
  const status = op['status'] === 'pending' ? 'pending' : 'ready';
  const envelope = await emitGuiEventForSession(
    sessionId,
    eventType,
    {
      source: 'debug.live_playtest_control_plane',
      ...(asRecord(op['payload']) ?? {}),
    },
    {
      playerId,
      turnId: readString(op['turnId']) ?? null,
      turnIndex: readPositiveInt(op['turnIndex']) ?? undefined,
      lane: lane as GuiEventLane,
      phase: phase as GuiEventPhase,
      dedupeKey: readString(op['dedupeKey']) ?? null,
      displayPolicy: asRecord(op['displayPolicy']),
      status,
      deferRelease: op['deferRelease'] === true,
    },
  );
  return {
    type: 'emit_gui_event',
    eventId: envelope?.eventId ?? null,
    eventType,
    releaseSeq: envelope?.releaseSeq ?? null,
    status,
  };
}

async function resolveItemRef(
  tx: TxClient,
  op: Record<string, unknown>,
  opts: { preferredHolderEntityId?: number | null } = {},
): Promise<{ entityId: number; itemId: number; slug: string }> {
  const itemEntityId = readPositiveInt(op['itemEntityId']);
  const itemName =
    readString(op['itemDisplayName']) ?? readString(op['itemName']);
  if (itemEntityId == null && itemName == null) {
    throw new Error('move_item requires itemEntityId or itemDisplayName');
  }
  const params: unknown[] = [];
  const filters: string[] = [];
  if (itemEntityId != null) {
    params.push(itemEntityId);
    filters.push(`e.id = $${params.length}`);
  }
  if (itemName != null) {
    params.push(itemName);
    filters.push(
      `(LOWER(e.display_name) = LOWER($${params.length}) OR i.slug = LOWER(REGEXP_REPLACE(REGEXP_REPLACE($${params.length}, '''', '', 'g'), '\\s+', '_', 'g')))`,
    );
  }
  let holderJoin = '';
  let holderOrder = '1';
  if (opts.preferredHolderEntityId != null) {
    params.push(opts.preferredHolderEntityId);
    holderJoin = `LEFT JOIN inventory_entries held
              ON held.item_entity_id = e.id
             AND held.holder_entity_id = $${params.length}`;
    holderOrder = 'CASE WHEN COALESCE(held.count, 0) > 0 THEN 0 ELSE 1 END';
  }
  const r = await tx.query<{
    entity_id: number | string;
    item_id: number | string | null;
    slug: string | null;
    display_name: string;
  }>(
    `SELECT e.id AS entity_id, i.id AS item_id, i.slug, e.display_name
       FROM entities e
       LEFT JOIN items i ON i.legacy_entity_id = e.id
       ${holderJoin}
      WHERE e.kind = 'item'
        AND (${filters.join(' OR ')})
      ORDER BY ${holderOrder}, CASE WHEN i.id IS NULL THEN 1 ELSE 0 END, e.id DESC
      LIMIT 1`,
    params,
  );
  const row = r.rows[0];
  if (!row) throw new Error('item not found');
  let itemId = row.item_id == null ? null : Number(row.item_id);
  let slug = row.slug ?? inventorySlugForDisplayName(row.display_name);
  if (itemId == null) {
    const materialized = await materializeEntityInventoryItem(tx, {
      entityId: Number(row.entity_id),
      kind: 'item',
      displayName: row.display_name,
      profile: { category: 'quest', inventory_item: true },
      tags: ['item', 'quest', 'debug'],
    });
    if (!materialized)
      throw new Error('failed to materialize item for move_item');
    itemId = materialized.item_id;
    slug = materialized.slug;
  }
  return { entityId: Number(row.entity_id), itemId, slug };
}

async function isPlayerEntity(
  tx: TxClient,
  entityId: number,
): Promise<boolean> {
  const r = await tx.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM players WHERE entity_id = $1`,
    [entityId],
  );
  return Number(r.rows[0]?.count ?? 0) > 0;
}

async function incrementPlayerInventory(
  tx: TxClient,
  playerId: number,
  itemId: number,
  quantity: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO player_inventory (player_id, item_id, quantity, equipped, meta)
     VALUES ($1, $2, $3, false, $4::jsonb)
     ON CONFLICT (player_id, item_id) WHERE equipped = false
     DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity,
                   meta = COALESCE(player_inventory.meta, '{}'::jsonb) ||
                          EXCLUDED.meta`,
    [
      playerId,
      itemId,
      quantity,
      JSON.stringify({ source: 'debug.live_playtest_control_plane' }),
    ],
  );
}

async function decrementPlayerInventory(
  tx: TxClient,
  playerId: number,
  itemId: number,
  quantity: number,
): Promise<void> {
  await tx.query(
    `DELETE FROM player_inventory
      WHERE player_id = $1
        AND item_id = $2
        AND equipped = false
        AND quantity <= $3`,
    [playerId, itemId, quantity],
  );
  await tx.query(
    `UPDATE player_inventory
        SET quantity = quantity - $3
      WHERE player_id = $1
        AND item_id = $2
        AND equipped = false
        AND quantity > $3`,
    [playerId, itemId, quantity],
  );
}

async function resolveRuntimeField(
  tx: TxClient,
  op: Record<string, unknown>,
  value: unknown,
): Promise<RuntimeFieldRow> {
  const fieldId = readPositiveInt(op['fieldId']);
  let row: RuntimeFieldRow | undefined;
  if (fieldId != null) {
    const found = await tx.query<RuntimeFieldRow>(
      `SELECT id, owner_entity_id, field_key, value_type, scope_per_player,
              allowed_values
         FROM runtime_fields
        WHERE id = $1
        LIMIT 1`,
      [fieldId],
    );
    row = found.rows[0];
  } else {
    const ownerEntityId = readPositiveInt(op['ownerEntityId']);
    const fieldKey = readString(op['fieldKey']);
    if (ownerEntityId != null && fieldKey != null) {
      const found = await tx.query<RuntimeFieldRow>(
        `SELECT id, owner_entity_id, field_key, value_type, scope_per_player,
                allowed_values
           FROM runtime_fields
          WHERE owner_entity_id = $1
            AND field_key = $2
          LIMIT 1`,
        [ownerEntityId, fieldKey],
      );
      row = found.rows[0];
    }
  }
  if (row) return row;
  if (op['createIfMissing'] !== true) {
    throw new Error('runtime field not found');
  }
  const ownerEntityId = positiveInt(op['ownerEntityId'], 'ownerEntityId');
  const fieldKey = readNonEmptyString(op['fieldKey'], 'fieldKey');
  await assertEntityExists(tx, ownerEntityId);
  const valueType =
    readRuntimeValueType(op['valueType']) ?? inferRuntimeValueType(value);
  const scope = readString(op['lifetime']) ?? 'session';
  if (!['turn', 'scene', 'session', 'journey', 'permanent'].includes(scope)) {
    throw new Error(`unsupported runtime field lifetime: ${scope}`);
  }
  const inserted = await tx.query<RuntimeFieldRow>(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value, allowed_values,
        scope, scope_per_player, description)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
     ON CONFLICT (owner_entity_id, field_key)
     DO UPDATE SET description = COALESCE(runtime_fields.description, EXCLUDED.description)
     RETURNING id, owner_entity_id, field_key, value_type, scope_per_player,
               allowed_values`,
    [
      ownerEntityId,
      fieldKey,
      valueType,
      JSON.stringify(op['defaultValue'] ?? value),
      op['allowedValues'] === undefined
        ? null
        : JSON.stringify(op['allowedValues']),
      scope,
      op['scopePerPlayer'] === true || op['scope'] === 'per_player',
      readString(op['description']) ?? 'Debug live playtest field.',
    ],
  );
  return inserted.rows[0]!;
}

interface RuntimeFieldRow {
  id: number | string;
  owner_entity_id: number | string;
  field_key: string;
  value_type: string;
  scope_per_player: boolean;
  allowed_values: unknown;
}

async function upsertQuestStatus(
  tx: TxClient,
  playerId: number,
  questEntityId: number,
  status: string,
  stageId: string | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase, current_stage_id,
        started_at, completed_at, metadata, accumulated_state, path_taken)
     VALUES (
       $1, $2, $3,
       CASE WHEN $3 = 'active' THEN 1 ELSE 0 END,
       $4,
       CASE WHEN $3 = 'active' THEN now() ELSE NULL END,
       CASE WHEN $3 = 'completed' THEN now() ELSE NULL END,
       $5::jsonb,
       '{}'::jsonb,
       '[]'::jsonb
     )
     ON CONFLICT (player_id, quest_entity_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       current_phase = CASE
         WHEN EXCLUDED.status = 'active'
           THEN GREATEST(player_quests.current_phase, 1)
         ELSE player_quests.current_phase
       END,
       current_stage_id = COALESCE(EXCLUDED.current_stage_id, player_quests.current_stage_id),
       started_at = CASE
         WHEN EXCLUDED.status = 'active'
           THEN COALESCE(player_quests.started_at, now())
         ELSE player_quests.started_at
       END,
       completed_at = CASE
         WHEN EXCLUDED.status = 'completed'
           THEN COALESCE(player_quests.completed_at, now())
         WHEN EXCLUDED.status = 'active'
           THEN NULL
         ELSE player_quests.completed_at
       END,
       metadata = COALESCE(player_quests.metadata, '{}'::jsonb) ||
                  COALESCE(EXCLUDED.metadata, '{}'::jsonb)`,
    [
      playerId,
      questEntityId,
      status,
      stageId ?? null,
      JSON.stringify(metadata),
    ],
  );
}

async function ensureSession(
  playerId: number,
  requested?: string,
): Promise<string> {
  const sessionId =
    requested || (await latestSessionId(playerId)) || `debug-${randomUUID()}`;
  const r = await query<{ id: string }>(
    `INSERT INTO sessions (id, player_id, metadata)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id)
     DO UPDATE SET
       player_id = COALESCE(sessions.player_id, EXCLUDED.player_id),
       last_seen = now(),
       metadata = COALESCE(sessions.metadata, '{}'::jsonb) ||
                  COALESCE(EXCLUDED.metadata, '{}'::jsonb)
     WHERE sessions.player_id IS NULL OR sessions.player_id = EXCLUDED.player_id
     RETURNING id`,
    [
      sessionId,
      playerId,
      JSON.stringify({ debug_live_playtest_control_plane: true }),
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`session ${sessionId} belongs to another player`);
  return row.id;
}

async function latestSessionId(playerId: number): Promise<string | undefined> {
  const bySession = await query<{ id: string }>(
    `SELECT id
       FROM sessions
      WHERE player_id = $1
      ORDER BY last_seen DESC, started_at DESC
      LIMIT 1`,
    [playerId],
  );
  if (bySession.rows[0]?.id) return bySession.rows[0].id;
  const byChat = await query<{ session_id: string }>(
    `SELECT session_id
       FROM chat_messages
      WHERE player_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [playerId],
  );
  return byChat.rows[0]?.session_id;
}

async function liveSessionSummaries(
  playerId: number,
  sessionId: string | undefined,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const [id, session] of sessionManager.entries()) {
    if (sessionId && id !== sessionId && session.playerId !== playerId)
      continue;
    if (!sessionId && session.playerId !== playerId) continue;
    out.push(summarizeSession(session));
  }
  return out;
}

function summarizeSession(session: Session): Record<string, unknown> {
  const barrier = currentPresentationBarrier(session);
  return {
    sessionId: session.id,
    playerId: session.playerId,
    lastActivityAt: new Date(session.lastActivityAt).toISOString(),
    sseClients: session.sse.clientCount,
    activeTurn: session.activeTurn
      ? {
          turnId: session.activeTurn.turnId,
          startedAt: new Date(session.activeTurn.startedAt).toISOString(),
          ageMs: Date.now() - session.activeTurn.startedAt,
          streamedContent: session.activeTurn.streamedContent === true,
          streamSeq: session.activeTurn.streamSeq ?? null,
          finalMessageId: session.activeTurn.finalMessageId ?? null,
          mode: session.activeTurn.mode ?? null,
          language: session.activeTurn.language ?? null,
          suppressPostTurn: session.activeTurn.suppressPostTurn === true,
          toolHistoryCount: session.activeTurn.toolHistory?.length ?? 0,
          narrativeChars: session.activeTurn.narrativeBuffer?.length ?? 0,
        }
      : null,
    presentationBarrier: barrier
      ? {
          id: barrier.id,
          turnId: barrier.turnId,
          pendingVisibleSlots: barrier.pendingVisibleSlots,
          // S-14 — `fallbackDeadlineAt` is the 5-minute dead-service
          // cap, not the old short per-hook wall-clock deadline.
          fallbackDeadlineAt: new Date(barrier.fallbackDeadlineAt).toISOString(),
          openedReleaseSeq: barrier.openedReleaseSeq,
        }
      : null,
  };
}

async function loadGuiEvents(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const { where, params } = scopedWhere(playerId, sessionId);
  const r = await query(
    `SELECT id, session_id, player_id, turn_id, turn_index, lane, phase,
            event_type, status, message_id, release_after_message_id,
            dedupe_key, display_policy, payload,
            ready_at::text AS ready_at,
            released_at::text AS released_at,
            expires_at::text AS expires_at,
            created_at::text AS created_at,
            release_seq
       FROM gui_events
      WHERE ${where}
      ORDER BY release_seq DESC NULLS LAST, id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

async function loadTurnIngressQueue(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const { where, params } = scopedWhere(playerId, sessionId);
  const r = await query(
    `SELECT id, session_id, player_id, turn_id, status, text, action_id,
            language, client_request_id, queue_index, visible_after_turn_id,
            created_at::text AS created_at,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            error
       FROM turn_ingress_queue
      WHERE ${where}
      ORDER BY queue_index DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

async function loadAdventureQueue(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const { where, params } = scopedWhere(playerId, sessionId);
  const r = await query(
    `SELECT id, session_id, player_id, turn_id, status, source,
            adventure_kind, priority, seed, sequence, table_id,
            roll_result, context_snapshot, blueprint, dedupe_key,
            available_after_turn_id, expires_at::text AS expires_at,
            created_at::text AS created_at, updated_at::text AS updated_at
       FROM adventure_queue
      WHERE ${where}
      ORDER BY id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

async function loadTurnTelemetry(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const { where, params } = scopedWhere(playerId, sessionId);
  const r = await query(
    `SELECT id, session_id, player_id, turn_id, role, model_id, thinking,
            input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens,
            duration_ms, cost_usd::text AS cost_usd, tier,
            slot_id, slot_key, slot_status, deadline_ms, expired,
            recorded_at::text AS recorded_at
       FROM turn_telemetry
      WHERE ${where}
      ORDER BY recorded_at DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

async function loadTelemetryEvents(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const { where, params } = scopedWhere(playerId, sessionId);
  const r = await query(
    `SELECT id, occurred_at::text AS occurred_at, trace_id, span_id,
            session_id, player_id, turn_id, event_id, release_seq,
            schema_name, schema_version, category, event_name, severity,
            properties, redaction_tier, validation_status, source
       FROM telemetry_events
      WHERE ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

async function loadPerformanceEvents(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const { where, params } = scopedWhere(playerId, sessionId);
  const r = await query(
    `SELECT id, recorded_at::text AS recorded_at, session_id, player_id,
            turn_id, trace_id, kind, phase, status, duration_ms, metadata,
            error
       FROM performance_events
      WHERE ${where}
      ORDER BY recorded_at DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

async function loadNearbyEntities(
  playerId: number,
  limit: number,
): Promise<unknown[]> {
  const player = await loadPlayerRuntime({ query }, playerId);
  if (player.currentLocationId == null) return [];
  const loc = String(player.currentLocationId);
  const r = await query(
    `SELECT id, kind, display_name, summary, tags, profile
       FROM entities
      WHERE id = $1
         OR profile->>'home_id' = $2
         OR profile->>'location_id' = $2
         OR profile->>'current_location_id' = $2
      ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, kind, display_name
      LIMIT ${limit}`,
    [player.currentLocationId, loc],
  );
  return r.rows;
}

async function loadNpcMemories(
  playerId: number,
  limit: number,
): Promise<unknown[]> {
  const rows = await selectLivePlaytestDebugMemoryRows({
    playerEntityId: playerId,
    debugTags: ['debug', 'live_playtest'],
    limit,
  });
  return rows.slice().reverse();
}

function scopedWhere(
  playerId: number,
  sessionId: string | undefined,
): { where: string; params: unknown[] } {
  if (sessionId) {
    return {
      where: `(player_id = $1 OR session_id = $2)`,
      params: [playerId, sessionId],
    };
  }
  return { where: `player_id = $1`, params: [playerId] };
}

async function loadPlayerRuntime(
  db: Pick<TxClient, 'query'>,
  playerId: number,
): Promise<{
  currentLocationId: number | null;
  currentSceneId: number | null;
  dialoguePartnerId: number | null;
}> {
  const r = await db.query<{
    current_location_id: number | string | null;
    current_scene_id: number | string | null;
    dialogue_partner_id: number | string | null;
  }>(
    `SELECT current_location_id, current_scene_id, dialogue_partner_id
       FROM players
      WHERE entity_id = $1`,
    [playerId],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`player ${playerId} not found`);
  return {
    currentLocationId: nullableNumber(row.current_location_id),
    currentSceneId: nullableNumber(row.current_scene_id),
    dialoguePartnerId: nullableNumber(row.dialogue_partner_id),
  };
}

async function assertPlayerExists(
  tx: TxClient,
  playerId: number,
): Promise<void> {
  const r = await tx.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM players WHERE entity_id = $1`,
    [playerId],
  );
  if (Number(r.rows[0]?.count ?? 0) !== 1) {
    throw new Error(`player ${playerId} not found`);
  }
}

async function assertEntityExists(
  tx: TxClient,
  entityId: number,
  allowedKinds?: string[],
): Promise<void> {
  const r = await tx.query<{ kind: string }>(
    `SELECT kind FROM entities WHERE id = $1 LIMIT 1`,
    [entityId],
  );
  const kind = r.rows[0]?.kind;
  if (!kind) throw new Error(`entity ${entityId} not found`);
  if (allowedKinds && !allowedKinds.includes(kind)) {
    throw new Error(
      `entity ${entityId} kind ${kind} is not one of ${allowedKinds.join(', ')}`,
    );
  }
}

async function resolveDefaultNpcId(
  playerId: number,
  db: Pick<TxClient, 'query'> = { query },
): Promise<number> {
  const player = await loadPlayerRuntime(db, playerId);
  if (player.dialoguePartnerId != null) return player.dialoguePartnerId;
  if (player.currentLocationId != null) {
    const nearby = await db.query<{ id: number | string }>(
      `SELECT id
         FROM entities
        WHERE kind = 'person'
          AND (
            profile->>'home_id' = $1
            OR profile->>'current_location_id' = $1
            OR profile->>'location_id' = $1
          )
          AND NOT EXISTS (
            SELECT 1 FROM actor_statuses s
             WHERE s.player_id = $2
               AND s.actor_entity_id = entities.id
               AND s.intensity > 0
               AND s.status_kind IN ('dead', 'missing')
          )
        ORDER BY id
        LIMIT 1`,
      [String(player.currentLocationId), playerId],
    );
    if (nearby.rows[0]?.id != null) return Number(nearby.rows[0].id);
  }
  const known = await db.query<{ id: number | string }>(
    `SELECT id FROM entities WHERE id IN (200, 220) ORDER BY id LIMIT 1`,
  );
  if (known.rows[0]?.id != null) return Number(known.rows[0].id);
  const anyPerson = await db.query<{ id: number | string }>(
    `SELECT id FROM entities WHERE kind = 'person' ORDER BY id LIMIT 1`,
  );
  if (anyPerson.rows[0]?.id != null) return Number(anyPerson.rows[0].id);
  throw new Error('no NPC/person entity available for preset');
}

function buildPresetOperations(
  preset: string,
  ctx: {
    playerId: number;
    sessionId: string;
    npcId: number;
    options: Record<string, unknown> | undefined;
  },
): unknown[] {
  const suffix = randomUUID().slice(0, 8);
  const includeQueuedTurn = ctx.options?.['includeQueuedTurn'] !== false;
  switch (preset) {
    case 'ready_adventure_hook':
      return [
        {
          type: 'enqueue_adventure',
          title: readString(ctx.options?.['title']) ?? `Debug Hook ${suffix}`,
          summary:
            readString(ctx.options?.['summary']) ??
            'A reproducible adventure hook waits in the timeline.',
          playerFacingHook:
            readString(ctx.options?.['playerFacingHook']) ??
            'A controlled lead appears so the next player decision can test hook handling.',
          danger: readString(ctx.options?.['danger']) ?? 'safe',
          giverEntityId: ctx.npcId,
          seed: `preset-ready-hook-${suffix}`,
        },
      ];
    case 'accepted_quest_memory_mismatch':
      return [
        {
          type: 'create_debug_quest',
          title:
            readString(ctx.options?.['title']) ??
            `Debug Accepted Quest ${suffix}`,
          summary:
            'Ask the giver about this quest; the NPC must acknowledge durable state.',
          goalText:
            'Confirm that the quest giver can explain the objective after acceptance.',
          giverEntityId: ctx.npcId,
          stageId: 'accepted',
          status: 'active',
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: ctx.npcId,
          aboutEntityId: ctx.playerId,
          text: 'I offered the active player a debug quest and must answer as if the agreement exists.',
          importance: 0.9,
          tags: ['quest_debug'],
        },
      ];
    case 'delivery_missing_item':
      return [
        {
          type: 'create_debug_quest',
          title:
            readString(ctx.options?.['title']) ??
            `Debug Delivery Missing Item ${suffix}`,
          summary:
            'Delivery quest whose required item is intentionally absent from inventory.',
          goalText:
            'Deliver the sealed debug parcel, but the parcel should not be present yet.',
          giverEntityId: ctx.npcId,
          stageId: 'needs_item',
          status: 'active',
          metadata: {
            expected_item:
              readString(ctx.options?.['expectedItem']) ??
              'Sealed Debug Parcel',
            intentionally_missing_item: true,
          },
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: ctx.npcId,
          aboutEntityId: ctx.playerId,
          text: 'The active player accepted a delivery, but the required parcel is missing; do not pretend it was handed over.',
          importance: 0.95,
          tags: ['quest_debug', 'missing_item'],
        },
      ];
    case 'silent_follow_private_scene':
      return [
        {
          type: 'add_npc_memory',
          ownerEntityId: ctx.npcId,
          aboutEntityId: ctx.playerId,
          text: 'I invited the active player to continue the conversation in the private booth; if they move there silently, I must either follow or acknowledge the move.',
          importance: 0.95,
          tags: ['quest_debug', 'silent_follow'],
        },
        {
          type: 'insert_chat',
          tone: 'npc',
          authorEntityId: ctx.npcId,
          npcEntityId: ctx.npcId,
          text:
            readString(ctx.options?.['inviteText']) ??
            'If you want the details, follow me behind the curtain. No speeches in the open room.',
        },
        {
          type: 'set_location',
          locationEntityId:
            readPositiveInt(ctx.options?.['privateLocationId']) ?? 101,
          preserveDialogue: false,
        },
        {
          type: 'set_entity_location',
          entityId: ctx.npcId,
          locationEntityId:
            readPositiveInt(ctx.options?.['npcStaysAtLocationId']) ?? 100,
          profileKey: 'home_id',
        },
        ...(includeQueuedTurn
          ? [
              {
                type: 'queue_player_turn',
                text:
                  readString(ctx.options?.['nextPlayerText']) ??
                  'Я молча прохожу за занавеску и жду, что она скажет дальше.',
                language: 'ru',
              },
            ]
          : []),
      ];
    case 'quest_chain_wrong_order':
      return [
        {
          type: 'create_debug_quest',
          title:
            readString(ctx.options?.['title']) ??
            `Debug Chain Wrong Order ${suffix}`,
          summary:
            'Three-stage chain intentionally parked on the return stage before evidence exists.',
          goalText:
            'Collect a clue, deliver it to a second NPC, then report back to the giver.',
          giverEntityId: ctx.npcId,
          stageId: 'return_to_giver',
          status: 'active',
          profile: {
            stages: [
              {
                id: 'collect_clue',
                title: 'Collect the clue',
                description:
                  'Find the marked clue before any report can happen.',
                next_stage: 'deliver_clue',
              },
              {
                id: 'deliver_clue',
                title: 'Deliver the clue',
                description: 'Give the clue to the intermediary.',
                next_stage: 'return_to_giver',
              },
              {
                id: 'return_to_giver',
                title: 'Return to the giver',
                description: 'Report only after the clue has changed hands.',
                next_stage: null,
              },
            ],
          },
          metadata: { wrong_order_probe: true, missing_prior_stages: true },
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: ctx.npcId,
          aboutEntityId: ctx.playerId,
          text: 'The active player is marked as returning from a chain quest, but I never saw the clue collected or delivered.',
          importance: 0.9,
          tags: ['quest_chain', 'wrong_order'],
        },
        ...(includeQueuedTurn
          ? [
              {
                type: 'queue_player_turn',
                text: 'Я возвращаюсь за наградой, хотя улику не находил и никому ничего не передавал.',
                language: 'ru',
              },
            ]
          : []),
      ];
    case 'quest_item_wrong_handoff':
      return [
        {
          type: 'create_debug_quest',
          title:
            readString(ctx.options?.['title']) ??
            `Debug Wrong Handoff ${suffix}`,
          summary:
            'Delivery chain where the player gives the quest item to the wrong holder.',
          goalText:
            'Carry the sealed debug envelope to the correct recipient, then return.',
          giverEntityId: ctx.npcId,
          stageId: 'deliver_item',
          status: 'active',
          metadata: {
            expected_holder:
              readPositiveInt(ctx.options?.['correctRecipientId']) ?? 220,
          },
        },
        {
          type: 'grant_item',
          displayName:
            readString(ctx.options?.['itemName']) ??
            `Sealed Debug Envelope ${suffix}`,
          category: 'quest',
          quantity: 1,
          tags: ['quest_item', 'delivery_probe'],
        },
        {
          type: 'move_item',
          itemDisplayName:
            readString(ctx.options?.['itemName']) ??
            `Sealed Debug Envelope ${suffix}`,
          fromEntityId: ctx.playerId,
          toEntityId:
            readPositiveInt(ctx.options?.['wrongRecipientId']) ?? ctx.npcId,
          count: 1,
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: ctx.npcId,
          aboutEntityId: ctx.playerId,
          text: 'The active player handed the delivery item to the wrong person; do not complete the quest unless the correct holder has it.',
          importance: 0.95,
          tags: ['quest_chain', 'wrong_handoff'],
        },
      ];
    case 'multi_quest_same_giver_conflict':
      return [
        {
          type: 'create_debug_quest',
          title: `Debug Chain A ${suffix}`,
          summary: 'First active quest from the same giver.',
          goalText: 'Report to the quiet inn before touching the alley route.',
          giverEntityId: ctx.npcId,
          stageId: 'go_to_inn',
          status: 'active',
          metadata: { conflict_group: `same_giver_${suffix}`, order: 1 },
        },
        {
          type: 'create_debug_quest',
          title: `Debug Chain B ${suffix}`,
          summary:
            'Second active quest from the same giver with a conflicting route.',
          goalText: 'Avoid the quiet inn and inspect the alley route first.',
          giverEntityId: ctx.npcId,
          stageId: 'avoid_inn',
          status: 'active',
          metadata: { conflict_group: `same_giver_${suffix}`, order: 2 },
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: ctx.npcId,
          aboutEntityId: ctx.playerId,
          text: 'I gave the active player two conflicting jobs; I must distinguish them by title and not merge objectives.',
          importance: 0.9,
          tags: ['quest_chain', 'conflict'],
        },
      ];
    case 'combat_dialogue_cross_npc':
      return [
        {
          type: 'set_location',
          locationEntityId:
            readPositiveInt(ctx.options?.['locationEntityId']) ?? 100,
          preserveDialogue: false,
        },
        {
          type: 'create_debug_npc',
          displayName:
            readString(ctx.options?.['enemyName']) ??
            `Debug Alley Cutpurse ${suffix}`,
          summary:
            'A debug combatant close enough to test dice, damage, NPC reactions, and grounded refusals.',
          locationEntityId:
            readPositiveInt(ctx.options?.['locationEntityId']) ?? 100,
          currentHp: readPositiveInt(ctx.options?.['currentHp']) ?? 12,
          maxHp: readPositiveInt(ctx.options?.['maxHp']) ?? 12,
          armorClass: readPositiveInt(ctx.options?.['armorClass']) ?? 12,
          tags: ['combat_probe'],
          profile: {
            social_role: 'hostile opportunist',
            wants:
              'pressure the player and nearby NPCs without becoming a permanent cartridge NPC',
          },
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: ctx.npcId,
          aboutEntityId: ctx.playerId,
          text: 'A debug hostile is nearby; if violence starts, I should react from my actual location and not teleport.',
          importance: 0.8,
          tags: ['combat_probe', 'presence'],
        },
      ];
    case 'queued_turn_interruption':
      return [
        {
          type: 'queue_player_turn',
          text: 'Первое намерение: я принимаю задание и прошу детали.',
          language: 'ru',
          status: 'running',
          turnId: `debug-running-${suffix}`,
        },
        {
          type: 'queue_player_turn',
          text: 'Второе намерение: я передумал и ухожу, пока ответ еще не готов.',
          language: 'ru',
          status: 'queued',
          visibleAfterTurnId: `debug-running-${suffix}`,
        },
      ];
    default:
      throw new Error(`unsupported live playtest preset: ${preset}`);
  }
}

function mapAdventureRow(row: AdventureQueueDbRow): AdventureQueueRow {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    playerId: Number(row.player_id),
    turnId: row.turn_id,
    status: row.status,
    source: row.source,
    adventureKind: row.adventure_kind,
    priority: Number(row.priority),
    seed: row.seed,
    sequence: Number(row.sequence),
    tableId: row.table_id,
    rollResult: asRecord(row.roll_result) ?? {},
    contextSnapshot: asRecord(row.context_snapshot) ?? {},
    blueprint: asRecord(row.blueprint) ?? null,
    dedupeKey: row.dedupe_key,
    availableAfterTurnId: row.available_after_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface AdventureQueueDbRow {
  id: number | string;
  session_id: string;
  player_id: number | string;
  turn_id: string | null;
  status: AdventureQueueStatus;
  source: AdventureQueueSource;
  adventure_kind: AdventureKind;
  priority: number | string;
  seed: string;
  sequence: number | string;
  table_id: string;
  roll_result: unknown;
  context_snapshot: unknown;
  blueprint: unknown;
  dedupe_key: string | null;
  available_after_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return Math.min(limit, MAX_LIMIT);
}

function positiveInt(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function readPositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function readNullablePositiveInt(value: unknown): number | null | undefined {
  if (value === null) return null;
  return readPositiveInt(value);
}

function nullableNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNonEmptyString(value: unknown, name: string): string {
  const text = readString(value);
  if (!text) throw new Error(`${name} must be a non-empty string`);
  return text;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((v): v is string => Boolean(v));
}

function readQuestStatus(value: unknown): string | undefined {
  const status = readString(value);
  if (status == null) return undefined;
  if (!QUEST_STATUSES.has(status))
    throw new Error(`unsupported quest status: ${status}`);
  return status;
}

function readAdventureKind(value: unknown): AdventureKind | undefined {
  const kind = readString(value);
  if (kind == null) return undefined;
  if (!ADVENTURE_KINDS.has(kind))
    throw new Error(`unsupported adventure kind: ${kind}`);
  return kind as AdventureKind;
}

function readDanger(value: unknown): 'safe' | 'risky' | 'deadly' | undefined {
  const danger = readString(value);
  if (danger === 'safe' || danger === 'risky' || danger === 'deadly') {
    return danger;
  }
  if (danger == null) return undefined;
  throw new Error(`unsupported adventure danger: ${danger}`);
}

function readRuntimeScope(value: unknown): 'per_player' | 'global' | undefined {
  const scope = readString(value);
  if (scope === 'per_player' || scope === 'global') return scope;
  if (scope == null) return undefined;
  throw new Error(`unsupported runtime field scope: ${scope}`);
}

function readRuntimeValueType(value: unknown): string | undefined {
  const valueType = readString(value);
  if (valueType == null) return undefined;
  if (valueType === 'number') return 'int';
  if (
    [
      'int',
      'float',
      'bool',
      'string',
      'enum',
      'entity_ref',
      'json',
      'dice',
    ].includes(valueType)
  ) {
    return valueType;
  }
  throw new Error(`unsupported runtime field value_type: ${valueType}`);
}

function inferRuntimeValueType(value: unknown): string {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'string';
  return 'json';
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecordRequired(
  value: unknown,
  name: string,
): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error(`${name} must be an object`);
  return record;
}
