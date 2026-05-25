-- AQ-2 — per-(session_id, player_id) adventure sequence counter.
--
-- Background: maybeEnqueueAdventureOpportunity() previously assigned
-- adventure_queue.sequence via
--   SELECT COALESCE(MAX(sequence), 0) + 1
--     FROM adventure_queue
--    WHERE session_id = $1 AND player_id = $2
-- inside the AQ-1 transaction. The AQ-1 lock makes this safe under
-- concurrency, but MAX(...)+1 still scans the per-(session, player)
-- partition on every allocation and is awkward for future analytics
-- (no durable "next free sequence" anchor). It is also incompatible
-- with explicit-sequence fixtures (devtools / support smokes pass
-- opts.sequence) because nothing advances the implicit allocator
-- after an explicit jump.
--
-- This migration introduces a dedicated counter table keyed on
-- (session_id, player_id). The runtime allocates new sequences with
--   INSERT INTO adventure_queue_counters (session_id, player_id, last_sequence)
--   VALUES ($1, $2, 1)
--   ON CONFLICT (session_id, player_id)
--   DO UPDATE SET last_sequence = adventure_queue_counters.last_sequence + 1
--   RETURNING last_sequence;
-- and advances the counter past an explicit fixture sequence via
-- GREATEST(...), so subsequent automatic allocations still grow
-- monotonically. The counter lives in its own table (not a Postgres
-- sequence per session) because creating millions of sequences would
-- bloat pg_class; one row per (session, player) is cheap to back up,
-- replicate, and reset.

CREATE TABLE IF NOT EXISTS adventure_queue_counters (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, player_id)
);

-- Backfill from existing adventure_queue rows so any database
-- carrying historical adventures starts the counter at MAX(sequence)
-- per (session, player). Idempotent via ON CONFLICT — re-running the
-- migration (or running it against a DB where the counter already
-- exists with a higher value) never lowers `last_sequence`.
INSERT INTO adventure_queue_counters (session_id, player_id, last_sequence)
SELECT session_id, player_id, MAX(sequence)
  FROM adventure_queue
 GROUP BY session_id, player_id
ON CONFLICT (session_id, player_id)
DO UPDATE SET last_sequence = GREATEST(
  adventure_queue_counters.last_sequence,
  EXCLUDED.last_sequence
);
