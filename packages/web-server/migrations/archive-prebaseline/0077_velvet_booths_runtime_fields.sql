-- Runtime state for player-visible manipulation inside the Velvet Booths.
-- These fields let the broker persist "cut the curtain" and "searched under
-- the table" beats instead of turning them into prose-only facts.

INSERT INTO runtime_fields
    (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
VALUES
  (2400, 101, 'curtain_state', 'enum',
   '"hanging"'::jsonb,
   '["hanging","cut","dropped"]'::jsonb,
   'session', false,
   'Physical state of the Velvet Booths curtain cord/velvet barrier.'),
  (2401, 101, 'table_sign_state', 'enum',
   '"unknown"'::jsonb,
   '["unknown","not_found","found","removed"]'::jsonb,
   'session', true,
   'Per-player result of searching for a hidden sign under the small booth table.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source)
VALUES
  (2400, '"hanging"'::jsonb, 'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;
