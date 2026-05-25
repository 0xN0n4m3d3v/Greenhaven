/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OPERATOR-HERO-CREATE-500 (2026-05-18) — `POST /api/heroes` real-PGlite
// regression. The reported operator failure was a generic
// `500 internal_error` from the Worlds & Heroes Create Hero entry
// point. The existing FEAT-CART-LIB-1 route test (cartridge
// LibraryRoutes.test.ts) covers the happy / 503 branches with mocked
// `createAnonymousPlayer`, but does NOT prove the route + service
// against real PGlite + the engine baseline + the
// `entities_cartridge_id_required_ck` CHECK constraint introduced in
// migration 0124.
//
// This file exercises the route through the real Hono app + the real
// `createAnonymousPlayer` against a pristine engine baseline DB. Only
// `issueCookie` is mocked, because cookie issuance is not part of the
// reported failure surface and the existing mocked test already pins
// its happy path. Coverage:
//
//   1. POST /api/heroes with no body on a clean baseline (no
//      cartridge_meta rows) → 200 + valid CreatedPlayer DTO.
//   2. POST /api/heroes with `{}` body → 200, default display name.
//   3. POST /api/heroes with camelCase `displayName` → 200, name used.
//   4. POST /api/heroes with snake_case `display_name` → 200, name used.
//   5. POST /api/heroes with Russian display name → 200, UTF-8 round-trip
//      preserved.
//   6. POST /api/heroes when global `cartridge_meta` has no
//      `cartridge_id` / `starting_location_id` keys → 200 (hero
//      creation is cartridge-neutral on a clean baseline).
//   7. GET /api/heroes after creating heroes → 200 + heroes envelope
//      that never serializes `recovery_code`, `recovery_code_hash`, or
//      `recovery_code_prefix`. (Security invariant: the one-time
//      recovery code is returned ONLY in the POST /heroes response.)
//   8. Multiple POST /api/heroes calls each return a distinct
//      `entity_id` + `public_id` (`createAnonymousPlayer` is
//      insert-only; never deletes / overwrites existing heroes).

import {Hono} from 'hono';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

const issueCookie = vi.fn().mockResolvedValue(undefined);
vi.mock('../../middleware/auth.js', () => ({
  authenticatedPlayerId: vi.fn().mockResolvedValue(null),
  issueCookie,
}));

let app: Hono;
let clearMetaCache: typeof import('../../cartridge.js').clearMetaCache;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  const {cartridgeLibraryRoutes} = await import('../../routes/cartridges.js');
  ({clearMetaCache} = await import('../../cartridge.js'));
  app = new Hono();
  app.route('/api', cartridgeLibraryRoutes);
}, 600_000);

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  issueCookie.mockClear();
  // Clean-baseline state per case — no cartridge defaults at all.
  await queryRows(
    `DELETE FROM cartridge_meta
      WHERE key IN ('cartridge_id',
                    'starting_location_id',
                    'starting_scene_id',
                    'default_class_id',
                    'currency_item_id',
                    'starting_currency_count')`,
  );
  clearMetaCache();
});

interface CreatedHeroBody {
  player: {
    entity_id: number;
    public_id: string;
    display_name: string;
    recovery_code: string;
    profile_created: boolean;
    current_xp: number;
    current_level: number;
    current_hp: number;
    max_hp: number;
    current_location_id: number | null;
    current_scene_id: number | null;
  };
  clearClientCache: {keys: string[]; playerPublicId: string};
}

async function postHeroes(body?: unknown): Promise<{
  status: number;
  body: CreatedHeroBody;
}> {
  const init: RequestInit = {method: 'POST'};
  if (body !== undefined) {
    init.headers = {'Content-Type': 'application/json'};
    init.body = JSON.stringify(body);
  }
  const res = await app.request('/api/heroes', init);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as CreatedHeroBody) : ({} as CreatedHeroBody),
  };
}

