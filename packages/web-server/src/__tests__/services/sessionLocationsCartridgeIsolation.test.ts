/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-7 (2026-05-17) — gameplay session location resolution
// must consult `hero_cartridge_states.status = 'active'` for the
// active player, not the global `cartridge_meta.cartridge_id` mirror.
//
// The regression seeds two cartridges with overlapping authored
// shapes (exits, density npc ids, map nodes) and proves that hero A's
// `/api/session/:id/locations` payload never leaks any of hero B's
// content. The `cartridge_meta.cartridge_id` global mirror points at
// cartridge B for the duration of the test — the locations view must
// still return cartridge A's data because hero A's active
// `hero_cartridge_states` row pins them to cartridge A.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let SessionLifecycleService:
  typeof import('../../services/SessionLifecycleService.js').SessionLifecycleService;
let sessionManager:
  typeof import('../../sessionManager.js').sessionManager;
let createAnonymousPlayer:
  typeof import('../../playerService.js').createAnonymousPlayer;
let clearMetaCache: typeof import('../../cartridge.js').clearMetaCache;

beforeAll(async () => {
  await setupTurnTestEnvironment();
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

const CART_A = 'cart-iso-a';
const CART_B = 'cart-iso-b';

beforeEach(async () => {
  await queryRows(
    `DELETE FROM hero_cartridge_states WHERE cartridge_id IN ($1, $2)`,
    [CART_A, CART_B],
  );
  await queryRows(
    `UPDATE players
        SET current_location_id = NULL,
            current_scene_id = NULL,
            dialogue_partner_id = NULL
      WHERE current_location_id IN (
              SELECT id FROM entities WHERE cartridge_id IN ($1, $2)
            )
         OR current_scene_id IN (
              SELECT id FROM entities WHERE cartridge_id IN ($1, $2)
            )
         OR dialogue_partner_id IN (
              SELECT id FROM entities WHERE cartridge_id IN ($1, $2)
            )`,
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

interface SeedLocationOpts {
  cartridgeId: string;
  displayName: string;
  exits?: number[];
  densityNpcIds?: number[];
  mapPosition?: {x: number; y: number};
}

async function seedLocation(opts: SeedLocationOpts): Promise<number> {
  const profile: Record<string, unknown> = {};
  if (opts.exits && opts.exits.length > 0) {
    profile['exits'] = opts.exits;
  }
  if (opts.densityNpcIds && opts.densityNpcIds.length > 0) {
    profile['local_density'] = {npc_ids: opts.densityNpcIds};
  }
  if (opts.mapPosition) {
    profile['map_position'] = opts.mapPosition;
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

async function seedNpc(
  cartridgeId: string,
  displayName: string,
  locationId: number,
): Promise<number> {
  const row = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name, profile, cartridge_id,
                            dynamic_origin)
     VALUES ('person', $1, $2::jsonb, $3, false)
     RETURNING id`,
    [
      displayName,
      JSON.stringify({location_id: String(locationId)}),
      cartridgeId,
    ],
  );
  return Number(row[0]!.id);
}

describe('SessionLifecycleService.loadLocationsView (FEAT-CART-LIB-7-FOLLOWUP)', () => {
  it('returns an empty DTO when the hero has no active hero_cartridge_states row and global cartridge_meta is unset (clean baseline)', async () => {
    // FEAT-CART-LIB-7-FOLLOWUP (2026-05-18) — the post-launch /api/
    // session/:id/locations 500 reproducer. On a clean engine-baseline
    // DB with a hero but no active playthrough, the legacy global
    // `cartridge_meta.cartridge_id` mirror is unset; the optional
    // resolver returns null and the service must degrade to an empty
    // DTO instead of escaping `getMetaRequired('cartridge_id')` as a
    // 500.
    await queryRows(
      `DELETE FROM cartridge_meta WHERE key = 'cartridge_id'`,
    );
    clearMetaCache();
    const player = await createAnonymousPlayer(
      `FEAT-CART-LIB-7-FOLLOWUP hero ${Date.now()}`,
    );
    // Sanity: no active row for this hero.
    const activeStates = await queryRows<{count: number}>(
      `SELECT COUNT(*)::int AS count
         FROM hero_cartridge_states
        WHERE player_id = $1
          AND status = 'active'`,
      [player.entity_id],
    );
    expect(Number(activeStates[0]?.count ?? 0)).toBe(0);
    const session = await sessionManager.getOrCreate(
      `cart-lib-no-active-${player.entity_id}-${Date.now()}`,
      player.entity_id,
    );
    try {
      const view = await SessionLifecycleService.loadLocationsView({
        session,
        playerId: player.entity_id,
      });
      expect(view.current).toBeNull();
      expect(view.exits).toEqual([]);
      expect(view.nearby).toEqual([]);
      expect(view.map.nodes).toEqual([]);
    } finally {
      await sessionManager.destroy(session.id);
    }
  });

  it('returns only the active hero cartridge content even when global cartridge_meta points elsewhere', async () => {
    // Build both cartridges. We materialise the entities for B first
    // so cartridge A can include B's location id in an authored
    // `exits` list — this proves the result-row cartridge gate (not
    // just topology-child sweep) filters cross-cartridge leakage.
    await seedCartridge(CART_A);
    await seedCartridge(CART_B);

    // ---- cartridge B (must be invisible in hero A's view) ----
    const locB = await seedLocation({
      cartridgeId: CART_B,
      displayName: 'B-Square',
      mapPosition: {x: 50, y: 50},
    });
    const locBExit = await seedLocation({
      cartridgeId: CART_B,
      displayName: 'B-Annex',
      mapPosition: {x: 60, y: 50},
    });
    const npcB = await seedNpc(CART_B, 'B-Resident', locB);
    void npcB; // anchored in cartridge B; must never appear in A's view

    // ---- cartridge A ----
    // A-Spawn lists an exit to A-Side AND a (forbidden) exit to
    // locB so the result-row predicate must strip B.
    const locASide = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Side',
      mapPosition: {x: 0, y: 10},
    });
    // npc anchored at locASide so density-sweep can pick it up.
    const npcA = await seedNpc(CART_A, 'A-Resident', locASide);
    const locA = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Spawn',
      exits: [locASide, locB],
      densityNpcIds: [npcA],
      mapPosition: {x: 0, y: 0},
    });

    // Hero is a real player. createAnonymousPlayer pins the player
    // entity to the (legacy) default cartridge; we move it onto a
    // location belonging to cartridge A and activate cart A for them.
    const player = await createAnonymousPlayer(
      `FEAT-CART-LIB-7 hero ${Date.now()}`,
    );
    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locA, player.entity_id],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status,
         current_location_id
       )
       VALUES ($1, $2, 'active', $3)`,
      [player.entity_id, CART_A, locA],
    );

    // Point the global cartridge_meta mirror at cartridge B so any
    // accidental reader of `activeCartridgeId()` would return B and
    // leak its content. The new player-scoped helper must override
    // this and still return cartridge A's data.
    await queryRows(
      `INSERT INTO cartridge_meta (key, value, description)
       VALUES ('cartridge_id', to_jsonb($1::text), 'FEAT-CART-LIB-7 test')
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = now()`,
      [CART_B],
    );
    clearMetaCache();

    const session = await sessionManager.getOrCreate(
      `cart-iso-${player.entity_id}-${Date.now()}`,
      player.entity_id,
    );
    try {
      const view = await SessionLifecycleService.loadLocationsView({
        session,
        playerId: player.entity_id,
      });

      expect(view.current?.id).toBe(locA);
      expect(view.current?.name).toBe('A-Spawn');

      // Exits: A-Side present, B-Annex absent (filtered out of the
      // result-row predicate even though it was named in A-Spawn's
      // authored exits list).
      const exitIds = view.exits.map((e) => e.id);
      expect(exitIds).toContain(locASide);
      expect(exitIds).not.toContain(locB);
      expect(exitIds).not.toContain(locBExit);

      // Nearby: only A-Resident; B-Resident must not leak through.
      const nearbyNames = view.nearby.map((n) => n.name);
      expect(nearbyNames).toContain('A-Resident');
      expect(nearbyNames).not.toContain('B-Resident');

      // Map: only cart A nodes. B-Square / B-Annex must not show up.
      const mapNames = view.map.nodes.map((n) => n.name);
      expect(mapNames).toContain('A-Spawn');
      expect(mapNames).toContain('A-Side');
      expect(mapNames).not.toContain('B-Square');
      expect(mapNames).not.toContain('B-Annex');
    } finally {
      await sessionManager.destroy(session.id);
    }
  });

  it('does not treat inactive scene participants as physically nearby', async () => {
    await seedCartridge(CART_A);

    const locOther = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Precinct',
    });
    const remoteNpc = await seedNpc(CART_A, 'A-Remote Captain', locOther);
    const localNpc = await seedNpc(CART_A, 'A-Local Witness', locOther);
    const locA = await seedLocation({
      cartridgeId: CART_A,
      displayName: 'A-Lab',
      densityNpcIds: [localNpc],
    });
    await queryRows(
      `UPDATE entities
          SET profile = profile || jsonb_build_object('home_id', $1::text)
        WHERE id = $2`,
      [locA, localNpc],
    );
    await queryRows(
      `INSERT INTO entities (kind, display_name, profile, cartridge_id,
                              dynamic_origin)
       VALUES ('scene', 'A-Lab Remote Briefing',
               jsonb_build_object(
                 'location_id', $1::text,
                 'participant_entity_ids', to_jsonb(ARRAY[$2::int])
               ),
               $3, false)`,
      [locA, remoteNpc, CART_A],
    );

    const player = await createAnonymousPlayer(
      `FEAT-CART-LIB scene presence hero ${Date.now()}`,
    );
    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locA, player.entity_id],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status,
         current_location_id
       )
       VALUES ($1, $2, 'active', $3)`,
      [player.entity_id, CART_A, locA],
    );

    const session = await sessionManager.getOrCreate(
      `cart-scene-presence-${player.entity_id}-${Date.now()}`,
      player.entity_id,
    );
    try {
      const view = await SessionLifecycleService.loadLocationsView({
        session,
        playerId: player.entity_id,
      });

      const nearbyNames = view.nearby.map((n) => n.name);
      expect(nearbyNames).toContain('A-Local Witness');
      expect(nearbyNames).not.toContain('A-Remote Captain');
    } finally {
      await sessionManager.destroy(session.id);
    }
  });
});
