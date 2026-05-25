-- Spec 34 — npc_memories.salience for ranked retrieval. Computed at
-- create-time from importance, bumped on reference, decays optionally
-- (deferred to a nightly batch).

ALTER TABLE npc_memories
  ADD COLUMN IF NOT EXISTS salience REAL NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS last_referenced_turn INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_npc_memories_salience
  ON npc_memories (owner_entity_id, about_entity_id, salience DESC);
