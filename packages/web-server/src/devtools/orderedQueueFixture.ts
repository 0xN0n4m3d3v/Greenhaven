/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {query} from '../db.js';
import {listGuiEvents, type GuiEventEnvelope} from '../guiEventOutbox.js';
import {
  closePresentationBarrier,
  listPostTurnPresentationSlots,
  openPresentationBarrier,
  reservePostTurnPresentationSlots,
  runPostTurnHookWithPresentation,
} from '../presentationScheduler.js';
import {applyQuestTransitionProposal} from '../quest/questTransitionArbiter.js';
import type {Session} from '../sessionManager.js';
import {dispatch} from '../tools/index.js';
import {
  enqueueTurn,
  startNextQueuedTurn,
} from '../turnIngressQueue.js';
import {buildSessionTranscriptDiagnostics} from './sessionTranscriptDiagnostics.js';

export interface OrderedQueueFixtureWorld {
  suffix: string;
  sessionId: string;
  playerId: number;
  session: Session;
  events: Array<{event?: string; data?: string; id?: string}>;
}

export interface OrderedQueueFixtureReport {
  ok: boolean;
  checks: {
    turn_b_queued_invisible: boolean;
    turn_a_events_ordered: boolean;
    quest_duplicate_suppressed: boolean;
    expired_slot_resolved: boolean;
    replay_order_matches_live_order: boolean;
    no_unanchored_chat_visible_events: boolean;
    frontend_server_id_guard: boolean;
  };
  liveEventIds: number[];
  replayedEventIds: number[];
  releaseSeqs: number[];
  turnA: string;
  turnB: string;
}

interface RawGuiRow {
  id: number | string;
  session_id: string | null;
  turn_id: string | null;
  lane: string | null;
  phase: string | null;
  event_type: string;
  message_id: number | string | null;
  display_policy: Record<string, unknown> | null;
}

