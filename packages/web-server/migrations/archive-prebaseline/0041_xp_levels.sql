-- Spec 36 §2 — XP / level scaling. The hard-coded
-- proficiency_bonus = 2 in spec 27 collapses D&D 5e's level curve
-- (lvl 1-4=+2, 5-8=+3, 9-12=+4, 13-16=+5, 17-20=+6). We expose the
-- canonical SRD table so turnContext computes prof_bonus from the
-- player's current level.
--
-- Field-id ABI: spec 35 already used 12100+entity / 12200+entity for
-- death-save counters. We allocate the 13xxx block here:
--   13100 + entity_id  →  xp
--   13200 + entity_id  →  level
-- (Spec 36's literal IDs 12100/12101 collide with spec 35; deviation
-- documented in EXECUTION_LOG.)

CREATE TABLE IF NOT EXISTS xp_thresholds (
  level             INT PRIMARY KEY,
  xp_required       INT NOT NULL,
  proficiency_bonus INT NOT NULL
);

INSERT INTO xp_thresholds (level, xp_required, proficiency_bonus) VALUES
  (1,0,2),(2,300,2),(3,900,2),(4,2700,2),
  (5,6500,3),(6,14000,3),(7,23000,3),(8,34000,3),
  (9,48000,4),(10,64000,4),(11,85000,4),(12,100000,4),
  (13,120000,5),(14,140000,5),(15,165000,5),(16,195000,5),
  (17,225000,6),(18,265000,6),(19,305000,6),(20,355000,6)
ON CONFLICT (level) DO NOTHING;

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  13100 + p.entity_id,
  p.entity_id,
  'xp',
  'int',
  '0'::jsonb,
  NULL,
  'permanent',
  false,
  'Total experience points. grant_xp tool increments; level recomputed via xp_thresholds.'
FROM players p
WHERE NOT EXISTS (
  SELECT 1 FROM runtime_fields rf
  WHERE rf.owner_entity_id = p.entity_id AND rf.field_key = 'xp'
);

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  13200 + p.entity_id,
  p.entity_id,
  'level',
  'int',
  '1'::jsonb,
  NULL,
  'permanent',
  false,
  'Character level (1..20). Derived from xp via xp_thresholds; persisted for cheap reads.'
FROM players p
WHERE NOT EXISTS (
  SELECT 1 FROM runtime_fields rf
  WHERE rf.owner_entity_id = p.entity_id AND rf.field_key = 'level'
);
