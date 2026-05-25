-- Repair legacy Memory Palace rows before 0102 adds the player FK.
--
-- Some local PGlite databases contain memory_threads rows whose player_id no
-- longer exists in players. Those rows are already unreachable by runtime
-- player-scoped reads, and 0102's ON DELETE CASCADE FK is the intended long-term
-- ownership rule. Delete them before the FK is added so existing local data can
-- continue migrating.

DELETE FROM memory_threads mt
 WHERE NOT EXISTS (
   SELECT 1
     FROM players p
    WHERE p.entity_id = mt.player_id
 );
