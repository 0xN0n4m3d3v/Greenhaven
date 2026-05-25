/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-5/USER-6 post-turn audit — `npcVoice.enrichOneMemory` must wrap
// the durable `applyEnrichment` UPDATE and the `memory:enriched`
// gui_events emit in one transaction. The test proves the rollback
// contract: when the second step inside the tx throws, the first
// step's UPDATE rolls back AND the deferred SSE never escapes.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const queryState = vi.hoisted(() => ({
  calls: [] as Array<{sql: string; params: unknown[] | undefined}>,
  responses: [] as Array<
    | {rows: Array<Record<string, unknown>>; rowCount?: number}
    | Error
  >,
}));

const txState = vi.hoisted(() => ({
  inTx: false,
  commitHooks: [] as Array<() => void | Promise<void>>,
  rollbackHooks: [] as Array<() => void | Promise<void>>,
  withTransactionCalls: 0,
  rolledBack: false,
}));

vi.mock('../../db.js', () => {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queryState.calls.push({sql, params});
    const next = queryState.responses.shift();
    if (next instanceof Error) throw next;
    return next ?? {rows: [], rowCount: 0};
  });
  return {
    query,
    withTransaction: vi.fn(
      async <T>(fn: (client: {query: typeof query}) => Promise<T>) => {
        txState.withTransactionCalls += 1;
        txState.inTx = true;
        txState.commitHooks = [];
        txState.rollbackHooks = [];
        try {
          const result = await fn({query});
          for (const hook of txState.commitHooks) await hook();
          return result;
        } catch (err) {
          txState.rolledBack = true;
          for (const hook of txState.rollbackHooks) await hook();
          throw err;
        } finally {
          txState.inTx = false;
        }
      },
    ),
    onTransactionCommit: vi.fn((fn: () => void | Promise<void>) => {
      if (!txState.inTx) return false;
      txState.commitHooks.push(fn);
      return true;
    }),
    onTransactionRollback: vi.fn((fn: () => void | Promise<void>) => {
      if (!txState.inTx) return false;
      txState.rollbackHooks.push(fn);
      return true;
    }),
    isInTransaction: vi.fn(() => txState.inTx),
  };
});

// emitGuiEventForSession routes through guiEventOutbox in production:
// `query(INSERT INTO gui_events ...)` then `session?.sse.emit(...)`,
// where SseBridge.emit auto-defers via onTransactionCommit when inside
// withTransaction. The mock below mirrors that contract: the
// gui_events row insert is observable directly, and the SSE emit is
// registered through onTransactionCommit so a rolled-back tx drops it.
const guiState = vi.hoisted(() => ({
  emitCalls: [] as Array<{
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
  }>,
  sseEmits: [] as Array<{sessionId: string; type: string}>,
}));

vi.mock('../../guiEventOutbox.js', async () => {
  const db = (await import('../../db.js')) as unknown as {
    onTransactionCommit: (fn: () => void | Promise<void>) => boolean;
  };
  return {
    emitGuiEventForSession: vi.fn(
      async (
        sessionId: string,
        type: string,
        payload: Record<string, unknown>,
      ) => {
        guiState.emitCalls.push({sessionId, type, payload});
        const deferred = db.onTransactionCommit(() => {
          guiState.sseEmits.push({sessionId, type});
        });
        if (!deferred) {
          guiState.sseEmits.push({sessionId, type});
        }
        return {
          eventId: 1,
          sessionId,
          type,
          payload,
          messageId: null,
          turnId: null,
          turnIndex: null,
          lane: 'post_response' as const,
          phase: 'post_turn' as const,
          createdAt: '',
          releasedAt: '',
          releaseSeq: 1,
          playerId: null,
          displayPolicy: {},
        };
      },
    ),
  };
});

vi.mock('../../chatHistoryScope.js', () => ({
  playerScopedChatPredicate: () => 'TRUE',
}));

vi.mock('../../agents/scriptUtil.js', () => ({
  languageHint: vi.fn(() => 'en'),
}));

vi.mock('../../agents/npcVoicePrompt.js', () => ({
  npcVoicePrompt: {
    buildSystem: vi.fn(() => 'SYS'),
    buildUser: vi.fn(() => 'USR'),
  },
}));

const specialistState = vi.hoisted(() => ({
  brief: null as null | {
    voiced_text: string;
    internal_reflection: string;
    links_to_memory_id: number | null;
    link_reason: string;
  },
}));

vi.mock('../../agents/base.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../agents/base.js')>();
  return {
    ...actual,
    runSpecialist: vi.fn(async () => specialistState.brief),
  };
});

import {enrichOneMemory} from '../../agents/npcVoice.js';

const MEM_ROW = {
  id: 42,
  owner_entity_id: 7,
  about_entity_id: null,
  text: 'plain draft text',
  importance: 3,
  tags: ['fact'],
  metadata: null,
};

const OWNER_ROW = {
  id: 7,
  kind: 'npc',
  display_name: 'Ardent',
  profile: {speech_style: 'archaic'},
};

