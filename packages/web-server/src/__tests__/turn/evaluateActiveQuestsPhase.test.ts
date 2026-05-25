/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-4 — `EvaluateActiveQuestsPhase` must forward `context.turnId`
// (not `session.activeTurn?.turnId`) into `evaluateActiveQuests`,
// so quest GUI events emitted by the engine are correlatable with
// the turn the orchestrator opened for this phase.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const callState = vi.hoisted(() => ({
  calls: [] as Array<{
    sessionId: string;
    playerId: number;
    recent: unknown;
    turnId: string;
  }>,
}));

vi.mock('../../quest/questEngine.js', () => ({
  evaluateActiveQuests: vi.fn(
    async (
      sessionId: string,
      playerId: number,
      recent: unknown,
      turnId: string,
    ) => {
      callState.calls.push({sessionId, playerId, recent, turnId});
    },
  ),
}));

import {evaluateActiveQuestsPhase} from '../../turn/phases/EvaluateActiveQuestsPhase.js';
import type {TurnContext} from '../../turn/TurnContext.js';

function makeContext(opts: {
  withActiveTurn: boolean;
  turnId: string;
  lastTurnToolHistory?: unknown[];
}): TurnContext {
  const session = {
    id: 'sess-1',
    activeTurn: opts.withActiveTurn
      ? {
          turnId: 'inner-active-turn',
          toolHistory: [],
        }
      : undefined,
    lastTurnToolHistory: opts.lastTurnToolHistory ?? [{name: 'noop', args: {}}],
  } as unknown as TurnContext['session'];
  return {
    session,
    input: {playerId: 42, text: 'irrelevant'},
    turnId: opts.turnId,
    signal: new AbortController().signal,
    state: {},
  } as unknown as TurnContext;
}

beforeEach(() => {
  callState.calls.length = 0;
});

describe('evaluateActiveQuestsPhase (QE-4)', () => {
  it('forwards `context.turnId` (not session.activeTurn.turnId) to evaluateActiveQuests', async () => {
    const context = makeContext({
      withActiveTurn: true,
      turnId: 'turn-phase-99',
      lastTurnToolHistory: [{name: 'narrate', args: {}}],
    });
    await evaluateActiveQuestsPhase.run(context);
    expect(callState.calls).toHaveLength(1);
    expect(callState.calls[0]).toEqual({
      sessionId: 'sess-1',
      playerId: 42,
      recent: [{name: 'narrate', args: {}}],
      turnId: 'turn-phase-99',
    });
    // Critically: `inner-active-turn` (the session.activeTurn.turnId)
    // must not leak through — the phase explicitly forwards the
    // context's turn id.
    expect(callState.calls[0]!.turnId).not.toBe('inner-active-turn');
  });

  it('skips evaluation when session.activeTurn is missing (defensive guard preserved)', async () => {
    const context = makeContext({
      withActiveTurn: false,
      turnId: 'turn-phase-100',
    });
    await evaluateActiveQuestsPhase.run(context);
    expect(callState.calls).toHaveLength(0);
  });
});
