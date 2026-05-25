import {playerScopedChatPredicate} from '../../../chatHistoryScope.js';
import {activeCartridgeEntityPredicate} from '../../../cartridgeScope.js';
import {qualitySqlPredicate} from '../../../contentQuality.js';
import {query} from '../../../db.js';
import {selectAdventureMaterializerRelevantMemories} from '../../memory/index.js';
import {
  ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
} from '../runtime/adventureBlueprint.js';
import type {AdventureQueueRow} from '../runtime/adventureQueue.js';
import {normalizeAgentLanguageCode} from '../../../agents/agentLanguageContract.js';
import {resolveActivePlayerCartridgeId} from '../../../services/CartridgePlaythroughService.js';
import type {AdventureMaterializerInput} from './types.js';

export async function buildMaterializerInput(
  queue: AdventureQueueRow,
): Promise<AdventureMaterializerInput> {
  const player = await query<{
    display_name: string;
    current_level: number | string;
    current_location_id: number | string | null;
    location_name: string | null;
  }>(
    `SELECT e.display_name,
            p.current_level,
            p.current_location_id,
            loc.display_name AS location_name
       FROM players p
       JOIN entities e ON e.id = p.entity_id
       LEFT JOIN entities loc ON loc.id = p.current_location_id
      WHERE p.entity_id = $1`,
    [queue.playerId],
  );
  const playerRow = player.rows[0];
  const cartridgeId = await resolveMaterializerCartridgeId(queue.playerId);
  const activeQuests = await query<{
    id: number;
    title: string;
    summary: string | null;
    current_stage_id: string | null;
    tags: string[] | null;
    stages: unknown;
  }>(
    `SELECT q.id, q.display_name AS title, q.summary, pq.current_stage_id,
            q.tags,
            q.profile->'stages' AS stages
       FROM player_quests pq
      JOIN entities q ON q.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status = 'active'
        ${
          cartridgeId != null
            ? `AND ${activeCartridgeEntityPredicate('q', '$2')}`
            : ''
        }
      ORDER BY pq.started_at DESC NULLS LAST, q.id DESC
      LIMIT 8`,
    cartridgeId != null ? [queue.playerId, cartridgeId] : [queue.playerId],
  );
  const currentLocationId =
    playerRow?.current_location_id == null
      ? null
      : Number(playerRow.current_location_id);
  const locationContext = await loadLocationContext(
    currentLocationId,
    cartridgeId,
  );
  const nearby = await loadNearby(currentLocationId, queue.playerId, cartridgeId);
  const relationships = await loadRelationships(queue.playerId, nearby);
  const relevantEntityIds = [
    queue.playerId,
    ...(currentLocationId == null ? [] : [currentLocationId]),
    ...nearby.map(entity => entity.id),
    ...activeQuests.rows.map(row => Number(row.id)),
  ];
  const relevantMemories = await loadRelevantMemories(relevantEntityIds);
  const activeSituations = await loadActiveSituations(queue);
  const duplicateCandidates = await query<{
    id: number;
    kind: string;
    display_name: string;
  }>(
    `SELECT id, kind, display_name
      FROM entities
      WHERE kind IN ('location','scene','item','person','event','service')
        ${
          cartridgeId != null
            ? `AND ${activeCartridgeEntityPredicate('entities', '$1')}`
            : ''
        }
        AND ${qualitySqlPredicate('entities')}
      ORDER BY id DESC
      LIMIT 80`,
    cartridgeId != null ? [cartridgeId] : [],
  );
  const recentNarrative = await query<{text: string}>(
    `SELECT cm.text
       FROM chat_messages cm
      WHERE cm.session_id = $1
        AND ${playerScopedChatPredicate('cm', 2)}
        AND cm.tone <> 'player'
      ORDER BY id DESC
      LIMIT 4`,
    [queue.sessionId, queue.playerId],
  );

  return {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    language: normalizeAgentLanguageCode(
      queue.contextSnapshot['language'] as string | null,
    ),
    queue: {
      id: queue.id,
      adventureKind: queue.adventureKind,
      source: queue.source,
      tableId: queue.tableId,
      seed: queue.seed,
      sequence: queue.sequence,
      rollResult: queue.rollResult,
      contextSnapshot: queue.contextSnapshot,
    },
    player: {
      id: queue.playerId,
      name: playerRow?.display_name ?? String(queue.playerId),
      level: Number(playerRow?.current_level ?? 1),
      currentLocationId,
      currentLocationName: playerRow?.location_name ?? null,
    },
    locationContext,
    activeQuests: activeQuests.rows.map(row => ({
      id: Number(row.id),
      title: row.title,
      summary: row.summary,
      currentStageId: row.current_stage_id,
      tags: row.tags ?? [],
      stages: parseQuestStages(row.stages),
    })),
    nearby,
    relationships,
    relevantMemories,
    activeSituations,
    duplicateCandidates: duplicateCandidates.rows.map(row => ({
      id: Number(row.id),
      kind: row.kind,
      displayName: row.display_name,
    })),
    recentNarrative: recentNarrative.rows
      .map(row => row.text.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .reverse()
      .join('\n')
      .slice(0, 1600),
  };
}

async function resolveMaterializerCartridgeId(
  playerId: number,
): Promise<string | null> {
  try {
    return await resolveActivePlayerCartridgeId(playerId);
  } catch {
    return null;
  }
}

async function loadNearby(
  currentLocationId: number | null,
  playerId: number,
  cartridgeId: string | null,
): Promise<AdventureMaterializerInput['nearby']> {
  if (currentLocationId == null) return [];
  const scopeRow = await query<{power_center_id: string | null}>(
    `SELECT profile->>'power_center_id' AS power_center_id
       FROM entities
      WHERE id = $1
        ${
          cartridgeId != null
            ? `AND ${activeCartridgeEntityPredicate('entities', '$2')}`
            : ''
        }`,
    cartridgeId != null ? [currentLocationId, cartridgeId] : [currentLocationId],
  );
  const powerCenterId = parseOptionalPositiveInt(scopeRow.rows[0]?.power_center_id);
  const scopeIds = powerCenterId != null && powerCenterId !== currentLocationId
    ? [String(currentLocationId), String(powerCenterId)]
    : [String(currentLocationId)];
  const rows = await query<{
    id: number;
    kind: string;
    display_name: string;
    summary: string | null;
    home_id: string | null;
    location_id: string | null;
    power_center_id: string | null;
    owner_entity_id: string | null;
    topology_parent_id: string | null;
    access_policy: string | null;
    access_reason: string | null;
    hidden_until_stage: string | null;
    current_location_id: string | null;
  }>(
    `SELECT id, kind, display_name, summary,
            profile->>'home_id' AS home_id,
            profile->>'location_id' AS location_id,
            profile->>'current_location_id' AS current_location_id,
            profile->>'power_center_id' AS power_center_id,
            profile->>'owner_entity_id' AS owner_entity_id,
            topology_parent_id::text AS topology_parent_id,
            profile->>'access_policy' AS access_policy,
            profile->>'access_reason' AS access_reason,
            profile->>'hidden_until_stage' AS hidden_until_stage
      FROM entities
      WHERE (
           profile->>'home_id' = ANY($1::text[])
        OR profile->>'location_id' = ANY($1::text[])
        OR profile->>'current_location_id' = ANY($1::text[])
        OR topology_parent_id = ANY($1::text[]::bigint[])
        OR profile->>'power_center_id' = ANY($1::text[])
        OR id = $2
      )
        ${
          cartridgeId != null
            ? `AND ${activeCartridgeEntityPredicate('entities', '$4')}`
            : ''
        }
        AND ${qualitySqlPredicate('entities')}
        AND NOT (
          kind = 'person'
          AND EXISTS (
            SELECT 1 FROM actor_statuses s
             WHERE s.player_id = $3
               AND s.actor_entity_id = entities.id
               AND s.intensity > 0
               AND s.status_kind IN ('dead', 'missing')
          )
      )
      ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END, id
      LIMIT 40`,
    cartridgeId != null
      ? [scopeIds, currentLocationId, playerId, cartridgeId]
      : [scopeIds, currentLocationId, playerId],
  );
  return rows.rows.map(row => ({
    id: Number(row.id),
    kind: row.kind,
    displayName: row.display_name,
    summary: row.summary,
    locationId: parseOptionalPositiveInt(row.location_id),
    powerCenterId: parseOptionalPositiveInt(row.power_center_id),
    homeId: row.home_id == null ? null : Number(row.home_id),
    ownerEntityId: parseOptionalPositiveInt(row.owner_entity_id),
    topologyParentId: parseOptionalPositiveInt(row.topology_parent_id),
    accessPolicy: row.access_policy,
    accessReason: row.access_reason,
    hiddenUntilStage: row.hidden_until_stage,
    reachable:
      row.id === currentLocationId ||
      row.home_id === String(currentLocationId) ||
      row.location_id === String(currentLocationId) ||
      row.current_location_id === String(currentLocationId) ||
      scopeIds.includes(String(row.power_center_id)) ||
      row.topology_parent_id === String(currentLocationId),
  }));
}

async function loadLocationContext(
  currentLocationId: number | null,
  cartridgeId: string | null,
): Promise<AdventureMaterializerInput['locationContext']> {
  if (currentLocationId == null) return null;
  const row = await query<{
    id: number;
    kind: string;
    display_name: string;
    summary: string | null;
    owner_entity_id: string | null;
    topology_parent_id: string | null;
    access_policy: string | null;
    access_reason: string | null;
    hidden_until_stage: string | null;
    exits: unknown;
  }>(
    `SELECT id, kind, display_name, summary,
            profile->>'owner_entity_id' AS owner_entity_id,
            topology_parent_id::text AS topology_parent_id,
            profile->>'access_policy' AS access_policy,
            profile->>'access_reason' AS access_reason,
            profile->>'hidden_until_stage' AS hidden_until_stage,
            profile->'exits' AS exits
       FROM entities
      WHERE id = $1
        ${
          cartridgeId != null
            ? `AND ${activeCartridgeEntityPredicate('entities', '$2')}`
            : ''
        }
        AND ${qualitySqlPredicate('entities')}`,
    cartridgeId != null ? [currentLocationId, cartridgeId] : [currentLocationId],
  );
  const location = row.rows[0];
  if (!location) return null;
  const exitIds = Array.isArray(location.exits)
    ? location.exits
        .map(readExitId)
        .filter(value => Number.isInteger(value) && value > 0)
    : [];
  const exits =
    exitIds.length > 0 ? await loadLocationRefs(exitIds, cartridgeId) : [];
  return {
    id: Number(location.id),
    kind: location.kind,
    displayName: location.display_name,
    summary: location.summary,
    ownerEntityId: parseOptionalPositiveInt(location.owner_entity_id),
    topologyParentId: parseOptionalPositiveInt(location.topology_parent_id),
    accessPolicy: location.access_policy,
    accessReason: location.access_reason,
    hiddenUntilStage: location.hidden_until_stage,
    exits,
  };
}

async function loadLocationRefs(
  ids: number[],
  cartridgeId: string | null,
): Promise<NonNullable<AdventureMaterializerInput['locationContext']>['exits']> {
  const rows = await query<{
    id: number;
    kind: string;
    display_name: string;
    summary: string | null;
    owner_entity_id: string | null;
    topology_parent_id: string | null;
    access_policy: string | null;
    access_reason: string | null;
    hidden_until_stage: string | null;
  }>(
    `SELECT id, kind, display_name, summary,
            profile->>'owner_entity_id' AS owner_entity_id,
            topology_parent_id::text AS topology_parent_id,
            profile->>'access_policy' AS access_policy,
            profile->>'access_reason' AS access_reason,
            profile->>'hidden_until_stage' AS hidden_until_stage
       FROM entities
      WHERE id = ANY($1::bigint[])
        ${
          cartridgeId != null
            ? `AND ${activeCartridgeEntityPredicate('entities', '$2')}`
            : ''
        }
        AND ${qualitySqlPredicate('entities')}
      ORDER BY array_position($1::bigint[], id)`,
    cartridgeId != null ? [ids, cartridgeId] : [ids],
  );
  return rows.rows.map(row => ({
    id: Number(row.id),
    kind: row.kind,
    displayName: row.display_name,
    summary: row.summary,
    ownerEntityId: parseOptionalPositiveInt(row.owner_entity_id),
    topologyParentId: parseOptionalPositiveInt(row.topology_parent_id),
    accessPolicy: row.access_policy,
    accessReason: row.access_reason,
    hiddenUntilStage: row.hidden_until_stage,
  }));
}

async function loadRelationships(
  playerId: number,
  nearby: AdventureMaterializerInput['nearby'],
): Promise<AdventureMaterializerInput['relationships']> {
  const people = nearby.filter(entity => entity.kind === 'person');
  if (people.length <= 0) return [];
  const ids = people.map(entity => entity.id);
  const rows = await query<{owner_entity_id: number; value: unknown}>(
    `SELECT rf.owner_entity_id, COALESCE(rv.value, rf.default_value) AS value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = ANY($1::bigint[])
        AND rf.field_key = 'strings'`,
    [ids],
  );
  const values = new Map<number, number>();
  for (const row of rows.rows) {
    const map = row.value;
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    values.set(
      row.owner_entity_id,
      Number((map as Record<string, unknown>)[String(playerId)] ?? 0),
    );
  }
  return people.map(person => {
    const strings = values.get(person.id) ?? 0;
    return {
      npcId: person.id,
      npcName: person.displayName,
      strings,
      band: relationshipBand(strings),
    };
  });
}

async function loadRelevantMemories(
  entityIds: number[],
): Promise<AdventureMaterializerInput['relevantMemories']> {
  const ids = [...new Set(entityIds.filter(id => Number.isInteger(id) && id > 0))];
  const rows = await selectAdventureMaterializerRelevantMemories({
    entityIds: ids,
    limit: 12,
  });
  return rows.map(row => ({
    ownerEntityId: Number(row.owner_entity_id),
    ownerName: row.owner_name,
    aboutEntityId: row.about_entity_id == null ? null : Number(row.about_entity_id),
    aboutName: row.about_name,
    text: row.text,
    importance: Number(row.importance ?? 0),
    tags: row.tags ?? [],
  }));
}

async function loadActiveSituations(
  queue: AdventureQueueRow,
): Promise<AdventureMaterializerInput['activeSituations']> {
  const rows = await query<{
    id: number;
    status: string;
    adventure_kind: string;
    turn_id: string | null;
    blueprint: Record<string, unknown> | null;
  }>(
    `SELECT id, status, adventure_kind, turn_id, blueprint
       FROM adventure_queue
      WHERE session_id = $1
        AND player_id = $2
        AND id <> $3
        AND status IN ('queued', 'materializing', 'ready', 'accepted')
      ORDER BY id DESC
      LIMIT 8`,
    [queue.sessionId, queue.playerId, queue.id],
  );
  return rows.rows.map(row => {
    const blueprint = row.blueprint ?? {};
    const suggestedQuest =
      blueprint['suggestedQuest'] &&
      typeof blueprint['suggestedQuest'] === 'object' &&
      !Array.isArray(blueprint['suggestedQuest'])
        ? (blueprint['suggestedQuest'] as Record<string, unknown>)
        : {};
    const scenario =
      blueprint['scenario'] &&
      typeof blueprint['scenario'] === 'object' &&
      !Array.isArray(blueprint['scenario'])
        ? (blueprint['scenario'] as Record<string, unknown>)
        : {};
    return {
      queueId: Number(row.id),
      status: row.status,
      adventureKind: row.adventure_kind,
      turnId: row.turn_id,
      title: typeof blueprint['title'] === 'string' ? blueprint['title'] : null,
      summary:
        typeof blueprint['summary'] === 'string' ? blueprint['summary'] : null,
      pressureType:
        typeof scenario['pressureType'] === 'string'
          ? scenario['pressureType']
          : null,
      existingQuestId: parseOptionalPositiveInt(suggestedQuest['existingQuestId']),
    };
  });
}

function parseQuestStages(
  value: unknown,
): Array<{id: string; title: string; next_stage?: string}> {
  if (!Array.isArray(value)) return [];
  return value
    .map(stage => {
      if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return null;
      const record = stage as Record<string, unknown>;
      if (typeof record['id'] !== 'string' || typeof record['title'] !== 'string') {
        return null;
      }
      return {
        id: record['id'],
        title: record['title'],
        ...(typeof record['next_stage'] === 'string'
          ? {next_stage: record['next_stage']}
          : {}),
      };
    })
    .filter((stage): stage is {id: string; title: string; next_stage?: string} => stage != null)
    .slice(0, 8);
}

function parseOptionalPositiveInt(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readExitId(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Number((value as Record<string, unknown>)['id']);
  }
  return Number(value);
}

function relationshipBand(strings: number): string {
  if (strings <= -3) return 'hostile';
  if (strings < 0) return 'wary';
  if (strings >= 5) return 'bonded';
  if (strings >= 3) return 'trusted';
  if (strings > 0) return 'friendly';
  return 'neutral';
}
