/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { query } from '../db.js';
import type { Session } from '../sessionManager.js';
import {
  emitAdventureHook,
  getAdventureQueueRow,
  markAdventureReady,
  maybeEnqueueAdventureOpportunity,
  ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
  type AdventureBlueprint,
  acceptPlayerAdventure,
  ignorePlayerAdventure,
  listPlayerAdventures,
  maybeAcceptReadyAdventureFromText,
  maybeIgnoreReadyAdventureFromText,
} from '../domain/adventure/index.js';

export async function runAdventureQueueEndToEndFixture(opts: {
  sessionId: string;
  playerId: number;
  locationId: number;
  ownerId: number;
  suffix: string;
  session?: Session;
  events?: Array<{ event?: string; data?: string; id?: string }>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const turnId = `support-smoke-adventure-e2e-${opts.suffix}`;
  const queued = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      turnId,
      source: 'manual_debug',
      mode: 'travel',
      seed: `support-adventure-e2e-${opts.suffix}`,
      sequence: 1,
      visible: false,
    },
    {
      text: 'support smoke adventure end to end',
      narrative: 'A marker waits at the roadside, but no canon changes yet.',
      toolHistory: [],
      mode: 'travel',
    },
  );
  if (!queued.row)
    throw new Error('end-to-end adventure fixture did not queue');

  const locationName = `Support Smoke E2E Spur ${opts.suffix}`;
  const blueprint = buildQuestBlueprint({
    queueId: queued.row.id,
    adventureKind: queued.row.adventureKind,
    locationName,
    locationId: opts.locationId,
    ownerId: opts.ownerId,
  });
  const ready = await markAdventureReady(queued.row.id, blueprint);
  if (!ready) throw new Error('end-to-end adventure did not become ready');
  await emitAdventureHook(ready, undefined);

  const listed = await listPlayerAdventures({
    playerId: opts.playerId,
    sessionId: opts.sessionId,
  });
  if (!listed.some((row) => row.queueId === ready.id)) {
    throw new Error('ready adventure was not exposed by player route service');
  }
  const preAcceptQuestRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM player_quests pq
       JOIN entities q ON q.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND q.display_name = $2`,
    [opts.playerId, `Find ${locationName}`],
  );
  if (preAcceptQuestRows !== 0) {
    throw new Error('ready adventure auto-created quest before accept');
  }
  const recapText =
    `@${opts.ownerId} stop and verify state: which promises, items, debts, ` +
    `and threats really exist around ${locationName}, and what was only my guess? ` +
    `Give one next move.`;
  const falseAccept = await maybeAcceptReadyAdventureFromText({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    turnId: `support-smoke-adventure-false-accept-${opts.suffix}`,
    text: recapText,
  });
  if (falseAccept.accepted) {
    throw new Error(
      `state recap text accepted ready adventure ${ready.id}: ${JSON.stringify(falseAccept)}`,
    );
  }
  const stillReady = await getAdventureQueueRow(ready.id);
  if (stillReady?.status !== 'ready') {
    throw new Error(
      `state recap text mutated adventure status: ${stillReady?.status}`,
    );
  }

  const priorActiveTurn = opts.session?.activeTurn;
  if (opts.session) opts.session.activeTurn = undefined;
  let accepted: Awaited<ReturnType<typeof acceptPlayerAdventure>>;
  try {
    accepted = await acceptPlayerAdventure({
      playerId: opts.playerId,
      queueId: ready.id,
      sessionId: opts.sessionId,
    });
  } finally {
    if (opts.session && priorActiveTurn)
      opts.session.activeTurn = priorActiveTurn;
  }
  if (!accepted.ok) {
    throw new Error(
      `accept adventure failed: ${accepted.reason} ${accepted.message ?? ''}`,
    );
  }
  if (accepted.followup?.emitted !== true) {
    throw new Error(
      `button adventure accept did not emit follow-up turn: ${JSON.stringify(accepted.followup)}`,
    );
  }
  const acceptedRow = await getAdventureQueueRow(ready.id);
  if (acceptedRow?.status !== 'accepted') {
    throw new Error(
      `accepted adventure status drifted: ${acceptedRow?.status}`,
    );
  }
  const questRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM player_quests pq
       JOIN entities q ON q.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND q.display_name = $2
        AND pq.status = 'active'`,
    [opts.playerId, `Find ${locationName}`],
  );
  if (questRows !== 1)
    throw new Error('accepted adventure did not start quest');
  const spawnedRows = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM entities
      WHERE display_name = $1
        AND kind = 'location'`,
    [locationName],
  );
  if (spawnedRows !== 1)
    throw new Error('accepted adventure did not spawn location');
  const followupTurnId = `adventure-accept:${ready.id}:details`;
  const followupRows = await query<{
    id: number;
    author_entity_id: number | string | null;
    text: string;
  }>(
    `SELECT id, author_entity_id, text
       FROM chat_messages
      WHERE session_id = $1
        AND payload->>'turn_id' = $2
        AND payload->>'source' = 'adventure_accept_followup'`,
    [opts.sessionId, followupTurnId],
  );
  if (followupRows.rows.length !== 1) {
    throw new Error(
      `expected one adventure accept follow-up row, got ${followupRows.rows.length}`,
    );
  }
  const followup = followupRows.rows[0]!;
  if (Number(followup.author_entity_id) !== opts.ownerId) {
    throw new Error(
      `follow-up author drifted: expected ${opts.ownerId}, got ${followup.author_entity_id}`,
    );
  }
  if (
    !followup.text.includes(`Find ${locationName}`) ||
    !followup.text.includes(`Find the marker that reveals ${locationName}.`)
  ) {
    throw new Error(`follow-up text missed quest details: ${followup.text}`);
  }
  if (opts.events) {
    const liveTypes = opts.events
      .filter((event) => eventForTurn(event, followupTurnId))
      .map((event) => event.event);
    const expected = ['turn.start', 'narrate', 'content', 'turn.end'];
    for (const type of expected) {
      if (!liveTypes.includes(type)) {
        throw new Error(
          `follow-up SSE missed ${type}: ${liveTypes.join(' -> ')}`,
        );
      }
    }
  }

  const textAccepted = await runStructuredTextAcceptFixture({
    ...opts,
    locationName: `${locationName} Text Accept`,
  });
  const ignoreResult = await runIgnoreDoesNotMutateFixture(opts);
  const actionIgnored = await runStructuredIgnoreFixture(opts);
  const orderRows = await query<{
    id: number;
    event_type: string;
    release_seq: number | string | null;
  }>(
    `SELECT id, event_type, release_seq
       FROM gui_events
      WHERE session_id = $1
        AND event_type IN ('adventure:hook', 'adventure:accepted', 'quest:created')
        AND (payload->>'queueId' = $2 OR payload->>'title' = $3)
      ORDER BY release_seq ASC NULLS LAST, id ASC`,
    [opts.sessionId, String(ready.id), `Find ${locationName}`],
  );
  const hookIndex = orderRows.rows.findIndex(
    (row) => row.event_type === 'adventure:hook',
  );
  const acceptedIndex = orderRows.rows.findIndex(
    (row) => row.event_type === 'adventure:accepted',
  );
  if (hookIndex < 0 || acceptedIndex < 0 || hookIndex >= acceptedIndex) {
    throw new Error(
      `adventure hook/accept ordering drifted: ${orderRows.rows.map((row) => row.event_type).join(' -> ')}`,
    );
  }

  return {
    queueId: ready.id,
    status: acceptedRow.status,
    listedReady: listed.length,
    spawnedLocation: locationName,
    followupTurnId,
    followupMessageId: accepted.followup.messageId,
    textAccepted,
    eventOrder: orderRows.rows.map((row) => row.event_type),
    ignore: ignoreResult,
    actionIgnored,
  };
}

function buildQuestBlueprint(opts: {
  queueId: number;
  adventureKind: AdventureBlueprint['adventureKind'];
  locationName: string;
  locationId: number;
  ownerId: number;
}): AdventureBlueprint {
  return {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    queueId: opts.queueId,
    adventureKind: opts.adventureKind,
    title: `Road Sign to ${opts.locationName}`,
    summary: 'A replayable support fixture opportunity.',
    playerFacingHook: `A fresh mark points toward @${opts.locationName}. It can become a real lead if accepted.`,
    danger: 'risky',
    suggestedQuest: {
      title: `Find ${opts.locationName}`,
      summary: 'Follow the support fixture marker and reveal the hidden spur.',
      goal_text: `Find the marker that reveals ${opts.locationName}.`,
      source: 'npc_giver',
      mode: 'create_new',
      giverEntityId: opts.ownerId,
      stages: [
        { id: 'open', title: 'Find the marker', next_stage: 'reveal_spur' },
        { id: 'reveal_spur', title: 'Reveal the spur' },
      ],
      tags: ['adventure-e2e'],
      spawn_entities: [
        {
          kind: 'location',
          display_name: opts.locationName,
          summary:
            'A hidden support-smoke location created through adventure accept.',
          tags: [],
          profile: {
            support_smoke: true,
            topology_parent_id: opts.locationId,
            owner_entity_id: opts.ownerId,
            access_policy: 'public',
            access_reason:
              'the support fixture owner points out the marker before the reveal',
          },
          hidden_until_stage: 'reveal_spur',
        },
      ],
    },
  };
}

async function runStructuredTextAcceptFixture(opts: {
  sessionId: string;
  playerId: number;
  locationId: number;
  ownerId: number;
  suffix: string;
  locationName: string;
}): Promise<unknown> {
  const turnId = `support-smoke-adventure-text-accept-${opts.suffix}`;
  const queued = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      turnId,
      source: 'manual_debug',
      mode: 'travel',
      seed: `support-adventure-text-accept-${opts.suffix}`,
      sequence: 1,
      visible: false,
    },
    {
      text: 'support smoke structured adventure accept',
      narrative: 'A second marker waits for a structured text accept token.',
      toolHistory: [],
      mode: 'travel',
    },
  );
  if (!queued.row) {
    throw new Error('structured text accept adventure did not queue');
  }
  const ready = await markAdventureReady(
    queued.row.id,
    buildQuestBlueprint({
      queueId: queued.row.id,
      adventureKind: queued.row.adventureKind,
      locationName: opts.locationName,
      locationId: opts.locationId,
      ownerId: opts.ownerId,
    }),
  );
  if (!ready) throw new Error('structured text accept adventure did not ready');
  const accepted = await maybeAcceptReadyAdventureFromText({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    turnId,
    text: `[[adventure.accept:${ready.id}]]`,
  });
  if (!accepted.accepted) {
    throw new Error(
      `structured text accept failed: ${JSON.stringify(accepted)}`,
    );
  }
  const finalRow = await getAdventureQueueRow(ready.id);
  if (finalRow?.status !== 'accepted') {
    throw new Error(
      `structured text accept status drifted: ${finalRow?.status}`,
    );
  }
  return { queueId: ready.id, status: finalRow.status };
}

async function runIgnoreDoesNotMutateFixture(opts: {
  sessionId: string;
  playerId: number;
  suffix: string;
}): Promise<unknown> {
  const queued = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      turnId: `support-smoke-adventure-ignore-${opts.suffix}`,
      source: 'manual_debug',
      mode: 'travel',
      seed: `support-adventure-ignore-${opts.suffix}`,
      sequence: 1,
      visible: false,
    },
    {
      text: 'support smoke adventure ignore',
      narrative: 'A second marker is deliberately ignored.',
      toolHistory: [],
      mode: 'travel',
    },
  );
  if (!queued.row) throw new Error('ignore adventure fixture did not queue');
  const itemName = `Support Smoke Ignored Cache ${opts.suffix}`;
  const blueprint: AdventureBlueprint = {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    queueId: queued.row.id,
    adventureKind: queued.row.adventureKind,
    title: `Ignored Cache ${opts.suffix}`,
    summary: 'A fixture that must not mutate when ignored.',
    playerFacingHook: `A cache named @${itemName} is only an option, not canon yet.`,
    danger: 'safe',
    standaloneSpawns: [
      {
        kind: 'item',
        display_name: itemName,
        summary: 'This item should not exist after ignore.',
        tags: [],
      },
    ],
  };
  const ready = await markAdventureReady(queued.row.id, blueprint);
  if (!ready) throw new Error('ignore adventure did not become ready');
  const before = await countRows(
    `SELECT COUNT(*)::int AS count FROM entities WHERE display_name = $1`,
    [itemName],
  );
  const ignored = await ignorePlayerAdventure({
    playerId: opts.playerId,
    queueId: ready.id,
    sessionId: opts.sessionId,
    reason: 'support_smoke_ignore',
  });
  if (!ignored.ok) {
    throw new Error(
      `ignore adventure failed: ${ignored.reason} ${ignored.message ?? ''}`,
    );
  }
  if (!ignored.consequence?.threadId && ignored.consequence?.memoryId == null) {
    throw new Error('ignore adventure did not record refusal consequence');
  }
  const after = await countRows(
    `SELECT COUNT(*)::int AS count FROM entities WHERE display_name = $1`,
    [itemName],
  );
  if (before !== 0 || after !== 0) {
    throw new Error(
      `ignored adventure mutated entities: before=${before}, after=${after}`,
    );
  }
  const ignoredEvents = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM gui_events
      WHERE session_id = $1
        AND event_type = 'adventure:ignored'
        AND payload->>'queueId' = $2`,
    [opts.sessionId, String(ready.id)],
  );
  if (ignoredEvents !== 0) {
    throw new Error(
      'adventure:ignored emitted for a hook that was never visible',
    );
  }
  return { queueId: ready.id, status: ignored.status, ignoredEvents };
}

