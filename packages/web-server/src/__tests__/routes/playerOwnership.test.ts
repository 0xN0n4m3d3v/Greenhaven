/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-1 / SEC-2 / DEEP-4 / DEEP-5 / DEEP-6 — central player ownership
// gate. These tests build a focused Hono fixture that mirrors the
// production mount order in `src/index.ts` (ownership middleware
// runs BEFORE the route handler), then drive the contract through
// the full Hono request/response path.
//
// Cookie signing reuses the real `signCookie` / `verifyCookie`
// pair, but `config()` is mocked so each test can toggle
// `authDisabled` without touching the cached global. `authSecret`
// is fixed to a stable 48-char string so the signed cookies in
// the test verify cleanly.

import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const configMock = vi.hoisted(() => ({
  authDisabled: false as boolean,
  authSecret: 'a'.repeat(48),
  authCookieSecure: 'off' as 'auto' | 'on' | 'off',
  isDesktop: false as boolean,
  nodeEnv: 'test' as 'development' | 'production' | 'test',
}));

vi.mock('../../config.js', () => ({
  config: () => configMock,
}));

// SEC-6 — the cookie now embeds a `jti` that auth verifies against
// `session_tokens`. Test cookies mint a deterministic jti and the
// store mock returns `active = true` so verification passes
// without booting a real DB. A test that wants to assert the
// revoked-cookie path can flip `tokenStoreMock.activeJtis` to an
// empty set for the duration of the case.
const tokenStoreMock = vi.hoisted(() => {
  const activeJtis = new Set<string>([
    '00000000-0000-4000-8000-000000000001',
  ]);
  return {
    activeJtis,
    isSessionTokenActive: async (jti: string, _playerId: number) =>
      activeJtis.has(jti),
    createSessionToken: async (playerId: number) => ({
      jti: '00000000-0000-4000-8000-000000000001',
      playerId,
      issuedAt: new Date(),
    }),
    revokeSessionToken: async (jti: string) => {
      activeJtis.delete(jti);
    },
  };
});

vi.mock('../../auth/sessionTokenStore.js', () => tokenStoreMock);

import {signCookie} from '../../middleware/auth.js';
import {ownsPlayer} from '../../middleware/ownsPlayer.js';
import {requireAuth} from '../../middleware/auth.js';

function authCookieHeader(playerId: number): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jti = '00000000-0000-4000-8000-000000000001';
  return `gh_player=${signCookie({playerId, exp, jti})}`;
}

// Mirrors the production mount: ownership middleware on `/:id/saves`
// + `/:id/saves/*`, with a handler that just echoes `c.var.playerId`
// when the request reaches it. The handler being reached is the
// strongest possible "guard didn't block" signal.
function makeOwnedApp(): Hono {
  const app = new Hono();
  app.use('/api/player/:id/saves', ownsPlayer());
  app.use('/api/player/:id/saves/*', ownsPlayer());
  app.get('/api/player/:id/saves', (c) =>
    c.json({ok: true, var_playerId: (c.var as {playerId?: number}).playerId}),
  );
  app.post('/api/player/:id/saves/:slotId/restore', (c) =>
    c.json({ok: true, slot_id: c.req.param('slotId')}),
  );
  app.delete('/api/player/:id/saves/:slotId', (c) =>
    c.json({ok: true, slot_id: c.req.param('slotId')}),
  );
  // Character stats/skills mirror — proves the same guard works at
  // a different URL shape, including a non-`/api/player` prefix.
  app.use('/api/character/:id/stats', ownsPlayer());
  app.use('/api/character/:id/skills', ownsPlayer());
  app.post('/api/character/:id/stats', (c) => c.json({ok: true}));
  app.post('/api/character/:id/skills', (c) => c.json({ok: true}));
  // LLM-costing assist endpoints — guarded by `requireAuth`, NOT
  // ownership (no player id in URL).
  app.use('/api/character/sheet/synthesize', requireAuth);
  app.post('/api/character/sheet/synthesize', (c) => c.json({ok: true}));
  // A non-protected control route — proves the guard doesn't bleed
  // into adjacent surfaces.
  app.get('/api/player/me', (c) => c.json({ok: true, public: true}));
  return app;
}

