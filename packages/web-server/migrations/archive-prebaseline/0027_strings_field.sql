-- Spec 18 — Strings (emotional leverage between player and NPC).
--
-- Adds 'strings' JSONB to every kind='person' entity. Schema:
--   { "<player_entity_id>": <int>, ... }
-- The OWNER of the runtime_field is one side of the bond; the KEYS are
-- the other side's player_id. v1 is symmetric: a single per-NPC map
-- carries player→NPC strings.
--
-- Field ID claim: 9000 + entity.id (per cross-cutting-concerns.md
-- registry — 9000+ block reserved for spec 18 strings).

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  9000 + e.id,
  e.id,
  'strings',
  'json',
  '{}'::jsonb,
  NULL,
  'permanent',
  false,
  'Emotional leverage strings keyed by counterparty player_id. Earned in intimate / dramatic beats, spent for +1d on social rolls.'
FROM entities e
WHERE e.kind = 'person'
  AND NOT EXISTS (
    SELECT 1 FROM runtime_fields rf
    WHERE rf.owner_entity_id = e.id AND rf.field_key = 'strings'
  );
