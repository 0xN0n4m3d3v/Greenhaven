-- 0050_fix_borek_sex_move_effect_args.sql
--
-- Spec 62 validation found that Borek's sex_move still used the
-- pre-Spec-17 apply_runtime_field_patch argument shape:
--   {target_entity_id, patches:[{field_key, value}]}
-- The current tool schema requires:
--   {patches:[{field_id, value, op}], source?}

UPDATE entities
   SET profile = jsonb_set(
     COALESCE(profile, '{}'::jsonb),
     '{sex_move,effect_args}',
     jsonb_build_object(
       'patches',
       jsonb_build_array(
         jsonb_build_object(
           'field_id', 8110,
           'value', 'add_current_player',
           'op', 'append'
         )
       ),
       'source', 'sex_move_borek_free_lodging'
     )
   )
 WHERE id = 220
   AND kind = 'person'
   AND profile ? 'sex_move';
