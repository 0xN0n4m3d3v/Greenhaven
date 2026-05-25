/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-QUEST-1 — `QuestDashboardService.snapshot` contract.
//
// Pins the DTO grouping + batched-join behaviour without booting
// PGlite. We mock `query()` so each `describe`/`it` plants the
// rows it cares about (player + joined player_quests + gui_events)
// and asserts the resulting `QuestDashboardSnapshot`.

import {beforeEach, describe, expect, it, vi} from 'vitest';

interface QueryRow {
  [key: string]: unknown;
}

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{rows: QueryRow[]}>>();

vi.mock('../../db.js', () => ({
  query: queryMock,
}));

vi.mock('../../i18n.js', () => ({
  loc: (
    _rec: unknown,
    _lang: string,
    _field: string,
    fallback: unknown,
  ) => fallback,
  locQuestStageField: (
    _rec: unknown,
    _lang: string,
    _stage: unknown,
    _field: string,
    fallback: unknown,
  ) => fallback,
  resolveLanguage: () => 'en',
}));

vi.mock('../../quest/objectiveEvaluators.js', () => ({
  evaluateObjective: vi.fn(async (obj: Record<string, unknown>) => {
    // Stage objectives in our seed cases set `__satisfied:true`
    // when we want the evaluator to say "done".
    return {
      satisfied: obj['__satisfied'] === true,
      detail: typeof obj['__detail'] === 'string' ? obj['__detail'] : null,
    };
  }),
}));

vi.mock('../../turnContext/index.js', () => ({
  describeObjective: (obj: Record<string, unknown>) =>
    typeof obj['__text'] === 'string' ? (obj['__text'] as string) : 'objective',
}));

const {QuestDashboardService} = await import(
  '../../services/QuestDashboardService.js'
);

