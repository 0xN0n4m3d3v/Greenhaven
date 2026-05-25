-- Spec 36 §7 — surface combo + decay extensions.
--
-- §5 (dialogue partner switch) is implemented at the column level:
-- switch_dialogue_partner writes to players.dialogue_partner_id (the
-- existing source of truth) rather than introducing a parallel
-- runtime_field. Documented as deviation in EXECUTION_LOG.
--
-- §7 extends cartridge_meta.surface_combo_rules (created spec 33) with
-- water+fire→steam, acid+armor→corroded, lava+any→fire. Also extends
-- surface_decay with steam/acid/lava/web entries.
-- Spec 33 stored these as cartridge_meta JSONB rather than separate
-- surface_combo_rules / surface_effects tables, so we patch the JSONB
-- in place.

-- Extend surface_combo_rules (cartridge_meta JSONB).
UPDATE cartridge_meta
SET value = value || jsonb_build_array(
  jsonb_build_object(
    'a', 'water', 'b', 'fire',
    'result', 'steam',
    'side_effects', jsonb_build_array(
      jsonb_build_object('apply_condition', 'obscured', 'severity', 1, 'duration', 2),
      jsonb_build_object('replace_surface', 'steam', 'severity', 1)
    ),
    'narrate_hint', 'Water meets flame; the room hisses into a thick veil of steam.'
  ),
  jsonb_build_object(
    'a', 'acid', 'b', 'metal_armor',
    'result', 'corroded',
    'side_effects', jsonb_build_array(
      jsonb_build_object('apply_condition', 'corroded', 'severity', 1, 'duration', 4),
      jsonb_build_object('damage', 4, 'type', 'acid')
    ),
    'narrate_hint', 'The acid sizzles against metal; armour pits and weakens.'
  ),
  jsonb_build_object(
    'a', 'lava', 'b', 'any',
    'result', 'fire',
    'side_effects', jsonb_build_array(
      jsonb_build_object('damage', 12, 'type', 'fire'),
      jsonb_build_object('replace_surface', 'fire', 'severity', 2)
    ),
    'narrate_hint', 'Whatever crosses the lava ignites; flame remains where the heat passed.'
  )
)
WHERE key = 'surface_combo_rules'
  AND NOT (value @> '[{"a":"water","b":"fire"}]'::jsonb);

-- Extend surface_decay with new surface lifetimes.
UPDATE cartridge_meta
SET value = value || jsonb_build_object(
  'steam', jsonb_build_object('default_lifetime_turns', 2, 'severity_decay_per_turn', 1),
  'acid',  jsonb_build_object('default_lifetime_turns', 4, 'severity_decay_per_turn', 0),
  'lava',  jsonb_build_object('default_lifetime_turns', 8, 'severity_decay_per_turn', 0),
  'web',   jsonb_build_object('default_lifetime_turns', 4, 'severity_decay_per_turn', 0)
)
WHERE key = 'surface_decay'
  AND NOT (value ? 'steam');