export async function runOrderedQueueFixture(
  world: OrderedQueueFixtureWorld,
): Promise<OrderedQueueFixtureReport> {
  const beforeReplay = await listGuiEvents({
    sessionId: world.sessionId,
    after: 0,
    limit: 500,
  });
  const afterEventId = beforeReplay.reduce(
    (max, event) => Math.max(max, event.eventId),
    0,
  );
  const liveStartIndex = world.events.length;
  const turnA = `support-smoke-ordered-a-${world.suffix}`;
  const questId = await insertActiveQuest(world, `Support Smoke Ordered Quest ${world.suffix}`);

  const activeBefore = world.session.activeTurn;
  world.session.activeTurn = undefined;
  const barrier = openPresentationBarrier(world.session, {
    turnId: turnA,
    pendingVisibleSlots: 3,
    deadlineMs: 30_000,
  });

  let turnB = '';
  try {
    const slots = await reservePostTurnPresentationSlots(
      {
        sessionId: world.sessionId,
        playerId: world.playerId,
        turnId: turnA,
      },
      [
        {
          name: 'ordered_quest_watcher',
          presentation: {
            slotKey: 'post.ordered_quest_watcher',
            lane: 'post_response',
            ordinal: 10,
            visible: true,
            barrierMode: 'chat_visible',
            deadlineMs: 500,
          },
        },
        {
          name: 'ordered_quest_pacer',
          presentation: {
            slotKey: 'post.ordered_quest_pacer',
            lane: 'post_response',
            ordinal: 20,
            visible: true,
            barrierMode: 'chat_visible',
            deadlineMs: 500,
          },
        },
        {
          name: 'ordered_movement',
          presentation: {
            slotKey: 'post.ordered_movement',
            lane: 'status',
            ordinal: 30,
            visible: true,
            barrierMode: 'chat_visible',
            deadlineMs: 50,
          },
        },
      ],
    );
    const [watcherSlot, pacerSlot, expiredSlot] = slots;
    if (!watcherSlot || !pacerSlot || !expiredSlot) {
      throw new Error('ordered queue slots were not reserved');
    }

    const slotWork = Promise.allSettled([
      runPostTurnHookWithPresentation(watcherSlot, async ({presentation}) => {
        await sleep(90);
        const application = await applyQuestTransitionProposal({
          source: 'quest_watcher',
          sessionId: world.sessionId,
          playerId: world.playerId,
          turnId: turnA,
          questId,
          expectedCurrentStageId: 'open',
          action: 'advance',
          toStage: 'done',
          reason: 'ordered queue fixture watcher evidence after delayed slot',
          turnToolHistory: [
            {
              name: 'dice_check',
              args: {dc: 10, label: 'ordered queue fixture evidence'},
              ok: true,
              source: 'ai_sdk',
              result: {outcome: 'success'},
            },
          ],
        });
        if (!application.applied) {
          throw new Error(`watcher transition rejected: ${application.verdict.reason}`);
        }
        await presentation.emit(
          'quest:auto_advanced',
          {
            questId,
            toStage: 'done',
            reason: 'ordered queue fixture watcher accepted',
          },
          {
            displayPolicy: {
              lane: 'post_response',
              anchor: 'turn_id',
            },
          },
        );
      }),
      runPostTurnHookWithPresentation(pacerSlot, async ({presentation}) => {
        await presentation.emit(
          'quest_pacer:stale',
          {
            questId,
            questTitle: 'ordered queue fast pacer',
            details: 'fast slot must still wait for watcher release order',
            suggestion: 'wait for the lower ordinal slot',
          },
          {
            displayPolicy: {
              lane: 'post_response',
              anchor: 'turn_id',
            },
          },
        );
      }),
      runPostTurnHookWithPresentation(expiredSlot, async () => {
        await sleep(120);
      }),
    ]);

    await sleep(20);
    const queued = await enqueueTurn({
      sessionId: world.sessionId,
      playerId: world.playerId,
      text: 'support smoke ordered queued input',
      clientRequestId: `support-smoke-ordered-queue-${world.suffix}`,
      visibleAfterTurnId: turnA,
    });
    turnB = queued.row.turnId;
    const chatBeforePromotion = await chatRowsForTurn(world.sessionId, turnB);
    if (chatBeforePromotion !== 0) {
      throw new Error('queued turn created a chat row before promotion');
    }
    const blocked = await startNextQueuedTurn(world.session, row => ({
      turnId: row.turnId,
      done: Promise.resolve(),
    }));
    if (blocked) {
      throw new Error('queued turn started while ordered barrier was open');
    }

    await slotWork;
    const snapshots = await listPostTurnPresentationSlots(world.sessionId, {turnId: turnA});
    const expired = snapshots.find(slot => slot.slotKey === 'post.ordered_movement');
    if (expired?.slotStatus !== 'expired') {
      throw new Error(`ordered expired slot resolved as ${expired?.slotStatus ?? '<missing>'}`);
    }

    closePresentationBarrier(world.session, barrier.id, 'ordered_queue_fixture');
    const promoted = await startNextQueuedTurn(world.session, row => ({
      turnId: row.turnId,
      done: insertQueuedPlayerBubble(world, row.turnId, row.text),
    }));
    if (!promoted || promoted.row.turnId !== turnB) {
      throw new Error('ordered queued turn did not promote after barrier close');
    }
    await promoted.handle.done;
    await sleep(30);
    const chatAfterPromotion = await chatRowsForTurn(world.sessionId, turnB);
    if (chatAfterPromotion !== 1) {
      throw new Error(`promoted queued turn chat rows=${chatAfterPromotion}`);
    }

    const liveEvents = guiEventsSince(world, liveStartIndex)
      .filter(event => event.turnId === turnA);
    const releaseSequence = interestingOrderedTypes(liveEvents);
    assertSequence(
      releaseSequence,
      ['quest:auto_advanced', 'quest_pacer:stale', 'post_turn:slot_failed'],
      'turn A ordered queue visible release',
    );
    assertStrictlyIncreasingReleaseSeq(liveEvents);

    const replayed = (await listGuiEvents({
      sessionId: world.sessionId,
      after: afterEventId,
      limit: 500,
    })).filter(event => event.turnId === turnA);
    const liveEventIds = liveEvents.map(event => event.eventId);
    const replayedEventIds = replayed.map(event => event.eventId);
    if (liveEventIds.join(',') !== replayedEventIds.join(',')) {
      throw new Error(
        `replay order drifted: live=${liveEventIds.join(',')} replay=${replayedEventIds.join(',')}`,
      );
    }
    const seqCursor = liveEvents[1]?.releaseSeq ?? null;
    if (typeof seqCursor !== 'number') {
      throw new Error('ordered queue fixture could not establish releaseSeq cursor');
    }
    const replayedAfterSeq = (await listGuiEvents({
      sessionId: world.sessionId,
      afterReleaseSeq: seqCursor,
      limit: 500,
    })).filter(event => event.turnId === turnA);
    const expectedAfterSeqIds = liveEvents
      .filter(event => (event.releaseSeq ?? 0) > seqCursor)
      .map(event => event.eventId);
    const replayedAfterSeqIds = replayedAfterSeq.map(event => event.eventId);
    if (expectedAfterSeqIds.join(',') !== replayedAfterSeqIds.join(',')) {
      throw new Error(
        `releaseSeq cursor replay drifted: expected=${expectedAfterSeqIds.join(',')} got=${replayedAfterSeqIds.join(',')}`,
      );
    }

    await assertNoChatVisibleAnchorGaps(world.sessionId, afterEventId);
    await runDuplicateQuestCardPass(world);
    await assertTranscriptDiagnosticsClean(world.sessionId);
    await assertFrontendServerIdGuard();

    return {
      ok: true,
      checks: {
        turn_b_queued_invisible: true,
        turn_a_events_ordered: true,
        quest_duplicate_suppressed: true,
        expired_slot_resolved: true,
        replay_order_matches_live_order: true,
        no_unanchored_chat_visible_events: true,
        frontend_server_id_guard: true,
      },
      liveEventIds,
      replayedEventIds,
      releaseSeqs: liveEvents
        .map(event => event.releaseSeq)
        .filter((value): value is number => typeof value === 'number'),
      turnA,
      turnB,
    };
  } finally {
    world.session.activeTurn = activeBefore;
    closePresentationBarrier(world.session, barrier.id, 'ordered_queue_fixture_cleanup');
  }
}

