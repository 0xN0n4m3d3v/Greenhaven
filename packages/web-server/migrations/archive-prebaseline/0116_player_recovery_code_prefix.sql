-- DEEP-2 — indexed recovery-code prefix lookup.
--
-- Restore currently scans every `players.recovery_code_hash` and
-- runs bcrypt against each row (O(N) with a 10ms-ish hash cost). Once
-- the player table grows past a handful of rows that becomes a
-- denial-of-service surface on `/api/player/restore`. We narrow the
-- candidate set by storing the first four plaintext characters of the
-- recovery code (uppercased, drawn from the same 32-symbol base32
-- alphabet as the generator: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) and
-- indexing them. bcrypt remains the authoritative match — the prefix
-- only filters which hashes are even worth comparing.
--
-- Forward-only. We do NOT — and cannot — backfill legacy rows: the
-- plaintext recovery code is unrecoverable from the bcrypt hash. Rows
-- written before this migration keep `recovery_code_prefix = NULL`,
-- and `restoreByRecoveryCode` in `playerService.ts` deliberately
-- skips them rather than reintroducing an unbounded
-- `WHERE recovery_code_hash IS NOT NULL` scan. The anonymous-MVP
-- footprint is small enough that affected users (if any) can re-bind
-- by creating a fresh anonymous account.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS recovery_code_prefix TEXT;

ALTER TABLE players
  DROP CONSTRAINT IF EXISTS players_recovery_code_prefix_check;

ALTER TABLE players
  ADD CONSTRAINT players_recovery_code_prefix_check
  CHECK (
    recovery_code_prefix IS NULL
    OR recovery_code_prefix ~ '^[A-HJ-NP-Z2-9]{4}$'
  );

CREATE INDEX IF NOT EXISTS idx_players_recovery_code_prefix
  ON players(recovery_code_prefix)
  WHERE recovery_code_prefix IS NOT NULL;
