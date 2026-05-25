CREATE TABLE IF NOT EXISTS telemetry_sessions (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  install_id TEXT,
  build_id TEXT,
  app_version TEXT,
  cartridge_id TEXT,
  cartridge_version TEXT,
  save_id TEXT,
  session_id TEXT,
  player_id BIGINT,
  platform TEXT,
  consent_mode TEXT NOT NULL DEFAULT 'local_only',
  retention_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_session
  ON telemetry_sessions (session_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_player
  ON telemetry_sessions (player_id, started_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_spans (
  id BIGSERIAL PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  session_id TEXT,
  player_id BIGINT,
  turn_id TEXT,
  event_id BIGINT,
  release_seq BIGINT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'ok',
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_ms INTEGER,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  redaction_tier TEXT NOT NULL DEFAULT 'tier0_safe',
  source TEXT NOT NULL DEFAULT 'greenhaven',
  UNIQUE (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_spans_trace
  ON telemetry_spans (trace_id, started_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_spans_turn
  ON telemetry_spans (turn_id, started_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_spans_session
  ON telemetry_spans (session_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_spans_name_status
  ON telemetry_spans (name, status, started_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id TEXT,
  span_id TEXT,
  session_id TEXT,
  player_id BIGINT,
  turn_id TEXT,
  event_id BIGINT,
  release_seq BIGINT,
  schema_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL DEFAULT 'system',
  event_name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction_tier TEXT NOT NULL DEFAULT 'tier0_safe',
  validation_status TEXT NOT NULL DEFAULT 'valid',
  source TEXT NOT NULL DEFAULT 'greenhaven'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_trace
  ON telemetry_events (trace_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_turn
  ON telemetry_events (turn_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_session
  ON telemetry_events (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_schema_time
  ON telemetry_events (schema_name, occurred_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_metrics (
  id BIGSERIAL PRIMARY KEY,
  bucket_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', now()),
  trace_id TEXT,
  session_id TEXT,
  player_id BIGINT,
  turn_id TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  aggregation TEXT NOT NULL DEFAULT 'raw',
  count INTEGER NOT NULL DEFAULT 1,
  sum DOUBLE PRECISION,
  min DOUBLE PRECISION,
  max DOUBLE PRECISION,
  p50 DOUBLE PRECISION,
  p95 DOUBLE PRECISION,
  p99 DOUBLE PRECISION,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'greenhaven'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_name_bucket
  ON telemetry_metrics (name, bucket_start DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_session
  ON telemetry_metrics (session_id, bucket_start DESC);

CREATE TABLE IF NOT EXISTS telemetry_artifacts (
  id BIGSERIAL PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id TEXT,
  span_id TEXT,
  session_id TEXT,
  player_id BIGINT,
  turn_id TEXT,
  artifact_type TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes BIGINT,
  sha256 TEXT,
  mime_type TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  redaction_tier TEXT NOT NULL DEFAULT 'tier1_local_debug',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'greenhaven'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_artifacts_trace
  ON telemetry_artifacts (trace_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_artifacts_session
  ON telemetry_artifacts (session_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_eval_scores (
  id BIGSERIAL PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id TEXT,
  span_id TEXT,
  session_id TEXT,
  player_id BIGINT,
  turn_id TEXT,
  evaluator_id TEXT NOT NULL,
  evaluator_version TEXT,
  score DOUBLE PRECISION,
  label TEXT,
  reason TEXT,
  reviewed BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'greenhaven'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_eval_scores_trace
  ON telemetry_eval_scores (trace_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_eval_scores_evaluator
  ON telemetry_eval_scores (evaluator_id, recorded_at DESC);
