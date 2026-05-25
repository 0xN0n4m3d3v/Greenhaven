/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — Character State routes.
//
//   * GET  /:id/character-state           — typed snapshot DTO.
//   * POST /:id/character-state/action    — player-clickable
//     equip/unequip title + stat/skill point spend dispatching
//     into the existing `equip_title` / `spend_stat_point` /
//     `spend_skill_point` tools via `executeTool`.
//
// Ownership is enforced by the central `ownsPlayer()` middleware
// mounted in `index.ts` on `/api/player/:id/character-state` and
// the `/:id/character-state/*` wildcard, plus `rateLimitStateChanges()`
// on the wildcard (SEC-5) so a single client can't burn the budget
// click-spamming the buttons. The action route validates the
// `sessionId` body field against the authenticated player via
// `SessionLifecycleService.getOwned` so a foreign / stale session
// id never slips into the dispatched `ToolContext`. Mirrors the
// FEAT-INV-1 `/inventory/action` contract.
//
// `award_progression_xp` and `award_title` are deliberately NOT
// exposed through this route. Granting XP / new titles is a
// broker / GM concern and must stay inside tool / live-ops paths;
// the player-action surface is limited to *consuming* already-
// earned currency (title slots, stat points, skill points).

import {Hono} from 'hono';
import {z} from 'zod';
import {CharacterStateService} from '../services/CharacterStateService.js';
import {
  SessionLifecycleService,
  SessionOwnershipError,
} from '../services/SessionLifecycleService.js';
import {
  executeTool,
  runWithContext,
  type ToolContext,
} from '../tools/base.js';

export const characterStateRoutes = new Hono();

const SessionId = z.string().trim().min(1).max(120);
const TitleKey = z.string().trim().min(1).max(120);
const StatKey = z.string().trim().min(1).max(40);
const SkillRef = z.string().trim().min(1).max(200);

const ActionBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('equip_title'),
    sessionId: SessionId,
    titleKey: TitleKey,
  }),
  z.object({
    action: z.literal('unequip_title'),
    sessionId: SessionId,
    titleKey: TitleKey,
  }),
  z.object({
    action: z.literal('spend_stat_point'),
    sessionId: SessionId,
    statKey: StatKey,
    reason: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    action: z.literal('spend_skill_point'),
    sessionId: SessionId,
    skill: SkillRef,
  }),
]);

type ActionInput = z.infer<typeof ActionBody>;

characterStateRoutes.get('/:id/character-state', async (c) => {
  const playerId = Number(c.req.param('id'));
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return c.json({error: 'invalid player id'}, 400);
  }
  const snapshot = await CharacterStateService.snapshot(
    playerId,
    c.req.query('language'),
  );
  if (!snapshot) return c.json({error: 'unknown_player'}, 404);
  return c.json(snapshot);
});

characterStateRoutes.post('/:id/character-state/action', async (c) => {
  const playerId = Number(c.req.param('id'));
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return c.json({error: 'invalid player id'}, 400);
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({error: 'invalid_json'}, 400);
  }
  const parsed = ActionBody.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '<root>',
          message: i.message,
        })),
      },
      400,
    );
  }

  try {
    const session = await SessionLifecycleService.getOwned(
      parsed.data.sessionId,
      playerId,
    );
    if (!session) {
      return c.json(
        {ok: false, action: parsed.data.action, error: 'unknown_session'},
        404,
      );
    }
  } catch (err) {
    if (err instanceof SessionOwnershipError) {
      return c.json(
        {ok: false, action: parsed.data.action, error: 'session_forbidden'},
        403,
      );
    }
    throw err;
  }

  const ctx: ToolContext = {
    sessionId: parsed.data.sessionId,
    playerId,
    toolHistorySource: 'direct',
    turnInputKind: 'player_action',
  };
  const {toolName, toolArgs} = mapActionToTool(parsed.data);
  const result = await runWithContext(ctx, () =>
    executeTool(toolName, toolArgs, ctx),
  );
  if (!result.ok) {
    return c.json(
      {
        ok: false,
        action: parsed.data.action,
        error: result.error ?? 'tool_error',
      },
      400,
    );
  }
  return c.json({
    ok: true,
    action: parsed.data.action,
    result: result.data ?? null,
  });
});

function mapActionToTool(input: ActionInput): {
  toolName: string;
  toolArgs: Record<string, unknown>;
} {
  switch (input.action) {
    case 'equip_title':
      return {
        toolName: 'equip_title',
        toolArgs: {title_key: input.titleKey, equip: true},
      };
    case 'unequip_title':
      return {
        toolName: 'equip_title',
        toolArgs: {title_key: input.titleKey, equip: false},
      };
    case 'spend_stat_point':
      return {
        toolName: 'spend_stat_point',
        toolArgs: {
          stat_key: input.statKey,
          ...(input.reason ? {reason: input.reason} : {}),
        },
      };
    case 'spend_skill_point':
      return {
        toolName: 'spend_skill_point',
        toolArgs: {skill: input.skill},
      };
  }
}
