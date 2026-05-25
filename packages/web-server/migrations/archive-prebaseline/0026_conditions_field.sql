-- Spec 17 — Combat Conditions & Tags layer.
--
-- Adds a 'conditions' JSONB array runtime_field to every kind='person'
-- entity. Schema:
--   [
--     { "tag": "bleeding", "applied_turn": N, "expires_turn": N+3,
--       "severity": 1..3, "source": "player:<entity_id>" },
--     ...
--   ]
-- Empty array = no conditions. transitionEngine.ts decrements on each
-- turn boundary; entries whose expires_turn <= currentTurn are dropped.
--
-- Field ID claim: 8000 + entity.id (per cross-cutting-concerns.md
-- registry — 8000+ block reserved for spec 17 conditions).

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  8000 + e.id,
  e.id,
  'conditions',
  'json',
  '[]'::jsonb,
  NULL,
  'session',
  false,
  'Active combat conditions: bleeding, stunned, off-balance, disarmed, prone. Decremented per turn.'
FROM entities e
WHERE e.kind = 'person'
  AND NOT EXISTS (
    SELECT 1 FROM runtime_fields rf
    WHERE rf.owner_entity_id = e.id AND rf.field_key = 'conditions'
  );
