/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

type QueryResult = {rows: Array<Record<string, unknown>>};

const queryMock = vi.hoisted(() =>
  vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(),
);

vi.mock('../../db.js', () => ({
  query: queryMock,
}));

import {recordLocationVisit} from '../../domain/memory/location/locationMemory.js';

function installVisitQueryMock(opts: {
  existingVisitCount?: number;
  returnedVisitCount: number;
}) {
  queryMock.mockImplementation(async (sql: string) => {
    if (
      sql.includes('SELECT visit_count, metadata') &&
      sql.includes('FROM player_location_visits')
    ) {
      return {
        rows:
          opts.existingVisitCount == null
            ? []
            : [{visit_count: opts.existingVisitCount, metadata: {}}],
      };
    }
    if (sql.includes('INSERT INTO player_location_visits')) {
      return {rows: [{visit_count: opts.returnedVisitCount, metadata: {}}]};
    }
    if (sql.includes('UPDATE players')) return {rows: []};
    if (sql.includes('UPDATE npc_memories')) return {rows: []};
    if (
      sql.includes('SELECT display_name') &&
      sql.includes("kind IN ('location', 'district')")
    ) {
      return {rows: [{display_name: 'Greenhaven Port'}]};
    }
    if (sql.includes('FROM location_intro_bubbles')) {
      return {
        rows: [{lang: 'en', bubble_text: 'The port crashes into view.'}],
      };
    }
    throw new Error(`Unexpected query in location visit test: ${sql}`);
  });
}

describe('recordLocationVisit first-entry intro bubbles', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('loads an intro bubble for the first visit', async () => {
    installVisitQueryMock({returnedVisitCount: 1});

    const visit = await recordLocationVisit({
      playerId: 7,
      locationId: 42,
      lang: 'en',
      previousLocationId: null,
    });

    expect(visit.firstVisit).toBe(true);
    expect(visit.enteredNow).toBe(true);
    expect(visit.visitCount).toBe(1);
    expect(visit.introBubble).toBe('The port crashes into view.');
  });

  it('does not reload the first-entry bubble on later re-entry', async () => {
    installVisitQueryMock({existingVisitCount: 1, returnedVisitCount: 2});

    const visit = await recordLocationVisit({
      playerId: 7,
      locationId: 42,
      lang: 'en',
      previousLocationId: 99,
    });

    expect(visit.firstVisit).toBe(false);
    expect(visit.enteredNow).toBe(true);
    expect(visit.visitCount).toBe(2);
    expect(visit.introBubble).toBeNull();
    expect(
      queryMock.mock.calls.some((call) =>
        String(call[0]).includes('FROM location_intro_bubbles'),
      ),
    ).toBe(false);
  });
});
