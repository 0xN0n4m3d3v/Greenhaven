/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// X-3 classifier-hint refactor — focused tests for the
// `reconcileDialogueFocusForTurn` farewell branch. The release path
// used to inspect raw player text with an en+ru goodbye regex; it now
// reads the classifier-emitted `DialogueAct`. These tests stub the
// dialogue-participants reader/writer so we can assert that the
// classifier hint drives the release decision and the emitted SSE
// `reason` without touching the database.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const participantsState = vi.hoisted(() => ({
  state: {
    focused_partner_id: null as number | null,
    participant_ids: [] as number[],
    updated_at_turn: null as string | null,
    source: 'none' as string,
  },
  companionIds: [] as number[],
  setCalls: [] as Array<Record<string, unknown>>,
  clearCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../dialogueParticipants.js', () => ({
  loadDialogueParticipantState: vi.fn(async () => participantsState.state),
  loadCompanionIdsForPlayer: vi.fn(async () => participantsState.companionIds),
  setDialogueParticipants: vi.fn(async (_playerId: number, args: Record<string, unknown>) => {
    participantsState.setCalls.push(args);
    return {
      changed: true,
      state: {...participantsState.state},
      participants: [],
      rejected_ids: [],
      rejected_focus_id: null,
    };
  }),
  clearDialogueParticipants: vi.fn(async (_playerId: number, args: Record<string, unknown>) => {
    participantsState.clearCalls.push(args);
    return {
      changed: true,
      state: {
        focused_partner_id: null,
        participant_ids: [],
        updated_at_turn: null,
        source: 'route',
      },
      participants: [],
      rejected_ids: [],
      rejected_focus_id: null,
    };
  }),
}));

const guiState = vi.hoisted(() => ({
  emits: [] as Array<{event: string; data: Record<string, unknown>}>,
}));

vi.mock('../../guiEventOutbox.js', () => ({
  emitGuiEvent: vi.fn(
    async (_envelope, event: string, data: Record<string, unknown>) => {
      guiState.emits.push({event, data});
    },
  ),
}));

import {reconcileDialogueFocusForTurn} from '../../turn/dialogueFocus.js';
import type {Session} from '../../sessionManager.js';

function makeSession(): Session {
  const sse = {
    emit: (event: string, data: unknown) => {
      guiState.emits.push({event, data: data as Record<string, unknown>});
    },
  };
  return {id: 'sess-stub', sse} as unknown as Session;
}

beforeEach(() => {
  participantsState.state = {
    focused_partner_id: 99,
    participant_ids: [99],
    updated_at_turn: null,
    source: 'route',
  };
  participantsState.companionIds = [];
  participantsState.setCalls = [];
  participantsState.clearCalls = [];
  guiState.emits = [];
});

describe('reconcileDialogueFocusForTurn — dialogueAct', () => {
  it('clears focus and emits player_farewell when dialogueAct is farewell', async () => {
    await reconcileDialogueFocusForTurn(1, 'dialogue', 'farewell', {
      session: makeSession(),
      turnId: 'turn-1',
    });
    expect(participantsState.clearCalls).toHaveLength(1);
    const switchEvent = guiState.emits.find(
      (e) => e.event === 'dialogue:partner_switched',
    );
    expect(switchEvent?.data['reason']).toBe('player_farewell');
  });

  it('keeps focus when dialogueAct is none and the player stays in dialogue mode', async () => {
    await reconcileDialogueFocusForTurn(1, 'dialogue', 'none', {
      session: makeSession(),
      turnId: 'turn-2',
    });
    expect(participantsState.clearCalls).toHaveLength(0);
    expect(guiState.emits).toHaveLength(0);
  });

  it('still releases focus when the mode leaves dialogue, even with dialogueAct=none', async () => {
    await reconcileDialogueFocusForTurn(1, 'exploration', 'none', {
      session: makeSession(),
      turnId: 'turn-3',
    });
    expect(participantsState.clearCalls).toHaveLength(1);
    const switchEvent = guiState.emits.find(
      (e) => e.event === 'dialogue:partner_switched',
    );
    expect(switchEvent?.data['reason']).toBe('player_action');
  });

  it('prefers player_moved_focus when a travel actionId is present', async () => {
    await reconcileDialogueFocusForTurn(1, 'dialogue', 'farewell', {
      actionId: 'location:42',
      session: makeSession(),
      turnId: 'turn-4',
    });
    expect(participantsState.clearCalls).toHaveLength(1);
    const switchEvent = guiState.emits.find(
      (e) => e.event === 'dialogue:partner_switched',
    );
    expect(switchEvent?.data['reason']).toBe('player_moved_focus');
  });
});
