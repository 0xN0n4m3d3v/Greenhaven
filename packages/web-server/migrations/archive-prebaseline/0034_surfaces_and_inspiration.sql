-- Spec 33 — Surfaces (DOS:OS 2 inspired) + Inspiration (BG3 inspired).
--
-- Surfaces: per-location runtime field listing environmental effects.
-- Field id 11000 + entity.id (cross-cutting registry — 11000+ block).
-- Combo rules + decay rates live in cartridge_meta.
--
-- Inspiration: per-player resource (0-3) earned for in-character play,
-- spent for +1d advantage on the next dice_check (rides spec 16's
-- advantage flag). Field id 6000 + entity.id (6000+ block).

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  11000 + e.id,
  e.id,
  'active_surfaces',
  'json',
  '[]'::jsonb,
  NULL,
  'session',
  false,
  'Active environmental surfaces (fire, oil, etc.). Decay via transitionEngine. Combo rules in cartridge_meta.surface_combo_rules.'
FROM entities e
WHERE e.kind IN ('location', 'scene')
  AND NOT EXISTS (
    SELECT 1 FROM runtime_fields rf
    WHERE rf.owner_entity_id = e.id AND rf.field_key = 'active_surfaces'
  );

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  6000 + p.entity_id,
  p.entity_id,
  'inspiration',
  'int',
  '0'::jsonb,
  NULL,
  'permanent',
  false,
  'BG3-style inspiration tokens. Earned for in-character play; spent for +1d advantage. Cap 3.'
FROM players p
WHERE NOT EXISTS (
  SELECT 1 FROM runtime_fields rf
  WHERE rf.owner_entity_id = p.entity_id AND rf.field_key = 'inspiration'
);

INSERT INTO cartridge_meta (key, value, description) VALUES (
  'surface_combo_rules',
  jsonb_build_array(
    jsonb_build_object(
      'a', 'oil', 'b', 'fire',
      'result', 'explosion',
      'side_effects', jsonb_build_array(
        jsonb_build_object('apply_condition', 'bleeding', 'severity', 2, 'duration', 3),
        jsonb_build_object('damage', 15, 'type', 'fire'),
        jsonb_build_object('replace_surface', 'fire', 'severity', 2)
      ),
      'narrate_hint', 'The oil ignites with a roar; everything in the room is briefly licked by flame.'
    ),
    jsonb_build_object(
      'a', 'water', 'b', 'electricity',
      'result', 'shocked-pool',
      'side_effects', jsonb_build_array(
        jsonb_build_object('apply_condition', 'stunned', 'severity', 1, 'duration', 1),
        jsonb_build_object('damage', 8, 'type', 'lightning')
      ),
      'narrate_hint', 'The water sings with current; anyone touching it stiffens.'
    ),
    jsonb_build_object(
      'a', 'ice', 'b', 'fire',
      'result', 'water',
      'side_effects', jsonb_build_array(
        jsonb_build_object('replace_surface', 'water', 'severity', 1),
        jsonb_build_object('apply_condition', 'off-balance', 'severity', 1, 'duration', 1)
      ),
      'narrate_hint', 'The ice runs to puddles; the floor goes treacherous.'
    ),
    jsonb_build_object(
      'a', 'poison', 'b', 'fire',
      'result', 'toxic-explosion',
      'side_effects', jsonb_build_array(
        jsonb_build_object('apply_condition', 'bleeding', 'severity', 2, 'duration', 3),
        jsonb_build_object('apply_condition', 'poisoned', 'severity', 2, 'duration', 4),
        jsonb_build_object('damage', 18, 'type', 'fire')
      ),
      'narrate_hint', 'The poison ignites in a green-yellow plume; the air itself bites.'
    ),
    jsonb_build_object(
      'a', 'blood', 'b', 'electricity',
      'result', 'shocked-pool',
      'side_effects', jsonb_build_array(
        jsonb_build_object('apply_condition', 'stunned', 'severity', 1, 'duration', 1)
      ),
      'narrate_hint', 'The blood-puddle hums; muscles lock briefly.'
    ),
    jsonb_build_object(
      'a', 'smoke', 'b', 'fire',
      'result', 'smoke',
      'side_effects', jsonb_build_array(),
      'narrate_hint', 'Smoke billows thicker but does not catch.'
    )
  ),
  'Surface combo rules. When apply_surface fires on a tile carrying surface "a" with new "b", the result + side_effects fire instead of stacking.'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO cartridge_meta (key, value, description) VALUES (
  'surface_decay',
  jsonb_build_object(
    'fire',        jsonb_build_object('default_lifetime_turns', 3, 'severity_decay_per_turn', 1),
    'oil',         jsonb_build_object('default_lifetime_turns', 6, 'severity_decay_per_turn', 0),
    'water',       jsonb_build_object('default_lifetime_turns', 5, 'severity_decay_per_turn', 0),
    'ice',         jsonb_build_object('default_lifetime_turns', 4, 'severity_decay_per_turn', 0),
    'poison',      jsonb_build_object('default_lifetime_turns', 5, 'severity_decay_per_turn', 1),
    'blood',       jsonb_build_object('default_lifetime_turns', 4, 'severity_decay_per_turn', 0),
    'electricity', jsonb_build_object('default_lifetime_turns', 1, 'severity_decay_per_turn', 1),
    'smoke',       jsonb_build_object('default_lifetime_turns', 3, 'severity_decay_per_turn', 1),
    'web',         jsonb_build_object('default_lifetime_turns', 4, 'severity_decay_per_turn', 0)
  ),
  'Default lifetime + per-turn severity decay per surface type.'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
