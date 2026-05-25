-- 0057_adventure_queue.sql
-- Durable, replayable adventure opportunity queue for the post-turn oracle.
-- Spec 89 deliberately stores only queue/oracle metadata; materialization and
-- canon mutations are later specs.

CREATE TABLE IF NOT EXISTS adventure_queue (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'materializing', 'ready', 'accepted', 'rejected', 'expired', 'cancelled', 'failed')),
  source TEXT NOT NULL
    CHECK (source IN ('oracle', 'quest_pacer', 'narrative_gap', 'manual_debug')),
  adventure_kind TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  seed TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  table_id TEXT NOT NULL,
  roll_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  blueprint JSONB,
  dedupe_key TEXT,
  available_after_turn_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adventure_queue_player_status
  ON adventure_queue(player_id, status, priority DESC, id);

CREATE INDEX IF NOT EXISTS idx_adventure_queue_session_turn
  ON adventure_queue(session_id, turn_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adventure_queue_dedupe
  ON adventure_queue(session_id, player_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS adventure_oracle_rolls (
  id BIGSERIAL PRIMARY KEY,
  adventure_queue_id BIGINT REFERENCES adventure_queue(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  player_id BIGINT NOT NULL,
  turn_id TEXT,
  seed TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  die TEXT NOT NULL,
  raw_roll INTEGER NOT NULL,
  table_id TEXT NOT NULL,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adventure_oracle_rolls_queue
  ON adventure_oracle_rolls(adventure_queue_id);

CREATE INDEX IF NOT EXISTS idx_adventure_oracle_rolls_session_turn
  ON adventure_oracle_rolls(session_id, turn_id, id);
