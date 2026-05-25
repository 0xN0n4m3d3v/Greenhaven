/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-1 / SEC-2 / DEEP-4 / DEEP-5 / DEEP-6 — central player ownership
// guard for player-scoped HTTP routes.
//
// Before SEC-1 several player-scoped surfaces parsed `:id` from the
// path and read player state straight from the DB without checking
// the caller's identity. `routes/saves.ts`, `routes/quests.ts`,
// `routes/profile.ts`, and `routes/character.ts` were all reachable
// without an auth cookie; `routes/adventures.ts` and the strings
// graph route in `routes/player.ts` had ad-hoc inline checks that
// disagreed about error codes (`player_forbidden` vs `forbidden` vs
// `playerId_required`). The audit (DEEP-4/5/6) flagged IDOR risk:
// player A's cookie + player B's id in the path would read or
// mutate B's saves, profile, stats, or quest log.
//
// The new contract, regardless of which router owns the handler:
//
//   * `:id` not a positive integer → `400 {error: 'invalid player id'}`.
//   * `config().authDisabled` → pass through. Owners of dev/test
//     deploys explicitly disabled auth and SEC-7 / DEEP-14 already
//     makes that combination fatal in production. The middleware
//     still sets `c.var.playerId = routeId` so downstream handlers
//     that read the var get a usable value.
//   * No valid auth cookie → `401 {error: 'unauthenticated'}`.
//   * Authed but `cookiePlayerId !== routeId` →
//     `403 {error: 'player_mismatch'}`.
//   * Otherwise: `c.var.playerId = cookiePlayerId` and `next()`.
//
// The 4xx bodies are intentionally NOT routed through the SEC-3
// `errorResponse` helper. These are client-actionable codes the
// UI surfaces directly (the player needs to know "log in" /
// "you tried to read someone else's saves"); the opaque
// `{error, correlation_id}` shape used for 500s would erase that
// signal without buying any leak protection here.

import type {MiddlewareHandler} from 'hono';
import {config} from '../config.js';
import {authenticatedPlayerId} from './auth.js';

export function ownsPlayer(): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.param('id');
    const routeId = Number(raw);
    if (!Number.isInteger(routeId) || routeId <= 0) {
      return c.json({error: 'invalid player id'}, 400);
    }
    if (config().authDisabled) {
      c.set('playerId', routeId);
      return next();
    }
    const cookiePlayerId = await authenticatedPlayerId(c);
    if (cookiePlayerId == null) {
      return c.json({error: 'unauthenticated'}, 401);
    }
    if (cookiePlayerId !== routeId) {
      return c.json({error: 'player_mismatch'}, 403);
    }
    c.set('playerId', cookiePlayerId);
    return next();
  };
}