async function insertActiveQuest(
  world: OrderedQueueFixtureWorld,
  title: string,
): Promise<number> {
  const profile = {
    stages: [
      {id: 'open', title: 'Open', next_stage: 'done'},
      {id: 'done', title: 'Done'},
    ],
    goal: title,
  };
  const inserted = await query<{id: number | string}>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, dynamic_origin
     )
     VALUES (
       'quest', $1, 'Ordered queue support quest.', $2::jsonb,
       ARRAY['quest'],
       'support-smoke', false
     )
     RETURNING id`,
    [title, JSON.stringify(profile)],
  );
  const questId = Number(inserted.rows[0]!.id);
  await query(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase, current_stage_id, started_at)
     VALUES ($1, $2, 'active', 1, 'open', now())`,
    [world.playerId, questId],
  );
  return questId;
}

async function insertQueuedPlayerBubble(
  world: OrderedQueueFixtureWorld,
  turnId: string,
  text: string,
): Promise<void> {
  await query(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload)
     VALUES ($1, $2, 'player', $3, 9000, $4::jsonb)`,
    [
      world.sessionId,
      world.playerId,
      text,
      JSON.stringify({turn_id: turnId, source: 'ordered_queue_fixture'}),
    ],
  );
}

async function chatRowsForTurn(sessionId: string, turnId: string): Promise<number> {
  const rows = await query<{count: number | string}>(
    `SELECT COUNT(*)::int AS count
       FROM chat_messages
      WHERE session_id = $1
        AND payload->>'turn_id' = $2`,
    [sessionId, turnId],
  );
  return Number(rows.rows[0]?.count ?? 0);
}

function guiEventsSince(
  world: OrderedQueueFixtureWorld,
  startIndex: number,
): GuiEventEnvelope[] {
  return world.events
    .slice(startIndex)
    .filter(event => event.event === 'gui:event' && event.data)
    .flatMap(event => {
      try {
        const parsed = JSON.parse(event.data ?? 'null') as GuiEventEnvelope;
        return parsed && typeof parsed.eventId === 'number' ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function interestingOrderedTypes(events: GuiEventEnvelope[]): string[] {
  return events
    .map(event => event.type)
    .filter(type =>
      type === 'quest:auto_advanced' ||
      type === 'quest_pacer:stale' ||
      type === 'post_turn:slot_failed',
    );
}

function assertSequence(actual: string[], expected: string[], label: string): void {
  const actualJoined = actual.join(' -> ');
  if (actual.length < expected.length) {
    throw new Error(`${label} missing events: ${actualJoined}`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        `${label} drifted: expected ${expected.join(' -> ')}, got ${actualJoined}`,
      );
    }
  }
}

function assertStrictlyIncreasingReleaseSeq(events: GuiEventEnvelope[]): void {
  const seqs = events.map(event => event.releaseSeq);
  if (seqs.some(seq => typeof seq !== 'number' || !Number.isFinite(seq))) {
    throw new Error(`released events missing releaseSeq: ${seqs.join(',')}`);
  }
  for (let i = 1; i < seqs.length; i += 1) {
    if (Number(seqs[i - 1]) >= Number(seqs[i])) {
      throw new Error(`releaseSeq order drifted: ${seqs.join(',')}`);
    }
  }
}

async function assertNoChatVisibleAnchorGaps(
  sessionId: string,
  afterEventId: number,
): Promise<void> {
  const rows = await query<RawGuiRow>(
    `SELECT id, session_id, turn_id, lane, phase, event_type,
            message_id, display_policy
       FROM gui_events
      WHERE session_id = $1
        AND id > $2
        AND status = 'released'
        AND event_type <> 'presentation:slot'
        AND lane <> 'rail'
      ORDER BY release_seq ASC NULLS LAST, id ASC`,
    [sessionId, afterEventId],
  );
  const bad = rows.rows.filter(row => {
    const anchor =
      row.display_policy &&
      typeof row.display_policy === 'object' &&
      !Array.isArray(row.display_policy)
        ? row.display_policy['anchor']
        : null;
    const explicitAnchor =
      anchor === 'turn_id' || anchor === 'message_id' || anchor === 'none';
    return (
      row.id == null ||
      row.session_id !== sessionId ||
      !row.turn_id ||
      !row.lane ||
      !row.phase ||
      (row.message_id == null && !explicitAnchor)
    );
  });
  if (bad.length > 0) {
    throw new Error(
      `chat-visible gui events missing anchors: ${bad.map(row => `${row.id}:${row.event_type}`).join(',')}`,
    );
  }
}

async function runDuplicateQuestCardPass(
  world: OrderedQueueFixtureWorld,
): Promise<void> {
  const turnId = `support-smoke-ordered-duplicate-${world.suffix}`;
  const questId = await insertActiveQuest(
    world,
    `Support Smoke Ordered Duplicate Quest ${world.suffix}`,
  );
  const beforeAuto = guiEventsSince(world, 0)
    .filter(event => event.turnId === turnId && event.type === 'quest:auto_advanced')
    .length;
  const brokerAdvance = await dispatch(
    'advance_quest',
    {quest_id: questId, player_id: world.playerId, to_stage: 'done'},
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId,
    },
  );
  if (!brokerAdvance.ok) {
    throw new Error(`ordered duplicate broker advance failed: ${brokerAdvance.error}`);
  }
  const duplicate = await applyQuestTransitionProposal({
    source: 'quest_watcher',
    sessionId: world.sessionId,
    playerId: world.playerId,
    turnId,
    questId,
    expectedCurrentStageId: 'open',
    action: 'advance',
    toStage: 'done',
    reason: 'ordered queue duplicate watcher proposal after broker advance',
    turnToolHistory: [
      {
        name: 'advance_quest',
        args: {quest_id: questId, to_stage: 'done'},
        ok: true,
        source: 'ai_sdk',
        result: {quest_id: questId, changed: true},
      },
    ],
  });
  if (duplicate.applied || duplicate.verdict.reason !== 'already_handled_same_turn') {
    throw new Error(`ordered duplicate proposal was not suppressed: ${JSON.stringify(duplicate)}`);
  }
  const afterAuto = guiEventsSince(world, 0)
    .filter(event => event.turnId === turnId && event.type === 'quest:auto_advanced')
    .length;
  if (afterAuto !== beforeAuto) {
    throw new Error('duplicate watcher proposal emitted quest:auto_advanced');
  }
}

async function assertTranscriptDiagnosticsClean(sessionId: string): Promise<void> {
  const diagnostics = await buildSessionTranscriptDiagnostics({sessionId, limit: 80});
  if (diagnostics.event_order_gaps.length > 0) {
    throw new Error(`event_order_gaps: ${JSON.stringify(diagnostics.event_order_gaps)}`);
  }
  if (diagnostics.unanchored_chat_visible_events.length > 0) {
    throw new Error(
      `unanchored_chat_visible_events: ${JSON.stringify(diagnostics.unanchored_chat_visible_events)}`,
    );
  }
  if (diagnostics.open_barriers.length > 0) {
    throw new Error(`open_barriers: ${JSON.stringify(diagnostics.open_barriers)}`);
  }
  if (diagnostics.queued_visible_leaks.length > 0) {
    throw new Error(
      `queued_visible_leaks: ${JSON.stringify(diagnostics.queued_visible_leaks)}`,
    );
  }
  if (diagnostics.duplicate_quest_cards.length > 0) {
    throw new Error(
      `duplicate_quest_cards: ${JSON.stringify(diagnostics.duplicate_quest_cards)}`,
    );
  }
}

async function assertFrontendServerIdGuard(): Promise<void> {
  const repoRoot = repoRootFromModule();
  const appPath = path.resolve(repoRoot, 'packages/web-ui/src/App.tsx');
  const systemEventsHookPath = path.resolve(
    repoRoot,
    'packages/web-ui/src/hooks/useSystemEvents.ts',
  );
  const messageFlowPath = path.resolve(
    repoRoot,
    'packages/web-ui/src/components/chat/MessageFlow.tsx',
  );
  const fixturePath = path.resolve(
    repoRoot,
    'packages/web-ui/src/components/chat/eventOrdering.fixture.ts',
  );
  const appSource = await readFile(appPath, 'utf8');
  const systemEventsHook = await readFile(systemEventsHookPath, 'utf8');
  const messageFlow = await readFile(messageFlowPath, 'utf8');
  const fixture = await readFile(fixturePath, 'utf8');
  if (
    !systemEventsHook.includes('event.eventId != null') ||
    !systemEventsHook.includes('event.turnId != null')
  ) {
    throw new Error(
      'useSystemEvents no longer guards server-id-bearing system events',
    );
  }
  if (
    appSource.includes('e.attachedTo == null ? {...e, attachedTo: attachId} : e') ||
    systemEventsHook.includes('e.attachedTo == null ? {...e, attachedTo: attachId} : e')
  ) {
    throw new Error(
      'frontend still attaches all unattached system events by message count',
    );
  }
  if (!fixture.includes('runEventOrderingFixture') || !fixture.includes('orderedSystemEvents')) {
    throw new Error('frontend event ordering fixture is missing');
  }
  if (
    !messageFlow.includes('requiresAssistantAnchor') ||
    !messageFlow.includes("ev.type.startsWith('quest:')") ||
    !messageFlow.includes('!isPlayer(directMessage)')
  ) {
    throw new Error('MessageFlow can again render post-response cards without an assistant anchor');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function repoRootFromModule(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}
