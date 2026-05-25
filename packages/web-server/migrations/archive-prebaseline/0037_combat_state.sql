-- Spec 35 — combat death state. Per-entity runtime fields:
--   combat_state ∈ {'active', 'downed', 'dead', 'stable'}
--   death_save_successes / death_save_failures (0..3)
-- Field id formula: 12000 + entity_id (combat_state),
--                   12100 + entity_id (death_save_successes),
--                   12200 + entity_id (death_save_failures).
--
-- Cross-cutting registry: 12000-02 reserved for spec 35. The block
-- entry in cross-cutting-concerns.md uses bare 12000-02 numbers
-- because it's a per-entity model — we tolerate the offset (entities
-- 1-99 fit within 12099 / 12199 / 12299 ranges).

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  12000 + e.id, e.id, 'combat_state', 'enum', '"active"'::jsonb,
  '["active","downed","dead","stable"]'::jsonb, 'session', false,
  'BG3-style combat state: active, downed (death-save loop), stable (revived but unconscious), dead (no return).'
FROM entities e
WHERE e.kind IN ('person', 'player')
  AND NOT EXISTS (
    SELECT 1 FROM runtime_fields rf
    WHERE rf.owner_entity_id = e.id AND rf.field_key = 'combat_state'
  );

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  12100 + e.id, e.id, 'death_save_successes', 'int', '0'::jsonb, NULL,
  'session', false,
  'Death-save successes accumulated this downed period (0..3). 3 → stable.'
FROM entities e
WHERE e.kind IN ('person', 'player')
  AND NOT EXISTS (
    SELECT 1 FROM runtime_fields rf
    WHERE rf.owner_entity_id = e.id AND rf.field_key = 'death_save_successes'
  );

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  12200 + e.id, e.id, 'death_save_failures', 'int', '0'::jsonb, NULL,
  'session', false,
  'Death-save failures accumulated this downed period (0..3). 3 → dead.'
FROM entities e
WHERE e.kind IN ('person', 'player')
  AND NOT EXISTS (
    SELECT 1 FROM runtime_fields rf
    WHERE rf.owner_entity_id = e.id AND rf.field_key = 'death_save_failures'
  );
