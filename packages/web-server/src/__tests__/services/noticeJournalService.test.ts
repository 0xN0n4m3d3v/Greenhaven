/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-NOTICE-1 — `NoticeJournalService` contract.
//
// Pins the materializer + paginated reader without booting PGlite.
// We mock `query()` so each `it` plants the rows it cares about
// (player + gui_events queue + journal projection) and asserts the
// resulting `NoticeJournalSnapshot`. Migration shape, FKs, indexes,
// and the partial-unique invariant are covered by the PGlite-backed
// `playerJournalEntries.test.ts` companion.

import {beforeEach, describe, expect, it, vi} from 'vitest';

interface QueryRow {
  [key: string]: unknown;
}

interface QueryResult {
  rows: QueryRow[];
  rowCount?: number;
}

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();

vi.mock('../../db.js', () => ({
  query: queryMock,
}));

const {NoticeJournalService, IMPORTANT_EVENT_TYPES, sanitizeJournalPayload} =
  await import('../../services/NoticeJournalService.js');

interface MockJournalRow {
  id: number;
  entry_type: string;
  event_type: string;
  source_event_id: number | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  turn_id: string | null;
  occurred_at: string;
  created_at: string;
}

describe('NoticeJournalService (FEAT-NOTICE-1)', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  describe('IMPORTANT_EVENT_TYPES taxonomy', () => {
    it('is bounded and conservative', () => {
      expect([...IMPORTANT_EVENT_TYPES].sort()).toEqual(
        [
          'adventure:accepted',
          'adventure:expired',
          'companion:added',
          'companion:removed',
          'location:first_entry',
          'memory:added',
          'memory:enriched',
          'quest:advanced',
          'quest:auto_advanced',
          'quest:completed',
          'quest:created',
          'quest:started',
          'string:changed',
          'xp:awarded',
          'xp:levelup',
        ].sort(),
      );
    });

    it('does not journal noisy or side-effect-only event types', () => {
      const banned = [
        'quest:changed',
        'quest:choice_required',
        'message:created',
        'tool:invocation',
        'turn:started',
        'turn:completed',
        'system:event',
      ];
      for (const t of banned) {
        expect(
          (IMPORTANT_EVENT_TYPES as readonly string[]).includes(t),
        ).toBe(false);
      }
    });
  });

  describe('snapshot()', () => {
    it('returns null when the player row is missing', async () => {
      queryMock.mockResolvedValueOnce({rows: []});
      const snap = await NoticeJournalService.snapshot(7);
      expect(snap).toBeNull();
      expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('materializes pending released gui_events then returns the journal page', async () => {
      // Call 1: player existence
      queryMock.mockResolvedValueOnce({rows: [{entity_id: 7}]});
      // Call 2: materialize SELECT pending gui_events
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 100,
            session_id: 'sess-a',
            event_type: 'quest:started',
            payload: {questId: 42, title: 'The Reckoning', summary: 'Find the bell.'},
            turn_id: 'turn-1',
            released_at: '2026-05-16T18:00:00.000Z',
            created_at: '2026-05-16T18:00:00.000Z',
          },
          {
            id: 101,
            session_id: 'sess-a',
            event_type: 'xp:awarded',
            payload: {amount: 25, reason: 'Lit the bell'},
            turn_id: 'turn-1',
            released_at: '2026-05-16T18:00:01.000Z',
            created_at: '2026-05-16T18:00:01.000Z',
          },
        ],
      });
      // Call 3 + 4: INSERT ... ON CONFLICT for each row
      queryMock
        .mockResolvedValueOnce({rows: [], rowCount: 1})
        .mockResolvedValueOnce({rows: [], rowCount: 1});
      // Call 5: list SELECT
      queryMock.mockResolvedValueOnce({
        rows: [
          journalRow({
            id: 11,
            entry_type: 'progression',
            event_type: 'xp:awarded',
            source_event_id: 101,
            title: '+25 XP',
            body: 'Lit the bell',
          }),
          journalRow({
            id: 10,
            entry_type: 'quest',
            event_type: 'quest:started',
            source_event_id: 100,
            title: 'The Reckoning',
            body: 'Find the bell.',
          }),
        ],
      });

      const snap = await NoticeJournalService.snapshot(7);
      expect(snap).not.toBeNull();
      expect(snap!.playerId).toBe(7);
      expect(snap!.entries.map((e) => e.eventType)).toEqual([
        'xp:awarded',
        'quest:started',
      ]);
      expect(snap!.entries[0]?.entryType).toBe('progression');
      expect(snap!.entries[1]?.entryType).toBe('quest');
      expect(snap!.entries[0]?.title).toBe('+25 XP');
      expect(snap!.entries[1]?.title).toBe('The Reckoning');

      // The materialize SELECT must filter by player_id, status='released',
      // event_type IN taxonomy, and skip already-projected rows.
      const materializeSelect = queryMock.mock.calls[1]?.[0] ?? '';
      expect(materializeSelect).toMatch(/FROM gui_events/);
      expect(materializeSelect).toMatch(/g\.status = 'released'/);
      expect(materializeSelect).toMatch(/g\.player_id = \$1/);
      expect(materializeSelect).toMatch(/event_type = ANY\(\$2::text\[\]\)/);
      expect(materializeSelect).toMatch(/LEFT JOIN player_journal_entries/);

      // The INSERTs must use ON CONFLICT DO NOTHING against the
      // partial unique index.
      const firstInsert = queryMock.mock.calls[2]?.[0] ?? '';
      expect(firstInsert).toMatch(/INSERT INTO player_journal_entries/);
      expect(firstInsert).toMatch(/ON CONFLICT \(player_id, source_event_id\)/);
      expect(firstInsert).toMatch(/WHERE source_event_id IS NOT NULL/);
      expect(firstInsert).toMatch(/DO NOTHING/);
    });

    it('does nothing when no new gui_events have been released', async () => {
      queryMock
        .mockResolvedValueOnce({rows: [{entity_id: 7}]})
        .mockResolvedValueOnce({rows: []}) // materialize SELECT returns 0 rows
        .mockResolvedValueOnce({rows: []}); // list SELECT
      const snap = await NoticeJournalService.snapshot(7);
      expect(snap).not.toBeNull();
      expect(snap!.entries).toEqual([]);
      expect(snap!.nextCursor).toBeNull();
      // Exactly 3 calls: player + materialize-select + list. No INSERTs.
      expect(queryMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('list() pagination', () => {
    it('returns newest-first and clamps limit at 200', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          journalRow({id: 5, entry_type: 'quest', event_type: 'quest:started'}),
          journalRow({id: 4, entry_type: 'quest', event_type: 'quest:advanced'}),
        ],
      });
      const snap = await NoticeJournalService.list(7, {limit: 1000});
      expect(snap.entries.length).toBeGreaterThan(0);
      const limitParam = queryMock.mock.calls[0]?.[1]?.[1] as number;
      // Limit is param 2 (player + limit_plus_one). 200 cap means 201.
      expect(limitParam).toBe(201);
    });

    it('reports nextCursor when there is another page', async () => {
      // limit=2 → query asks for 3 rows; if it returns 3, nextCursor = id of 2nd row
      queryMock.mockResolvedValueOnce({
        rows: [
          journalRow({id: 5}),
          journalRow({id: 4}),
          journalRow({id: 3}),
        ],
      });
      const snap = await NoticeJournalService.list(7, {limit: 2});
      expect(snap.entries.map((e) => e.id)).toEqual([5, 4]);
      expect(snap.nextCursor).toBe(4);
    });

    it('returns null nextCursor when the page is the last', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [journalRow({id: 5}), journalRow({id: 4})],
      });
      const snap = await NoticeJournalService.list(7, {limit: 50});
      expect(snap.nextCursor).toBeNull();
    });

    it('passes cursor as an exclusive `id <` filter', async () => {
      queryMock.mockResolvedValueOnce({rows: []});
      await NoticeJournalService.list(7, {cursor: 42, limit: 10});
      const sql = queryMock.mock.calls[0]?.[0] ?? '';
      expect(sql).toMatch(/AND id < \$/);
    });

    it('filters by entry_type when supplied', async () => {
      queryMock.mockResolvedValueOnce({rows: []});
      await NoticeJournalService.list(7, {type: 'quest'});
      const sql = queryMock.mock.calls[0]?.[0] ?? '';
      const params = (queryMock.mock.calls[0]?.[1] ?? []) as unknown[];
      expect(sql).toMatch(/AND entry_type = \$/);
      expect(params).toContain('quest');
    });

    it('ignores unknown entry_type values without filtering', async () => {
      queryMock.mockResolvedValueOnce({rows: []});
      await NoticeJournalService.list(7, {
        type: 'definitely-not-a-bucket' as never,
      });
      const sql = queryMock.mock.calls[0]?.[0] ?? '';
      expect(sql).not.toMatch(/AND entry_type =/);
    });
  });

  describe('materialize() title/body derivation', () => {
    it('derives titles from structured payload fields with safe fallbacks', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          guiEventRow({
            id: 200,
            event_type: 'xp:awarded',
            payload: {amount: 50},
          }),
          guiEventRow({
            id: 201,
            event_type: 'companion:added',
            payload: {npcName: 'Sable Vey'},
          }),
          guiEventRow({
            id: 202,
            event_type: 'location:first_entry',
            payload: {locationName: 'Town square', introBubble: 'Bells ring overhead.'},
          }),
          guiEventRow({
            id: 203,
            event_type: 'quest:started',
            // no title in payload — should fall back deterministically
            payload: {},
          }),
        ],
      });
      // 4 INSERTs
      for (let i = 0; i < 4; i++) {
        queryMock.mockResolvedValueOnce({rows: [], rowCount: 1});
      }
      await NoticeJournalService.materialize(7);
      const inserts = queryMock.mock.calls.slice(1).map((c) => c[1] ?? []);
      // Each INSERT has (player_id, session_id, source_event_id,
      //   entry_type, event_type, title, body, payload, turn_id, occurred_at)
      // Title is index 5, body index 6.
      const titles = inserts.map((p) => (p as unknown[])[5]);
      const bodies = inserts.map((p) => (p as unknown[])[6]);
      const entryTypes = inserts.map((p) => (p as unknown[])[3]);
      expect(titles).toEqual([
        '+50 XP',
        'Sable Vey',
        'Town square',
        'Quest started',
      ]);
      expect(bodies).toEqual([
        null, // xp:awarded with no reason
        null, // companion:added with no reason
        'Bells ring overhead.',
        null,
      ]);
      expect(entryTypes).toEqual(['progression', 'relationship', 'world', 'quest']);
    });
  });

  describe('error shape from snapshot()', () => {
    it('passes 0 / negative ids straight through to the player check', async () => {
      queryMock.mockResolvedValueOnce({rows: []});
      const snap = await NoticeJournalService.snapshot(0);
      expect(snap).toBeNull();
    });
  });

  // FEAT-MEMORY-1 — memory journal privacy hardening.
  describe('memory privacy (FEAT-MEMORY-1)', () => {
    const SECRET = 'she suspects the lord poisoned the cook';
    const memoryPayload = {
      memoryId: 7,
      ownerId: 42,
      ownerName: 'Sable Vey',
      aboutId: 9,
      aboutName: 'The Lord',
      text: SECRET,
      summary: SECRET,
      draft_text: SECRET,
      internal_reflection: 'she is afraid to speak it aloud',
      link_reason: 'cross-references the cook poisoning thread',
      tags: ['entity:9', 'sensitive', 'suspicion'],
      kind: 'betrayal',
      category: 'betrayal',
      sensitive: true,
      importance: 0.9,
    };

    it('sanitizeJournalPayload() strips memory text + category + tags + reflections', () => {
      const safe = sanitizeJournalPayload('memory:added', memoryPayload);
      // Identifiers + safe numeric importance survive.
      expect(safe).toEqual({
        memoryId: 7,
        ownerId: 42,
        ownerName: 'Sable Vey',
        aboutId: 9,
        aboutName: 'The Lord',
        importance: 0.9,
      });
      // Every private field is gone.
      const serialized = JSON.stringify(safe);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain('internal_reflection');
      expect(serialized).not.toContain('link_reason');
      expect(serialized).not.toContain('betrayal');
      expect(serialized).not.toContain('suspicion');
      expect(serialized).not.toContain('draft_text');
    });

    it('sanitizeJournalPayload() also handles memory:enriched', () => {
      const safe = sanitizeJournalPayload('memory:enriched', memoryPayload);
      expect(JSON.stringify(safe)).not.toContain(SECRET);
      expect(JSON.stringify(safe)).not.toContain('betrayal');
    });

    it('sanitizeJournalPayload() is a no-op on non-memory events', () => {
      const original = {questId: 1, title: 'x', summary: 'y'};
      const out = sanitizeJournalPayload('quest:created', original);
      expect(out).toBe(original);
    });

    it('materialize() persists a memory:added row with body=null and a stripped payload', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          guiEventRow({
            id: 500,
            event_type: 'memory:added',
            payload: memoryPayload,
          }),
        ],
      });
      queryMock.mockResolvedValueOnce({rows: [], rowCount: 1});

      await NoticeJournalService.materialize(7);
      const insertCall = queryMock.mock.calls[1];
      expect(insertCall).toBeDefined();
      const params = (insertCall?.[1] ?? []) as unknown[];
      // (player_id, session_id, source_event_id, entry_type,
      //  event_type, title, body, payload_json, turn_id, occurred_at)
      const title = params[5];
      const body = params[6];
      const payloadJson = params[7] as string;
      expect(title).toBe('Memory recorded');
      expect(body).toBeNull();
      // The persisted JSON must NOT contain the raw memory secret
      // or any private-revealing field.
      expect(payloadJson).not.toContain(SECRET);
      expect(payloadJson).not.toContain('betrayal');
      expect(payloadJson).not.toContain('internal_reflection');
      expect(payloadJson).not.toContain('link_reason');
      expect(payloadJson).not.toContain('"text"');
      expect(payloadJson).not.toContain('"draft_text"');
      expect(payloadJson).not.toContain('"summary"');
      expect(payloadJson).not.toContain('"tags"');
    });

    it('materialize() persists a memory:enriched row with body=null and a stripped payload', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          guiEventRow({
            id: 501,
            event_type: 'memory:enriched',
            payload: memoryPayload,
          }),
        ],
      });
      queryMock.mockResolvedValueOnce({rows: [], rowCount: 1});
      await NoticeJournalService.materialize(7);
      const params = (queryMock.mock.calls[1]?.[1] ?? []) as unknown[];
      expect(params[5]).toBe('Memory deepened');
      expect(params[6]).toBeNull();
      expect(params[7]).not.toContain(SECRET);
    });

    it('list() defensively sanitizes legacy memory rows before returning them', async () => {
      // Simulate a legacy row that was materialized before the
      // privacy fix landed: secret content in body + payload.
      queryMock.mockResolvedValueOnce({
        rows: [
          journalRow({
            id: 999,
            entry_type: 'system',
            event_type: 'memory:added',
            source_event_id: 500,
            title: 'betrayal', // legacy `kind`-leaking title
            body: SECRET, // legacy body with raw memory text
            payload: memoryPayload,
          }),
        ],
      });
      const snap = await NoticeJournalService.list(7);
      expect(snap.entries).toHaveLength(1);
      const entry = snap.entries[0]!;
      // body forced to null on the way out
      expect(entry.body).toBeNull();
      // payload stripped on the way out
      const payloadJson = JSON.stringify(entry.payload);
      expect(payloadJson).not.toContain(SECRET);
      expect(payloadJson).not.toContain('betrayal');
      expect(payloadJson).not.toContain('internal_reflection');
      expect(payloadJson).not.toContain('link_reason');
      // legacy title rewritten to the generic placeholder so the
      // memory `kind` / `category` (`"betrayal"`) never leaves the
      // service.
      expect(entry.title).toBe('Memory recorded');
      // The full serialized entry — title, body, payload, every
      // field — must not contain the secret or any category clue
      // anywhere. No `entryWithoutTitle` loophole.
      const fullEntryJson = JSON.stringify(entry);
      expect(fullEntryJson).not.toContain(SECRET);
      expect(fullEntryJson).not.toContain('betrayal');
      expect(fullEntryJson).not.toContain('suspicion');
      expect(fullEntryJson).not.toContain('intimacy');
      expect(fullEntryJson).not.toContain('internal_reflection');
      expect(fullEntryJson).not.toContain('link_reason');
      expect(fullEntryJson).not.toContain('draft_text');
    });

    it('list() rewrites legacy memory:enriched titles to the generic placeholder', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          journalRow({
            id: 1000,
            entry_type: 'system',
            event_type: 'memory:enriched',
            source_event_id: 501,
            title: 'intimacy', // legacy `kind`-leaking title
            body: SECRET,
            payload: memoryPayload,
          }),
        ],
      });
      const snap = await NoticeJournalService.list(7);
      const entry = snap.entries[0]!;
      expect(entry.title).toBe('Memory deepened');
      expect(entry.body).toBeNull();
      expect(JSON.stringify(entry)).not.toContain('intimacy');
      expect(JSON.stringify(entry)).not.toContain(SECRET);
    });

    it('list() leaves non-memory rows untouched', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          journalRow({
            id: 8,
            entry_type: 'quest',
            event_type: 'quest:started',
            title: 'The Reckoning',
            body: 'Find the bell.',
            payload: {questId: 1, title: 'The Reckoning'},
          }),
        ],
      });
      const snap = await NoticeJournalService.list(7);
      expect(snap.entries[0]?.body).toBe('Find the bell.');
      expect(snap.entries[0]?.payload).toEqual({
        questId: 1,
        title: 'The Reckoning',
      });
    });
  });
});

function journalRow(overrides: Partial<MockJournalRow>): QueryRow {
  return {
    id: 1,
    entry_type: 'quest',
    event_type: 'quest:started',
    source_event_id: 100,
    title: 'Quest started',
    body: null,
    payload: {},
    turn_id: null,
    occurred_at: '2026-05-16T18:00:00.000Z',
    created_at: '2026-05-16T18:00:00.000Z',
    ...overrides,
  };
}

function guiEventRow(overrides: {
  id: number;
  event_type: string;
  payload?: Record<string, unknown>;
}): QueryRow {
  return {
    id: overrides.id,
    session_id: 'sess-a',
    event_type: overrides.event_type,
    payload: overrides.payload ?? {},
    turn_id: 'turn-1',
    released_at: '2026-05-16T18:00:00.000Z',
    created_at: '2026-05-16T18:00:00.000Z',
  };
}
