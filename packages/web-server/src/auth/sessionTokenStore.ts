/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-6 — server-side store for `gh_player` session tokens.
//
// Before SEC-6, `clearAuthCookie()` only expired the browser
// cookie; a captured `playerId.exp.sig` HMAC would keep
// authenticating until its 30-day TTL ran out. The
// `session_tokens` table introduced by migration 0118 gives
// each issued cookie a server-side row keyed by `jti` (a v4
// UUID minted at issuance time). Revocation is a single
// `UPDATE session_tokens SET revoked_at = now() WHERE jti = $1`
// and is final.
//
// This module is the only sanctioned path through that table.
// Auth helpers in `middleware/auth.ts` consume the
// `createSessionToken` / `isSessionTokenActive` /
// `revokeSessionToken` triple; tests mock this module so they
// can mint tokens without booting a real database.

import {randomUUID} from 'node:crypto';
import {query} from '../db.js';

export interface SessionTokenRecord {
  jti: string;
  playerId: number;
  issuedAt: Date;
}

/**
 * Insert a fresh non-revoked token row for the given player and
 * return the minted `jti` plus the canonical issued-at instant.
 * Generates the `jti` in-process via `crypto.randomUUID()` so the
 * migration does not need the `pgcrypto` / `uuid-ossp` extension.
 */
export async function createSessionToken(
  playerId: number,
): Promise<SessionTokenRecord> {
  const jti = randomUUID();
  const result = await query<{issued_at: string}>(
    `INSERT INTO session_tokens (jti, player_id)
     VALUES ($1, $2)
     RETURNING issued_at::text AS issued_at`,
    [jti, playerId],
  );
  const issuedAtRaw = result.rows[0]?.issued_at;
  const issuedAt = issuedAtRaw ? new Date(issuedAtRaw) : new Date();
  return {jti, playerId, issuedAt};
}

/**
 * Returns `true` when the token row exists, has not been
 * revoked, and binds to the supplied `playerId`. The `playerId`
 * cross-check protects against a forged HMAC that happens to
 * embed a real `jti` from a different player (defense in depth —
 * the HMAC alone already makes this combinatorially infeasible).
 */
export async function isSessionTokenActive(
  jti: string,
  playerId: number,
): Promise<boolean> {
  if (!isValidUuid(jti)) return false;
  const result = await query<{ok: number}>(
    `SELECT 1 AS ok
       FROM session_tokens
      WHERE jti = $1
        AND player_id = $2
        AND revoked_at IS NULL`,
    [jti, playerId],
  );
  return result.rows.length > 0;
}

/**
 * Marks the token revoked. Idempotent: a second call against an
 * already-revoked or unknown `jti` is a no-op (preserves the
 * `clearAuthCookie()` contract where the cookie is always
 * expired client-side, even if the server-side row is missing or
 * already revoked).
 */
export async function revokeSessionToken(jti: string): Promise<void> {
  if (!isValidUuid(jti)) return;
  await query(
    `UPDATE session_tokens
        SET revoked_at = now()
      WHERE jti = $1
        AND revoked_at IS NULL`,
    [jti],
  );
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_V4_RE.test(value);
}
