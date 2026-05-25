/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-INV-1 — `/api/player/:id/inventory` routes.
//
//   * GET  /:id/inventory        → snapshot read for the surface.
//   * POST /:id/inventory/action → use / equip / unequip / give.
//
// Ownership is enforced by the central `ownsPlayer()` middleware
// mounted in `index.ts` (`/api/player/:id/inventory` + the
// `/:id/inventory/*` wildcard line) and, for the state-changing
// action endpoint, by `rateLimitStateChanges()` immediately after
// the ownership check. The handlers parse + delegate; 500-class
// errors propagate to `app.onError` and surface as the SEC-3
// generic body.
//
// The action endpoint deliberately does NOT re-implement inventory
// mutation rules. It dispatches into the existing `use_item`,
// `equip_item`, and `give_to_npc` tool registrations via
// `executeTool`, which routes through the same zod validation,
// pre-tool validators, audit log, telemetry, and
// `emitPlayerInventoryEvents` fan-out the LLM-driven path uses.
// `runWithContext` wraps the dispatch so any helper that reads
// `currentToolContext()` (telemetry, AI-SDK adapter shims) sees the
// route's caller identity rather than throwing.
//
// FEAT-INV-1 hardening (2026-05-16): the action endpoint also
// validates the body's `sessionId` against the authenticated
// player via `SessionLifecycleService.getOwned`. Without that step
// the route would happily dispatch a tool with any string the
// client supplied, allowing a foreign or stale session id to slip
// into the `ToolContext` — at best the `inventory:changed` SSE
// would never reach the live client (the session lookup in
// `emitPlayerInventoryEvents` silently no-ops on miss), at worst
// it would emit on another player's session and pollute their
// tool/audit history. The two failure shapes mirror the
// `session.ts` contract: missing/expired session → `404
// {error:'unknown_session'}`; session owned by a different player
// → `403 {error:'session_forbidden'}`.

import {Hono} from 'hono';
import {z} from 'zod';
import {InventoryReadService} from '../services/InventoryReadService.js';
import {
  SessionLifecycleService,
  SessionOwnershipError,
} from '../services/SessionLifecycleService.js';
import {
  executeTool,
  runWithContext,
  type ToolContext,
} from '../tools/base.js';

export const inventoryRoutes = new Hono();

const ItemSlug = z.string().trim().min(1).max(120);
const SessionId = z.string().trim().min(1).max(120);
const TargetRef = z.string().trim().min(1).max(120);

const ActionBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('use'),
    sessionId: SessionId,
    itemSlug: ItemSlug,
    targetLocation: TargetRef.optional(),
    targetEntity: TargetRef.optional(),
  }),
  z.object({
    action: z.literal('equip'),
    sessionId: SessionId,
    itemSlug: ItemSlug,
  }),
  z.object({
    action: z.literal('unequip'),
    sessionId: SessionId,
    itemSlug: ItemSlug,
  }),
  z.object({
    action: z.literal('give'),
    sessionId: SessionId,
    itemSlug: ItemSlug,
    npc: TargetRef,
    quantity: z.number().int().min(1).max(99).optional(),
  }),
]);

type ActionInput = z.infer<typeof ActionBody>;

inventoryRoutes.get('/:id/inventory', async (c) => {
  const playerId = Number(c.req.param('id'));
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return c.json({error: 'invalid player id'}, 400);
  }
  const language = c.req.query('language') ?? null;
  const snapshot = await InventoryReadService.snapshot(playerId, language);
  return c.json(snapshot);
});

inventoryRoutes.post('/:id/inventory/action', async (c) => {
  const playerId = Number(c.req.param('id'));
  if (!Number.isInteger(playerId) || playerId <= 0) {
    // `ownsPlayer` already rejects non-positive ids with the same
    // body before we reach here; this is defence in depth so a
    // missing middleware mount never silently runs the tool
    // against a stray `:id`.
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
      {ok: false, action: parsed.data.action, error: result.error ?? 'tool_error'},
      400,
    );
  }
  return c.json({ok: true, action: parsed.data.action, result: result.data ?? null});
});

function mapActionToTool(input: ActionInput): {
  toolName: string;
  toolArgs: Record<string, unknown>;
} {
  switch (input.action) {
    case 'use':
      return {
        toolName: 'use_item',
        toolArgs: {
          item_slug: input.itemSlug,
          ...(input.targetLocation
            ? {target_location: input.targetLocation}
            : {}),
          ...(input.targetEntity ? {target_entity: input.targetEntity} : {}),
        },
      };
    case 'equip':
      return {
        toolName: 'equip_item',
        toolArgs: {item_slug: input.itemSlug, equipped: true},
      };
    case 'unequip':
      return {
        toolName: 'equip_item',
        toolArgs: {item_slug: input.itemSlug, equipped: false},
      };
    case 'give':
      return {
        toolName: 'give_to_npc',
        toolArgs: {
          item_slug: input.itemSlug,
          npc: input.npc,
          quantity: input.quantity ?? 1,
        },
      };
  }
}