describe('ownsPlayer middleware (SEC-1 / SEC-2 / DEEP-4 / DEEP-5 / DEEP-6)', () => {
  beforeEach(() => {
    configMock.authDisabled = false;
  });

  it('returns 401 unauthenticated when no auth cookie is present', async () => {
    const app = makeOwnedApp();
    const res = await app.request('http://127.0.0.1:7777/api/player/42/saves', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({error: 'unauthenticated'});
  });

  it('returns 401 unauthenticated when the auth cookie is malformed', async () => {
    const app = makeOwnedApp();
    const res = await app.request('http://127.0.0.1:7777/api/player/42/saves', {
      method: 'GET',
      headers: {cookie: 'gh_player=not-a-real-signed-token'},
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({error: 'unauthenticated'});
  });

  it('returns 403 player_mismatch when the cookie belongs to a different player', async () => {
    const app = makeOwnedApp();
    const res = await app.request('http://127.0.0.1:7777/api/player/42/saves', {
      method: 'GET',
      headers: {cookie: authCookieHeader(7)},
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'player_mismatch'});
  });

  it('passes through when the cookie player id matches the route id', async () => {
    const app = makeOwnedApp();
    const res = await app.request('http://127.0.0.1:7777/api/player/42/saves', {
      method: 'GET',
      headers: {cookie: authCookieHeader(42)},
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true, var_playerId: 42});
  });

  it('protects the sub-path POST `/:id/saves/:slotId/restore`', async () => {
    const app = makeOwnedApp();
    // No cookie → 401 even on the restore endpoint.
    const unauth = await app.request(
      'http://127.0.0.1:7777/api/player/42/saves/9/restore',
      {method: 'POST'},
    );
    expect(unauth.status).toBe(401);

    // Wrong cookie → 403.
    const mismatched = await app.request(
      'http://127.0.0.1:7777/api/player/42/saves/9/restore',
      {method: 'POST', headers: {cookie: authCookieHeader(7)}},
    );
    expect(mismatched.status).toBe(403);
    expect(await mismatched.json()).toEqual({error: 'player_mismatch'});

    // Right cookie → handler runs.
    const ok = await app.request(
      'http://127.0.0.1:7777/api/player/42/saves/9/restore',
      {method: 'POST', headers: {cookie: authCookieHeader(42)}},
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ok: true, slot_id: '9'});
  });

  it('protects DELETE `/:id/saves/:slotId`', async () => {
    const app = makeOwnedApp();
    const unauth = await app.request(
      'http://127.0.0.1:7777/api/player/42/saves/9',
      {method: 'DELETE'},
    );
    expect(unauth.status).toBe(401);
    const mismatched = await app.request(
      'http://127.0.0.1:7777/api/player/42/saves/9',
      {method: 'DELETE', headers: {cookie: authCookieHeader(7)}},
    );
    expect(mismatched.status).toBe(403);
  });

  it('returns 400 invalid player id on non-numeric or non-positive params', async () => {
    const app = makeOwnedApp();
    // `sheet` is the canonical literal that would collide with
    // `:id` matching. Belt-and-suspenders for the SEC-1 mount-order
    // pattern: even if a future mistake routes `:id` past a literal,
    // a non-numeric id fails the param check before any cookie work.
    const res = await app.request(
      'http://127.0.0.1:7777/api/player/sheet/saves',
      {method: 'GET', headers: {cookie: authCookieHeader(42)}},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({error: 'invalid player id'});

    const zero = await app.request('http://127.0.0.1:7777/api/player/0/saves', {
      method: 'GET',
      headers: {cookie: authCookieHeader(42)},
    });
    expect(zero.status).toBe(400);

    const negative = await app.request(
      'http://127.0.0.1:7777/api/player/-1/saves',
      {method: 'GET', headers: {cookie: authCookieHeader(42)}},
    );
    expect(negative.status).toBe(400);
  });

  it('bypasses entirely when AUTH_DISABLED=1 (dev/test escape hatch preserved)', async () => {
    configMock.authDisabled = true;
    const app = makeOwnedApp();
    // No cookie at all → still reaches the handler.
    const res = await app.request('http://127.0.0.1:7777/api/player/42/saves', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    // The middleware seeds `c.var.playerId` from the route param
    // so handlers that read the var still work in the bypass case.
    expect(await res.json()).toEqual({ok: true, var_playerId: 42});
  });

  it('does not intercept the public `/api/player/me` control route', async () => {
    const app = makeOwnedApp();
    const res = await app.request('http://127.0.0.1:7777/api/player/me', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true, public: true});
  });
});

describe('ownsPlayer middleware on character mutation routes (SEC-1)', () => {
  beforeEach(() => {
    configMock.authDisabled = false;
  });

  it('guards `/api/character/:id/stats` with 401 / 403 / pass-through', async () => {
    const app = makeOwnedApp();
    const unauth = await app.request(
      'http://127.0.0.1:7777/api/character/42/stats',
      {method: 'POST'},
    );
    expect(unauth.status).toBe(401);

    const mismatched = await app.request(
      'http://127.0.0.1:7777/api/character/42/stats',
      {method: 'POST', headers: {cookie: authCookieHeader(7)}},
    );
    expect(mismatched.status).toBe(403);

    const ok = await app.request(
      'http://127.0.0.1:7777/api/character/42/stats',
      {method: 'POST', headers: {cookie: authCookieHeader(42)}},
    );
    expect(ok.status).toBe(200);
  });

  it('guards `/api/character/:id/skills` with 401 / 403 / pass-through', async () => {
    const app = makeOwnedApp();
    const unauth = await app.request(
      'http://127.0.0.1:7777/api/character/42/skills',
      {method: 'POST'},
    );
    expect(unauth.status).toBe(401);

    const mismatched = await app.request(
      'http://127.0.0.1:7777/api/character/42/skills',
      {method: 'POST', headers: {cookie: authCookieHeader(7)}},
    );
    expect(mismatched.status).toBe(403);

    const ok = await app.request(
      'http://127.0.0.1:7777/api/character/42/skills',
      {method: 'POST', headers: {cookie: authCookieHeader(42)}},
    );
    expect(ok.status).toBe(200);
  });

  it('does NOT treat the literal `sheet` in `/api/character/sheet/synthesize` as an id', async () => {
    const app = makeOwnedApp();
    // The synth endpoint is protected by `requireAuth`, not the
    // ownership guard. Without a cookie it should be 401 (auth),
    // not 400 invalid id (which is what a `/:id/*` wildcard would
    // emit when `sheet` parses to NaN).
    const noAuth = await app.request(
      'http://127.0.0.1:7777/api/character/sheet/synthesize',
      {method: 'POST'},
    );
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({error: 'unauthenticated'});

    // With ANY valid cookie (the synth endpoint has no per-player
    // ownership), it should pass.
    const ok = await app.request(
      'http://127.0.0.1:7777/api/character/sheet/synthesize',
      {method: 'POST', headers: {cookie: authCookieHeader(7)}},
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ok: true});
  });
});