async function runStructuredIgnoreFixture(opts: {
  sessionId: string;
  playerId: number;
  suffix: string;
}): Promise<unknown> {
  const turnId = `support-smoke-adventure-action-ignore-${opts.suffix}`;
  const queued = await maybeEnqueueAdventureOpportunity(
    {
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      turnId,
      source: 'manual_debug',
      mode: 'travel',
      seed: `support-adventure-action-ignore-${opts.suffix}`,
      sequence: 1,
      visible: false,
    },
    {
      text: 'support smoke adventure action ignore',
      narrative:
        'A visible marker is deliberately declined through an action id.',
      toolHistory: [],
      mode: 'travel',
    },
  );
  if (!queued.row) {
    throw new Error('structured ignore adventure fixture did not queue');
  }
  const itemName = `Support Smoke Action Ignored Cache ${opts.suffix}`;
  const blueprint: AdventureBlueprint = {
    schemaVersion: ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
    queueId: queued.row.id,
    adventureKind: queued.row.adventureKind,
    title: `Action Ignored Cache ${opts.suffix}`,
    summary: 'A fixture that must not mutate when ignored via turn action.',
    playerFacingHook: `A cache named @${itemName} is visible, but refusal must not materialize it.`,
    danger: 'safe',
    standaloneSpawns: [
      {
        kind: 'item',
        display_name: itemName,
        summary: 'This item should not exist after action ignore.',
        tags: [],
      },
    ],
  };
  const ready = await markAdventureReady(queued.row.id, blueprint);
  if (!ready)
    throw new Error('structured ignore adventure did not become ready');
  await emitAdventureHook(ready, undefined);
  const before = await countRows(
    `SELECT COUNT(*)::int AS count FROM entities WHERE display_name = $1`,
    [itemName],
  );
  const ignored = await maybeIgnoreReadyAdventureFromText({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    turnId,
    text: 'Пропустить',
    actionId: `adventure.ignore:${ready.id}`,
  });
  if (!ignored.ignored || ignored.queueId !== ready.id) {
    throw new Error(`structured ignore failed: ${JSON.stringify(ignored)}`);
  }
  if (!ignored.consequence?.threadId && ignored.consequence?.memoryId == null) {
    throw new Error('structured ignore did not record refusal consequence');
  }
  const finalRow = await getAdventureQueueRow(ready.id);
  if (finalRow?.status !== 'cancelled') {
    throw new Error(`structured ignore status drifted: ${finalRow?.status}`);
  }
  const after = await countRows(
    `SELECT COUNT(*)::int AS count FROM entities WHERE display_name = $1`,
    [itemName],
  );
  if (before !== 0 || after !== 0) {
    throw new Error(
      `action ignored adventure mutated entities: before=${before}, after=${after}`,
    );
  }
  const ignoredEvents = await countRows(
    `SELECT COUNT(*)::int AS count
       FROM gui_events
      WHERE session_id = $1
        AND event_type = 'adventure:ignored'
        AND payload->>'queueId' = $2`,
    [opts.sessionId, String(ready.id)],
  );
  if (ignoredEvents !== 1) {
    throw new Error(`structured ignore event count drifted: ${ignoredEvents}`);
  }
  return {
    queueId: ready.id,
    status: finalRow.status,
    ignoredEvents,
    hookTitle: ignored.hook?.['title'] ?? null,
  };
}

function eventForTurn(
  event: { event?: string; data?: string },
  turnId: string,
): boolean {
  if (!event.data) return false;
  try {
    const data = JSON.parse(event.data) as { turnId?: string };
    return data.turnId === turnId;
  } catch {
    return false;
  }
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{ count: number | string }>(sql, params);
  return Number(rows.rows[0]?.count ?? 0);
}
