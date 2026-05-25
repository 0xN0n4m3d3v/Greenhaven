-- 0053_gui_event_outbox.sql - durable GUI event ordering/replay metadata.

CREATE TABLE IF NOT EXISTS gui_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id BIGINT REFERENCES entities(id) ON DELETE SET NULL,
  turn_id TEXT,
  turn_index INTEGER,
  lane TEXT NOT NULL DEFAULT 'post_response',
  phase TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('pending', 'ready', 'released', 'failed', 'dead')),
  message_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,
  release_after_message_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,
  dedupe_key TEXT,
  display_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ready_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gui_events_session_id
  ON gui_events(session_id, id);

CREATE INDEX IF NOT EXISTS idx_gui_events_turn
  ON gui_events(session_id, turn_id, id);

CREATE INDEX IF NOT EXISTS idx_gui_events_message
  ON gui_events(message_id, id);

CREATE INDEX IF NOT EXISTS idx_gui_events_dispatch
  ON gui_events(session_id, status, turn_index, lane, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gui_events_dedupe
  ON gui_events(session_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
