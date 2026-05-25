/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';
import {
  emitAdventureHook,
  expireStaleReadyAdventures,
  getAdventureQueueRow,
  markAdventureReady,
  maybeEnqueueAdventureOpportunity,
  maybeAcceptReadyAdventureFromText,
  ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
  type AdventureBlueprint,
  acceptPlayerAdventure,
} from '../domain/adventure/index.js';

export async function runAdventurePhase2Fixture(opts: {
  sessionId: string;
  playerId: number;
  locationId: number;
  ownerId: number;
  suffix: string;
}): Promise<unknown> {
  const structuredText = await runStructuredTextAcceptanceFixture(opts);
  const expiry = await runExpiryFixture(opts);
  const itemPlacement = await runItemPlacementFixture(opts);
  const encounter = await runEncounterNoDamageFixture(opts);
  return {structuredText, expiry, itemPlacement, encounter};
}

async function runStructuredTextAcceptanceFixture(opts: {
  sessionId: string;
  playerId: number;
  locationId: number;
  ownerId: number;
  suffix: string;
}): Promise<unknown> {
  const turnId = `support-smoke-adventure-structured-base-${opts.suffix}`;
  const locationName = `Support Smoke Structured Spur ${opts.suffix}`;
  const ready = await queueReadyAdventure(
    opts,
    turnId,
    `support-adventure-structured-${opts.suffix}`,
    row => ({
      schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
      queueId: row.id,
      adventureKind: row.adventureKind,
      title: `Structured Sign to ${locationName}`.slice(0, 120),
      summary: 'A support fixture hook accepted through a structured token.',
      playerFacingHook:
        `A fresh mark points toward @${locationName}. It can be accepted by queue id.`,
      danger: 'safe',
      suggestedQuest: {
        title: `Follow ${locationName}`.slice(0, 80),
        summary: 'Follow the structured acceptance marker.',
        goal_text: `Follow the mark toward ${locationName}.`,
        stages: [{id: 'open', title: 'Follow the mark'}],
        tags: ['adventure-structured-text'],
        spawn_entities: [
          {
            kind: 'location',
            display_name: locationName,
            summary: 'A hidden support-smoke location created by structured accept.',
            tags: [],
            profile: {
              support_smoke: true,
              topology_parent_id: opts.locationId,
              owner_entity_id: opts.ownerId,
              access_policy: 'public',
              access_reason: 'the support fixture marker is revealed by the local owner',
            },
            hidden_until_stage: 'open',
          },
        ],
      },
    }),
  );

  const result = await maybeAcceptReadyAdventureFromText({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    turnId: `support-smoke-adventure-structured-accept-${opts.suffix}`,
    text: `[[adventure.accept:${ready.id}]]`,
  });
  if (!result.accepted || result.queueId !== ready.id) {
    throw new Error(`structured adventure acceptance failed: ${JSON.stringify(result)}`);
  }
  const accepted = await getAdventureQueueRow(ready.id);
  if (accepted?.status !== 'accepted') {
    throw new Error(`structured acceptance status drifted: ${accepted?.status}`);
  }
  const questRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM player_quests pq
       JOIN entities q ON q.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND q.display_name = $2`,
    [opts.playerId, `Follow ${locationName}`.slice(0, 80)],
  );
  if (questRows !== 1) {
    throw new Error('structured acceptance did not create tracked quest');
  }
  return {queueId: ready.id, status: accepted.status};
}

async function runExpiryFixture(opts: {
  sessionId: string;
  playerId: number;
  suffix: string;
}): Promise<unknown> {
  const baseTurnId = `support-smoke-adventure-expiry-base-${opts.suffix}`;
  await insertPlayerTurn(opts.sessionId, opts.playerId, baseTurnId, 'expiry baseline');
  const ready = await queueReadyAdventure(
    opts,
    baseTurnId,
    `support-adventure-expiry-${opts.suffix}`,
    row => ({
      schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
      queueId: row.id,
      adventureKind: row.adventureKind,
      title: `Expiring Hook ${opts.suffix}`.slice(0, 120),
      summary: 'A support fixture hook that should expire.',
      playerFacingHook: 'This support fixture hook should expire after one later turn.',
      danger: 'safe',
      standaloneSpawns: [
        {
          kind: 'event',
          display_name: `Expired Event ${opts.suffix}`,
          summary: 'This event must not be spawned by expiry.',
          tags: [],
        },
      ],
    }),
  );
  await insertPlayerTurn(opts.sessionId, opts.playerId, `${baseTurnId}-later`, 'later turn');
  const expiredRows = await expireStaleReadyAdventures({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    turnId: `support-smoke-adventure-expiry-check-${opts.suffix}`,
    defaultTtlTurns: 1,
  });
  if (!expiredRows.some(row => row.id === ready.id)) {
    throw new Error(`expiry did not include queue ${ready.id}`);
  }
  const latest = await getAdventureQueueRow(ready.id);
  if (latest?.status !== 'expired') {
    throw new Error(`expiry status drifted: ${latest?.status}`);
  }
  const eventRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM gui_events
      WHERE session_id = $1
        AND event_type = 'adventure:expired'
        AND payload->>'queueId' = $2`,
    [opts.sessionId, String(ready.id)],
  );
  if (eventRows !== 1) {
    throw new Error(`expected one adventure:expired event, got ${eventRows}`);
  }
  return {queueId: ready.id, status: latest.status, expiredEvents: eventRows};
}

