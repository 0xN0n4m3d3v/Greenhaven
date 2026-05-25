-- 0018_cartridge_meta.sql — engine ↔ cartridge decoupling.
--
-- The engine should not hardcode "starting location is 100", "currency
-- is item 300", "Mikka's mood lives at field 2101". Those are cartridge
-- decisions. This table lets the engine read them at runtime so any
-- cartridge can ship its own values without touching engine source.
--
-- Convention: keys are stable identifiers; values are JSONB. Schema
-- versions live in cartridge_id / cartridge_version so the engine can
-- gate features by cartridge generation if needed later.
--
-- Below we seed the values that match Quickgrin Lane today (the
-- numbers previously hardcoded in playerService.ts and index.ts).
-- A second cartridge would ship its own seed migration overwriting
-- these rows, or the loader would re-INSERT on cartridge import.

CREATE TABLE IF NOT EXISTS cartridge_meta (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    description TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO cartridge_meta (key, value, description) VALUES
  ('cartridge_id',
     '"quickgrin-lane"'::jsonb,
     'Identifier of the active cartridge.'),
  ('cartridge_version',
     '"0.1.0"'::jsonb,
     'Cartridge schema/content version.'),
  ('starting_location_id',
     '100'::jsonb,
     'entity_id where new players spawn.'),
  ('starting_scene_id',
     'null'::jsonb,
     'Optional entity_id for an initial scene anchor; null = no scene pin.'),
  ('default_class_id',
     '600'::jsonb,
     'class entity_id used at anonymous-create.'),
  ('currency_item_id',
     '300'::jsonb,
     'entity_id of the canonical currency item.'),
  ('starting_currency_count',
     '100'::jsonb,
     'Amount of currency given to new players.'),
  ('reset_inventory_seeds',
     '[{"holder_entity_id":200,"item_entity_id":300,"count":0}]'::jsonb,
     'Inventory rows to UPSERT on /api/debug/reset-world (cartridge-specific intake bags).'),
  ('reset_runtime_overrides',
     '[{"field_id":2101,"value":"pricing"},{"field_id":2102,"value":"dark"}]'::jsonb,
     'runtime_values to force-write on /api/debug/reset-world (cartridge-initial state).')
ON CONFLICT (key) DO NOTHING;
