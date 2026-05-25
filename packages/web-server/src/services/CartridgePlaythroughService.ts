/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-4 — playthrough preview / launch / new-game.
//
// This service owns the hero ↔ cartridge launch contract. It never
// touches the Obsidian compile pipeline, the import preview/apply
// services, or the static cartridge content tables (`cartridges`,
// `cartridge_records`, `entities`, `cartridge_meta_scoped`,
// `cartridge_install_cache`). Those belong to FEAT-CART-LIB-2/3.
//
// What it DOES write:
//
//   * `hero_cartridge_states` — activates/restores the target
//     `(player_id, cartridge_id)` pair, snapshots the previously
//     active pair (if any) before flipping it back to `available`,
//     and stamps a fresh `playthrough_id` + bumped `reset_generation`
//     for the new-game path.
//   * `players` — refreshes `current_location_id`, `current_scene_id`,
//     `dialogue_partner_id`, and `last_seen` so the next gameplay
//     turn picks up the launched run as canonical server state.
//
// What it does NOT do:
//
//   * Never calls `resetWorldState`, the import services, or any
//     compile script. New-game on a `ready` install reuses the
//     already-applied content; it only resets the hero's runtime
//     mapping, never the cartridge data.
//   * Never deletes static entities, cartridge records, scoped
//     metadata, or other heroes' rows. A new-game on hero A in
//     cartridge X never touches hero B's row in cartridge X.

import {randomUUID} from 'node:crypto';
import {clearMetaCache, getMeta} from '../cartridge.js';
import {activeCartridgeId} from '../cartridgeScope.js';
import {query, withTransaction} from '../db.js';
import {telemetry} from '../telemetry/index.js';
import {readInstallCache} from './CartridgeImportPreviewService.js';
import {
  HeroContinuityCarryoverService,
  type ContinuityCarryoverSummary,
} from './HeroContinuityCarryoverService.js';
import {
  HeroContinuityService,
  type ContinuityPreview,
} from './HeroContinuityService.js';
import {UniverseInstanceService} from './UniverseInstanceService.js';

export type PlaythroughMode = 'continue' | 'first_spawn' | 'repair_required';

export interface PlaythroughPreview {
  playerId: number;
  publicId: string;
  heroName: string;
  cartridgeId: string;
  cartridgeTitle: string;
  mode: PlaythroughMode;
  isDefaultCartridge: boolean;
  installReady: boolean;
  installState: string | null;
  startingLocationId: number | null;
  startingLocationName: string | null;
  /** Existing hero-cartridge state (if any). Null on a first launch. */
  state: {
    status: 'available' | 'active' | 'incompatible' | 'archived';
    playthroughId: string;
    resetGeneration: number;
    lastSessionId: string | null;
    currentLocationId: number | null;
    currentLocationName: string | null;
    updatedAt: string;
  } | null;
  /** Repair / blocker codes the GUI can show. Non-empty when
   *  `mode === 'repair_required'`. */
  blockers: string[];
  /** FEAT-HERO-CONTINUITY-1 — additive read-only continuity preview.
   *  Lists hero core that carries with the hero, local state that
   *  stays in whichever source world it lives in, companion roster
   *  classification, and the active continuity policy. Null when the
   *  preview helper itself faulted; existing Worlds & Heroes callers
   *  ignore the field. */
  continuityPreview: ContinuityPreview | null;
  /** FEAT-HERO-CONTINUITY-2 — id of the default
   *  `local_single_player` universe instance for this cartridge.
   *  Null on a clean baseline where the cartridge has not been
   *  applied yet; existing callers ignore the field. */
  universeInstanceId: string | null;
}

export interface PlaythroughLaunchResult {
  playerId: number;
  publicId: string;
  cartridgeId: string;
  playthroughId: string;
  resetGeneration: number;
  mode: PlaythroughMode;
  currentLocationId: number | null;
  currentLocationName: string | null;
  /** FEAT-HERO-CONTINUITY-2 — id of the universe instance this
   *  playthrough is attached to. Always present after a successful
   *  launch / new-game because the service ensures the default
   *  universe before writing the `hero_cartridge_states` row. */
  universeInstanceId: string;
  /** FEAT-HERO-CONTINUITY-4 — additive carryover summary. Reports
   *  which bonds traveled, which artifacts carried, the live roster
   *  the hero now has in the target world, and the continuity event
   *  id recorded for this launch / new-game. Null when the carryover
   *  helper itself faulted; existing Worlds & Heroes callers ignore
   *  the field. */
  continuityCarryover: ContinuityCarryoverSummary | null;
  /** Client-cache reset hint. The web-ui bridge clears the listed
   *  storage keys + resets bootstrap before fetching gameplay state. */
  clearClientCache: {
    keys: string[];
    /** Public id the bridge should now write into local storage. */
    playerPublicId: string;
  };
}

export class PlaythroughServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlaythroughServiceError';
  }
}

interface HeroRow {
  player_id: number;
  public_id: string;
  hero_name: string;
}

interface StateRow {
  status: string;
  playthrough_id: string;
  reset_generation: number;
  last_session_id: string | null;
  current_location_id: number | null;
  current_scene_id: number | null;
  updated_at: string;
}

const STALE_CLIENT_STORAGE_KEYS = [
  'greenhaven.sessionId',
  // The public id is rewritten by the launch flow; the bridge will
  // write the new value in. We list it here so the bridge knows the
  // old value is no longer authoritative.
  'greenhaven.playerPublicId',
];

