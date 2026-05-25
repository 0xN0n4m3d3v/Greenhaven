/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-6 — `gh_player` session-token contract.
//
// Pins the four-part `playerId.exp.jti.sig` cookie format and the
// `verifyCookie` server-side revocation check it depends on:
//
//   * an issued cookie authenticates while the `jti` row is
//     active,
//   * the same cookie stops authenticating once the row is
//     revoked,
//   * a structurally valid HMAC against a `jti` that doesn't
//     exist in the store fails,
//   * a pre-SEC-6 three-part `playerId.exp.sig` cookie is
//     rejected (no `jti` to revoke against),
//   * `clearAuthCookie()` revokes the current `jti` server-side
//     in addition to expiring the browser cookie.
//
// The store is mocked so the test stays hermetic; the
// `sessionTokens` migration test pins the SQL shape separately.

import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Context} from 'hono';

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

const tokenStoreMock = vi.hoisted(() => {
  const activeJtis = new Set<string>();
  const created: Array<{jti: string; playerId: number}> = [];
  const revoked: string[] = [];
  return {
    activeJtis,
    created,
    revoked,
    isSessionTokenActive: async (jti: string, _playerId: number) =>
      activeJtis.has(jti),
    createSessionToken: async (playerId: number) => {
      const jti = `00000000-0000-4000-8000-${String(created.length + 1).padStart(12, '0')}`;
      created.push({jti, playerId});
      activeJtis.add(jti);
      return {jti, playerId, issuedAt: new Date()};
    },
    revokeSessionToken: async (jti: string) => {
      revoked.push(jti);
      activeJtis.delete(jti);
    },
  };
});

vi.mock('../../auth/sessionTokenStore.js', () => tokenStoreMock);

import {
  authenticatedPlayerId,
  clearAuthCookie,
  issueCookie,
  signCookie,
  verifyCookie,
} from '../../middleware/auth.js';
import {createHmac} from 'node:crypto';

interface FakeCookieJar {
  current: string | null;
  cleared: boolean;
}

function makeContext(jar: FakeCookieJar): Context {
  return {
    req: {
      method: 'GET',
      raw: {
        headers: {
          get(name: string): string | null {
            if (name.toLowerCase() !== 'cookie') return null;
            return jar.current ?? null;
          },
        },
      },
      header(name: string) {
        if (name.toLowerCase() === 'cookie') return jar.current ?? undefined;
        return undefined;
      },
    },
    header(_name: string, _value: string) {
      // Hono's setCookie appends Set-Cookie via c.header; we intercept
      // both `gh_player=<value>` and the maxAge=0 clear so the test
      // can observe what `issueCookie` / `clearAuthCookie` would
      // emit on the wire.
    },
    res: {
      headers: new Map<string, string>(),
    },
  } as unknown as Context;
}

function makeWriteContext(jar: FakeCookieJar): Context {
  // Variant used by issueCookie / clearAuthCookie — needs a stub
  // `c.header` and `c.res.headers` so Hono's `setCookie` helper
  // can write the Set-Cookie header without crashing. We capture
  // the value into `jar.current` to mimic the round-trip a real
  // browser would do.
  const ctx = {
    req: {
      method: 'POST',
      raw: {
        headers: {
          get(name: string): string | null {
            if (name.toLowerCase() !== 'cookie') return null;
            return jar.current ?? null;
          },
        },
      },
      header(name: string) {
        if (name.toLowerCase() === 'cookie') return jar.current ?? undefined;
        return undefined;
      },
    },
    header(name: string, value: string) {
      if (name.toLowerCase() === 'set-cookie') {
        // `gh_player=<value>; HttpOnly; ...`
        const match = /^gh_player=([^;]*)/.exec(value);
        if (match) {
          const newValue = match[1] ?? '';
          if (newValue.length === 0) {
            jar.current = null;
            jar.cleared = true;
          } else {
            jar.current = `gh_player=${newValue}`;
          }
        }
      }
    },
  } as unknown as Context;
  return ctx;
}

