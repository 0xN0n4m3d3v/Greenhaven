-- Migration 0102: Fix missing FK constraints and CASCADE rules
--   * Add ON DELETE CASCADE to transitions.goto_entity_id -> entities(id)
--   * Add FK constraint on memory_threads.player_id -> players(entity_id)
--
-- GH-BUG-093: Missing CASCADE on goto_entity_id could leave dangling
-- references when a target entity is deleted.
-- GH-BUG-094: Missing FK on memory_threads.player_id violates the
-- pattern used by every other player-scoped table.

-- Part 1: Fix transitions.goto_entity_id — drop old FK, add with CASCADE.
-- We need to find and drop the auto-generated constraint name.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT con.conname INTO con_name
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attnum = con.conkey[1] AND att.attrelid = 'transitions'::regclass
   WHERE con.conrelid = 'transitions'::regclass
     AND con.confrelid = 'entities'::regclass
     AND att.attname = 'goto_entity_id'
   LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE transitions DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE transitions
  ADD CONSTRAINT transitions_goto_fk
  FOREIGN KEY (goto_entity_id) REFERENCES entities(id) ON DELETE CASCADE;

-- Part 2: Add FK on memory_threads.player_id
ALTER TABLE memory_threads
  ADD CONSTRAINT memory_threads_player_fk
  FOREIGN KEY (player_id) REFERENCES players(entity_id) ON DELETE CASCADE;
