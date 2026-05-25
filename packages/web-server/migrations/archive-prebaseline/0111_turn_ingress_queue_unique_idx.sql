-- DEEP-8 — enforce per-session uniqueness of turn_ingress_queue.queue_index.
--
-- Background: enqueueTurn() previously ran
--   findByClientRequest -> countQueued -> nextQueueIndex -> INSERT
-- as separate, non-transactional statements. Two concurrent
-- POST /api/session/:id/turn requests against the same session could
-- read identical MAX(queue_index) values and write two rows with the
-- same (session_id, queue_index), also bypassing
-- MAX_QUEUED_PER_SESSION.
--
-- The runtime fix wraps those steps in withTransaction(...) with a
-- per-session SELECT id FROM sessions WHERE id = $1 FOR UPDATE lock
-- (plus a per-session in-process promise mutex so PGlite — which
-- shares one connection — still serialises). This migration is the
-- DB-level backstop: if a future bypass slips past the application
-- lock, the unique index makes the offending INSERT fail loudly
-- instead of producing silent duplicates.
--
-- Any existing duplicates from databases created against the
-- un-fixed code are restamped first, deterministically by
-- (session_id, queue_index, id), so the constraint can be added
-- without manual intervention.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM turn_ingress_queue
     GROUP BY session_id, queue_index
    HAVING COUNT(*) > 1
  ) THEN
    WITH ranked AS (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY session_id
          ORDER BY queue_index ASC, id ASC
        ) AS new_idx
      FROM turn_ingress_queue
    )
    UPDATE turn_ingress_queue t
       SET queue_index = ranked.new_idx
      FROM ranked
     WHERE t.id = ranked.id
       AND t.queue_index <> ranked.new_idx;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS turn_ingress_queue_session_queue_idx_uniq
  ON turn_ingress_queue (session_id, queue_index);