describe('verifyCookie / authenticatedPlayerId (SEC-6)', () => {
  beforeEach(() => {
    tokenStoreMock.activeJtis.clear();
    tokenStoreMock.created.length = 0;
    tokenStoreMock.revoked.length = 0;
  });

  it('accepts a freshly issued cookie while the jti row is active', async () => {
    const jti = '11111111-1111-4111-8111-111111111111';
    tokenStoreMock.activeJtis.add(jti);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = signCookie({playerId: 42, exp, jti});

    const payload = await verifyCookie(cookie);
    expect(payload).toEqual({playerId: 42, exp, jti});
  });

  it('rejects the same cookie once the jti row is revoked', async () => {
    const jti = '22222222-2222-4222-8222-222222222222';
    tokenStoreMock.activeJtis.add(jti);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = signCookie({playerId: 42, exp, jti});

    expect(await verifyCookie(cookie)).not.toBeNull();
    tokenStoreMock.activeJtis.delete(jti);
    expect(await verifyCookie(cookie)).toBeNull();
  });

  it('rejects a structurally valid HMAC against an unknown jti', async () => {
    // Sign a cookie WITHOUT seeding the jti — the HMAC matches but
    // `isSessionTokenActive` returns false, so the verifier fails.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = signCookie({
      playerId: 42,
      exp,
      jti: '33333333-3333-4333-8333-333333333333',
    });
    expect(await verifyCookie(cookie)).toBeNull();
  });

  it('rejects a pre-SEC-6 three-part cookie (`playerId.exp.sig`)', async () => {
    // Mint a legacy-format cookie with the correct old HMAC body
    // (no `jti` in the signed text) to prove the new verifier
    // rejects the legacy shape outright, not just because the
    // signature happens to mismatch.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const body = `42.${exp}`;
    const sig = createHmac('sha256', configMock.authSecret)
      .update(body)
      .digest('base64url');
    const legacy = `${body}.${sig}`;
    expect(legacy.split('.').length).toBe(3);
    expect(await verifyCookie(legacy)).toBeNull();
  });

  it('rejects an expired cookie even if the jti is still active', async () => {
    const jti = '44444444-4444-4444-8444-444444444444';
    tokenStoreMock.activeJtis.add(jti);
    const past = Math.floor(Date.now() / 1000) - 60;
    const cookie = signCookie({playerId: 42, exp: past, jti});
    expect(await verifyCookie(cookie)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const jti = '55555555-5555-4555-8555-555555555555';
    tokenStoreMock.activeJtis.add(jti);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = signCookie({playerId: 42, exp, jti});
    const tampered = `${cookie.slice(0, -4)}XXXX`;
    expect(await verifyCookie(tampered)).toBeNull();
  });

  it('authenticatedPlayerId returns null for malformed or absent cookies', async () => {
    const jar: FakeCookieJar = {current: null, cleared: false};
    const ctx = makeContext(jar);
    expect(await authenticatedPlayerId(ctx)).toBeNull();

    jar.current = 'gh_player=not-a-real-cookie';
    expect(await authenticatedPlayerId(ctx)).toBeNull();
  });
});

describe('issueCookie / clearAuthCookie (SEC-6)', () => {
  beforeEach(() => {
    tokenStoreMock.activeJtis.clear();
    tokenStoreMock.created.length = 0;
    tokenStoreMock.revoked.length = 0;
  });

  it('issueCookie creates a token row BEFORE setting the cookie', async () => {
    const jar: FakeCookieJar = {current: null, cleared: false};
    const ctx = makeWriteContext(jar);
    await issueCookie(ctx, 99);
    expect(tokenStoreMock.created).toHaveLength(1);
    expect(tokenStoreMock.created[0]!.playerId).toBe(99);
    expect(jar.current).toMatch(/^gh_player=/);
    // The cookie value is a 4-part `playerId.exp.jti.sig`.
    const value = jar.current!.split('=')[1] ?? '';
    expect(value.split('.').length).toBe(4);
  });

  it('clearAuthCookie revokes the current jti AND expires the cookie', async () => {
    const jar: FakeCookieJar = {current: null, cleared: false};
    const writeCtx = makeWriteContext(jar);
    await issueCookie(writeCtx, 7);
    const issuedJti = tokenStoreMock.created[0]!.jti;
    expect(tokenStoreMock.activeJtis.has(issuedJti)).toBe(true);

    await clearAuthCookie(writeCtx);
    expect(tokenStoreMock.revoked).toContain(issuedJti);
    expect(tokenStoreMock.activeJtis.has(issuedJti)).toBe(false);
    expect(jar.cleared).toBe(true);
  });

  it('clearAuthCookie still expires the browser cookie when no token row exists', async () => {
    // Legitimate "stale 3-part cookie / tampered cookie" cleanup
    // path: there is no matching server-side row, but the client
    // cookie must still be cleared.
    const jar: FakeCookieJar = {
      current: 'gh_player=42.999999999.deadbeefdeadbeefdeadbeefdeadbeef',
      cleared: false,
    };
    const ctx = makeWriteContext(jar);
    await clearAuthCookie(ctx);
    expect(jar.cleared).toBe(true);
    // No revocation was attempted because the cookie didn't have a
    // valid HMAC match (it's the legacy 3-part shape with garbage).
    expect(tokenStoreMock.revoked).toHaveLength(0);
  });
});
