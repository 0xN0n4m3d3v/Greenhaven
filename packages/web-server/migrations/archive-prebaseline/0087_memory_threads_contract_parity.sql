-- Align the implemented session memory-thread API with the first table shape.
-- Migration 0085 created thread_kind/payload; Spec 137 code writes kind/metadata.

ALTER TABLE memory_threads
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB;

UPDATE memory_threads
   SET kind = COALESCE(kind, thread_kind, 'session'),
       metadata = COALESCE(metadata, payload, '{}'::jsonb);

ALTER TABLE memory_threads
  ALTER COLUMN kind SET DEFAULT 'session',
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb,
  ALTER COLUMN metadata SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_threads_kind_updated
  ON memory_threads (player_id, kind, updated_at DESC);
