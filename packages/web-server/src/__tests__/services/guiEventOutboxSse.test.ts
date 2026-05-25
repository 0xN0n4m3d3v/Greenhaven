/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// GE-1 — `guiEventOutbox.ts` fans out one durable `gui_events` row
// as exactly one normalized `gui:event` SSE per release. The
// previous behaviour also fired a duplicate legacy per-type SSE
// (`session?.sse.emit(type, legacyPayload, ...)`), which let the
// UI accidentally double-render a single event via both the
// per-type listener and the normalized envelope path.
//
// The tests below pin the new contract on both delivery paths:
//   1. immediate-release path inside `emitGuiEventForSession(...)`
//   2. delayed-release path used by `releaseGuiEvent(...)` /
//      `bindReleasedTurnGuiEventsToMessage(...)`
// Both must produce exactly one captured SSE call, and the event
// name must be `gui:event` (not the per-type alias).

import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const sseCalls = vi.hoisted(() => ({
  emits: [] as Array<{event: string; data: unknown; id?: string}>,
}));

vi.mock('../../sessionManager.js', () => ({
  sessionManager: {
    get: vi.fn(() => ({
      sse: {
        emit: vi.fn((event: string, data: unknown, id?: string) => {
          sseCalls.emits.push({event, data, id});
        }),
      },
    })),
  },
}));

vi.mock('../../telemetry/index.js', () => ({
  telemetry: {
    record: vi.fn(),
    flush: vi.fn(async () => {}),
    pendingCount: vi.fn(() => 0),
  },
  measure: vi.fn(async (_input: unknown, work: () => unknown) => work()),
}));

let emitGuiEventForSession: typeof import('../../guiEventOutbox.js').emitGuiEventForSession;
let releaseGuiEvent: typeof import('../../guiEventOutbox.js').releaseGuiEvent;
let bindReleasedTurnGuiEventsToMessage: typeof import('../../guiEventOutbox.js').bindReleasedTurnGuiEventsToMessage;

beforeAll(async () => {
  const {setupTurnTestEnvironment} = await import('../turn/framework.js');
  await setupTurnTestEnvironment();
  const outbox = await import('../../guiEventOutbox.js');
  emitGuiEventForSession = outbox.emitGuiEventForSession;
  releaseGuiEvent = outbox.releaseGuiEvent;
  bindReleasedTurnGuiEventsToMessage = outbox.bindReleasedTurnGuiEventsToMessage;
});

afterAll(async () => {
  const {cleanupTurnTestEnvironment} = await import('../turn/framework.js');
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  sseCalls.emits.length = 0;
  // A fresh sessions row per case so the foreign-key constraint
  // on `gui_events.session_id` is satisfied without leaking
  // outbox rows between tests.
  const {query} = await import('../../db.js');
  await query(`DELETE FROM gui_events`);
});

async function seedSession(sessionId: string): Promise<void> {
  const {query} = await import('../../db.js');
  const playerService = await import('../../playerService.js');
  const player = await playerService.createAnonymousPlayer(
    `GE-1 SSE Player ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await query(
    `INSERT INTO sessions (id, player_id) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [sessionId, player.entity_id],
  );
}

describe('guiEventOutbox GE-1 — single normalized SSE per release', () => {
  it('immediate-release path emits exactly one gui:event SSE per durable row', async () => {
    const sessionId = `ge1-immediate-${Date.now()}`;
    await seedSession(sessionId);

    await emitGuiEventForSession(sessionId, 'xp:awarded', {amount: 7});

    expect(sseCalls.emits).toHaveLength(1);
    expect(sseCalls.emits[0]!.event).toBe('gui:event');
    const envelope = sseCalls.emits[0]!.data as {
      type: string;
      eventId: number;
    };
    expect(envelope.type).toBe('xp:awarded');
    expect(envelope.eventId).toBeGreaterThan(0);
    expect(sseCalls.emits[0]!.id).toBe(String(envelope.eventId));
    // No legacy per-type SSE was emitted.
    expect(
      sseCalls.emits.find((e) => e.event === 'xp:awarded'),
    ).toBeUndefined();
  });

  it('delayed-release path (releaseGuiEvent + bindReleasedTurnGuiEventsToMessage) also emits exactly one gui:event SSE per durable row', async () => {
    const sessionId = `ge1-delayed-${Date.now()}`;
    await seedSession(sessionId);

    // Seed a row with `status: 'pending'` so the immediate path
    // doesn't fire any SSE; the delayed path then releases it.
    const envelope = await emitGuiEventForSession(
      sessionId,
      'quest:changed',
      {questId: 1, status: 'advanced'},
      {status: 'pending'},
    );
    expect(sseCalls.emits).toHaveLength(0);
    expect(envelope?.eventId).toBeGreaterThan(0);

    await releaseGuiEvent(envelope!.eventId);

    expect(sseCalls.emits).toHaveLength(1);
    expect(sseCalls.emits[0]!.event).toBe('gui:event');
    const released = sseCalls.emits[0]!.data as {
      type: string;
      eventId: number;
    };
    expect(released.type).toBe('quest:changed');
    expect(released.eventId).toBe(envelope!.eventId);
    expect(
      sseCalls.emits.find((e) => e.event === 'quest:changed'),
    ).toBeUndefined();

    // Re-binding to a message id triggers a second release for the
    // SAME envelope only if a new row exists. Here we add a new
    // pending row, bind it, and assert that path also emits one
    // and only one `gui:event` SSE for the new row.
    sseCalls.emits.length = 0;
    const second = await emitGuiEventForSession(
      sessionId,
      'memory:added',
      {memoryId: 99},
      {status: 'ready', deferRelease: true, turnId: 'turn-1'},
    );
    expect(second?.eventId).toBeGreaterThan(0);
    expect(sseCalls.emits).toHaveLength(0);

    // `bindReleasedTurnGuiEventsToMessage` writes
    // `gui_events.message_id = $3` and re-releases the matching
    // rows. `gui_events.message_id` has an FK to `chat_messages.id`,
    // so seed a minimal NPC row for the target turn first.
    const {query} = await import('../../db.js');
    const messageRow = await query<{id: number}>(
      `INSERT INTO chat_messages
         (session_id, tone, text, turn_index, payload)
       VALUES ($1, 'npc', 'GE-1 placeholder', 0,
               jsonb_build_object('turn_id', $2::text))
       RETURNING id`,
      [sessionId, 'turn-1'],
    );
    const messageId = Number(messageRow.rows[0]!.id);
    const bound = await bindReleasedTurnGuiEventsToMessage({
      sessionId,
      turnId: 'turn-1',
      messageId,
    });
    expect(bound).toHaveLength(1);

    expect(sseCalls.emits).toHaveLength(1);
    expect(sseCalls.emits[0]!.event).toBe('gui:event');
    expect(
      sseCalls.emits.find((e) => e.event === 'memory:added'),
    ).toBeUndefined();
  });
});
