-- SEC-6 — server-side auth session token revocation.
--
-- Before SEC-6 the `gh_player` cookie was a bearer-only signed
-- envelope (`playerId.exp.sig`, HMAC-SHA256 with `AUTH_SECRET`).
-- Verification was a stateless string compare against the HMAC:
-- the server had no way to mark a stolen / leaked cookie invalid
-- before its 30-day TTL expired, and `clearAuthCookie()` only
-- expired the browser cookie — anyone who had captured the value
-- could still authenticate until the TTL ran out.
--
-- The new contract gives each issued cookie a server-side row
-- ("jti", JWT-style identifier) here, and every authentication
-- read joins through it. Revocation is now a single
-- `UPDATE session_tokens SET revoked_at = now() WHERE jti = $1`
-- and is final: the same cookie value cannot be re-used after
-- logout / reset / suspected leak.
--
-- Forward-only. Pre-SEC-6 cookies (3-part `playerId.exp.sig`)
-- are intentionally rejected by the new auth verifier rather
-- than backfilled: there is no `jti` to retroactively mint
-- against a stale cookie, and the anonymous-MVP footprint is
-- small enough that affected users simply re-issue by hitting
-- the bootstrap signup again.

CREATE TABLE IF NOT EXISTS session_tokens (
  jti UUID PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_tokens_player_id
  ON session_tokens(player_id);

CREATE INDEX IF NOT EXISTS idx_session_tokens_active
  ON session_tokens(jti)
  WHERE revoked_at IS NULL;
