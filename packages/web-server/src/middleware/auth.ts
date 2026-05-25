/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// HTTP-only signed cookie auth. Cookie payload encodes
// `playerId.exp.jti` and the signature is HMAC-SHA256 over the
// same body using `AUTH_SECRET`. Routes read `c.var.playerId`
// (set by `requireAuth`), never body input.
//
// SEC-6 / DEEP-14 — every issued cookie also has a server-side
// row in `session_tokens` keyed by `jti`. A cookie is only
// considered valid when:
//   * the signature matches (rules out HMAC forgery),
//   * the embedded `exp` is in the future,
//   * `isSessionTokenActive(jti, playerId)` returns `true`
//     (rules out revoked / unknown tokens).
// Pre-SEC-6 cookies (3-part `playerId.exp.sig`) are rejected as
// invalid sessions rather than silently bypassing the
// revocation check — there is no `jti` to retroactively mint
// against a stale value.

import {createHmac, timingSafeEqual} from 'node:crypto';
import type {Context, MiddlewareHandler} from 'hono';
import {getCookie, setCookie} from 'hono/cookie';
import {
  createSessionToken,
  isSessionTokenActive,
  revokeSessionToken,
} from '../auth/sessionTokenStore.js';
import {config} from '../config.js';

const COOKIE_NAME = 'gh_player';
const COOKIE_TTL_DAYS = 30;

interface CookiePayload {
  playerId: number;
  exp: number; // unix seconds
  jti: string;
}

export function authSecret(): string {
  const s = config().authSecret;
  if (!s || s.length < 32) {
    throw new Error(
      "AUTH_SECRET env var required, min 32 chars. Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`",
    );
  }
  return s;
}

/**
 * Sign the 3-tuple `(playerId, exp, jti)` with HMAC-SHA256 and
 * return the 4-part cookie value. The same body is verified at
 * read time; the `jti` is opaque to the signature step and is
 * looked up server-side via `isSessionTokenActive` after the
 * HMAC matches.
 */
export function signCookie(payload: CookiePayload): string {
  const body = `${payload.playerId}.${payload.exp}.${payload.jti}`;
  const sig = createHmac('sha256', authSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function shouldUseSecureCookie(): boolean {
  const override = config().authCookieSecure;
  if (override === 'on') return true;
  if (override === 'off') return false;
  return config().nodeEnv === 'production' && !config().isDesktop;
}

/**
 * Verify the cookie's structure + signature + expiry, then
 * confirm the embedded `jti` is still active server-side. Async
 * because the revocation check requires a database read.
 *
 * Returns `null` for any malformed / expired / unknown / revoked
 * cookie. Pre-SEC-6 cookies (3-part `playerId.exp.sig`) are
 * rejected here — they have no `jti` and therefore cannot pass
 * the revocation check.
 */
export async function verifyCookie(
  value: string,
): Promise<CookiePayload | null> {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [pidStr, expStr, jti, sig] = parts as [string, string, string, string];
  const playerId = Number(pidStr);
  const exp = Number(expStr);
  if (!Number.isFinite(playerId) || !Number.isFinite(exp)) return null;
  if (!jti) return null;
  const expected = createHmac('sha256', authSecret())
    .update(`${pidStr}.${expStr}.${jti}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 > exp) return null;
  if (!(await isSessionTokenActive(jti, playerId))) return null;
  return {playerId, exp, jti};
}

/**
 * Mint a fresh `session_tokens` row, then sign + set the cookie
 * against that `jti`. Async because the token row must be in the
 * database before the cookie value is handed to the client (so a
 * race between issue + next request can't see a "valid HMAC but
 * unknown jti" combination).
 */
export async function issueCookie(
  c: Context,
  playerId: number,
): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_DAYS * 86400;
  const token = await createSessionToken(playerId);
  const value = signCookie({playerId, exp, jti: token.jti});
  setCookie(c, COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: shouldUseSecureCookie(),
    maxAge: COOKIE_TTL_DAYS * 86400,
    path: '/',
  });
}

/**
 * Revoke the current cookie's `jti` server-side (so the value
 * cannot authenticate again even if it leaked) and expire the
 * browser cookie. Async because the revocation runs a SQL
 * `UPDATE`. The cookie is still expired client-side even when no
 * valid token row exists — that path is the legitimate
 * "stale 3-part cookie" / "tampered cookie" cleanup.
 */
export async function clearAuthCookie(c: Context): Promise<void> {
  const cookieValue = getCookie(c, COOKIE_NAME);
  if (cookieValue) {
    const parts = cookieValue.split('.');
    if (parts.length === 4) {
      const [pidStr, expStr, jti, sig] = parts as [
        string,
        string,
        string,
        string,
      ];
      const expected = createHmac('sha256', authSecret())
        .update(`${pidStr}.${expStr}.${jti}`)
        .digest('base64url');
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        await revokeSessionToken(jti);
      }
    }
  }
  setCookie(c, COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: shouldUseSecureCookie(),
    maxAge: 0,
    path: '/',
  });
}

/**
 * Resolve the authenticated player id from the request's cookie,
 * or `null` if any check fails (missing cookie, malformed
 * payload, bad signature, expired, unknown / revoked `jti`).
 * Async because of the server-side revocation lookup.
 */
export async function authenticatedPlayerId(
  c: Context,
): Promise<number | null> {
  const cookieValue = getCookie(c, COOKIE_NAME);
  if (!cookieValue) return null;
  const payload = await verifyCookie(cookieValue);
  return payload?.playerId ?? null;
}

/**
 * Middleware that requires an authenticated player. Sets c.var.playerId.
 *
 * Dev escape hatch: `AUTH_DISABLED=1` short-circuits to `next()` without
 * setting `playerId` — handlers must then fall back to body/query for
 * the value. The combination `AUTH_DISABLED=1` + `NODE_ENV=production`
 * is rejected at config load time by `enforceFatalConfigGuards` (SEC-7
 * / DEEP-14), so this branch can never see a misconfigured production
 * deploy; the runtime warning that used to live here has been removed.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (config().authDisabled) {
    return next();
  }
  const cookieValue = getCookie(c, COOKIE_NAME);
  if (!cookieValue) return c.json({error: 'unauthenticated'}, 401);
  const payload = await verifyCookie(cookieValue);
  if (!payload) return c.json({error: 'invalid_session'}, 401);
  c.set('playerId', payload.playerId);
  return next();
};
