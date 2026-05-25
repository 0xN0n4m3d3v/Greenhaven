-- 0055_turn_telemetry_presentation_slots.sql
-- Slot-level telemetry for Spec 86 post-turn presentation scheduling.

ALTER TABLE turn_telemetry
  ADD COLUMN IF NOT EXISTS slot_id BIGINT,
  ADD COLUMN IF NOT EXISTS slot_key TEXT,
  ADD COLUMN IF NOT EXISTS slot_status TEXT,
  ADD COLUMN IF NOT EXISTS deadline_ms INTEGER,
  ADD COLUMN IF NOT EXISTS expired BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_turn_telemetry_slot
  ON turn_telemetry(session_id, turn_id, slot_key, recorded_at DESC)
  WHERE slot_key IS NOT NULL;
