/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-8 (2026-05-17) — `move_player` must enforce
// cartridge isolation on both ends: cross-cartridge targets are
// rejected pre-write, and a successful same-cartridge move syncs
// `hero_cartridge_states.current_location_id` in the same
// transaction as `players.current_location_id`. The session
// locations view, in turn, must refuse to surface a foreign
// `players.current_location_id` (stale or otherwise).

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let getRegisteredTools: typeof import('../../tools/base.js').getRegisteredTools;
let runWithContext: typeof import('../../tools/base.js').runWithContext;
let SessionLifecycleService:
  typeof import('../../services/SessionLifecycleService.js').SessionLifecycleService;
let sessionManager:
  typeof import('../../sessionManager.js').sessionManager;
let createAnonymousPlayer:
  typeof import('../../playerService.js').createAnonymousPlayer;
let clearMetaCache: typeof import('../../cartridge.js').clearMetaCache;

interface ToolHandle {
  execute: (
    args: Record<string, unknown>,
    ctx: {sessionId: string; playerId: number},
  ) => Promise<unknown>;
}

function getTool(name: string): ToolHandle {
  const def = getRegisteredTools().get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def as unknown as ToolHandle;
}

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({getRegisteredTools, runWithContext} = await import('../../tools/base.js'));
  ({SessionLifecycleService} = await import(
    '../../services/SessionLifecycleService.js'
  ));
  ({sessionManager} = await import('../../sessionManager.js'));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
  ({clearMetaCache} = await import('../../cartridge.js'));
}, 600_000);

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

const CART_A = 'cart-move-a';
const CART_B = 'cart-move-b';

