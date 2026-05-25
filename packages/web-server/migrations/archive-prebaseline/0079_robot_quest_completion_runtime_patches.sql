-- Spec 120 follow-up: complete_quest must not close the authored robot quest
-- without also writing the final durable runtime state. 0078 authored the
-- cartridge; this forward migration patches already-migrated dev databases.

UPDATE entities
   SET profile = jsonb_set(
     profile,
     '{rewards,runtime_field_patches}',
     jsonb_build_array(
       jsonb_build_object('field_id', 12140, 'value', 'reported'),
       jsonb_build_object('field_id', 12150, 'value', 'closed'),
       jsonb_build_object('field_id', 12120, 'value', 'satisfied'),
       jsonb_build_object('field_id', 12103, 'value', 'verified')
     ),
     true
   ),
       updated_at = now()
 WHERE id = 12040
   AND kind = 'quest';
