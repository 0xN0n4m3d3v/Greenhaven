-- 0009_npc_hp.sql — declare HP runtime fields for NPCs that should be
-- damageable. Convention: every NPC who can take damage gets two
-- runtime_fields keyed `current_hp` and `max_hp`, both global scope
-- (not per-player — Mikka's wounds in this scene are seen by every
-- player at this location). The combat tool (`damage`/`heal`)
-- recognises these by field_key and clamps to [0, max_hp].
--
-- Mikka is a goblin broker, light frame, light leather. Stats come
-- out around D&D CR 1/4 — ~12 HP keeps her dangerous-but-killable
-- for a level 1 player.

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
VALUES
  (2200, 200, 'current_hp', 'int', '12'::jsonb, NULL, 'session', false,
   'Mikka''s current HP. Combat tools mutate this; transitions can fire on hp <= 0.'),
  (2201, 200, 'max_hp', 'int', '12'::jsonb, NULL, 'session', false,
   'Mikka''s max HP. Healing clamps to this ceiling.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (2200, '12'::jsonb, 'cartridge_seed'),
  (2201, '12'::jsonb, 'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;