describe('QuestDashboardService.snapshot (FEAT-QUEST-1)', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns null when the player row is missing', async () => {
    queryMock.mockResolvedValueOnce({rows: []});
    const snap = await QuestDashboardService.snapshot(42);
    expect(snap).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty snapshot with zero counts when player has no quests', async () => {
    queryMock
      .mockResolvedValueOnce({rows: [{preferred_language: 'en'}]})
      .mockResolvedValueOnce({rows: []})
      .mockResolvedValueOnce({rows: []});
    const snap = await QuestDashboardService.snapshot(42);
    expect(snap).not.toBeNull();
    expect(snap!.playerId).toBe(42);
    expect(snap!.summary).toEqual({
      total: 0,
      active: 0,
      choiceRequired: 0,
      offered: 0,
      completed: 0,
      failed: 0,
      archived: 0,
    });
    expect(snap!.active).toEqual([]);
    expect(snap!.completed).toEqual([]);
    expect(snap!.failed).toEqual([]);
    expect(snap!.recentEvents).toEqual([]);
  });

  it('batches player_quests with quest entities in a single JOIN query', async () => {
    queryMock
      .mockResolvedValueOnce({rows: [{preferred_language: 'en'}]})
      .mockResolvedValueOnce({rows: []})
      .mockResolvedValueOnce({rows: []});
    await QuestDashboardService.snapshot(42);
    const callSqls = queryMock.mock.calls.map((c) => String(c[0]));
    // Player lang lookup + JOIN quest snapshot + gui_events tail = 3
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(callSqls[1]).toMatch(/FROM player_quests pq/i);
    expect(callSqls[1]).toMatch(/JOIN entities e/i);
    // No per-quest entity SELECT loop.
    expect(
      callSqls.filter((s) => /SELECT.+FROM entities WHERE id = \$1/i.test(s)),
    ).toHaveLength(0);
  });

  it('groups quests into active / completed / failed and marks choiceRequired', async () => {
    queryMock
      .mockResolvedValueOnce({rows: [{preferred_language: 'en'}]})
      .mockResolvedValueOnce({
        rows: [
          questRow({
            id: 101,
            status: 'active',
            currentStageId: 'open',
            accumulated: {awaiting_choice: true},
          }),
          questRow({
            id: 102,
            status: 'active',
            currentStageId: 'open',
          }),
          questRow({
            id: 103,
            status: 'completed',
            currentStageId: null,
            startedAt: '2026-05-01T00:00:00Z',
            completedAt: '2026-05-15T00:00:00Z',
          }),
          questRow({
            id: 104,
            status: 'failed',
            currentStageId: 'open',
          }),
          questRow({
            id: 105,
            status: 'offered',
            currentStageId: null,
          }),
        ],
      })
      .mockResolvedValueOnce({rows: []});

    const snap = await QuestDashboardService.snapshot(42);
    expect(snap).not.toBeNull();
    const s = snap!;
    expect(s.active.map((c) => c.id)).toEqual([101, 102]);
    expect(s.choiceRequired.map((c) => c.id)).toEqual([101]);
    expect(s.completed.map((c) => c.id)).toEqual([103]);
    expect(s.failed.map((c) => c.id)).toEqual([104]);
    expect(s.offered.map((c) => c.id)).toEqual([105]);
    expect(s.summary).toEqual({
      total: 5,
      active: 2,
      choiceRequired: 1,
      offered: 1,
      completed: 1,
      failed: 1,
      archived: 0,
    });
    expect(s.active[0]!.awaitingChoice).toBe(true);
    expect(s.active[1]!.awaitingChoice).toBe(false);
  });

  it('builds a stage timeline + objectives + nextActionHint for an active quest', async () => {
    queryMock
      .mockResolvedValueOnce({rows: [{preferred_language: 'en'}]})
      .mockResolvedValueOnce({
        rows: [
          questRow({
            id: 201,
            status: 'active',
            currentStageId: 'middle',
            stages: [
              stage('opening', 'Opening', 'It begins.'),
              stage('middle', 'Middle', 'Here we are.', [
                {
                  __text: 'Talk to Mikka',
                  __satisfied: true,
                  __detail: 'spoke yesterday',
                },
                {__text: 'Pay the fee'},
              ]),
              stage('finale', 'Finale', 'Climax.'),
            ],
          }),
        ],
      })
      .mockResolvedValueOnce({rows: []});

    const snap = await QuestDashboardService.snapshot(42);
    const card = snap!.active[0]!;
    expect(card.stage?.id).toBe('middle');
    expect(card.stage?.name).toBe('Middle');
    expect(card.stages.map((s) => s.status)).toEqual([
      'done',
      'current',
      'upcoming',
    ]);
    expect(card.objectives).toEqual([
      {text: 'Talk to Mikka', satisfied: true, detail: 'spoke yesterday'},
      {text: 'Pay the fee', satisfied: false, detail: null},
    ]);
    expect(card.nextActionHint).toBe('Pay the fee');
  });

  it('marks every stage as done when the quest is completed', async () => {
    queryMock
      .mockResolvedValueOnce({rows: [{preferred_language: 'en'}]})
      .mockResolvedValueOnce({
        rows: [
          questRow({
            id: 301,
            status: 'completed',
            currentStageId: 'finale',
            stages: [
              stage('opening', 'Opening', 'It begins.'),
              stage('finale', 'Finale', 'Done.'),
            ],
            completedAt: '2026-05-15T00:00:00Z',
          }),
        ],
      })
      .mockResolvedValueOnce({rows: []});
    const snap = await QuestDashboardService.snapshot(42);
    const card = snap!.completed[0]!;
    expect(card.stages.map((s) => s.status)).toEqual(['done', 'done']);
    // No objectives evaluated for completed quests — only active.
    expect(card.objectives).toEqual([]);
    expect(card.nextActionHint).toBeNull();
    expect(card.completedAt).toBe('2026-05-15T00:00:00Z');
  });

  it('surfaces recent gui_events filtered to quest/adventure types', async () => {
    queryMock
      .mockResolvedValueOnce({rows: [{preferred_language: 'en'}]})
      .mockResolvedValueOnce({rows: []})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 2002,
            event_type: 'quest:changed',
            payload: {quest_entity_id: 101, quest_name: 'Heart of Glass'},
            released_at: '2026-05-16T00:00:00Z',
            created_at: '2026-05-16T00:00:00Z',
          },
          {
            id: 2001,
            event_type: 'adventure:hook',
            payload: {questName: 'Velvet Booth'},
            released_at: null,
            created_at: '2026-05-15T23:55:00Z',
          },
        ],
      });
    const snap = await QuestDashboardService.snapshot(42);
    expect(snap!.recentEvents).toHaveLength(2);
    expect(snap!.recentEvents[0]).toMatchObject({
      id: 2002,
      type: 'quest:changed',
      questEntityId: 101,
      questName: 'Heart of Glass',
    });
    expect(snap!.recentEvents[1]).toMatchObject({
      type: 'adventure:hook',
      questName: 'Velvet Booth',
    });
    // The gui_events query is filtered to the dashboard taxonomy.
    const eventCall = queryMock.mock.calls[2]!;
    const params = eventCall[1] as unknown[];
    const allowed = params[1] as string[];
    expect(allowed).toEqual(
      expect.arrayContaining([
        'quest:created',
        'quest:started',
        'quest:advanced',
        'quest:auto_advanced',
        'quest:choice_required',
        'quest:completed',
        'quest:changed',
        'adventure:hook',
        'adventure:accepted',
        'adventure:expired',
      ]),
    );
  });

  it('extracts questEntityId + questName from every payload variant the server emits', async () => {
    queryMock
      .mockResolvedValueOnce({rows: [{preferred_language: 'en'}]})
      .mockResolvedValueOnce({rows: []})
      .mockResolvedValueOnce({
        rows: [
          // tools/quest.ts:emitQuestCard payload shape — `questId`
          // + `title`. Used by quest:created / quest:started /
          // quest:advanced / quest:completed / quest:auto_advanced.
          {
            id: 4001,
            event_type: 'quest:started',
            payload: {questId: 700, title: 'Pact of Smoke', tags: []},
            released_at: '2026-05-16T01:00:00Z',
            created_at: '2026-05-16T01:00:00Z',
          },
          // questEngine quest:changed payload shape — `quest_entity_id`
          // + `quest_name` (`quest_name` may be absent on the wire).
          {
            id: 4002,
            event_type: 'quest:changed',
            payload: {
              quest_entity_id: 701,
              quest_name: 'Bond Repaid',
              status: 'completed',
            },
            released_at: null,
            created_at: '2026-05-16T01:01:00Z',
          },
          // Adventure hook payload — `questEntityId` + `questName`
          // (camelCase variants the donor still emits).
          {
            id: 4003,
            event_type: 'adventure:accepted',
            payload: {questEntityId: 702, questName: 'Lantern Walk'},
            released_at: null,
            created_at: '2026-05-16T01:02:00Z',
          },
          // String-encoded `quest_id` (legacy SQL cast). Numeric
          // coercion still produces a positive int.
          {
            id: 4004,
            event_type: 'quest:advanced',
            payload: {quest_id: '703'},
            released_at: null,
            created_at: '2026-05-16T01:03:00Z',
          },
          // Unrelated payload — no quest pointer, no name.
          {
            id: 4005,
            event_type: 'adventure:expired',
            payload: {reason: 'timeout'},
            released_at: null,
            created_at: '2026-05-16T01:04:00Z',
          },
        ],
      });
    const snap = await QuestDashboardService.snapshot(42);
    const byId = new Map(
      snap!.recentEvents.map((e) => [e.id, e] as const),
    );
    expect(byId.get(4001)).toMatchObject({
      questEntityId: 700,
      questName: 'Pact of Smoke',
    });
    expect(byId.get(4002)).toMatchObject({
      questEntityId: 701,
      questName: 'Bond Repaid',
    });
    expect(byId.get(4003)).toMatchObject({
      questEntityId: 702,
      questName: 'Lantern Walk',
    });
    expect(byId.get(4004)).toMatchObject({
      questEntityId: 703,
      questName: null,
    });
    expect(byId.get(4005)).toMatchObject({
      questEntityId: null,
      questName: null,
    });
  });
});

function questRow(opts: {
  id: number;
  status: string;
  currentStageId: string | null;
  accumulated?: Record<string, unknown>;
  startedAt?: string | null;
  completedAt?: string | null;
  stages?: Array<Record<string, unknown>>;
}): QueryRow {
  const stages = opts.stages ?? [stage('open', 'Open', 'Stage description.')];
  return {
    quest_entity_id: opts.id,
    status: opts.status,
    current_stage_id: opts.currentStageId,
    started_at: opts.startedAt ?? '2026-05-10T00:00:00Z',
    completed_at: opts.completedAt ?? null,
    accumulated_state: opts.accumulated ?? {},
    display_name: `Quest ${opts.id}`,
    summary: `Summary ${opts.id}`,
    profile: {
      tags: ['debug'],
      partner: 'Mikka Quickgrin',
      rewards: {xp: 50},
      stages,
    },
    i18n: null,
  };
}

function stage(
  id: string,
  name: string,
  description: string,
  objectives: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {id, name, description, objectives};
}
