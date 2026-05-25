/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Quest routes:
//   * GET /api/player/:id/quests           — compact panel snapshot
//     used by `QuestPanel` (`QuestLogService.log`). Kept unchanged
//     for backward compatibility with the existing rail panel.
//   * GET /api/player/:id/quest-dashboard  — FEAT-QUEST-1 batched
//     dashboard DTO used by `useQuestDashboard` /
//     `QuestDashboardSurface`. Single-query join with grouped
//     `active` / `choiceRequired` / `offered` / `completed` /
//     `failed` / `archived` cards plus a `recentEvents` rail.
//
// Both endpoints are ownership-protected by `ownsPlayer()` mounted
// in `index.ts` on `/api/player/:id/quests` and
// `/api/player/:id/quest-dashboard`.

import {Hono} from 'hono';
import {QuestDashboardService} from '../services/QuestDashboardService.js';
import {QuestLogService} from '../services/QuestLogService.js';

export const questRoutes = new Hono();

questRoutes.get('/:id/quests', async (c) => {
  const playerId = Number(c.req.param('id'));
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return c.json({error: 'invalid player id'}, 400);
  }
  const log = await QuestLogService.log(playerId, c.req.query('language'));
  if (!log) return c.json({error: 'unknown_player'}, 404);
  return c.json(log);
});

questRoutes.get('/:id/quest-dashboard', async (c) => {
  const playerId = Number(c.req.param('id'));
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return c.json({error: 'invalid player id'}, 400);
  }
  const snapshot = await QuestDashboardService.snapshot(
    playerId,
    c.req.query('language'),
  );
  if (!snapshot) return c.json({error: 'unknown_player'}, 404);
  return c.json(snapshot);
});
