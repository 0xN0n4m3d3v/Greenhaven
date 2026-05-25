/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-4 — `CartridgePlaythroughService` contract.
//
// Drives preview / launch / newGame against real PGlite so the
// transactional snapshot-then-activate flow and the player-row
// reflection happen against the actual schema. Tests must never
// touch the Obsidian compile pipeline or the import services; this
// service is hero-runtime-only.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let CartridgePlaythroughService: typeof import('../../services/CartridgePlaythroughService.js').CartridgePlaythroughService;
let PlaythroughServiceError: typeof import('../../services/CartridgePlaythroughService.js').PlaythroughServiceError;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({CartridgePlaythroughService, PlaythroughServiceError} = await import(
    '../../services/CartridgePlaythroughService.js'
  ));
}, 600_000);

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

// We isolate test data under cartridge ids starting with `cart-pt-`
// so the seeded default cartridge is left intact for any sibling
// suite running in the same PGlite.
const TEST_PREFIX = 'cart-pt-';

beforeEach(async () => {
  await queryRows(
    `DELETE FROM hero_cartridge_states WHERE cartridge_id LIKE 'cart-pt-%'`,
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE cartridge_id LIKE 'cart-pt-%'`,
  );
  await queryRows(
    `DELETE FROM cartridge_install_cache WHERE cartridge_id LIKE 'cart-pt-%'`,
  );
  await queryRows(
    `DELETE FROM cartridges WHERE id LIKE 'cart-pt-%'`,
  );
});

async function seedCartridge(args: {
  id: string;
  installState?: 'ready' | 'active_db' | 'stale';
  startingLocationId?: number | null;
  worldEntityId?: number | null;
}): Promise<void> {
  const id = args.id;
  await queryRows(
    `INSERT INTO cartridges (id, title, version, schema_version,
                              source_kind, content_hash)
     VALUES ($1, $2, '0.1', '1', 'forge_project', 'sha256:fixture')
     ON CONFLICT (id) DO NOTHING`,
    [id, `Test ${id}`],
  );
  if (args.installState) {
    await queryRows(
      `INSERT INTO cartridge_install_cache
         (cartridge_id, state, content_hash, record_count)
       VALUES ($1, $2, 'sha256:fixture', 0)
       ON CONFLICT (cartridge_id) DO UPDATE SET state = EXCLUDED.state`,
      [id, args.installState],
    );
  }
  if (args.startingLocationId != null) {
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
       VALUES ($1, 'starting_location_id', $2::jsonb, 'test')
       ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [id, String(args.startingLocationId)],
    );
  }
  if (args.worldEntityId != null) {
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
       VALUES ($1, 'world_entity_id', $2::jsonb, 'test')
       ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [id, String(args.worldEntityId)],
    );
  }
}

async function defaultCartridgeId(): Promise<string> {
  const r = await queryRows<{value: string | null}>(
    `SELECT (value #>> '{}')::text AS value
       FROM cartridge_meta WHERE key = 'cartridge_id'`,
  );
  return r[0]?.value ?? 'default';
}

async function seedHero(displayName: string): Promise<number> {
  // ARCH-19 / migration 0124 requires `cartridge_id` on
  // `entities`. Pin player rows to the active default cartridge so
  // they live in a real cartridge scope.
  const cartridgeId = await defaultCartridgeId();
  const ent = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name, cartridge_id)
     VALUES ('player', $1, $2)
     RETURNING id`,
    [displayName, cartridgeId],
  );
  const playerId = Number(ent[0]?.id);
  await queryRows(
    `INSERT INTO players (entity_id, public_id)
     VALUES ($1, gen_random_uuid())
     ON CONFLICT (entity_id) DO NOTHING`,
    [playerId],
  );
  return playerId;
}

async function seedLocation(
  displayName: string,
  cartridgeId?: string,
): Promise<number> {
  const cid = cartridgeId ?? (await defaultCartridgeId());
  const ent = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name, cartridge_id)
     VALUES ('location', $1, $2)
     RETURNING id`,
    [displayName, cid],
  );
  return Number(ent[0]?.id);
}

describe('CartridgePlaythroughService (FEAT-CART-LIB-4)', () => {
  it('preview on a ready cartridge returns first_spawn for a hero with no state', async () => {
    const cartridgeId = `${TEST_PREFIX}preview-first`;
    const locId = await seedLocation('Test Spawn Square');
    await seedCartridge({
      id: cartridgeId,
      installState: 'ready',
      startingLocationId: locId,
    });
    const playerId = await seedHero('Preview Hero');
    const view = await CartridgePlaythroughService.preview({
      playerId,
      cartridgeId,
    });
    expect(view.mode).toBe('first_spawn');
    expect(view.installReady).toBe(true);
    expect(view.installState).toBe('ready');
    expect(view.startingLocationId).toBe(locId);
    expect(view.startingLocationName).toBe('Test Spawn Square');
    expect(view.state).toBeNull();
    expect(view.blockers).toEqual([]);
    // FEAT-HERO-CONTINUITY-1 — additive continuity preview is
    // present, read-only, and uses the documented default policy
    // when the seeded cartridge has no scoped continuity row.
    expect(view.continuityPreview).not.toBeNull();
    expect(view.continuityPreview?.targetCartridgeId).toBe(cartridgeId);
    expect(view.continuityPreview?.policy.isDefault).toBe(true);
    expect(view.continuityPreview?.audit.mutatesRows).toBe(false);
    expect(view.continuityPreview?.hero.playerId).toBe(playerId);
  });

  it('preview returns repair_required when install cache is not ready', async () => {
    const cartridgeId = `${TEST_PREFIX}preview-stale`;
    await seedCartridge({id: cartridgeId, installState: 'stale'});
    const playerId = await seedHero('Stale Hero');
    const view = await CartridgePlaythroughService.preview({
      playerId,
      cartridgeId,
    });
    expect(view.mode).toBe('repair_required');
    expect(view.installReady).toBe(false);
    expect(view.blockers).toContain('install_cache_not_ready');
  });

  it('preview returns continue when a prior hero state exists', async () => {
    const cartridgeId = `${TEST_PREFIX}preview-resume`;
    const locId = await seedLocation('Resume Tavern');
    await seedCartridge({
      id: cartridgeId,
      installState: 'ready',
      startingLocationId: locId,
    });
    const playerId = await seedHero('Resume Hero');
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, current_location_id
       )
       VALUES ($1, $2, 'available', $3)`,
      [playerId, cartridgeId, locId],
    );
    const view = await CartridgePlaythroughService.preview({
      playerId,
      cartridgeId,
    });
    expect(view.mode).toBe('continue');
    expect(view.state?.status).toBe('available');
    expect(view.state?.currentLocationId).toBe(locId);
    expect(view.state?.currentLocationName).toBe('Resume Tavern');
  });

  it('launch activates the target and reflects on players row', async () => {
    const cartridgeId = `${TEST_PREFIX}launch-first`;
    const locId = await seedLocation('Launch Square');
    const worldId = await seedLocation('Launch World');
    await seedCartridge({
      id: cartridgeId,
      installState: 'ready',
      startingLocationId: locId,
      worldEntityId: worldId,
    });
    const playerId = await seedHero('Launch Hero');
    const result = await CartridgePlaythroughService.launch({
      playerId,
      cartridgeId,
    });
    expect(result.cartridgeId).toBe(cartridgeId);
    expect(result.currentLocationId).toBe(locId);
    expect(result.currentLocationName).toBe('Launch Square');
    expect(result.clearClientCache.keys).toContain('greenhaven.sessionId');
    expect(result.clearClientCache.playerPublicId.length).toBeGreaterThan(0);
    // hero_cartridge_states row created in 'active'.
    const state = await queryRows<{status: string; playthrough_id: string}>(
      `SELECT status, playthrough_id::text AS playthrough_id
         FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [playerId, cartridgeId],
    );
    expect(state[0]?.status).toBe('active');
    expect(state[0]?.playthrough_id).toBe(result.playthroughId);
    // FEAT-HERO-CONTINUITY-2 — launch result + hero_cartridge_states
    // row both carry the cartridge's default universe instance id.
    expect(typeof result.universeInstanceId).toBe('string');
    expect(result.universeInstanceId.length).toBeGreaterThan(0);
    const stateUniverse = await queryRows<{universe_instance_id: string | null}>(
      `SELECT universe_instance_id::text AS universe_instance_id
         FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [playerId, cartridgeId],
    );
    expect(stateUniverse[0]?.universe_instance_id).toBe(
      result.universeInstanceId,
    );
    // players.current_location_id updated.
    const player = await queryRows<{
      current_location_id: number | null;
      dialogue_partner_id: number | null;
    }>(
      `SELECT current_location_id, dialogue_partner_id
         FROM players WHERE entity_id = $1`,
      [playerId],
    );
    expect(player[0]?.current_location_id).toBe(locId);
    expect(player[0]?.dialogue_partner_id).toBeNull();
    const globalMeta = await queryRows<{key: string; value: string | number}>(
      `SELECT key, value FROM cartridge_meta
        WHERE key IN ('cartridge_id', 'starting_location_id', 'world_entity_id')
        ORDER BY key`,
    );
    expect(globalMeta).toEqual([
      {key: 'cartridge_id', value: cartridgeId},
      {key: 'starting_location_id', value: locId},
      {key: 'world_entity_id', value: worldId},
    ]);
  });

  it('launch snapshots the previously-active cartridge for the same hero', async () => {
    const cartridgeA = `${TEST_PREFIX}launch-prev-a`;
    const cartridgeB = `${TEST_PREFIX}launch-prev-b`;
    const locA = await seedLocation('Prev A Place');
    const locB = await seedLocation('Prev B Place');
    await seedCartridge({
      id: cartridgeA,
      installState: 'ready',
      startingLocationId: locA,
    });
    await seedCartridge({
      id: cartridgeB,
      installState: 'ready',
      startingLocationId: locB,
    });
    const playerId = await seedHero('Prev Hero');
    // Pre-seed an `active` state in cartridge A.
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status,
         current_location_id, last_session_id
       )
       VALUES ($1, $2, 'active', $3, 'sess-old')`,
      [playerId, cartridgeA, locA],
    );
    // Launch cartridge B for the same hero.
    await CartridgePlaythroughService.launch({
      playerId,
      cartridgeId: cartridgeB,
      authenticatedPlayerId: playerId,
    });
    // Cartridge A row should now be `available` with a non-empty
    // hero_snapshot capturing the prior location + session.
    const snapped = await queryRows<{
      status: string;
      hero_snapshot: {
        current_location_id?: number;
        last_session_id?: string;
        snapshotted_at?: string;
      };
    }>(
      `SELECT status, hero_snapshot
         FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [playerId, cartridgeA],
    );
    expect(snapped[0]?.status).toBe('available');
    expect(snapped[0]?.hero_snapshot.current_location_id).toBe(locA);
    expect(snapped[0]?.hero_snapshot.last_session_id).toBe('sess-old');
  });

  it('newGame respawns at the cartridge starting location and bumps reset_generation', async () => {
    const cartridgeId = `${TEST_PREFIX}new-game`;
    const startLoc = await seedLocation('New Game Origin');
    const otherLoc = await seedLocation('Where Hero Was');
    await seedCartridge({
      id: cartridgeId,
      installState: 'active_db',
      startingLocationId: startLoc,
    });
    const playerId = await seedHero('New Game Hero');
    // Pre-seed a prior `active` row at a different location +
    // reset_generation = 2 so we can assert the bump.
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status,
         current_location_id, reset_generation, last_session_id
       )
       VALUES ($1, $2, 'active', $3, 2, 'sess-x')`,
      [playerId, cartridgeId, otherLoc],
    );
    await queryRows(
      `UPDATE players
          SET metadata = $2::jsonb
        WHERE entity_id = $1`,
      [
        playerId,
        JSON.stringify({
          [`bootstrap_location_intro_rendered_v2_${startLoc}`]: true,
          [`bootstrap_location_intro_rendered_v2_${otherLoc}`]: true,
          keep_me: 'still-here',
        }),
      ],
    );
    const result = await CartridgePlaythroughService.newGame({
      playerId,
      cartridgeId,
    });
    expect(result.mode).toBe('first_spawn');
    expect(result.currentLocationId).toBe(startLoc);
    expect(result.resetGeneration).toBe(3);
    const state = await queryRows<{
      status: string;
      reset_generation: number;
      current_location_id: number | null;
      last_session_id: string | null;
      playthrough_id: string;
    }>(
      `SELECT status, reset_generation, current_location_id,
              last_session_id, playthrough_id::text AS playthrough_id
         FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [playerId, cartridgeId],
    );
    expect(state[0]?.status).toBe('active');
    expect(state[0]?.reset_generation).toBe(3);
    expect(state[0]?.current_location_id).toBe(startLoc);
    expect(state[0]?.last_session_id).toBeNull();
    expect(state[0]?.playthrough_id).toBe(result.playthroughId);
    expect(state[0]?.playthrough_id).not.toBe('sess-x');
    // Player row reflects the respawn.
    const player = await queryRows<{
      current_location_id: number | null;
      current_scene_id: number | null;
      dialogue_partner_id: number | null;
    }>(
      `SELECT current_location_id, current_scene_id, dialogue_partner_id
         FROM players WHERE entity_id = $1`,
      [playerId],
    );
    expect(player[0]?.current_location_id).toBe(startLoc);
    expect(player[0]?.current_scene_id).toBeNull();
    expect(player[0]?.dialogue_partner_id).toBeNull();
    const metadata = await queryRows<{metadata: Record<string, unknown>}>(
      `SELECT metadata FROM players WHERE entity_id = $1`,
      [playerId],
    );
    expect(metadata[0]?.metadata.keep_me).toBe('still-here');
    expect(
      metadata[0]?.metadata[`bootstrap_location_intro_rendered_v2_${startLoc}`],
    ).toBeUndefined();
    expect(
      metadata[0]?.metadata[`bootstrap_location_intro_rendered_v2_${otherLoc}`],
    ).toBeUndefined();
  });

  it('newGame does not touch other heroes rows for the same cartridge', async () => {
    const cartridgeId = `${TEST_PREFIX}new-game-multi`;
    const startLoc = await seedLocation('Multi Start');
    await seedCartridge({
      id: cartridgeId,
      installState: 'ready',
      startingLocationId: startLoc,
    });
    const heroA = await seedHero('Hero A');
    const heroB = await seedHero('Hero B');
    // Seed hero B's run as `active` with reset_generation=5 at a
    // pre-existing location. We will start a new game on hero A and
    // verify hero B's row survives unchanged.
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status,
         current_location_id, reset_generation
       )
       VALUES ($1, $2, 'active', $3, 5)`,
      [heroB, cartridgeId, startLoc],
    );
    await CartridgePlaythroughService.newGame({
      playerId: heroA,
      cartridgeId,
      authenticatedPlayerId: heroA,
    });
    const heroBState = await queryRows<{
      status: string;
      reset_generation: number;
    }>(
      `SELECT status, reset_generation
         FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [heroB, cartridgeId],
    );
    // Hero A's launch must have left hero B's row exactly as we
    // seeded it.
    expect(heroBState[0]?.status).toBe('active');
    expect(heroBState[0]?.reset_generation).toBe(5);
  });

  it('rejects launch when cartridge install state is stale', async () => {
    const cartridgeId = `${TEST_PREFIX}launch-stale`;
    await seedCartridge({id: cartridgeId, installState: 'stale'});
    const playerId = await seedHero('Stale Launch Hero');
    await expect(
      CartridgePlaythroughService.launch({playerId, cartridgeId}),
    ).rejects.toBeInstanceOf(PlaythroughServiceError);
    await expect(
      CartridgePlaythroughService.launch({playerId, cartridgeId}),
    ).rejects.toMatchObject({code: 'repair_required'});
    // No state row should exist for this pair.
    const state = await queryRows<{cartridge_id: string}>(
      `SELECT cartridge_id FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [playerId, cartridgeId],
    );
    expect(state.length).toBe(0);
  });

  it('rejects newGame when cartridge has no starting location', async () => {
    // The new no_starting_location preview gate makes this surface as
    // `repair_required` (first-spawn + no scoped starting location is
    // a launch-blocker, not a runtime error). The dedicated
    // `no_starting_location` newGame error code is still reachable if
    // a future caller bypasses preview (e.g. direct service entry in
    // a fixture-only test).
    const cartridgeId = `${TEST_PREFIX}new-game-no-start`;
    await seedCartridge({id: cartridgeId, installState: 'ready'});
    const playerId = await seedHero('NoStart Hero');
    await expect(
      CartridgePlaythroughService.newGame({playerId, cartridgeId}),
    ).rejects.toMatchObject({code: 'repair_required'});
  });

  it('preview marks first-spawn without scoped starting_location as repair_required (FEAT-CART-LIB-5 corrective)', async () => {
    const cartridgeId = `${TEST_PREFIX}preview-no-start`;
    // Install cache ready, but cartridge has no scoped
    // starting_location_id. Without the gate, launch would COALESCE
    // a stale location from elsewhere.
    await seedCartridge({id: cartridgeId, installState: 'ready'});
    const playerId = await seedHero('PreviewNoStart Hero');
    const view = await CartridgePlaythroughService.preview({
      playerId,
      cartridgeId,
    });
    expect(view.mode).toBe('repair_required');
    expect(view.installReady).toBe(true);
    expect(view.blockers).toContain('no_starting_location');
    // Launch into this state must reject pre-commit; no
    // hero_cartridge_states row should be created and players.location
    // must not move.
    await expect(
      CartridgePlaythroughService.launch({playerId, cartridgeId}),
    ).rejects.toMatchObject({code: 'repair_required'});
    const state = await queryRows<{cartridge_id: string}>(
      `SELECT cartridge_id FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [playerId, cartridgeId],
    );
    expect(state.length).toBe(0);
  });

  it('preview returns continue for an existing run even when starting_location is missing', async () => {
    // A continue path is still launchable — the prior run already has
    // a location persisted on `hero_cartridge_states`. Only first-
    // spawn is gated on starting_location_id.
    const cartridgeId = `${TEST_PREFIX}preview-continue-no-start`;
    const locId = await seedLocation('Resume Lounge');
    await seedCartridge({id: cartridgeId, installState: 'ready'});
    const playerId = await seedHero('Continue Hero');
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, current_location_id
       )
       VALUES ($1, $2, 'available', $3)`,
      [playerId, cartridgeId, locId],
    );
    const view = await CartridgePlaythroughService.preview({
      playerId,
      cartridgeId,
    });
    expect(view.mode).toBe('continue');
    expect(view.blockers).toEqual([]);
  });

  // FEAT-HERO-CONTINUITY-4 (2026-05-17) — launch carryover policy.
  describe('launch carryover (FEAT-HERO-CONTINUITY-4)', () => {
    it('records continuity event, snapshots departing roster, suppresses world-bound bond, materializes portable bond', async () => {
      const cartridgeId = `${TEST_PREFIX}cont4-portable`;
      const locId = await seedLocation('Carryover Plaza');
      await seedCartridge({
        id: cartridgeId,
        installState: 'ready',
        startingLocationId: locId,
      });
      // Mark cartridge policy as accepting portable contracts so the
      // bond is allowed to travel.
      await queryRows(
        `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
         VALUES ($1, 'hero_continuity_policy', $2::jsonb, 'test')
         ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [
          cartridgeId,
          JSON.stringify({
            schema_version: 'greenhaven.hero_continuity_policy.v1',
            carry: {companions: 'portable_contracts'},
          }),
        ],
      );
      const playerId = await seedHero('Cont4 Hero');

      // Source cartridge: another playable world the hero just left.
      const sourceCartridgeId = `${TEST_PREFIX}cont4-source`;
      const sourceLoc = await seedLocation('Source Square');
      await seedCartridge({
        id: sourceCartridgeId,
        installState: 'ready',
        startingLocationId: sourceLoc,
      });
      // Bonded companion (portable) + world-bound NPC, both seeded
      // as dynamic_origin so they satisfy the cartridge-id check.
      const portableNpc = await queryRows<{id: number}>(
        `INSERT INTO entities (kind, display_name, dynamic_origin)
         VALUES ('person', 'Portable Friend', true)
         RETURNING id`,
      );
      const portableId = Number(portableNpc[0]!.id);
      const worldBoundNpc = await queryRows<{id: number}>(
        `INSERT INTO entities (kind, display_name, dynamic_origin)
         VALUES ('person', 'Local Hearth', true)
         RETURNING id`,
      );
      const worldBoundId = Number(worldBoundNpc[0]!.id);
      // Seed live roster as if the hero were currently in the source
      // world with both companions.
      await queryRows(
        `UPDATE players
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('companions', $1::jsonb)
          WHERE entity_id = $2`,
        [JSON.stringify([portableId, worldBoundId]), playerId],
      );
      // Pre-existing source-active row so the launch's "departing
      // world" lookup has something to snapshot into.
      await queryRows(
        `INSERT INTO hero_cartridge_states
           (player_id, cartridge_id, status, current_location_id)
         VALUES ($1, $2, 'active', $3)`,
        [playerId, sourceCartridgeId, sourceLoc],
      );
      // Bonds: one portable (will travel), one world-bound (suppressed).
      const {HeroContinuityLedgerService} = await import(
        '../../services/HeroContinuityLedgerService.js'
      );
      await HeroContinuityLedgerService.upsertCompanionBond({
        playerId,
        companionKey: 'cont4:portable',
        sourceEntityId: portableId,
        portability: 'portable',
        status: 'traveling',
        sourceCartridgeId,
      });
      await HeroContinuityLedgerService.upsertCompanionBond({
        playerId,
        companionKey: 'cont4:hearth',
        sourceEntityId: worldBoundId,
        portability: 'local_locked',
        status: 'world_bound',
        sourceCartridgeId,
      });

      const result = await CartridgePlaythroughService.launch({
        playerId,
        cartridgeId,
      });

      expect(result.continuityCarryover).not.toBeNull();
      const carry = result.continuityCarryover!;
      expect(carry.schemaVersion).toBe(
        'greenhaven.hero_continuity_carryover.v1',
      );
      expect(carry.mode).toBe('launch_first_spawn');
      expect(carry.sourceCartridgeId).toBe(sourceCartridgeId);
      expect(carry.targetCartridgeId).toBe(cartridgeId);
      expect(carry.departingRosterBefore).toEqual([portableId, worldBoundId]);

      // Portable bond accepted → projection materialized; world-bound
      // bond suppressed.
      const portableOutcome = carry.companions.find(
        (c) => c.companionKey === 'cont4:portable',
      );
      expect(portableOutcome?.status).toBe('traveling');
      expect(portableOutcome?.projectionEntityId).not.toBeNull();
      const projectionId = portableOutcome!.projectionEntityId!;
      expect(projectionId).not.toBe(portableId);
      const hearthOutcome = carry.companions.find(
        (c) => c.companionKey === 'cont4:hearth',
      );
      expect(hearthOutcome?.status).toBe('world_bound');
      expect(hearthOutcome?.projectionEntityId).toBeNull();

      // Live roster now contains ONLY the projection id; the source-
      // world ids never leak.
      expect(carry.liveRosterAfter).toEqual([projectionId]);
      const rosterRows = await queryRows<{companions: unknown}>(
        `SELECT metadata->'companions' AS companions
           FROM players WHERE entity_id = $1`,
        [playerId],
      );
      expect(rosterRows[0]?.companions).toEqual([projectionId]);

      // Source-world snapshot now holds the departing roster so a
      // future return restores it.
      const srcSnap = await queryRows<{companions: unknown}>(
        `SELECT world_snapshot->'companions' AS companions
           FROM hero_cartridge_states
          WHERE player_id = $1 AND cartridge_id = $2`,
        [playerId, sourceCartridgeId],
      );
      expect(srcSnap[0]?.companions).toEqual([portableId, worldBoundId]);

      // Continuity event recorded with both companion outcomes.
      const events = await queryRows<{event_type: string; payload: unknown}>(
        `SELECT event_type, payload
           FROM hero_continuity_events
          WHERE player_id = $1
          ORDER BY id DESC
          LIMIT 1`,
        [playerId],
      );
      expect(events[0]?.event_type).toBe('continuity:launch');
      const eventPayload = events[0]!.payload as Record<string, unknown>;
      expect(eventPayload['mode']).toBe('launch_first_spawn');

      // Projection entity exists in the target cartridge as a
      // dynamic person, with actor_statuses(companion=following) for
      // the hero.
      const projRows = await queryRows<{
        kind: string;
        cartridge_id: string;
        dynamic_origin: boolean;
      }>(
        `SELECT kind, cartridge_id, dynamic_origin
           FROM entities WHERE id = $1`,
        [projectionId],
      );
      expect(projRows[0]?.kind).toBe('person');
      expect(projRows[0]?.cartridge_id).toBe(cartridgeId);
      expect(projRows[0]?.dynamic_origin).toBe(true);
      const statusRows = await queryRows<{
        status_kind: string;
        status_value: string;
      }>(
        `SELECT status_kind, status_value
           FROM actor_statuses
          WHERE player_id = $1 AND actor_entity_id = $2`,
        [playerId, projectionId],
      );
      expect(statusRows[0]?.status_kind).toBe('companion');
      expect(statusRows[0]?.status_value).toBe('following');

      // The projection row in companion_universe_projections is set
      // to following and points at the projection entity.
      const projectionRows = await queryRows<{
        status: string;
        projection_entity_id: number | string | null;
      }>(
        `SELECT cup.status, cup.projection_entity_id
           FROM companion_universe_projections cup
           JOIN hero_companion_bonds b ON b.id = cup.companion_bond_id
          WHERE b.player_id = $1 AND b.companion_key = 'cont4:portable'`,
        [playerId],
      );
      expect(projectionRows[0]?.status).toBe('following');
      expect(Number(projectionRows[0]?.projection_entity_id)).toBe(
        projectionId,
      );
    });

    it('suppresses portable bond when target policy disallows portable contracts', async () => {
      const cartridgeId = `${TEST_PREFIX}cont4-no-policy`;
      const locId = await seedLocation('Locked World Square');
      await seedCartridge({
        id: cartridgeId,
        installState: 'ready',
        startingLocationId: locId,
      });
      // Default policy (no scoped row) → companions stay local-only.
      const playerId = await seedHero('Cont4 Locked Hero');
      const npc = await queryRows<{id: number}>(
        `INSERT INTO entities (kind, display_name, dynamic_origin)
         VALUES ('person', 'Locked Out Pal', true)
         RETURNING id`,
      );
      const npcId = Number(npc[0]!.id);
      const {HeroContinuityLedgerService} = await import(
        '../../services/HeroContinuityLedgerService.js'
      );
      await HeroContinuityLedgerService.upsertCompanionBond({
        playerId,
        companionKey: 'cont4:locked',
        sourceEntityId: npcId,
        portability: 'portable',
        status: 'traveling',
      });

      const result = await CartridgePlaythroughService.launch({
        playerId,
        cartridgeId,
      });
      const outcome = result.continuityCarryover!.companions.find(
        (c) => c.companionKey === 'cont4:locked',
      );
      expect(outcome?.status).toBe('suppressed');
      expect(outcome?.reason).toBe(
        'target_policy_disallows_portable_contracts',
      );
      expect(outcome?.projectionEntityId).toBeNull();
      // No projection row materialized.
      const projRows = await queryRows<{n: number}>(
        `SELECT COUNT(*)::int AS n
           FROM companion_universe_projections cup
           JOIN hero_companion_bonds b ON b.id = cup.companion_bond_id
          WHERE b.player_id = $1`,
        [playerId],
      );
      expect(Number(projRows[0]!.n)).toBe(0);
      // Roster ends empty (no projection appended).
      expect(result.continuityCarryover!.liveRosterAfter).toEqual([]);
    });

    it('newGame records continuity:new_game event with reset_generation bump', async () => {
      const cartridgeId = `${TEST_PREFIX}cont4-newgame`;
      const locId = await seedLocation('Reset Square');
      await seedCartridge({
        id: cartridgeId,
        installState: 'ready',
        startingLocationId: locId,
      });
      const playerId = await seedHero('Cont4 NewGame Hero');
      // First launch to establish the playthrough.
      await CartridgePlaythroughService.launch({playerId, cartridgeId});
      // Now new-game.
      const result = await CartridgePlaythroughService.newGame({
        playerId,
        cartridgeId,
      });
      expect(result.continuityCarryover).not.toBeNull();
      expect(result.continuityCarryover!.mode).toBe('new_game');
      expect(result.continuityCarryover!.resetGeneration).toBeGreaterThanOrEqual(
        1,
      );
      const events = await queryRows<{event_type: string}>(
        `SELECT event_type FROM hero_continuity_events
          WHERE player_id = $1 ORDER BY id DESC LIMIT 1`,
        [playerId],
      );
      expect(events[0]?.event_type).toBe('continuity:new_game');
    });

    it('preview remains read-only with no continuity events recorded', async () => {
      const cartridgeId = `${TEST_PREFIX}cont4-preview-readonly`;
      const locId = await seedLocation('Preview Read Only');
      await seedCartridge({
        id: cartridgeId,
        installState: 'ready',
        startingLocationId: locId,
      });
      const playerId = await seedHero('Cont4 Preview Hero');
      const before = await queryRows<{n: number}>(
        `SELECT COUNT(*)::int AS n FROM hero_continuity_events
          WHERE player_id = $1`,
        [playerId],
      );
      await CartridgePlaythroughService.preview({playerId, cartridgeId});
      const after = await queryRows<{n: number}>(
        `SELECT COUNT(*)::int AS n FROM hero_continuity_events
          WHERE player_id = $1`,
        [playerId],
      );
      expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    });

    // FEAT-HERO-CONTINUITY-4-FOLLOWUP (2026-05-17) — state isolation
    // + deferred capsule slice coverage.
    describe('FEAT-HERO-CONTINUITY-4-FOLLOWUP — state isolation', () => {
      it('snapshots an empty departing roster so stale companions cannot rehydrate', async () => {
        const sourceCartridgeId = `${TEST_PREFIX}cont4f-empty-src`;
        const targetCartridgeId = `${TEST_PREFIX}cont4f-empty-tgt`;
        const srcLoc = await seedLocation('Empty Source');
        const tgtLoc = await seedLocation('Empty Target');
        await seedCartridge({
          id: sourceCartridgeId,
          installState: 'ready',
          startingLocationId: srcLoc,
        });
        await seedCartridge({
          id: targetCartridgeId,
          installState: 'ready',
          startingLocationId: tgtLoc,
        });
        const playerId = await seedHero('Cont4F Empty Hero');
        // Source row has a STALE world_snapshot.companions array
        // from a prior departure. The new launch should overwrite
        // it with the empty current roster.
        await queryRows(
          `INSERT INTO hero_cartridge_states
             (player_id, cartridge_id, status, current_location_id,
              world_snapshot)
           VALUES ($1, $2, 'active', $3, $4::jsonb)`,
          [
            playerId,
            sourceCartridgeId,
            srcLoc,
            JSON.stringify({companions: [777]}),
          ],
        );
        await CartridgePlaythroughService.launch({
          playerId,
          cartridgeId: targetCartridgeId,
        });
        const snap = await queryRows<{companions: unknown}>(
          `SELECT world_snapshot->'companions' AS companions
             FROM hero_cartridge_states
            WHERE player_id = $1 AND cartridge_id = $2`,
          [playerId, sourceCartridgeId],
        );
        expect(snap[0]?.companions).toEqual([]);
      });

      it('re-launching the same already-active world preserves the live roster', async () => {
        const cartridgeId = `${TEST_PREFIX}cont4f-relaunch`;
        const locId = await seedLocation('Relaunch Plaza');
        await seedCartridge({
          id: cartridgeId,
          installState: 'ready',
          startingLocationId: locId,
        });
        await queryRows(
          `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
           VALUES ($1, 'hero_continuity_policy', $2::jsonb, 'test')
           ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [
            cartridgeId,
            JSON.stringify({
              schema_version: 'greenhaven.hero_continuity_policy.v1',
              carry: {companions: 'portable_contracts'},
            }),
          ],
        );
        const playerId = await seedHero('Cont4F Relaunch Hero');
        // First launch establishes the active row + projection.
        const npc = await queryRows<{id: number}>(
          `INSERT INTO entities (kind, display_name, dynamic_origin)
           VALUES ('person', 'Sworn', true)
           RETURNING id`,
        );
        const npcId = Number(npc[0]!.id);
        await queryRows(
          `UPDATE players
              SET metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('companions', $1::jsonb)
            WHERE entity_id = $2`,
          [JSON.stringify([npcId]), playerId],
        );
        const {HeroContinuityLedgerService} = await import(
          '../../services/HeroContinuityLedgerService.js'
        );
        await HeroContinuityLedgerService.upsertCompanionBond({
          playerId,
          companionKey: 'cont4f:relaunch',
          sourceEntityId: npcId,
          portability: 'portable',
          status: 'traveling',
        });
        const first = await CartridgePlaythroughService.launch({
          playerId,
          cartridgeId,
        });
        const projectionId =
          first.continuityCarryover!.companions.find(
            (c) => c.companionKey === 'cont4f:relaunch',
          )!.projectionEntityId!;
        // Seed a STALE world_snapshot on the target row with a
        // different ghost companion id. A naive restore would
        // overwrite the live roster with [777].
        await queryRows(
          `UPDATE hero_cartridge_states
              SET world_snapshot = jsonb_build_object('companions',
                $1::jsonb)
            WHERE player_id = $2 AND cartridge_id = $3`,
          [JSON.stringify([777]), playerId, cartridgeId],
        );
        // Re-launch the SAME (now-active) world. Live roster should
        // stay [projectionId], NOT pick up the stale snapshot.
        const second = await CartridgePlaythroughService.launch({
          playerId,
          cartridgeId,
        });
        expect(second.continuityCarryover!.liveRosterAfter).toEqual([
          projectionId,
        ]);
        const rosterRows = await queryRows<{companions: unknown}>(
          `SELECT metadata->'companions' AS companions
             FROM players WHERE entity_id = $1`,
          [playerId],
        );
        expect(rosterRows[0]?.companions).toEqual([projectionId]);
      });

      it('continue restore rejects foreign dynamic-origin persons in world_snapshot', async () => {
        const sourceCartridgeId = `${TEST_PREFIX}cont4f-foreign-src`;
        const targetCartridgeId = `${TEST_PREFIX}cont4f-foreign-tgt`;
        const srcLoc = await seedLocation('Foreign Source');
        const tgtLoc = await seedLocation('Foreign Target');
        await seedCartridge({
          id: sourceCartridgeId,
          installState: 'ready',
          startingLocationId: srcLoc,
        });
        await seedCartridge({
          id: targetCartridgeId,
          installState: 'ready',
          startingLocationId: tgtLoc,
        });
        const playerId = await seedHero('Cont4F Foreign Hero');
        // A `dynamic_origin = true` person with NULL cartridge_id —
        // the kind of row that previously slipped through the
        // permissive filter.
        const foreigner = await queryRows<{id: number}>(
          `INSERT INTO entities (kind, display_name, dynamic_origin)
           VALUES ('person', 'Foreign Ghost', true)
           RETURNING id`,
        );
        const foreignerId = Number(foreigner[0]!.id);
        // Pre-existing target row with a stale world_snapshot that
        // references the foreigner — pretend the hero visited
        // before and "had" a foreign companion in the snapshot.
        await queryRows(
          `INSERT INTO hero_cartridge_states
             (player_id, cartridge_id, status, current_location_id,
              world_snapshot)
           VALUES ($1, $2, 'available', $3, $4::jsonb)`,
          [
            playerId,
            targetCartridgeId,
            tgtLoc,
            JSON.stringify({companions: [foreignerId]}),
          ],
        );
        // Hero is currently active in the SOURCE world so the
        // departing-source path runs (not the same-world relaunch).
        await queryRows(
          `INSERT INTO hero_cartridge_states
             (player_id, cartridge_id, status, current_location_id)
           VALUES ($1, $2, 'active', $3)`,
          [playerId, sourceCartridgeId, srcLoc],
        );
        const result = await CartridgePlaythroughService.launch({
          playerId,
          cartridgeId: targetCartridgeId,
        });
        // The foreigner must NOT have been restored.
        expect(result.continuityCarryover!.liveRosterAfter).not.toContain(
          foreignerId,
        );
        const rosterRows = await queryRows<{companions: unknown}>(
          `SELECT metadata->'companions' AS companions
             FROM players WHERE entity_id = $1`,
          [playerId],
        );
        const roster = (rosterRows[0]?.companions ?? []) as number[];
        expect(roster).not.toContain(foreignerId);
      });

      it('projection reuse is keyed by exact target universe instance', async () => {
        // Two cartridges → two universes; the SAME bond should
        // materialize a DISTINCT projection in each. If the reuse
        // query were keyed by cartridge only, the second launch
        // would reuse the first universe's projection.
        const cartA = `${TEST_PREFIX}cont4f-proj-a`;
        const cartB = `${TEST_PREFIX}cont4f-proj-b`;
        const locA = await seedLocation('Proj A');
        const locB = await seedLocation('Proj B');
        for (const id of [cartA, cartB]) {
          await seedCartridge({
            id,
            installState: 'ready',
            startingLocationId: id === cartA ? locA : locB,
          });
          await queryRows(
            `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
             VALUES ($1, 'hero_continuity_policy', $2::jsonb, 'test')
             ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
            [
              id,
              JSON.stringify({
                schema_version: 'greenhaven.hero_continuity_policy.v1',
                carry: {companions: 'portable_contracts'},
              }),
            ],
          );
        }
        const playerId = await seedHero('Cont4F Proj Hero');
        const npc = await queryRows<{id: number}>(
          `INSERT INTO entities (kind, display_name, dynamic_origin)
           VALUES ('person', 'Cross-Universe Friend', true)
           RETURNING id`,
        );
        const npcId = Number(npc[0]!.id);
        const {HeroContinuityLedgerService} = await import(
          '../../services/HeroContinuityLedgerService.js'
        );
        await HeroContinuityLedgerService.upsertCompanionBond({
          playerId,
          companionKey: 'cont4f:cross',
          sourceEntityId: npcId,
          portability: 'portable',
          status: 'traveling',
        });
        const launchA = await CartridgePlaythroughService.launch({
          playerId,
          cartridgeId: cartA,
        });
        const projA = launchA.continuityCarryover!.companions[0]!
          .projectionEntityId!;
        const launchB = await CartridgePlaythroughService.launch({
          playerId,
          cartridgeId: cartB,
        });
        const projB = launchB.continuityCarryover!.companions[0]!
          .projectionEntityId!;
        expect(projA).not.toBe(projB);
        // Each universe should have exactly one projection row for
        // this bond.
        const counts = await queryRows<{
          universe_instance_id: string;
          n: number;
        }>(
          `SELECT cup.universe_instance_id::text AS universe_instance_id,
                  COUNT(*)::int AS n
             FROM companion_universe_projections cup
             JOIN hero_companion_bonds b ON b.id = cup.companion_bond_id
            WHERE b.player_id = $1 AND b.companion_key = 'cont4f:cross'
            GROUP BY cup.universe_instance_id`,
          [playerId],
        );
        expect(counts).toHaveLength(2);
        for (const row of counts) expect(Number(row.n)).toBe(1);
      });
    });

    describe('FEAT-HERO-CONTINUITY-4-FOLLOWUP — capsule slices', () => {
      it('sanitizes the projection profile, copies safe runtime fields, resolves inventory by source_slug, and applies non-companion statuses', async () => {
        const cartridgeId = `${TEST_PREFIX}cont4f-slices`;
        const locId = await seedLocation('Slice Square');
        await seedCartridge({
          id: cartridgeId,
          installState: 'ready',
          startingLocationId: locId,
        });
        await queryRows(
          `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
           VALUES ($1, 'hero_continuity_policy', $2::jsonb, 'test')
           ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [
            cartridgeId,
            JSON.stringify({
              schema_version: 'greenhaven.hero_continuity_policy.v1',
              carry: {companions: 'portable_contracts'},
            }),
          ],
        );
        const playerId = await seedHero('Cont4F Slice Hero');
        // Source companion with a "loaded" profile: traits we want
        // to keep + location keys we must drop.
        const cmp = await queryRows<{id: number}>(
          `INSERT INTO entities (kind, display_name, summary, profile, dynamic_origin)
           VALUES ('person', 'Sliced Friend', 'a sworn ally', $1::jsonb, true)
           RETURNING id`,
          [
            JSON.stringify({
              voice: 'low and dry',
              oath: 'protect',
              traits: ['stoic', 'loyal'],
              // Source-world refs that must be sanitized away:
              home_id: 999_001,
              current_location_id: 999_002,
              scene_id: 999_003,
              exits: [999_004],
              companions: [999_005],
            }),
          ],
        );
        const cmpId = Number(cmp[0]!.id);
        // Source-world item with a stable source_slug. The target
        // cartridge owns an item with the matching slug → the
        // resolver should remap the inventory entry to the target
        // item id.
        const srcItem = await queryRows<{id: number}>(
          `INSERT INTO entities (kind, display_name, profile, dynamic_origin)
           VALUES ('item', 'Source Coin', $1::jsonb, true)
           RETURNING id`,
          [JSON.stringify({source_slug: 'item.coin'})],
        );
        const srcItemId = Number(srcItem[0]!.id);
        const tgtItem = await queryRows<{id: number}>(
          `INSERT INTO entities (kind, display_name, profile, cartridge_id)
           VALUES ('item', 'Target Coin', $1::jsonb, $2)
           RETURNING id`,
          [JSON.stringify({source_slug: 'item.coin'}), cartridgeId],
        );
        const tgtItemId = Number(tgtItem[0]!.id);
        // A second source item with NO matching target → should
        // be counted as suppressed in arrival_payload.
        const lostItem = await queryRows<{id: number}>(
          `INSERT INTO entities (kind, display_name, profile, dynamic_origin)
           VALUES ('item', 'Lost Relic', '{}'::jsonb, true)
           RETURNING id`,
        );
        const lostItemId = Number(lostItem[0]!.id);
        await queryRows(
          `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count, metadata)
           VALUES ($1, $2, 4, '{}'::jsonb),
                  ($1, $3, 1, '{}'::jsonb)`,
          [cmpId, srcItemId, lostItemId],
        );
        // npc_stats so we still copy them.
        await queryRows(
          `INSERT INTO npc_stats (npc_entity_id, stat_key, base, current)
           VALUES ($1, 'STR', 4, 4)`,
          [cmpId],
        );
        // Runtime fields: one safe `mood` field + one `strings`
        // (the strings sanitizer is already covered elsewhere).
        const moodFieldRow = await queryRows<{id: number}>(
          `INSERT INTO runtime_fields (owner_entity_id, field_key, value_type, scope)
           VALUES ($1, 'mood', 'string', 'permanent')
           RETURNING id`,
          [cmpId],
        );
        await queryRows(
          `INSERT INTO runtime_values (field_id, value, source)
           VALUES ($1, $2::jsonb, 'test')`,
          [Number(moodFieldRow[0]!.id), JSON.stringify('cautious')],
        );
        // Non-companion actor status that should ride.
        await queryRows(
          `INSERT INTO actor_statuses
             (player_id, actor_entity_id, status_kind, status_value, intensity, source)
           VALUES ($1, $2, 'wounded', 'mild', 0.3, 'test')`,
          [playerId, cmpId],
        );
        // Companion status (will be ignored by the apply helper —
        // carryover writes its own `following` row).
        await queryRows(
          `INSERT INTO actor_statuses
             (player_id, actor_entity_id, status_kind, status_value, intensity, source)
           VALUES ($1, $2, 'companion', 'native', 1.0, 'test')`,
          [playerId, cmpId],
        );
        const {HeroContinuityLedgerService} = await import(
          '../../services/HeroContinuityLedgerService.js'
        );
        await HeroContinuityLedgerService.upsertCompanionBond({
          playerId,
          companionKey: 'cont4f:slices',
          sourceEntityId: cmpId,
          portability: 'portable',
          status: 'traveling',
        });

        const result = await CartridgePlaythroughService.launch({
          playerId,
          cartridgeId,
        });
        const projectionId = result.continuityCarryover!.companions[0]!
          .projectionEntityId!;
        // Projection profile is sanitized — kept traits, dropped
        // source-world refs.
        const projRow = await queryRows<{profile: Record<string, unknown>}>(
          `SELECT profile FROM entities WHERE id = $1`,
          [projectionId],
        );
        const projectionProfile = projRow[0]!.profile;
        expect(projectionProfile.voice).toBe('low and dry');
        expect(projectionProfile.oath).toBe('protect');
        expect(projectionProfile.traits).toEqual(['stoic', 'loyal']);
        expect(projectionProfile.home_id).toBeUndefined();
        expect(projectionProfile.current_location_id).toBeUndefined();
        expect(projectionProfile.scene_id).toBeUndefined();
        expect(projectionProfile.exits).toBeUndefined();
        expect(projectionProfile.companions).toBeUndefined();
        // Non-companion status copied.
        const statusRows = await queryRows<{
          status_kind: string;
          status_value: string;
        }>(
          `SELECT status_kind, status_value
             FROM actor_statuses
            WHERE player_id = $1 AND actor_entity_id = $2
            ORDER BY status_kind`,
          [playerId, projectionId],
        );
        const kinds = statusRows.map((r) => r.status_kind);
        expect(kinds).toContain('companion');
        expect(kinds).toContain('wounded');
        // Inventory resolved via source_slug → target item id;
        // the unresolved item is suppressed (NOT copied to the
        // projection).
        const invRows = await queryRows<{
          item_entity_id: number;
          count: number;
        }>(
          `SELECT item_entity_id, count
             FROM inventory_entries
            WHERE holder_entity_id = $1`,
          [projectionId],
        );
        expect(invRows).toHaveLength(1);
        expect(Number(invRows[0]!.item_entity_id)).toBe(tgtItemId);
        expect(Number(invRows[0]!.count)).toBe(4);
        // Runtime mood field copied; strings field exists and is
        // hero-only.
        const fieldsRows = await queryRows<{field_key: string}>(
          `SELECT field_key FROM runtime_fields WHERE owner_entity_id = $1
            ORDER BY field_key`,
          [projectionId],
        );
        const keys = fieldsRows.map((r) => r.field_key);
        expect(keys).toContain('mood');
        expect(keys).toContain('strings');
        // arrival_payload counts surface the applied/suppressed
        // slices.
        const arrivalRow = await queryRows<{arrival_payload: unknown}>(
          `SELECT arrival_payload
             FROM companion_universe_projections cup
             JOIN hero_companion_bonds b ON b.id = cup.companion_bond_id
            WHERE b.player_id = $1 AND b.companion_key = 'cont4f:slices'`,
          [playerId],
        );
        const arrivalPayload = arrivalRow[0]!.arrival_payload as Record<
          string,
          unknown
        >;
        const sliceCounts = arrivalPayload['slice_counts'] as Record<
          string,
          number
        >;
        expect(sliceCounts['appliedInventory']).toBe(1);
        expect(sliceCounts['suppressedInventory']).toBe(1);
        expect(sliceCounts['appliedStatuses']).toBeGreaterThanOrEqual(1);
        expect(sliceCounts['appliedRuntimeFields']).toBeGreaterThanOrEqual(1);
      });
    });
  });
});