/**
 * FEAT-CART-LIB-7 (2026-05-17) — resolve the active cartridge for a
 * specific hero from `hero_cartridge_states.status = 'active'`. The
 * global `cartridge_meta.cartridge_id` mirror remains as a fallback
 * for callers that have no player context (jobs, scripts) or for the
 * legacy first-boot window before any hero has been launched.
 *
 * This is the read side of the per-(player, cartridge) cartridge
 * scope: gameplay session readers must consult it instead of
 * `activeCartridgeId()` so map/exits/nearby never leak content from
 * a different hero's cartridge.
 *
 * Behaviour:
 *   * Non-positive / NaN `playerId` → falls through to the global
 *     fallback. Defensive: every gameplay-session caller already has
 *     a real player id, but the helper stays safe for any future
 *     pre-auth caller.
 *   * Multiple `active` rows for the same player (legacy: only one
 *     should be active at a time, but `hero_cartridge_states` has no
 *     DB-level partial unique index for this) → returns the
 *     most-recently-updated row.
 *   * No `active` row → falls back to `activeCartridgeId()` from
 *     `cartridgeScope.ts`. Throws the same `getMetaRequired` error
 *     when the global mirror is also empty.
 */
export async function resolveActivePlayerCartridgeId(
  playerId: number | null | undefined,
): Promise<string> {
  const ctx = await resolveActivePlayerCartridgeContext(playerId);
  return ctx.cartridgeId;
}

export interface ActivePlayerCartridgeContext {
  cartridgeId: string;
  /** `current_location_id` from the active `hero_cartridge_states`
   *  row, or `null` when no such row exists / fallback was used. */
  playthroughLocationId: number | null;
  /** `current_scene_id` from the active row; null when absent. */
  playthroughSceneId: number | null;
  /** True when the cartridge came from `hero_cartridge_states.active`;
   *  false when the global `cartridge_meta` fallback fired. Callers
   *  that need to refuse stale-fallback writes (e.g. move_player
   *  sync) can gate on this. */
  hasActivePlaythrough: boolean;
}

/**
 * FEAT-CART-LIB-8 (2026-05-17) — full active-playthrough context for
 * a hero. Used by:
 *
 *   * `SessionLifecycleService.loadLocationsView()` to validate
 *     `players.current_location_id` against the active cartridge
 *     and recover via the playthrough or scoped starting location
 *     when the player row holds a foreign id.
 *   * `move_player` (`tools/movement.ts`) to reject cross-cartridge
 *     targets pre-write and to sync the `hero_cartridge_states`
 *     row in the same transaction as the `players` UPDATE.
 *
 * The shape extends `resolveActivePlayerCartridgeId` with the
 * playthrough location/scene + a `hasActivePlaythrough` flag so the
 * caller can decide whether the global-meta fallback path is safe
 * for their contract.
 *
 * Throws via `activeCartridgeId()` → `getMetaRequired('cartridge_id')`
 * when neither the active `hero_cartridge_states` row nor the legacy
 * global `cartridge_meta` mirror is populated. Write/tool callers
 * keep this strict contract; session-read callers should prefer
 * `resolveActivePlayerCartridgeContextOptional`, which returns `null`
 * for the no-active branch so the route can degrade gracefully
 * instead of 500-ing.
 */
export async function resolveActivePlayerCartridgeContext(
  playerId: number | null | undefined,
): Promise<ActivePlayerCartridgeContext> {
  const ctx = await resolveActivePlayerCartridgeContextOptional(playerId);
  if (ctx) return ctx;
  return {
    cartridgeId: await activeCartridgeId(),
    playthroughLocationId: null,
    playthroughSceneId: null,
    hasActivePlaythrough: false,
  };
}

/**
 * FEAT-CART-LIB-7-FOLLOWUP (2026-05-18) — non-throwing variant of
 * `resolveActivePlayerCartridgeContext`. Returns the same shape when
 * an active row exists, falls back to legacy global `cartridge_meta.
 * cartridge_id` via `getMeta` (no throw), and finally returns `null`
 * when neither source has a cartridge id.
 *
 * Used by session-read callers (`SessionLifecycleService.
 * loadLocationsView`) that should degrade to an empty / stable
 * payload rather than escape a `cartridge_meta missing required key`
 * Error to the HTTP layer when a hero has not launched a cartridge
 * yet (clean engine baseline, partial reset, etc.). Tool / write
 * callers keep using the strict variant so a missing active cartridge
 * still surfaces as a typed failure.
 */
