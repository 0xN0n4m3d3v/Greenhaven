/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// X-3/X-4 follow-up #8 — focused tests for the
// `renderDialogueParticipants` prompt-history sanitiser.
//
// The previous slice held an en-only `looksLikePlayerPovUnderNpc`
// regex that silently dropped every non-English equivalent of NPC
// first-person prose. The upstream multilingual voice-warden
// specialist already quarantines `mismatch_player_pov_under_npc`
// rows before they reach `chat_messages`, so the runtime sanitiser
// only needs to drop control-shaped narrate text. These tests pin
// that contract end-to-end without exercising the full preamble
// builder.

import {beforeEach, describe, expect, it, vi} from 'vitest';

type DbResult<T> = {rows: T[]};

const dbState = vi.hoisted(() => ({
  responses: [] as Array<DbResult<unknown>>,
}));

vi.mock('../../db.js', () => ({
  query: vi.fn(async () => {
    if (dbState.responses.length === 0) return {rows: []};
    return dbState.responses.shift() ?? {rows: []};
  }),
}));

vi.mock('../../chatHistoryScope.js', () => ({
  playerScopedChatPredicate: () => 'TRUE',
}));

vi.mock('../../i18n.js', () => ({
  loc: (_record: unknown, _lang: unknown, _key: unknown, fallback: unknown) =>
    typeof fallback === 'string' ? fallback : '',
  locQuestStageField: (
    _record: unknown,
    _lang: unknown,
    _stage: unknown,
    _key: unknown,
    fallback: unknown,
  ) => (typeof fallback === 'string' ? fallback : ''),
}));

vi.mock('../../tools/narrate.js', () => ({
  // Identity sanitiser for the test — real call drops Stanislavski
  // headings / paragraph dups; here we just trim and return.
  sanitiseNarrateText: (text: string) => text.trim(),
  // Treat any payload starting with the broker control marker as
  // control text. Production code uses the multilingual control
  // detector; the test only needs a deterministic stub.
  isNarrateControlText: (text: string) =>
    text.startsWith('Broker stage complete'),
}));

vi.mock('../../tools/runtimeContext.js', () => ({
  getEntityRuntimeContext: vi.fn(async () => ({fields: [], instructions: ''})),
}));

vi.mock('../../tools/strings.js', () => ({
  bandFor: () => 'neutral',
}));

vi.mock('./entitySections.js', () => ({
  fetchEntity: vi.fn(async () => null),
  renderInstructions: () => '',
  renderProfile: () => '',
  renderRuntime: () => '',
}));

const telemetryState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../telemetry/index.js', () => ({
  telemetry: {
    record: vi.fn((event: Record<string, unknown>) => {
      telemetryState.events.push(event);
    }),
    flush: vi.fn(async () => {}),
    pendingCount: vi.fn(() => 0),
  },
  measure: vi.fn(async (_input: unknown, work: () => unknown) => work()),
}));

const {renderDialogueParticipants} = await import(
  '../../turnContext/dialogueContext.js'
);

beforeEach(() => {
  dbState.responses = [];
  telemetryState.events.length = 0;
});

describe('renderDialogueParticipants prompt-history sanitiser', () => {
  it('keeps NPC first-person prose regardless of language', async () => {
    const npcId = 42;
    // 1. Entity row lookup for participants.
    dbState.responses.push({
      rows: [
        {
          id: npcId,
          kind: 'person',
          display_name: 'Mikka',
          summary: null,
          profile: {},
          tags: [],
          i18n: null,
        },
      ],
    });
    // 2. Runtime-fields lookup (mood/stance/strings).
    dbState.responses.push({rows: []});
    // 3. Recent chat rows — three NPC first-person beats:
    //    English action-verb (would have been dropped by old regex),
    //    Russian, and Japanese. All authored by Mikka.
    dbState.responses.push({
      rows: [
        {
          author_entity_id: npcId,
          text: '"I take the lantern off the hook and turn toward you," Mikka says.',
          turn_index: 5,
        },
        {
          author_entity_id: npcId,
          text: 'Я беру фонарь со стены и поворачиваюсь к тебе.',
          turn_index: 4,
        },
        {
          author_entity_id: npcId,
          text: '私はランタンを取り、君のほうを向いた。',
          turn_index: 3,
        },
      ],
    });

    const out = await renderDialogueParticipants(
      [npcId],
      npcId,
      /*playerId*/ 1,
      'sess-stub',
      /*limit*/ 5,
    );
    expect(out).not.toBeNull();
    // The newest NPC bubble is the English one; all three are
    // legitimate NPC first-person beats, none should be dropped.
    expect(out).toContain('I take the lantern');
    // No `bubble_dropped` telemetry should have fired because zero
    // rows were filtered out.
    expect(
      telemetryState.events.find(
        (e) => e['name'] === 'turn_context.dialogue_history.bubble_dropped',
      ),
    ).toBeUndefined();
  });

  it('drops control-shaped narrate text and emits gameplay telemetry', async () => {
    const npcId = 7;
    dbState.responses.push({
      rows: [
        {
          id: npcId,
          kind: 'person',
          display_name: 'Borek',
          summary: null,
          profile: {},
          tags: [],
          i18n: null,
        },
      ],
    });
    dbState.responses.push({rows: []});
    // Control-shaped row + one real first-person beat.
    dbState.responses.push({
      rows: [
        {
          author_entity_id: npcId,
          text: 'Broker stage complete: handing off',
          turn_index: 9,
        },
        {
          author_entity_id: npcId,
          text: '"Hand me the lens," Borek mutters.',
          turn_index: 8,
        },
      ],
    });

    const out = await renderDialogueParticipants(
      [npcId],
      npcId,
      /*playerId*/ 2,
      'sess-stub-2',
      /*limit*/ 5,
    );
    expect(out).not.toBeNull();
    // The recent line shown should be the legitimate beat, not the
    // control-shaped one (which the upstream sanitiser stripped).
    expect(out).not.toContain('Broker stage complete');
    // Because the newest row WAS filtered, we expect telemetry on
    // the gameplay channel naming the new event.
    const dropEvent = telemetryState.events.find(
      (e) => e['name'] === 'turn_context.dialogue_history.bubble_dropped',
    );
    expect(dropEvent).toBeDefined();
    expect(dropEvent?.['channel']).toBe('gameplay');
    expect(dropEvent?.['sessionId']).toBe('sess-stub-2');
    expect(dropEvent?.['playerId']).toBe(2);
    const data = dropEvent?.['data'] as Record<string, unknown> | undefined;
    expect(data?.['droppedByFilter']).toBe(1);
    expect(data?.['participantIds']).toEqual([npcId]);
  });
});
