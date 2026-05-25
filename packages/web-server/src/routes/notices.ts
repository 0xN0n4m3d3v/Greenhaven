/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-NOTICE-1 — Notice Journal read route.
//
//   * GET /api/player/:id/notices?limit=50&cursor=<id>&type=<entry_type>
//     Returns `{playerId, entries, nextCursor}` from the durable
//     `player_journal_entries` projection. Materialization of any
//     newly released `gui_events` happens inside
//     `NoticeJournalService.snapshot`.
//
// Ownership is enforced by the central `ownsPlayer()` middleware
// mounted in `index.ts` on `/api/player/:id/notices`. Errors stick
// to the same shape as the FEAT-INV-1 / FEAT-QUEST-1 routes: 400
// on an invalid id or unsupported query parameter, 404 when the
// player row is missing.

import {Hono} from 'hono';
import {
  NoticeJournalService,
  type JournalEntryType,
} from '../services/NoticeJournalService.js';

export const noticeRoutes = new Hono();

const VALID_ENTRY_TYPES: ReadonlySet<JournalEntryType> = new Set([
  'quest',
  'progression',
  'relationship',
  'world',
  'story',
  'system',
]);

noticeRoutes.get('/:id/notices', async (c) => {
  const playerId = Number(c.req.param('id'));
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return c.json({error: 'invalid player id'}, 400);
  }

  const limitParam = c.req.query('limit');
  let limit: number | undefined;
  if (limitParam != null) {
    const parsed = Number(limitParam);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({error: 'invalid limit'}, 400);
    }
    limit = parsed;
  }

  const cursorParam = c.req.query('cursor');
  let cursor: number | null | undefined;
  if (cursorParam != null) {
    const parsed = Number(cursorParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return c.json({error: 'invalid cursor'}, 400);
    }
    cursor = parsed;
  }

  const typeParam = c.req.query('type');
  let type: JournalEntryType | null | undefined;
  if (typeParam != null) {
    if (!VALID_ENTRY_TYPES.has(typeParam as JournalEntryType)) {
      return c.json({error: 'invalid type'}, 400);
    }
    type = typeParam as JournalEntryType;
  }

  const snapshot = await NoticeJournalService.snapshot(playerId, {
    limit,
    cursor,
    type,
  });
  if (!snapshot) return c.json({error: 'unknown_player'}, 404);
  return c.json(snapshot);
});
