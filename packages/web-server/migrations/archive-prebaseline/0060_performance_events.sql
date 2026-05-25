CREATE TABLE IF NOT EXISTS performance_events (
  id BIGSERIAL PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id TEXT,
  player_id BIGINT,
  turn_id TEXT,
  trace_id TEXT,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  duration_ms INTEGER,
  cpu_user_us BIGINT,
  cpu_system_us BIGINT,
  rss_bytes BIGINT,
  heap_used_bytes BIGINT,
  external_bytes BIGINT,
  event_loop_utilization DOUBLE PRECISION,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_performance_events_turn
  ON performance_events (turn_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_performance_events_session_time
  ON performance_events (session_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_performance_events_phase_time
  ON performance_events (phase, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_performance_events_status_time
  ON performance_events (status, recorded_at DESC);
