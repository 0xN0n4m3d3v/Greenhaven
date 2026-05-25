-- 0081_restore_quickgrin_active_cartridge.sql
--
-- Robot Empty World is a separate cartridge fixture, not the default cartridge
-- for Greenhaven live playtests. Migration 0078 seeded the robot cartridge and
-- made it active by overwriting cartridge_meta. That broke Quickgrin runtime
-- tests because cartridge-scoped tools correctly hid Quickgrin entities while
-- the player was still placed in Quickgrin locations by debug scenarios.
--
-- Keep the robot rows in the database, but restore Quickgrin Lane as the
-- default active cartridge. Robot-specific smoke tests opt into the robot meta
-- explicitly before creating their robot player.

INSERT INTO cartridge_meta (key, value, description) VALUES
  ('cartridge_id', '"quickgrin-lane"'::jsonb, 'Identifier of the active cartridge.'),
  ('cartridge_version', '"0.3.0"'::jsonb, 'Quickgrin Lane cartridge version.'),
  ('world_entity_id', '10'::jsonb, 'Quickgrin Lane world entity.'),
  ('starting_location_id', '100'::jsonb, 'Quickgrin Lane starting location.'),
  ('starting_scene_id', 'null'::jsonb, 'Quickgrin Lane starts without a pinned scene.'),
  ('default_class_id', '600'::jsonb, 'Default class scaffold for Quickgrin Lane players.'),
  ('currency_item_id', '300'::jsonb, 'Quickgrin Lane canonical currency item.'),
  ('starting_currency_count', '100'::jsonb, 'Quickgrin Lane starting currency.'),
  ('reset_inventory_seeds',
   '[
      {"holder_entity_id":200,"item_entity_id":300,"count":0},
      {"holder_entity_id":220,"item_entity_id":300,"count":0},
      {"holder_entity_id":220,"item_entity_id":310,"count":20}
    ]'::jsonb,
   'Quickgrin Lane reset inventory seeds.'),
  ('reset_runtime_overrides',
   '[
      {"field_id":2101,"value":"pricing"},
      {"field_id":2102,"value":"dark"},
      {"field_id":2200,"value":12},
      {"field_id":2204,"value":false},
      {"field_id":2300,"value":"tired"},
      {"field_id":2310,"value":15}
    ]'::jsonb,
   'Quickgrin Lane reset runtime values.')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();

