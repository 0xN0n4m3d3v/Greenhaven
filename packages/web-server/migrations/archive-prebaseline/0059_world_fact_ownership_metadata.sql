-- 0059_world_fact_ownership_metadata.sql
--
-- Adds deterministic topology/ownership/access metadata to the shipped
-- Greenhaven locations so dynamic world-fact guards can validate private or
-- hidden spawned places against actual cartridge control chains.

UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
     'access_policy', 'public'
   )
 WHERE id = 100
   AND kind = 'location';

UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
     'topology_parent_id', 100,
     'owner_entity_id', 200,
     'access_policy', 'staff_only',
     'access_reason', 'Mikka controls which private negotiations move from Quickgrin Lane into the booths.'
   )
 WHERE id = 101
   AND kind = 'location';

UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
     'topology_parent_id', 100,
     'owner_entity_id', 220,
     'access_policy', 'public',
     'access_reason', 'Borek keeps the inn open to paying and civil guests from Quickgrin Lane.'
   )
 WHERE id = 110
   AND kind = 'location';
