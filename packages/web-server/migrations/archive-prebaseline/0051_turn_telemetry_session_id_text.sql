-- 0051_turn_telemetry_session_id_text.sql
--
-- Align telemetry with the runtime session contract. sessions.id,
-- chat_messages.session_id, and tool_invocations.session_id are TEXT;
-- support fixtures and imported saves may use non-UUID opaque ids.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'turn_telemetry'
       AND column_name = 'session_id'
       AND data_type <> 'text'
  ) THEN
    ALTER TABLE turn_telemetry
      ALTER COLUMN session_id TYPE TEXT
      USING session_id::text;
  END IF;
END $$;
