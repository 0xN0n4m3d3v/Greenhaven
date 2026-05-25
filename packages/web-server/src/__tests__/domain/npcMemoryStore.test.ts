/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
}

const queryMock =
  vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();

vi.mock('../../db.js', () => ({
  query: queryMock,
}));

const {upsertRollingDialogueSummary} = await import(
  '../../domain/memory/npc/memoryStore.js'
);

describe('npc memory store rolling dialogue summaries', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({rows: [], rowCount: 0});
  });

  it('casts the rolling-summary checkpoint parameter before jsonb_build_object', async () => {
    await upsertRollingDialogueSummary({
      ownerEntityId: 12,
      aboutEntityId: 34,
      text: 'Vex remembers the player asking about the cold case.',
      upToTurn: 56,
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    const insertSql = String(queryMock.mock.calls[1]?.[0] ?? '');
    const insertParams = queryMock.mock.calls[1]?.[1] ?? [];

    expect(insertSql).toContain(
      "jsonb_build_object('visibility', 'public', 'up_to_turn', $4::int)",
    );
    expect(insertParams).toEqual([
      12,
      34,
      'Vex remembers the player asking about the cold case.',
      56,
    ]);
  });
});
