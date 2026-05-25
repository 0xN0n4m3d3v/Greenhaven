-- 0014_player_status.sql — combat status flags on the player.
--
-- Mirrors the NPC convention from 0013 (stunned runtime field) but
-- on a column on `players` for tighter typing. Future status effects
-- (prone, poisoned, frightened) can land as additional columns OR
-- migrate to a single JSONB `status_effects` blob — keep it as a
-- bool column for now since `stunned` is the only one combat reads.
--
-- Combat resolution checks this BEFORE Phase 1 (player swing).
-- Stunned → player skips their action, the flag auto-clears at the
-- end of the round so it lasts exactly one round.

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS is_stunned BOOLEAN NOT NULL DEFAULT false;