function seedFiveReadsThenUpdate(updateResult: Error | {rowCount: number}) {
  queryState.responses.push(
    // 1. loadMemoryRow
    {rows: [MEM_ROW], rowCount: 1},
    // 2. loadOwnerEntity
    {rows: [OWNER_ROW], rowCount: 1},
    // 3. loadRecentUtterances
    {rows: [], rowCount: 0},
    // 4. loadPastMemoryCandidates
    {rows: [], rowCount: 0},
    // 5. UPDATE npc_memories inside withTransaction
    updateResult instanceof Error
      ? updateResult
      : {rows: [], rowCount: updateResult.rowCount},
  );
}

beforeEach(() => {
  queryState.calls = [];
  queryState.responses = [];
  txState.inTx = false;
  txState.commitHooks = [];
  txState.rollbackHooks = [];
  txState.withTransactionCalls = 0;
  txState.rolledBack = false;
  guiState.emitCalls = [];
  guiState.sseEmits = [];
  specialistState.brief = {
    voiced_text: 'In sooth, plain draft text holds',
    internal_reflection: '',
    links_to_memory_id: null,
    link_reason: '',
  };
});

describe('npcVoice.enrichOneMemory — USER-5/USER-6 transactional contract', () => {
  it('runs applyEnrichment + memory:enriched emit inside a single withTransaction (happy path)', async () => {
    seedFiveReadsThenUpdate({rowCount: 1});
    const ctx = {
      sessionId: 'sess-1',
      playerId: 5,
      turnId: 'turn-1',
      signal: new AbortController().signal,
    };

    const result = await enrichOneMemory(42, ctx, true);

    expect(result).toEqual({voiced: true});
    expect(txState.withTransactionCalls).toBe(1);
    expect(txState.rolledBack).toBe(false);

    // applyEnrichment runs through the same query() — it lands inside
    // the tx because the wrapping withTransaction is the outer scope.
    const updateCall = queryState.calls.find((c) =>
      c.sql.includes('UPDATE npc_memories'),
    );
    expect(updateCall).toBeDefined();

    // Exactly one gui_events row was written and the deferred SSE
    // fired exactly once when the tx committed.
    expect(guiState.emitCalls).toHaveLength(1);
    expect(guiState.emitCalls[0]).toMatchObject({
      sessionId: 'sess-1',
      type: 'memory:enriched',
      payload: expect.objectContaining({
        memoryId: 42,
        ownerId: 7,
        ownerName: 'Ardent',
      }),
    });
    expect(guiState.sseEmits).toEqual([
      {sessionId: 'sess-1', type: 'memory:enriched'},
    ]);
  });

  it('rolls back when applyEnrichment fails: no deferred memory:enriched SSE escapes', async () => {
    seedFiveReadsThenUpdate(new Error('npc_memories update boom'));
    const ctx = {
      sessionId: 'sess-1',
      playerId: 5,
      turnId: 'turn-1',
      signal: new AbortController().signal,
    };

    // enrichOneMemory does not swallow inner errors; the wrapping
    // PostTurnHook.run is what catches them in production. Drive it
    // directly and assert the rejection so the test surfaces a
    // regression if the contract changes.
    await expect(enrichOneMemory(42, ctx, true)).rejects.toThrow(
      /npc_memories update boom/,
    );

    expect(txState.withTransactionCalls).toBe(1);
    expect(txState.rolledBack).toBe(true);

    // The UPDATE was attempted, but the throw aborted before the emit
    // could register a commit hook. Either way the deferred SSE must
    // not have fired.
    expect(guiState.sseEmits).toEqual([]);
  });

  it('rolls back when emitEnrichedSse fails: applyEnrichment runs but the deferred SSE never escapes', async () => {
    seedFiveReadsThenUpdate({rowCount: 1});
    // The 6th query inside the tx is `INSERT INTO gui_events ...`
    // routed through the mocked emitGuiEventForSession. Forcing that
    // mock to throw mid-flight exercises the case where the durable
    // write succeeded but the GUI event step fails.
    const guiMod = (await import('../../guiEventOutbox.js')) as unknown as {
      emitGuiEventForSession: ReturnType<typeof vi.fn>;
    };
    guiMod.emitGuiEventForSession.mockImplementationOnce(async () => {
      throw new Error('gui_events insert boom');
    });

    const ctx = {
      sessionId: 'sess-1',
      playerId: 5,
      turnId: 'turn-1',
      signal: new AbortController().signal,
    };

    await expect(enrichOneMemory(42, ctx, true)).rejects.toThrow(
      /gui_events insert boom/,
    );

    expect(txState.withTransactionCalls).toBe(1);
    expect(txState.rolledBack).toBe(true);
    // applyEnrichment was attempted inside the tx (UPDATE landed in
    // queryState), but the tx rolled back so the write effectively
    // never happened — and crucially no SSE escaped.
    expect(
      queryState.calls.some((c) => c.sql.includes('UPDATE npc_memories')),
    ).toBe(true);
    expect(guiState.sseEmits).toEqual([]);
  });
});
