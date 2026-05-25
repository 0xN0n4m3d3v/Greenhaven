-- 0015_turn_telemetry.sql — per-turn cost + latency tracking.
--
-- One row per (turn, role) — broker and narrator are separate rows so
-- we can isolate which stage dominates cost. Scripted-only turns have
-- only a narrator row.
--
-- cost_usd is computed at insert-time from token counts × the role's
-- model rate. Pricing constants live in src/ai/pricing.ts.

CREATE TABLE IF NOT EXISTS turn_telemetry (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL,                -- 'broker' | 'narrator' | 'narrator-scripted'
    model_id TEXT NOT NULL,
    thinking BOOLEAN NOT NULL DEFAULT false,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
    cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL,
    cost_usd NUMERIC(12, 8) NOT NULL,
    tier TEXT,                          -- T0..T4 from cost-optimization tiers, NULL until classifier lands
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_turn_telemetry_session_turn
  ON turn_telemetry(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_turn_telemetry_recorded_at
  ON turn_telemetry(recorded_at DESC);