describe('POST /api/heroes — real PGlite regression (OPERATOR-HERO-CREATE-500)', () => {
  it('returns 200 + a valid CreatedPlayer DTO on a clean engine baseline (no body)', async () => {
    const {status, body} = await postHeroes();
    expect(status).toBe(200);
    expect(body.player.entity_id).toBeGreaterThan(0);
    expect(typeof body.player.public_id).toBe('string');
    expect(body.player.public_id.length).toBeGreaterThan(0);
    expect(typeof body.player.display_name).toBe('string');
    expect(body.player.display_name.length).toBeGreaterThan(0);
    expect(body.player.current_location_id).toBeNull();
    expect(body.player.current_scene_id).toBeNull();
    expect(body.clearClientCache.playerPublicId).toBe(body.player.public_id);
    expect(body.clearClientCache.keys).toContain('greenhaven.sessionId');
    expect(body.clearClientCache.keys).toContain('greenhaven.playerPublicId');
    expect(issueCookie).toHaveBeenCalledTimes(1);
    const [, cookiePlayerId] = issueCookie.mock.calls[0]!;
    expect(cookiePlayerId).toBe(body.player.entity_id);
  });

  it('returns 200 on an empty `{}` body', async () => {
    const {status, body} = await postHeroes({});
    expect(status).toBe(200);
    expect(body.player.entity_id).toBeGreaterThan(0);
    // No display_name supplied → default "Uncreated Player <prefix>"
    expect(body.player.display_name).toMatch(/^Uncreated Player /);
  });

  it('honours camelCase `displayName`', async () => {
    const {status, body} = await postHeroes({displayName: 'Alex'});
    expect(status).toBe(200);
    expect(body.player.display_name).toBe('Alex');
  });

  it('honours snake_case `display_name`', async () => {
    const {status, body} = await postHeroes({display_name: 'Snake'});
    expect(status).toBe(200);
    expect(body.player.display_name).toBe('Snake');
  });

  it('round-trips Cyrillic display names', async () => {
    const {status, body} = await postHeroes({displayName: 'Аркадий'});
    expect(status).toBe(200);
    expect(body.player.display_name).toBe('Аркадий');
  });

  it('does not crash when global cartridge_meta is fully empty (FEAT-ENGINE-BASELINE-6 soft defaults)', async () => {
    // beforeEach already deletes the defaults, so this case is the
    // load-bearing one. Re-asserts the soft-default contract: hero
    // creation is cartridge-neutral on a clean baseline and only the
    // cartridge launch / new-game flow assigns scoped location data.
    const {status, body} = await postHeroes({displayName: 'Cartridgeless'});
    expect(status).toBe(200);
    expect(body.player.current_location_id).toBeNull();
    expect(body.player.current_scene_id).toBeNull();
  });

  it('mints distinct (entity_id, public_id) for each call — never deletes or overwrites prior heroes', async () => {
    const a = await postHeroes({displayName: 'Hero A'});
    const b = await postHeroes({displayName: 'Hero B'});
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.player.entity_id).not.toBe(b.body.player.entity_id);
    expect(a.body.player.public_id).not.toBe(b.body.player.public_id);

    // GET /api/heroes lists both, no recovery_* fields in the serialized
    // wire payload.
    const listRes = await app.request('/api/heroes');
    expect(listRes.status).toBe(200);
    const text = await listRes.text();
    const listBody = JSON.parse(text) as {
      heroes: Array<{playerId: number; publicId: string; name: string}>;
    };
    const playerIds = listBody.heroes.map((h) => h.playerId);
    expect(playerIds).toContain(a.body.player.entity_id);
    expect(playerIds).toContain(b.body.player.entity_id);
    // SEC: list payload must never carry the one-time recovery
    // credentials. They were returned ONLY in the POST response above.
    expect(text).not.toContain('recovery_code');
    expect(text).not.toContain('recovery_code_hash');
    expect(text).not.toContain('recovery_code_prefix');
  });
});
