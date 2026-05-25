-- Spec 137/138: Khash-inspired Memory Palace loop fields and packet support.
-- Keep Greenhaven's existing npc_memories/player_quests authority; add only
-- derived metadata for recall, clustering, continuity, and dynamic planning.

ALTER TABLE npc_memories
  ADD COLUMN IF NOT EXISTS memory_kind TEXT NOT NULL DEFAULT 'world_fact',
  ADD COLUMN IF NOT EXISTS memory_family TEXT NOT NULL DEFAULT 'world',
  ADD COLUMN IF NOT EXISTS source_turn_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS source_tool TEXT NULL,
  ADD COLUMN IF NOT EXISTS reference_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS cluster_id TEXT NULL;

UPDATE npc_memories
   SET memory_kind = CASE
       WHEN tags && ARRAY['quest', 'quest_lesson', 'stage', 'objective']::text[] THEN 'quest_lesson'
       WHEN tags && ARRAY['trauma', 'harm', 'wound', 'sensitive']::text[] OR sensitive = true THEN 'trauma_memory'
       WHEN tags && ARRAY['promise', 'debt', 'commitment']::text[] THEN 'promise'
       WHEN tags && ARRAY['failure', 'failed', 'blocked']::text[] THEN 'failure_pattern'
       WHEN tags && ARRAY['desire', 'boundary', 'preference']::text[] THEN 'desire_or_boundary'
       WHEN tags && ARRAY['bond', 'relationship', 'strings']::text[] THEN 'bond_memory'
       ELSE COALESCE(NULLIF(memory_kind, ''), 'world_fact')
     END,
     memory_family = CASE
       WHEN tags && ARRAY['quest', 'quest_lesson', 'stage', 'objective']::text[] THEN 'quest'
       WHEN tags && ARRAY['trauma', 'harm', 'wound', 'sensitive']::text[] OR sensitive = true THEN 'safety'
       WHEN tags && ARRAY['promise', 'debt', 'commitment']::text[] THEN 'commitment'
       WHEN tags && ARRAY['failure', 'failed', 'blocked']::text[] THEN 'lesson'
       WHEN tags && ARRAY['desire', 'boundary', 'preference']::text[] THEN 'preference'
       WHEN tags && ARRAY['bond', 'relationship', 'strings']::text[] THEN 'relationship'
       ELSE COALESCE(NULLIF(memory_family, ''), 'world')
     END
 WHERE memory_kind = 'world_fact'
    OR memory_family = 'world'
    OR memory_kind IS NULL
    OR memory_family IS NULL;

CREATE INDEX IF NOT EXISTS idx_npc_memories_family_salience
  ON npc_memories (owner_entity_id, memory_family, salience DESC, importance DESC);

CREATE INDEX IF NOT EXISTS idx_npc_memories_kind_salience
  ON npc_memories (owner_entity_id, memory_kind, salience DESC, importance DESC);

CREATE INDEX IF NOT EXISTS idx_npc_memories_cluster
  ON npc_memories (cluster_id)
  WHERE cluster_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_threads (
  id TEXT PRIMARY KEY,
  player_id BIGINT NOT NULL,
  session_id TEXT,
  thread_kind TEXT NOT NULL DEFAULT 'session',
  title TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_memory_threads_player_updated
  ON memory_threads (player_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_clusters (
  id TEXT PRIMARY KEY,
  owner_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  about_entity_id BIGINT NULL REFERENCES entities(id) ON DELETE SET NULL,
  memory_family TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  salience REAL NOT NULL DEFAULT 0.5,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE memory_clusters
  ADD COLUMN IF NOT EXISTS about_entity_id BIGINT NULL REFERENCES entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_memory_clusters_owner_salience
  ON memory_clusters (owner_entity_id, salience DESC, updated_at DESC);
