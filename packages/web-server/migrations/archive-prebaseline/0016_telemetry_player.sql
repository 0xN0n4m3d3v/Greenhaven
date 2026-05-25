-- 0016_telemetry_player.sql — attribute telemetry to players for usage admin.
--
-- Spec 05 introduced `turn_telemetry` without a player_id column.
-- Spec 13's per-player usage endpoint needs that attribution. Existing
-- rows stay NULL; new rows from turnRunnerV2 record the player.

ALTER TABLE turn_telemetry ADD COLUMN IF NOT EXISTS player_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_turn_telemetry_player_recorded
  ON turn_telemetry(player_id, recorded_at DESC);