beforeEach(async () => {
  // Null out any test-player pointers into our cartridge-scoped
  // entities first so the entity DELETE below cannot trip
  // `players_current_location_id_fkey`.
  await queryRows(
    `UPDATE players SET current_location_id = NULL
      WHERE current_location_id IN (
        SELECT id FROM entities WHERE cartridge_id IN ($1, $2)
      )`,
    [CART_A, CART_B],
  );
  await queryRows(
    `DELETE FROM hero_cartridge_states WHERE cartridge_id IN ($1, $2)`,
    [CART_A, CART_B],
  );
  await queryRows(
    `DELETE FROM entities WHERE cartridge_id IN ($1, $2)`,
    [CART_A, CART_B],
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE cartridge_id IN ($1, $2)`,
    [CART_A, CART_B],
  );
  await queryRows(`DELETE FROM cartridges WHERE id IN ($1, $2)`, [
    CART_A,
    CART_B,
  ]);
});

async function seedCartridge(id: string): Promise<void> {
  await queryRows(
    `INSERT INTO cartridges (id, title, version, schema_version,
                              source_kind, content_hash)
     VALUES ($1, $2, '0.1', '1', 'forge_project', $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, `Cart ${id}`, `sha256:${id}`],
  );
}

async function seedLocation(opts: {
  cartridgeId: string;
  displayName: string;
  exits?: number[];
}): Promise<number> {
  const profile: Record<string, unknown> = {};
  if (opts.exits && opts.exits.length > 0) {
    profile['exits'] = opts.exits;
  }
  const row = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name, profile, cartridge_id,
                            dynamic_origin)
     VALUES ('location', $1, $2::jsonb, $3, false)
     RETURNING id`,
    [opts.displayName, JSON.stringify(profile), opts.cartridgeId],
  );
  return Number(row[0]!.id);
}

async function pointGlobalMetaAt(cartridgeId: string): Promise<void> {
  await queryRows(
    `INSERT INTO cartridge_meta (key, value, description)
     VALUES ('cartridge_id', to_jsonb($1::text), 'FEAT-CART-LIB-8 test')
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = now()`,
    [cartridgeId],
  );
  clearMetaCache();
}

describe('move_player + loadLocationsView cartridge isolation (FEAT-CART-LIB-8)', () => {
  it('rejects a move_player target that does not belong to the active cartridge', async () => {
    await seedCartridge(CART_A);
    await seedCartridge(CART_B);
    const locB = await seedLocation({
      cartridgeId: CART_B,
      displayName: 'B-Square (move test)',
    });
    const locA = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Spawn (move test)',
      // Author the foreign id into exits so reachability would
      // otherwise let the move through. The cartridge gate must
      // reject it before reachability fires.
      exits: [locB],
    });

    const player = await createAnonymousPlayer(
      `FEAT-CART-LIB-8 reject ${Date.now()}`,
    );
    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locA, player.entity_id],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, current_location_id
       )
       VALUES ($1, $2, 'active', $3)`,
      [player.entity_id, CART_A, locA],
    );
    await pointGlobalMetaAt(CART_A);

    const sessionId = `s-${player.entity_id}-reject-${Date.now()}`;
    const tool = getTool('move_player');
    let caught: unknown = null;
    try {
      await runWithContext({sessionId, playerId: player.entity_id}, () =>
        tool.execute(
          {target_location_id: locB, intent_source: 'user_command'},
          {sessionId, playerId: player.entity_id},
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /does not belong to the active cartridge/,
    );

    // No mutation: player still at locA, hero_cartridge_states row
    // still pinned to locA.
    const playerAfter = await queryRows<{current_location_id: number | null}>(
      `SELECT current_location_id FROM players WHERE entity_id = $1`,
      [player.entity_id],
    );
    expect(playerAfter[0]?.current_location_id).toBe(locA);
    const stateAfter = await queryRows<{current_location_id: number | null}>(
      `SELECT current_location_id FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [player.entity_id, CART_A],
    );
    expect(stateAfter[0]?.current_location_id).toBe(locA);
  });

  it('accepts a same-cartridge move and syncs hero_cartridge_states in the same write', async () => {
    await seedCartridge(CART_A);
    const locA = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Spawn (sync test)',
    });
    const locASide = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Side (sync test)',
    });
    // Patch A-Spawn's exits to point at A-Side now that both ids
    // are known. (Two-step seed because seedLocation needs an id
    // before profile.exits can reference it.)
    await queryRows(
      `UPDATE entities
          SET profile = jsonb_set(profile, '{exits}', $1::jsonb, true)
        WHERE id = $2`,
      [JSON.stringify([locASide]), locA],
    );

    const player = await createAnonymousPlayer(
      `FEAT-CART-LIB-8 sync ${Date.now()}`,
    );
    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locA, player.entity_id],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, current_location_id, current_scene_id
       )
       VALUES ($1, $2, 'active', $3, NULL)`,
      [player.entity_id, CART_A, locA],
    );
    await pointGlobalMetaAt(CART_A);

    // Register a real session so the SSE/GUI emits inside
    // move_player can write `gui_events.session_id` rows without
    // tripping the FK to `sessions`.
    const session = await sessionManager.getOrCreate(
      `cart-iso8-sync-${player.entity_id}-${Date.now()}`,
      player.entity_id,
    );
    try {
      const tool = getTool('move_player');
      const result = (await runWithContext(
        {sessionId: session.id, playerId: player.entity_id},
        () =>
          tool.execute(
            {target_location_id: locASide, intent_source: 'user_command'},
            {sessionId: session.id, playerId: player.entity_id},
          ),
      )) as {moved: boolean; toId: number; fromId: number | null};
      expect(result.moved).toBe(true);
      expect(result.toId).toBe(locASide);
      expect(result.fromId).toBe(locA);

      // players.current_location_id updated.
      const playerAfter = await queryRows<{
        current_location_id: number | null;
      }>(
        `SELECT current_location_id FROM players WHERE entity_id = $1`,
        [player.entity_id],
      );
      expect(playerAfter[0]?.current_location_id).toBe(locASide);

      // hero_cartridge_states.current_location_id updated; scene reset.
      const stateAfter = await queryRows<{
        current_location_id: number | null;
        current_scene_id: number | null;
        status: string;
      }>(
        `SELECT current_location_id, current_scene_id, status
           FROM hero_cartridge_states
          WHERE player_id = $1 AND cartridge_id = $2`,
        [player.entity_id, CART_A],
      );
      expect(stateAfter[0]?.current_location_id).toBe(locASide);
      expect(stateAfter[0]?.current_scene_id).toBeNull();
      expect(stateAfter[0]?.status).toBe('active');
    } finally {
      await sessionManager.destroy(session.id);
    }
  });

  it('rejects unreachable target when player row is foreign and playthrough anchor is the active spawn (FEAT-CART-LIB-9)', async () => {
    // Hero's playthrough pin is at A-Spawn. A-Spawn does NOT
    // expose A-Unreachable as an exit, parent, child, or home
    // edge. With FEAT-CART-LIB-8 alone, a foreign `players.
    // current_location_id` would zero the from-anchor and
    // `validateMovementReachability(null, ...)` would let the
    // teleport through. FEAT-CART-LIB-9 must recover the anchor
    // through the active playthrough and fail reachability.
    await seedCartridge(CART_A);
    await seedCartridge(CART_B);
    const locBForeign = await seedLocation({
      cartridgeId: CART_B,
      displayName: 'B-Foreign (anchor reject test)',
    });
    const locASpawn = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Spawn (anchor reject test)',
    });
    const locAUnreachable = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Unreachable (anchor reject test)',
      // Authored as a separate same-cartridge location with no
      // edge back to A-Spawn. Reachability must reject.
    });

    const player = await createAnonymousPlayer(
      `FEAT-CART-LIB-9 anchor-reject ${Date.now()}`,
    );
    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locBForeign, player.entity_id],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, current_location_id
       )
       VALUES ($1, $2, 'active', $3)`,
      [player.entity_id, CART_A, locASpawn],
    );
    await pointGlobalMetaAt(CART_A);

    const session = await sessionManager.getOrCreate(
      `cart-iso9-reject-${player.entity_id}-${Date.now()}`,
      player.entity_id,
    );
    try {
      const tool = getTool('move_player');
      let caught: unknown = null;
      try {
        await runWithContext(
          {sessionId: session.id, playerId: player.entity_id},
          () =>
            tool.execute(
              {
                target_location_id: locAUnreachable,
                intent_source: 'user_command',
              },
              {sessionId: session.id, playerId: player.entity_id},
            ),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // The reachability error mentions the recovered anchor
      // (locASpawn) rather than the foreign locBForeign.
      const msg = (caught as Error).message;
      expect(msg).toMatch(/move_player rejected/);
      expect(msg).toContain(String(locAUnreachable));
      // The foreign id must not appear in the rejection message.
      expect(msg).not.toContain(String(locBForeign));

      // No state mutated.
      const playerAfter = await queryRows<{
        current_location_id: number | null;
      }>(
        `SELECT current_location_id FROM players WHERE entity_id = $1`,
        [player.entity_id],
      );
      expect(playerAfter[0]?.current_location_id).toBe(locBForeign);
      const stateAfter = await queryRows<{
        current_location_id: number | null;
      }>(
        `SELECT current_location_id FROM hero_cartridge_states
          WHERE player_id = $1 AND cartridge_id = $2`,
        [player.entity_id, CART_A],
      );
      expect(stateAfter[0]?.current_location_id).toBe(locASpawn);
    } finally {
      await sessionManager.destroy(session.id);
    }
  });

  it('accepts a reachable target through the recovered playthrough anchor (FEAT-CART-LIB-9)', async () => {
    // Foreign player row, playthrough pinned at A-Spawn, and
    // A-Spawn has an authored exit to A-Side. The move must
    // succeed via the recovered anchor and the returned
    // fromId/fromName must reflect A-Spawn (not the foreign
    // B-side row).
    await seedCartridge(CART_A);
    await seedCartridge(CART_B);
    const locBForeign = await seedLocation({
      cartridgeId: CART_B,
      displayName: 'B-Foreign (anchor accept test)',
    });
    const locASpawn = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Spawn (anchor accept test)',
    });
    const locASide = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Side (anchor accept test)',
    });
    // Wire A-Spawn → A-Side authored exit after both ids are known.
    await queryRows(
      `UPDATE entities
          SET profile = jsonb_set(profile, '{exits}', $1::jsonb, true)
        WHERE id = $2`,
      [JSON.stringify([locASide]), locASpawn],
    );

    const player = await createAnonymousPlayer(
      `FEAT-CART-LIB-9 anchor-accept ${Date.now()}`,
    );
    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locBForeign, player.entity_id],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, current_location_id
       )
       VALUES ($1, $2, 'active', $3)`,
      [player.entity_id, CART_A, locASpawn],
    );
    await pointGlobalMetaAt(CART_A);

    const session = await sessionManager.getOrCreate(
      `cart-iso9-accept-${player.entity_id}-${Date.now()}`,
      player.entity_id,
    );
    try {
      const tool = getTool('move_player');
      const result = (await runWithContext(
        {sessionId: session.id, playerId: player.entity_id},
        () =>
          tool.execute(
            {target_location_id: locASide, intent_source: 'user_command'},
            {sessionId: session.id, playerId: player.entity_id},
          ),
      )) as {
        moved: boolean;
        fromId: number | null;
        fromName: string | null;
        toId: number;
      };

      // Recovered anchor surfaces as fromId/fromName — never the
      // foreign id/name.
      expect(result.moved).toBe(true);
      expect(result.fromId).toBe(locASpawn);
      expect(result.fromName).toBe('A-Spawn (anchor accept test)');
      expect(result.fromId).not.toBe(locBForeign);
      expect(result.toId).toBe(locASide);

      // Both rows committed at the new location.
      const playerAfter = await queryRows<{
        current_location_id: number | null;
      }>(
        `SELECT current_location_id FROM players WHERE entity_id = $1`,
        [player.entity_id],
      );
      expect(playerAfter[0]?.current_location_id).toBe(locASide);
      const stateAfter = await queryRows<{
        current_location_id: number | null;
        current_scene_id: number | null;
      }>(
        `SELECT current_location_id, current_scene_id
           FROM hero_cartridge_states
          WHERE player_id = $1 AND cartridge_id = $2`,
        [player.entity_id, CART_A],
      );
      expect(stateAfter[0]?.current_location_id).toBe(locASide);
      expect(stateAfter[0]?.current_scene_id).toBeNull();
    } finally {
      await sessionManager.destroy(session.id);
    }
  });

  it('loadLocationsView recovers when players.current_location_id is foreign', async () => {
    await seedCartridge(CART_A);
    await seedCartridge(CART_B);
    const locB = await seedLocation({
      cartridgeId: CART_B,
      displayName: 'B-FOREIGN (locations test)',
    });
    const locA = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Recover (locations test)',
    });

    const player = await createAnonymousPlayer(
      `FEAT-CART-LIB-8 recover ${Date.now()}`,
    );
    // Player row points at cartridge B's location; the active
    // playthrough is in cartridge A and pins them to locA.
    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locB, player.entity_id],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, current_location_id
       )
       VALUES ($1, $2, 'active', $3)`,
      [player.entity_id, CART_A, locA],
    );
    // Global mirror also points at B, mirroring the FEAT-CART-LIB-6
    // back-compat surface. The view must still resolve to cartridge
    // A because the active playthrough authorizes it.
    await pointGlobalMetaAt(CART_B);

    const session = await sessionManager.getOrCreate(
      `cart-iso8-${player.entity_id}-${Date.now()}`,
      player.entity_id,
    );
    try {
      const view = await SessionLifecycleService.loadLocationsView({
        session,
        playerId: player.entity_id,
      });
      // The foreign locB must not leak in as `current`.
      expect(view.current?.id).not.toBe(locB);
      expect(view.current?.name).not.toBe('B-FOREIGN (locations test)');
      // FEAT-CART-LIB-8 — but the view also points the global mirror
      // at cartridge B above. The player-scoped resolver pins to
      // cartridge A via the active playthrough; the playthrough's
      // current location (locA) is the recovery anchor.
      expect(view.current?.id).toBe(locA);
      expect(view.current?.name).toBe('A-Recover (locations test)');
    } finally {
      await sessionManager.destroy(session.id);
    }
  });
});
