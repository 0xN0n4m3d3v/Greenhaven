-- Spec 24 — Quest mechanics integration. Extend "Mikka's Trust"
-- (entity 700, seeded by 0029) with prerequisites + per-stage
-- bargain + richer rewards.
--
-- Idempotent: re-running just rewrites the profile keys. Safe even
-- if entity 700 wasn't seeded by 0029 (UPDATE matches zero rows,
-- still no error).

UPDATE entities SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
  'stages', jsonb_build_array(
    jsonb_build_object(
      'id', 'first-string',
      'name', 'First trust earned',
      'description', 'The active player earns their first string on Mikka through helpful action, not seduction.',
      'prerequisites', jsonb_build_array(
        jsonb_build_object('kind', 'trauma_absent', 'tag', 'bitter')
      ),
      'objectives', jsonb_build_array(
        jsonb_build_object('kind', 'string_threshold', 'npc', 'Mikka Quickgrin', 'op', '>=', 'value', 1)
      ),
      'advance_on', 'all_objectives_complete',
      'next_stage', 'second-string'
    ),
    jsonb_build_object(
      'id', 'second-string',
      'name', 'Trust deepens',
      'description', 'The bond grows beyond a single moment of leverage.',
      'prerequisites', jsonb_build_array(
        jsonb_build_object('kind', 'trauma_absent', 'tag', 'bitter')
      ),
      'objectives', jsonb_build_array(
        jsonb_build_object('kind', 'string_threshold', 'npc', 'Mikka Quickgrin', 'op', '>=', 'value', 3),
        jsonb_build_object('kind', 'last_dice_effect', 'min_level', 'standard')
      ),
      'advance_on', 'all_objectives_complete',
      'next_stage', null,
      'bargain', jsonb_build_object(
        'text', 'You can lean hard enough on the bond to tip her into telling you everything (+1d on the persuade), but she will hold a mark on you afterward — Mikka takes 1 String on you regardless of the roll.',
        'complication_tool', 'string_award',
        'complication_args', jsonb_build_object('npc', 'Mikka Quickgrin', 'delta', 1)
      )
    )
  ),
  'rewards', jsonb_build_object(
    'xp', 50,
    'strings', jsonb_build_array(jsonb_build_object('npc', 'Mikka Quickgrin', 'delta', 1)),
    'permanent_field_patches', jsonb_build_array(
      jsonb_build_object(
        'owner_entity_id', 200,
        'field_key', 'info_discount_for_player',
        'value', true
      )
    ),
    'memory', jsonb_build_object(
      'owner', 'Mikka Quickgrin', 'about', NULL,
      'text', 'Earned my trust without bedding me. Discounts apply.',
      'importance', 0.8
    )
  )
) WHERE id = 700;
