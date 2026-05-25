-- 0083_activate_grinhaven_full_cartridge.sql
--
-- The full ena-chat Grinhaven dataset is now the production cartridge.
-- Keep 0082 as the data import, then switch active cartridge metadata here so
-- existing databases receive the activation as a forward-only migration.

INSERT INTO cartridge_meta (key, value, description) VALUES
  ('cartridge_id', '"grinhaven-full"'::jsonb, 'Identifier of the active cartridge.'),
  ('cartridge_version', '"0.4.0"'::jsonb, 'Full Grinhaven dataset cartridge version.'),
  ('world_entity_id', '200000'::jsonb, 'Active full Grinhaven world entity.'),
  ('starting_location_id', '201019'::jsonb, 'New players start in Ale & Eats, the tavern power center.'),
  ('starting_scene_id', 'null'::jsonb, 'Full Grinhaven starts in tavern free play without a pinned scene.'),
  ('default_class_id', '600'::jsonb, 'Keep existing base class scaffold until full cartridge classes are authored.'),
  ('currency_item_id', '300'::jsonb, 'Keep existing currency scaffold for player creation.'),
  ('starting_currency_count', '100'::jsonb, 'Starting purse for new full Grinhaven players.'),
  ('reset_inventory_seeds', '[]'::jsonb, 'Full Grinhaven reset has no Quickgrin-specific NPC inventory seeds.'),
  ('reset_runtime_overrides', '[]'::jsonb, 'Full Grinhaven reset uses runtime field defaults without Quickgrin overrides.'),
  ('cartridge_i18n_policy', '"source_only"'::jsonb, 'Full Grinhaven authored dataset is source-language canon; strict i18n checks skip entity translation coverage for this cartridge.'),
  ('grinhaven_full_starting_location_id', '201019'::jsonb, 'Production starting tavern for the active full Grinhaven cartridge.')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();

UPDATE entities
   SET display_name = 'Grinhaven',
       summary = 'Dense living-city cartridge for psychological LitRPG chat play.',
       profile = (
         COALESCE(profile, '{}'::jsonb)
         - 'import_notes'
       ) || jsonb_build_object(
         'activation_status', 'active',
         'starting_location_id', 201019,
         'starting_location_name', 'Ale & Eats',
         'i18n_policy', 'source_only',
         'narrator_brief',
         'Run Grinhaven as a dense living-world cartridge. Start play from Ale & Eats. Prefer database entities, runtime fields, quests, relationships, scenes, routines, and consequences over invented ambience.'
       ),
       tags = ARRAY(
         SELECT DISTINCT tag
           FROM unnest(COALESCE(tags, ARRAY[]::text[]) || ARRAY['active-cartridge', 'power:tavern-start']) AS t(tag)
       )
 WHERE id = 200000
   AND kind = 'world'
   AND profile->>'cartridge_id' = 'grinhaven-full';

UPDATE players p
   SET current_location_id = 201019,
       current_scene_id = NULL,
       dialogue_partner_id = NULL,
       last_seen = now()
 WHERE NOT EXISTS (
   SELECT 1
     FROM entities loc
    WHERE loc.id = p.current_location_id
      AND loc.profile->>'cartridge_id' = 'grinhaven-full'
 );
