-- Spec 83: durable per-session input queue.
--
-- Player text waits here while an active turn or presentation barrier
-- owns the visible transcript. It is not copied into chat_messages
-- until the queued row is promoted and startTurnV2 begins.

CREATE TABLE IF NOT EXISTS turn_ingress_queue (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'starting', 'running', 'done', 'cancelled', 'failed')),
  text TEXT NOT NULL,
  action_id TEXT,
  language TEXT,
  client_request_id TEXT,
  queue_index BIGINT NOT NULL,
  visible_after_turn_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_turn_ingress_session_status
  ON turn_ingress_queue(session_id, status, queue_index);

CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_ingress_client_request
  ON turn_ingress_queue(session_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