export async function resolveActivePlayerCartridgeContextOptional(
  playerId: number | null | undefined,
): Promise<ActivePlayerCartridgeContext | null> {
  if (typeof playerId === 'number' && Number.isInteger(playerId) && playerId > 0) {
    const r = await query<{
      cartridge_id: string;
      current_location_id: number | null;
      current_scene_id: number | null;
    }>(
      `SELECT cartridge_id,
              current_location_id,
              current_scene_id
         FROM hero_cartridge_states
        WHERE player_id = $1
          AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [playerId],
    );
    const row = r.rows[0];
    if (row && row.cartridge_id) {
      return {
        cartridgeId: row.cartridge_id,
        playthroughLocationId: row.current_location_id ?? null,
        playthroughSceneId: row.current_scene_id ?? null,
        hasActivePlaythrough: true,
      };
    }
  }
  const globalCartridgeId = await getMeta<string>('cartridge_id');
  if (typeof globalCartridgeId === 'string' && globalCartridgeId.length > 0) {
    return {
      cartridgeId: globalCartridgeId,
      playthroughLocationId: null,
      playthroughSceneId: null,
      hasActivePlaythrough: false,
    };
  }
  return null;
}

/**
 * FEAT-CART-LIB-8 (2026-05-17) — verify that an entity id belongs to
 * the cartridge scope (`entities.cartridge_id = $cartridge` OR
 * `dynamic_origin = true` OR `kind = 'player'`). Used by gameplay
 * readers and `move_player` to refuse cross-cartridge targets.
 *
 * Returns `false` when the entity does not exist OR is not part of
 * the active cartridge scope. Defensive against missing ids so
 * callers can treat "not found" and "foreign" as the same rejection
 * branch.
 */
export async function entityBelongsToCartridge(
  entityId: number,
  cartridgeId: string,
): Promise<boolean> {
  if (!Number.isInteger(entityId) || entityId <= 0) return false;
  const r = await query<{ok: boolean | null}>(
    `SELECT (
       cartridge_id = $2
       OR dynamic_origin = true
       OR kind = 'player'
     ) AS ok
       FROM entities
      WHERE id = $1
      LIMIT 1`,
    [entityId, cartridgeId],
  );
  return r.rows[0]?.ok === true;
}

/**
 * FEAT-CART-LIB-8 (2026-05-17) — resolve the cartridge's scoped
 * starting location id (if any), as a final fallback for session
 * readers when neither `players.current_location_id` nor the active
 * playthrough row points at a same-cartridge place.
 *
 * Returns null when scoped meta has no `starting_location_id` or it
 * is not parseable.
 */
export async function resolveScopedStartingLocationId(
  cartridgeId: string,
): Promise<number | null> {
  const r = await query<{id: string | null}>(
    `SELECT (value #>> '{}')::text AS id
       FROM cartridge_meta_scoped
      WHERE cartridge_id = $1
        AND key = 'starting_location_id'
      LIMIT 1`,
    [cartridgeId],
  );
  const raw = r.rows[0]?.id;
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * FEAT-CART-LIB-9 (2026-05-17) — shared current-location anchor
 * resolution for the active cartridge. Centralizes the priority
 * chain used by both `SessionLifecycleService.loadLocationsView`
 * (read side) and `move_player` (write side):
 *
 *   1. `players.current_location_id` when it belongs to the active
 *      cartridge scope (the common path).
 *   2. The active playthrough's `current_location_id`
 *      (`hero_cartridge_states.current_location_id` for the
 *      `status='active'` row) when it belongs to the cartridge.
 *   3. The cartridge's scoped `starting_location_id` when it
 *      belongs to the cartridge.
 *   4. `null` — no safe same-cartridge anchor.
 *
 * Cartridge-scope check uses `entityBelongsToCartridge`, which
 * preserves the dynamic-spawn / player-row allowances from
 * `activeCartridgeEntityPredicate`. Returning a structured result
 * lets callers know which branch fired (and whether recovery
 * happened) without re-running the predicate.
 */
export interface PickedCurrentLocation {
  locationId: number | null;
  /** Which fallback branch supplied the id. `null` when no anchor
   *  survived the priority chain. */
  source: 'player_row' | 'playthrough' | 'scoped_start' | null;
  /** Convenience flag — true when the player row had a value but
   *  it failed the cartridge predicate and a recovery branch fired
   *  (or `null` if nothing recovered). */
  recoveredFromForeign: boolean;
}

export async function pickActiveCartridgeLocationAnchor(opts: {
  cartridgeId: string;
  playerCurrentLocationId: number | null;
  playthroughCurrentLocationId: number | null;
}): Promise<PickedCurrentLocation> {
  const playerHasForeign =
    opts.playerCurrentLocationId != null &&
    !(await entityBelongsToCartridge(
      opts.playerCurrentLocationId,
      opts.cartridgeId,
    ));
  if (
    opts.playerCurrentLocationId != null &&
    !playerHasForeign
  ) {
    return {
      locationId: opts.playerCurrentLocationId,
      source: 'player_row',
      recoveredFromForeign: false,
    };
  }
  if (
    opts.playthroughCurrentLocationId != null &&
    (await entityBelongsToCartridge(
      opts.playthroughCurrentLocationId,
      opts.cartridgeId,
    ))
  ) {
    return {
      locationId: opts.playthroughCurrentLocationId,
      source: 'playthrough',
      recoveredFromForeign: playerHasForeign,
    };
  }
  const scoped = await resolveScopedStartingLocationId(opts.cartridgeId);
  if (
    scoped != null &&
    (await entityBelongsToCartridge(scoped, opts.cartridgeId))
  ) {
    return {
      locationId: scoped,
      source: 'scoped_start',
      recoveredFromForeign: playerHasForeign,
    };
  }
  return {
    locationId: null,
    source: null,
    recoveredFromForeign: playerHasForeign,
  };
}

async function loadHero(playerId: number): Promise<HeroRow | null> {
  const r = await query<{
    entity_id: number;
    public_id: string;
    display_name: string;
  }>(
    `SELECT p.entity_id,
            p.public_id::text AS public_id,
            e.display_name
       FROM players p
       JOIN entities e ON e.id = p.entity_id
      WHERE p.entity_id = $1
        AND e.kind = 'player'`,
    [playerId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    player_id: row.entity_id,
    public_id: row.public_id,
    hero_name: row.display_name,
  };
}

async function loadCartridge(
  cartridgeId: string,
): Promise<{id: string; title: string} | null> {
  const r = await query<{id: string; title: string}>(
    `SELECT id, title FROM cartridges WHERE id = $1`,
    [cartridgeId],
  );
  return r.rows[0] ?? null;
}

async function loadExistingState(
  playerId: number,
  cartridgeId: string,
): Promise<StateRow | null> {
  const r = await query<StateRow>(
    `SELECT status,
            playthrough_id::text AS playthrough_id,
            reset_generation,
            last_session_id,
            current_location_id,
            current_scene_id,
            updated_at::text AS updated_at
       FROM hero_cartridge_states
      WHERE player_id = $1 AND cartridge_id = $2`,
    [playerId, cartridgeId],
  );
  return r.rows[0] ?? null;
}

async function loadStartingLocation(
  cartridgeId: string,
): Promise<{id: number | null; name: string | null}> {
  // Scoped meta only. Migration 0125 backfills the legacy global
  // `cartridge_meta` row into `cartridge_meta_scoped` for the active
  // default cartridge, so no legacy fallback is needed here. Using
  // the `(value #>> '{}')::text` cast that
  // `CartridgeLibraryService.loadStartingLocationName` uses — JSONB
  // scalar decoding is driver-quirky so the SQL cast is the safest
  // extraction path.
  const scoped = await query<{id: string | null}>(
    `SELECT (value #>> '{}')::text AS id
       FROM cartridge_meta_scoped
      WHERE cartridge_id = $1
        AND key = 'starting_location_id'
      LIMIT 1`,
    [cartridgeId],
  );
  let id: number | null = null;
  const rawScoped = scoped.rows[0]?.id;
  if (rawScoped != null) {
    const n = Number(rawScoped);
    if (Number.isFinite(n)) id = Math.trunc(n);
  }
  if (id == null) return {id: null, name: null};
  const r = await query<{display_name: string | null}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [id],
  );
  return {id, name: r.rows[0]?.display_name ?? null};
}

async function loadLocationName(id: number | null): Promise<string | null> {
  if (id == null) return null;
  const r = await query<{display_name: string | null}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.display_name ?? null;
}

/**
 * FEAT-CART-LIB-6 corrective (2026-05-17) — mirror the launched
 * cartridge id (and its scoped starting location id) into legacy
 * global `cartridge_meta`. Pre-FEAT-CART-LIB-5 gameplay routes
 * (`SessionLifecycleService.loadLocationsView` etc.) read
 * `getMetaRequired('cartridge_id')` / `getMetaRequired
 * ('starting_location_id')` from the global table to decide which
 * cartridge a turn happens in. On a clean baseline + GUI install,
 * those keys are empty and any session bootstrap 500s with
 * `cartridge_meta missing required key: 'cartridge_id'`.
 *
 * Writing on every launch/new-game keeps the active default in
 * sync with whichever (player, cartridge) pair was most recently
 * promoted to `status = 'active'`. The scoped table remains
 * authoritative; this global mirror is the back-compat surface for
 * legacy readers and will go away once those callers consult
 * `hero_cartridge_states` directly.
 */
async function syncGlobalCartridgeMeta(
  cartridgeId: string,
  startingLocationId: number | null,
): Promise<void> {
  await query(
    `INSERT INTO cartridge_meta (key, value, description)
     VALUES ('cartridge_id', to_jsonb($1::text),
             'FEAT-CART-LIB-6 — id of the cartridge the last playthrough launch / new-game activated.')
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       description = EXCLUDED.description,
       updated_at = now()`,
    [cartridgeId],
  );
  if (startingLocationId != null) {
    await query(
      `INSERT INTO cartridge_meta (key, value, description)
       VALUES ('starting_location_id', to_jsonb($1::int),
               'FEAT-CART-LIB-6 — starting_location_id mirrored from cartridge_meta_scoped on launch.')
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         description = EXCLUDED.description,
         updated_at = now()`,
      [startingLocationId],
    );
  }
  const scopedWorld = await query<{world_entity_id: number | null}>(
    `SELECT (value #>> '{}')::int AS world_entity_id
       FROM cartridge_meta_scoped
      WHERE cartridge_id = $1 AND key = 'world_entity_id'
      LIMIT 1`,
    [cartridgeId],
  );
  const worldEntityId = scopedWorld.rows[0]?.world_entity_id;
  if (worldEntityId != null) {
    await query(
      `INSERT INTO cartridge_meta (key, value, description)
       VALUES ('world_entity_id', to_jsonb($1::int),
               'World entity id mirrored from cartridge_meta_scoped on launch.')
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         description = EXCLUDED.description,
         updated_at = now()`,
      [Number(worldEntityId)],
    );
  } else {
    await query(`DELETE FROM cartridge_meta WHERE key = 'world_entity_id'`);
  }
  clearMetaCache();
}

function deriveMode(args: {
  state: StateRow | null;
  installReady: boolean;
  startingLocationId: number | null;
}): {mode: PlaythroughMode; blockers: string[]} {
  const blockers: string[] = [];
  if (!args.installReady) blockers.push('install_cache_not_ready');
  if (args.state?.status === 'incompatible') blockers.push('hero_incompatible');
  // First-spawn into a cartridge with no scoped `starting_location_id`
  // is treated as `repair_required` — there is no safe place to put
  // the hero, and a `COALESCE`-based launch would silently preserve a
  // stale location from an unrelated cartridge. The GUI shows this as
  // a repair blocker. A `continue` state already has its own location
  // so the gate only fires on first-spawn.
  const isFirstSpawn = args.state == null;
  if (isFirstSpawn && args.startingLocationId == null) {
    blockers.push('no_starting_location');
  }
  if (blockers.length > 0) return {mode: 'repair_required', blockers};
  if (isFirstSpawn) return {mode: 'first_spawn', blockers};
  // Continue when there is any prior in-cartridge state, even if the
  // status is `available` — the GUI shows that as "resume run". An
  // explicit new-game endpoint exists separately for "wipe and respawn".
  return {mode: 'continue', blockers};
}

export class CartridgePlaythroughService {
  /**
   * Resolve the per-(player, cartridge) launch preview. Read-only.
   */
  static async preview(opts: {
    playerId: number;
    cartridgeId: string;
  }): Promise<PlaythroughPreview> {
    if (!Number.isInteger(opts.playerId) || opts.playerId <= 0) {
      throw new PlaythroughServiceError(
        'invalid_player_id',
        'playerId must be a positive integer',
      );
    }
    if (!opts.cartridgeId || opts.cartridgeId.length > 256) {
      throw new PlaythroughServiceError(
        'invalid_cartridge_id',
        'cartridgeId is required',
      );
    }
    const hero = await loadHero(opts.playerId);
    if (!hero) {
      throw new PlaythroughServiceError(
        'unknown_player',
        `player ${opts.playerId} not found`,
      );
    }
    const cart = await loadCartridge(opts.cartridgeId);
    if (!cart) {
      throw new PlaythroughServiceError(
        'unknown_cartridge',
        `cartridge ${opts.cartridgeId} not found`,
      );
    }
    const defaultId = await activeCartridgeId().catch(() => '');
    const isDefault = defaultId === opts.cartridgeId;
    const installCacheRow = await readInstallCache(opts.cartridgeId);
    const installState = installCacheRow?.state ?? null;
    // Both `ready` and `active_db` are launchable. Default cartridge
    // typically reports `active_db`; freshly applied non-default
    // cartridges report `ready`.
    const installReady =
      installState === 'ready' || installState === 'active_db';
    const state = await loadExistingState(opts.playerId, opts.cartridgeId);
    const starting = await loadStartingLocation(opts.cartridgeId);
    const {mode, blockers} = deriveMode({
      state,
      installReady,
      startingLocationId: starting.id,
    });
    const currentLocationName = await loadLocationName(
      state?.current_location_id ?? null,
    );
    // FEAT-HERO-CONTINUITY-1 — additive read-only preview. The
    // helper never mutates rows and never throws for valid (player,
    // cartridge) pairs we already validated above, but we still
    // wrap it in a guarded read so any future helper bug surfaces
    // as `continuityPreview: null` rather than failing the whole
    // playthrough preview that Worlds & Heroes depends on.
    let continuityPreview: ContinuityPreview | null = null;
    try {
      continuityPreview = await HeroContinuityService.previewTransfer(
        opts.playerId,
        opts.cartridgeId,
      );
    } catch (err) {
      // CATCH-WARN-OK: continuity preview is additive read-only data
      // for Worlds & Heroes; a fault here must not block the
      // playthrough preview (which the BootGate flow already
      // depends on).
      console.warn(
        '[CartridgePlaythroughService.preview] continuity preview failed:',
        err instanceof Error ? err.message : err,
      );
    }
    // FEAT-HERO-CONTINUITY-2 — read-only lookup of the default
    // universe instance. Migration 0129 backfilled one row per
    // installed cartridge; this preview path stays read-only and
    // surfaces `null` when the cartridge has not been applied yet
    // (no row in `universe_instances`). Launch + new-game write
    // paths call `ensureDefaultForCartridge` so the
    // `hero_cartridge_states.universe_instance_id` link gets stamped
    // even on the rare path that pre-dates migration 0129.
    const universe = await UniverseInstanceService.getDefaultForCartridge(
      opts.cartridgeId,
    );
    return {
      playerId: hero.player_id,
      publicId: hero.public_id,
      heroName: hero.hero_name,
      cartridgeId: cart.id,
      cartridgeTitle: cart.title,
      mode,
      isDefaultCartridge: isDefault,
      installReady,
      installState,
      startingLocationId: starting.id,
      startingLocationName: starting.name,
      state: state
        ? {
            status: state.status as
              | 'available'
              | 'active'
              | 'incompatible'
              | 'archived',
            playthroughId: state.playthrough_id,
            resetGeneration: state.reset_generation,
            lastSessionId: state.last_session_id,
            currentLocationId: state.current_location_id,
            currentLocationName,
            updatedAt: state.updated_at,
          }
        : null,
      blockers,
      continuityPreview,
      universeInstanceId: universe?.id ?? null,
    };
  }

  /**
   * Launch (or resume) the selected (player, cartridge). Snapshots
   * any other `active` row for this player before flipping that row
   * back to `available`; activates the target row (creating it on
   * first launch). Always returns the post-launch state + a client-
   * cache reset hint.
   */
  static async launch(opts: {
    playerId: number;
    cartridgeId: string;
    /** Optional cookie-derived player id; when present and different
     *  from `playerId`, the launch is treated as a hero switch and
     *  the previous hero's active row is snapshotted instead of the
     *  selected one. */
    authenticatedPlayerId?: number | null;
  }): Promise<PlaythroughLaunchResult> {
    const preview = await CartridgePlaythroughService.preview({
      playerId: opts.playerId,
      cartridgeId: opts.cartridgeId,
    });
    if (preview.mode === 'repair_required') {
      throw new PlaythroughServiceError(
        'repair_required',
        `cannot launch: blockers=${preview.blockers.join(',')}`,
      );
    }
    return await withTransaction(async () => {
      // 1) Snapshot the previously-active pair for the AUTHENTICATED
      //    hero, if any, BEFORE flipping target to active. This is
      //    the "save what I was playing" step that ensures the
      //    departing run survives switches across cartridges. We
      //    intentionally use the cookie-derived id when available so
      //    a hero switch (different selected hero) snapshots the
      //    HERO who was actually in the seat, not the one being
      //    moved into it.
      const sourcePlayerId =
        typeof opts.authenticatedPlayerId === 'number' &&
        opts.authenticatedPlayerId > 0
          ? opts.authenticatedPlayerId
          : opts.playerId;
      await query(
        `UPDATE hero_cartridge_states
            SET status = 'available',
                hero_snapshot = jsonb_build_object(
                  'current_location_id', current_location_id,
                  'current_scene_id', current_scene_id,
                  'last_session_id', last_session_id,
                  'snapshotted_at', to_jsonb(now())
                ),
                updated_at = now()
          WHERE player_id = $1
            AND status = 'active'
            AND NOT (player_id = $2 AND cartridge_id = $3)`,
        [sourcePlayerId, opts.playerId, opts.cartridgeId],
      );

      // 2) Read the most-recent player row so the launched run keeps
      //    the player's current location/scene/dialogue partner if
      //    they line up with the run we're resuming. On a first
      //    launch we fall back to the cartridge starting location
      //    (already resolved during preview).
      const existing = await loadExistingState(
        opts.playerId,
        opts.cartridgeId,
      );
      let nextLocationId: number | null = null;
      let nextSceneId: number | null = null;
      if (existing && existing.current_location_id != null) {
        nextLocationId = existing.current_location_id;
        nextSceneId = existing.current_scene_id;
      } else if (preview.startingLocationId != null) {
        nextLocationId = preview.startingLocationId;
      }

      // FEAT-HERO-CONTINUITY-2 — ensure the cartridge has its default
      // universe instance and stamp the link before the launch write.
      // Idempotent — `ensureDefaultForCartridge` no-ops when the row
      // already exists (migration 0129 backfilled every installed
      // cartridge, but explicit apply paths still call ensure too).
      const universe =
        await UniverseInstanceService.ensureDefaultForCartridge(
          opts.cartridgeId,
        );

      // 3) Upsert the (player, cartridge) row → status='active'. A
      //    first launch creates the row with a fresh playthrough_id;
      //    a resume keeps the existing playthrough_id and resets the
      //    `last_session_id` field so the GUI knows to mint a new
      //    session on the next /api/session call.
      const playthroughId = existing?.playthrough_id ?? randomUUID();
      const resetGeneration = existing?.reset_generation ?? 0;
      await query(
        `INSERT INTO hero_cartridge_states (
           player_id, cartridge_id, status,
           playthrough_id, reset_generation,
           current_location_id, current_scene_id,
           last_session_id, snapshot, compatibility_report,
           hero_snapshot, world_snapshot,
           universe_instance_id
         )
         VALUES (
           $1, $2, 'active',
           $3::uuid, $4,
           $5, $6,
           NULL, '{}'::jsonb, '{}'::jsonb,
           '{}'::jsonb, '{}'::jsonb,
           $7::uuid
         )
         ON CONFLICT (player_id, cartridge_id) DO UPDATE SET
           status = 'active',
           current_location_id = COALESCE($5, hero_cartridge_states.current_location_id),
           current_scene_id = COALESCE($6, hero_cartridge_states.current_scene_id),
           last_session_id = NULL,
           universe_instance_id = $7::uuid,
           updated_at = now()`,
        [
          opts.playerId,
          opts.cartridgeId,
          playthroughId,
          resetGeneration,
          nextLocationId,
          nextSceneId,
          universe.id,
        ],
      );

      // 4) Reflect the launch on the canonical `players` row so the
      //    gameplay turn loop reads the same location/scene the
      //    library says we just activated. Dialogue partner is
      //    cleared on launch — a continuation re-engages dialogue
      //    naturally on the next turn, and a hero switch should
      //    never inherit a stale partner from a different run.
      await query(
        `UPDATE players
            SET current_location_id = COALESCE($1, current_location_id),
                current_scene_id    = $2,
                dialogue_partner_id = NULL,
                last_seen           = now()
          WHERE entity_id = $3`,
        [nextLocationId, nextSceneId, opts.playerId],
      );

      const currentLocationName = await loadLocationName(nextLocationId);

      await syncGlobalCartridgeMeta(
        opts.cartridgeId,
        preview.startingLocationId,
      );

      // FEAT-HERO-CONTINUITY-4 — apply the carryover policy: snapshot
      // the departing roster, restore target-world locals on continue,
      // accept-or-suppress bonds per `cartridge_meta_scoped.
      // hero_continuity_policy`, materialize portable companion
      // projections, and record a `hero_continuity_events` row. The
      // helper runs inside this same `withTransaction()` block; any
      // throw rolls the launch back. We guard against helper faults
      // so a bad ledger row never blocks the launch contract itself.
      const sourceCartridgeId = await loadDepartingSourceCartridgeId(
        opts.playerId,
        opts.cartridgeId,
      );
      let continuityCarryover: ContinuityCarryoverSummary | null = null;
      try {
        continuityCarryover =
          await HeroContinuityCarryoverService.applyLaunchCarryover({
            playerId: opts.playerId,
            sourceCartridgeId,
            targetCartridgeId: opts.cartridgeId,
            targetUniverseInstanceId: universe.id,
            playthroughId,
            resetGeneration,
            mode:
              preview.mode === 'continue'
                ? 'launch_continue'
                : 'launch_first_spawn',
            // FEAT-HERO-CONTINUITY-4-FOLLOWUP — flag a same-active-world
            // relaunch so carryover keeps the live roster instead of
            // re-hydrating from a stale target `world_snapshot`. The
            // playthrough's snapshot-others step (above) does NOT
            // touch the target row, so `existing?.status === 'active'`
            // here means "hero was already in this world".
            targetAlreadyActive: existing?.status === 'active',
          });
      } catch (err) {
        // CATCH-WARN-OK: hero-continuity carryover helper. The
        // launch contract itself (hero_cartridge_states + players)
        // is already committed-bound to this transaction; a single
        // ledger fault should surface via telemetry while leaving
        // the launch working.
        console.warn(
          '[hero-continuity-4] launch carryover failed:',
          err instanceof Error ? err.message : err,
        );
      }

      telemetry.record({
        channel: 'gameplay',
        name: 'cartridge.playthrough.launched',
        playerId: opts.playerId,
        data: {
          cartridge_id: opts.cartridgeId,
          playthrough_id: playthroughId,
          reset_generation: resetGeneration,
          mode: preview.mode,
          source_player_id: sourcePlayerId,
          continuity_event_id: continuityCarryover?.continuityEventId ?? null,
          continuity_companions_traveling:
            continuityCarryover?.companions.filter(c => c.status === 'traveling')
              .length ?? 0,
        },
      });

      return {
        playerId: opts.playerId,
        publicId: preview.publicId,
        cartridgeId: opts.cartridgeId,
        playthroughId,
        resetGeneration,
        mode: preview.mode,
        currentLocationId: nextLocationId,
        currentLocationName,
        universeInstanceId: universe.id,
        continuityCarryover,
        clearClientCache: {
          keys: STALE_CLIENT_STORAGE_KEYS,
          playerPublicId: preview.publicId,
        },
      };
    });
  }

  /**
   * Start a fresh run for `(playerId, cartridgeId)` against the
   * already-installed content. This reuses the ready cartridge data
   * — it never re-runs import, compile, or apply. The hero respawns
   * at the cartridge's `starting_location_id`, dialogue partner is
   * cleared, and `reset_generation` is incremented so historical
   * telemetry can attribute events to the prior run.
   */
  static async newGame(opts: {
    playerId: number;
    cartridgeId: string;
    authenticatedPlayerId?: number | null;
  }): Promise<PlaythroughLaunchResult> {
    const preview = await CartridgePlaythroughService.preview({
      playerId: opts.playerId,
      cartridgeId: opts.cartridgeId,
    });
    if (preview.mode === 'repair_required') {
      throw new PlaythroughServiceError(
        'repair_required',
        `cannot start new game: blockers=${preview.blockers.join(',')}`,
      );
    }
    if (preview.startingLocationId == null) {
      throw new PlaythroughServiceError(
        'no_starting_location',
        `cartridge ${opts.cartridgeId} has no scoped starting_location_id`,
      );
    }
    return await withTransaction(async () => {
      // 1) Snapshot any other active row for the authenticated hero
      //    so a new game doesn't lose an unrelated cartridge's run.
      const sourcePlayerId =
        typeof opts.authenticatedPlayerId === 'number' &&
        opts.authenticatedPlayerId > 0
          ? opts.authenticatedPlayerId
          : opts.playerId;
      await query(
        `UPDATE hero_cartridge_states
            SET status = 'available',
                hero_snapshot = jsonb_build_object(
                  'current_location_id', current_location_id,
                  'current_scene_id', current_scene_id,
                  'last_session_id', last_session_id,
                  'snapshotted_at', to_jsonb(now())
                ),
                updated_at = now()
          WHERE player_id = $1
            AND status = 'active'
            AND NOT (player_id = $2 AND cartridge_id = $3)`,
        [sourcePlayerId, opts.playerId, opts.cartridgeId],
      );

      // FEAT-HERO-CONTINUITY-2 — stamp the universe-instance link
      // on new-game too. New-game preserves the hero's portable
      // continuity contracts (none in this pass) and resets only
      // playthrough-local state; the universe id reflects which
      // live world the run belongs to.
      const universe =
        await UniverseInstanceService.ensureDefaultForCartridge(
          opts.cartridgeId,
        );

      // 2) Reset the target row: fresh playthrough_id, bumped
      //    reset_generation, location reset to scoped starting
      //    location, last_session_id cleared. We deliberately do
      //    NOT delete the row (so cross-hero history survives) and
      //    do NOT delete other heroes' rows.
      const existing = await loadExistingState(
        opts.playerId,
        opts.cartridgeId,
      );
      const playthroughId = randomUUID();
      const resetGeneration = (existing?.reset_generation ?? 0) + 1;
      await query(
        `INSERT INTO hero_cartridge_states (
           player_id, cartridge_id, status,
           playthrough_id, reset_generation,
           current_location_id, current_scene_id,
           last_session_id, snapshot, compatibility_report,
           hero_snapshot, world_snapshot,
           universe_instance_id
         )
         VALUES (
           $1, $2, 'active',
           $3::uuid, $4,
           $5, NULL,
           NULL, '{}'::jsonb, '{}'::jsonb,
           '{}'::jsonb, '{}'::jsonb,
           $6::uuid
         )
         ON CONFLICT (player_id, cartridge_id) DO UPDATE SET
           status               = 'active',
           playthrough_id       = EXCLUDED.playthrough_id,
           reset_generation     = EXCLUDED.reset_generation,
           current_location_id  = EXCLUDED.current_location_id,
           current_scene_id     = NULL,
           last_session_id      = NULL,
           hero_snapshot        = '{}'::jsonb,
           world_snapshot       = '{}'::jsonb,
           universe_instance_id = $6::uuid,
           updated_at           = now()`,
        [
          opts.playerId,
          opts.cartridgeId,
          playthroughId,
          resetGeneration,
          preview.startingLocationId,
          universe.id,
        ],
      );

      // 3) Refresh `players` to the cartridge starting location, no
      //    dialogue partner, no scene.
      await query(
        `UPDATE players
            SET current_location_id = $1,
                current_scene_id    = NULL,
                dialogue_partner_id = NULL,
                last_seen           = now()
          WHERE entity_id = $2`,
        [preview.startingLocationId, opts.playerId],
      );
      await clearBootstrapIntroClaims(opts.playerId);

      const currentLocationName = await loadLocationName(
        preview.startingLocationId,
      );

      await syncGlobalCartridgeMeta(
        opts.cartridgeId,
        preview.startingLocationId,
      );

      // FEAT-HERO-CONTINUITY-4 — new-game records its own
      // continuity event (event_type='continuity:new_game') and
      // resets the live roster. The cartridge_id never changes
      // here (new-game is per-cartridge), so the "departing world"
      // is the same as the target world: the world-snapshot for
      // this cartridge gets refreshed before the bonds re-apply.
      const sourceCartridgeIdForNewGame = await loadDepartingSourceCartridgeId(
        opts.playerId,
        opts.cartridgeId,
      );
      let continuityCarryover: ContinuityCarryoverSummary | null = null;
      try {
        continuityCarryover =
          await HeroContinuityCarryoverService.applyLaunchCarryover({
            playerId: opts.playerId,
            sourceCartridgeId: sourceCartridgeIdForNewGame,
            targetCartridgeId: opts.cartridgeId,
            targetUniverseInstanceId: universe.id,
            playthroughId,
            resetGeneration,
            mode: 'new_game',
          });
      } catch (err) {
        // CATCH-WARN-OK: see launch() above.
        console.warn(
          '[hero-continuity-4] new-game carryover failed:',
          err instanceof Error ? err.message : err,
        );
      }

      telemetry.record({
        channel: 'gameplay',
        name: 'cartridge.playthrough.new_game',
        playerId: opts.playerId,
        data: {
          cartridge_id: opts.cartridgeId,
          playthrough_id: playthroughId,
          reset_generation: resetGeneration,
          source_player_id: sourcePlayerId,
          continuity_event_id: continuityCarryover?.continuityEventId ?? null,
          continuity_companions_traveling:
            continuityCarryover?.companions.filter(c => c.status === 'traveling')
              .length ?? 0,
        },
      });

      return {
        playerId: opts.playerId,
        publicId: preview.publicId,
        cartridgeId: opts.cartridgeId,
        playthroughId,
        resetGeneration,
        mode: 'first_spawn',
        currentLocationId: preview.startingLocationId,
        currentLocationName,
        universeInstanceId: universe.id,
        continuityCarryover,
        clearClientCache: {
          keys: STALE_CLIENT_STORAGE_KEYS,
          playerPublicId: preview.publicId,
        },
      };
    });
  }
}

/**
 * FEAT-HERO-CONTINUITY-4 — resolve the cartridge id of the previously
 * `status='active'` row for this hero, used as the "departing world"
 * when calling `applyLaunchCarryover`. The playthrough launch path
 * has already flipped that row to `available` immediately before;
 * carryover snapshots the departing roster into that row's
 * `world_snapshot`. Returns null when the hero has never had an
 * active row, when the prior active row matches the target, or
 * when none survives the available scan.
 */
async function loadDepartingSourceCartridgeId(
  playerId: number,
  targetCartridgeId: string,
): Promise<string | null> {
  const r = await query<{cartridge_id: string}>(
    `SELECT cartridge_id
       FROM hero_cartridge_states
      WHERE player_id = $1
        AND status = 'available'
        AND cartridge_id <> $2
      ORDER BY updated_at DESC
      LIMIT 1`,
    [playerId, targetCartridgeId],
  );
  return r.rows[0]?.cartridge_id ?? null;
}

async function clearBootstrapIntroClaims(playerId: number): Promise<void> {
  await query(
    `UPDATE players p
        SET metadata = COALESCE((
          SELECT jsonb_object_agg(e.key, e.value)
            FROM jsonb_each(COALESCE(p.metadata, '{}'::jsonb)) AS e(key, value)
           WHERE e.key NOT LIKE 'bootstrap_location_intro_rendered_v2_%'
        ), '{}'::jsonb)
      WHERE p.entity_id = $1`,
    [playerId],
  );
}