async function runEncounterNoDamageFixture(opts: {
  sessionId: string;
  playerId: number;
  locationId: number;
  suffix: string;
}): Promise<unknown> {
  const hpBefore = await readPlayerHp(opts.playerId);
  const ready = await queueReadyAdventure(
    opts,
    `support-smoke-adventure-encounter-${opts.suffix}`,
    `support-adventure-encounter-${opts.suffix}`,
    row => ({
      schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
      queueId: row.id,
      adventureKind: row.adventureKind,
      title: `Encounter Hook ${opts.suffix}`.slice(0, 120),
      summary: 'A support fixture encounter setup.',
      playerFacingHook:
        'Shapes move beyond the lantern light; accepting only sets up a visible roll.',
      danger: 'deadly',
      encounterPlan: {
        encounterType: 'ambush',
        budget: 'easy',
        requiredVisibleRoll: true,
        enemies: [
          {
            display_name: `Support Smoke Ambusher ${opts.suffix}`,
            role: 'ambusher',
            count: 1,
          },
        ],
      },
    }),
  );
  const accepted = await acceptPlayerAdventure({
    playerId: opts.playerId,
    queueId: ready.id,
    sessionId: opts.sessionId,
    turnId: `support-smoke-adventure-encounter-accept-${opts.suffix}`,
  });
  if (!accepted.ok) {
    throw new Error(`encounter accept failed: ${accepted.reason} ${accepted.message ?? ''}`);
  }
  const hpAfter = await readPlayerHp(opts.playerId);
  if (hpAfter !== hpBefore) {
    throw new Error(`encounter acceptance changed player HP: ${hpBefore} -> ${hpAfter}`);
  }
  const enemyRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM entities e
       JOIN runtime_fields hp ON hp.owner_entity_id = e.id
      WHERE e.kind = 'person'
        AND e.display_name = $1
        AND e.profile->>'home_id' = $2
        AND hp.field_key = 'current_hp'`,
    [`Support Smoke Ambusher ${opts.suffix}`, String(opts.locationId)],
  );
  if (enemyRows !== 1) {
    throw new Error(`encounter acceptance did not create one HP-bearing enemy, got ${enemyRows}`);
  }
  return {queueId: ready.id, hpBefore, hpAfter, enemyRows};
}

async function runItemPlacementFixture(opts: {
  sessionId: string;
  playerId: number;
  locationId: number;
  suffix: string;
}): Promise<unknown> {
  const itemName = `Support Smoke Cache Token ${opts.suffix}`;
  const ready = await queueReadyAdventure(
    opts,
    `support-smoke-adventure-item-${opts.suffix}`,
    `support-adventure-item-${opts.suffix}`,
    row => ({
      schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
      queueId: row.id,
      adventureKind: row.adventureKind,
      title: `Item Hook ${opts.suffix}`.slice(0, 120),
      summary: 'A support fixture item placement setup.',
      playerFacingHook:
        'A glint under the counter looks promising, but it must be claimed in-world.',
      danger: 'safe',
      itemPlacements: [
        {
          itemDisplayName: itemName,
          holderEntityId: opts.locationId,
          count: 2,
        },
      ],
    }),
  );
  const accepted = await acceptPlayerAdventure({
    playerId: opts.playerId,
    queueId: ready.id,
    sessionId: opts.sessionId,
    turnId: `support-smoke-adventure-item-accept-${opts.suffix}`,
  });
  if (!accepted.ok) {
    throw new Error(`item placement accept failed: ${accepted.reason} ${accepted.message ?? ''}`);
  }
  const itemRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM entities
      WHERE kind = 'item'
        AND display_name = $1
        AND profile->>'home_id' = $2
        AND profile->>'count' = '2'`,
    [itemName, String(opts.locationId)],
  );
  if (itemRows !== 1) {
    throw new Error(`item placement did not create location item, got ${itemRows}`);
  }
  return {queueId: ready.id, itemRows};
}

async function queueReadyAdventure(
  opts: {sessionId: string; playerId: number; suffix: string},
  turnId: string,
  seed: string,
  buildBlueprint: (row: {id: number; adventureKind: AdventureBlueprint['adventureKind']}) => AdventureBlueprint,
) {
  const queued = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      turnId,
      source: 'manual_debug',
      mode: 'travel',
      seed,
      sequence: 1,
      visible: false,
    },
    {
      text: 'support smoke adventure phase 2',
      narrative: 'A support fixture opportunity waits without canon mutation.',
      toolHistory: [],
      mode: 'travel',
    },
  );
  if (!queued.row) throw new Error('phase 2 adventure did not queue');
  const blueprint = buildBlueprint({
    id: queued.row.id,
    adventureKind: queued.row.adventureKind,
  });
  const ready = await markAdventureReady(queued.row.id, blueprint);
  if (!ready) throw new Error('phase 2 adventure did not become ready');
  await emitAdventureHook(ready, undefined);
  return ready;
}

async function insertPlayerTurn(
  sessionId: string,
  playerId: number,
  turnId: string,
  text: string,
): Promise<void> {
  const next = await query<{n: number}>(
    `SELECT COALESCE(MAX(turn_index), 0) + 1 AS n
       FROM chat_messages WHERE session_id = $1`,
    [sessionId],
  );
  await query(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload, player_id)
     VALUES ($1, $2, 'player', $3, $4, $5::jsonb, $2)`,
    [sessionId, playerId, text, next.rows[0]!.n, JSON.stringify({turn_id: turnId})],
  );
}

async function readPlayerHp(playerId: number): Promise<number> {
  const rows = await query<{current_hp: number | string}>(
    `SELECT current_hp FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return Number(rows.rows[0]?.current_hp ?? 0);
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{count: number | string}>(sql, params);
  return Number(rows.rows[0]?.count ?? 0);
}
