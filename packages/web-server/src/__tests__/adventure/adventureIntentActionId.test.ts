/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

const queueState = vi.hoisted(() => ({
  rows: [] as Array<{id: number}>,
  listCalls: [] as Array<Record<string, unknown>>,
}));

const serviceState = vi.hoisted(() => ({
  acceptCalls: [] as Array<Record<string, unknown>>,
  ignoreCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../domain/adventure/runtime/adventureQueue.js', () => ({
  listAdventureQueue: vi.fn(async (opts: Record<string, unknown>) => {
    queueState.listCalls.push(opts);
    return queueState.rows;
  }),
}));

vi.mock('../../domain/adventure/AdventureService.js', () => ({
  acceptPlayerAdventure: vi.fn(async (opts: Record<string, unknown>) => {
    serviceState.acceptCalls.push(opts);
    return {
      ok: true,
      status: 'accepted',
      questResult: null,
      spawnResults: [],
    };
  }),
  ignorePlayerAdventure: vi.fn(async (opts: Record<string, unknown>) => {
    serviceState.ignoreCalls.push(opts);
    return {
      ok: true,
      status: 'ignored',
      hookPayload: {title: 'Ignored'},
      consequence: null,
    };
  }),
}));

import {
  maybeAcceptReadyAdventureFromText,
  maybeIgnoreReadyAdventureFromText,
} from '../../domain/adventure/runtime/adventureIntent.js';

beforeEach(() => {
  queueState.rows = [{id: 42}, {id: 77}];
  queueState.listCalls = [];
  serviceState.acceptCalls = [];
  serviceState.ignoreCalls = [];
});

describe('adventure intent action ids', () => {
  it('accepts the exact ready adventure row from actionId, independent of visible button text', async () => {
    const result = await maybeAcceptReadyAdventureFromText({
      sessionId: 'sess-1',
      playerId: 5,
      turnId: 'turn-9',
      text: 'Принять',
      actionId: 'adventure.accept:77',
    });

    expect(result).toMatchObject({
      accepted: true,
      queueId: 77,
      reason: 'accepted',
      status: 'accepted',
    });
    expect(queueState.listCalls).toEqual([
      {
        sessionId: 'sess-1',
        playerId: 5,
        statuses: ['ready'],
        limit: 10,
      },
    ]);
    expect(serviceState.acceptCalls).toEqual([
      {
        playerId: 5,
        queueId: 77,
        sessionId: 'sess-1',
        turnId: 'turn-9',
      },
    ]);
  });

  it('ignores the exact ready adventure row from actionId, independent of visible button text', async () => {
    const result = await maybeIgnoreReadyAdventureFromText({
      sessionId: 'sess-1',
      playerId: 5,
      turnId: 'turn-9',
      text: 'Игнорировать',
      actionId: 'adventure.ignore:42',
    });

    expect(result).toMatchObject({
      ignored: true,
      queueId: 42,
      reason: 'ignored',
      status: 'ignored',
    });
    expect(serviceState.ignoreCalls).toEqual([
      {
        playerId: 5,
        queueId: 42,
        sessionId: 'sess-1',
        turnId: 'turn-9',
        reason: 'player_declined_turn_action',
      },
    ]);
  });

  it('does not accept a stale or unrelated actionId', async () => {
    const result = await maybeAcceptReadyAdventureFromText({
      sessionId: 'sess-1',
      playerId: 5,
      turnId: 'turn-9',
      text: 'Принять',
      actionId: 'adventure.accept:999',
    });

    expect(result).toEqual({accepted: false, reason: 'no_match'});
    expect(serviceState.acceptCalls).toEqual([]);
  });
});
