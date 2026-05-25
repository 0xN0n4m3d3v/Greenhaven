-- Make Meow Meow Paradise playable as a populated location.
--
-- The cartridge imported Mii, Mokko, and Karuruw as full person records, but
-- only the location prose referenced them. Runtime presence checks use
-- profile.home_id/location_id/current_location_id, so the venue rendered as
-- empty even though its content existed.

UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb)
      || jsonb_build_object(
           'home_id', 201012,
           'location_id', 201012,
           'power_center_id', 201012,
           'power_center_role', 'venue',
           'venue_role', CASE display_name
             WHEN 'Mii' THEN 'front-threshold host and first-timer specialist'
             WHEN 'Mokko' THEN 'quiet room host and dawn baker'
             WHEN 'Karuruw' THEN 'late-shift host and senior sister'
             ELSE 'house worker'
           END
         )
 WHERE kind = 'person'
   AND id IN (230005, 230012, 230013)
   AND display_name IN ('Mii', 'Mokko', 'Karuruw');

UPDATE entities
   SET profile = jsonb_set(
       jsonb_set(
         COALESCE(profile, '{}'::jsonb),
         '{local_density,npc_ids}',
         '[230005,230012,230013]'::jsonb,
         true
       ),
       '{local_density_summary,npc_count}',
       '3'::jsonb,
       true
     )
 WHERE id = 201012
   AND kind = 'location'
   AND display_name = 'Meow Meow Paradise';
