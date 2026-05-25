-- 0013_status_effects.sql — combat status effects on NPCs.
--
-- Convention: any NPC that can be incapacitated declares a runtime
-- field keyed `stunned` (bool). Combat resolution checks this flag
-- before letting the NPC take an active turn — stunned NPCs skip
-- their action phase but their HP still ticks (DoT, healing, etc.).
--
-- Future extensions follow the same pattern: `prone`, `poisoned`,
-- `silenced`, `frightened`. Each is a bool runtime field on the
-- entity. Combat code reads them to gate phases.

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, scope, scope_per_player, description)
VALUES
  (2204, 200, 'stunned', 'bool', 'false'::jsonb, 'session', false,
   'Mikka is stunned this round and skips her active turn. Combat resolution must check this before scheduling her counter-attack.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (2204, 'false'::jsonb, 'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;
