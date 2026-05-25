-- Spec 36 §4 — save slots. 5 named + 1 quicksave (auto on death,
-- spec 35 combat_state='dead'). Snapshot is a single JSONB blob
-- spanning entities/runtime_values/npc_memories/player_inventory/
-- player_quests + last 200 chat_messages with a watermark id.
-- Snapshot semantics live in src/routes/saves.ts; this table is the
-- bare schema.

CREATE TABLE IF NOT EXISTS save_slots (
  id          SERIAL PRIMARY KEY,
  player_id   BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  slot_name   TEXT NOT NULL,
  is_auto     BOOLEAN NOT NULL DEFAULT false,
  snapshot    JSONB NOT NULL,
  size_bytes  INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, slot_name)
);
CREATE INDEX IF NOT EXISTS idx_saves_player ON save_slots(player_id, created_at DESC);
