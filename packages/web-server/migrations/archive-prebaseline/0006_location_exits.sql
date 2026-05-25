-- 0006_location_exits.sql — declare adjacency between Quickgrin Lane
-- and the Velvet Booths so the GM-affordance code in
-- query_player_state can surface them as @-mention travel options.
--
-- Convention: locations expose connectivity via their profile JSONB
-- under the `exits` key, which holds an array of entity ids the
-- player can move to from here. Resolved server-side into a list of
-- {id, kind, display_name, summary} tuples and shipped to the model
-- as `exits` on the player snapshot.
--
-- Eventually this should grow into a proper transitions / edges
-- table with directional rules (locked doors, hidden exits, key
-- requirements). For now the inline array is enough for the
-- demo cartridge.

UPDATE entities
   SET profile = profile || jsonb_build_object('exits', jsonb_build_array(101))
 WHERE id = 100;  -- Quickgrin Lane → Velvet Booths

UPDATE entities
   SET profile = profile || jsonb_build_object('exits', jsonb_build_array(100))
 WHERE id = 101;  -- Velvet Booths → Quickgrin Lane
