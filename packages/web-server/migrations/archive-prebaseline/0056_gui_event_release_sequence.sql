-- 0056_gui_event_release_sequence.sql
-- Deterministic replay order for deferred GUI events. `id` is insertion
-- order; `release_seq` is player-visible release order.

CREATE SEQUENCE IF NOT EXISTS gui_events_release_seq;

ALTER TABLE gui_events
  ADD COLUMN IF NOT EXISTS release_seq BIGINT;

UPDATE gui_events
   SET release_seq = id
 WHERE status = 'released'
   AND release_seq IS NULL;

SELECT setval(
  'gui_events_release_seq',
  GREATEST(
    COALESCE((SELECT MAX(release_seq) FROM gui_events), 0),
    COALESCE((SELECT last_value FROM gui_events_release_seq), 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_gui_events_replay_release_seq
  ON gui_events(session_id, release_seq, id)
  WHERE status = 'released';
