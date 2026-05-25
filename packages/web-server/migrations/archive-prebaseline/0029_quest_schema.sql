-- Spec 21 — Quest authoring contract.
--
-- Adds stage tracking to player_quests + scratchpad + path-taken
-- history. Backfills "Mikka's Private Price" with the full stage
-- schema and seeds a second test quest "Mikka's Trust" (entity 700).
-- See plans/quests-roadmap.md and the spec body for the full schema
-- contract on entities[kind='quest'].profile.

ALTER TABLE player_quests
  ADD COLUMN IF NOT EXISTS current_stage_id text,
  ADD COLUMN IF NOT EXISTS accumulated_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS path_taken jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE entities SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
  'tags', jsonb_build_array('intimacy'),
  'partner', 'Mikka Quickgrin',
  'stages', jsonb_build_array(
    jsonb_build_object(
      'id', 'initiation',
      'name', 'Initiation',
      'description', 'The active player commits to the encounter - pays in coin or in body, signs the deal.',
      'objectives', jsonb_build_array(
        jsonb_build_object('kind', 'tool_called', 'tool', 'string_award',
          'args_match', jsonb_build_object('npc', 'Mikka Quickgrin', 'delta_min', 1))
      ),
      'advance_on', 'all_objectives_complete',
      'next_stage', 'escalation'
    ),
    jsonb_build_object(
      'id', 'escalation',
      'name', 'Escalation',
      'description', 'The encounter intensifies; Mikka becomes vocal.',
      'objectives', jsonb_build_array(
        jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 200,
          'field_key', 'arousal_level', 'op', '>=', 'value', 50)
      ),
      'advance_on', 'all_objectives_complete',
      'next_stage', 'climax'
    ),
    jsonb_build_object(
      'id', 'climax',
      'name', 'Mutual climax',
      'description', 'Both parties reach the peak.',
      'objectives', jsonb_build_array(
        jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 200,
          'field_key', 'satisfaction_level', 'op', '>=', 'value', 90)
      ),
      'advance_on', 'all_objectives_complete',
      'next_stage', null
    )
  ),
  'rewards', jsonb_build_object(
    'xp', 75,
    'strings', jsonb_build_array(jsonb_build_object('npc', 'Mikka Quickgrin', 'delta', 1)),
    'memory', jsonb_build_object(
      'owner', 'Mikka Quickgrin', 'about', NULL,
      'text', 'A real one. Paid in body and felt every coin.',
      'importance', 0.85
    ),
    'sex_move_eligible', true
  ),
  'failure_conditions', jsonb_build_array(
    jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 200,
      'field_key', 'mood_string', 'op', '==', 'value', 'reluctant')
  )
) WHERE display_name = 'Mikka''s Private Price' AND kind = 'quest';

INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES (
  700, 'quest', 'Mikka''s Trust',
  'Earn enough strings on Mikka without sleeping with her to unlock a permanent info-broker discount.',
  jsonb_build_object(
    'tags', jsonb_build_array('social'),
    'partner', 'Mikka Quickgrin',
    'stages', jsonb_build_array(
      jsonb_build_object(
        'id', 'first-string',
        'name', 'First trust earned',
        'description', 'The active player earns their first string on Mikka through helpful action, not seduction.',
        'objectives', jsonb_build_array(
          jsonb_build_object('kind', 'string_threshold', 'npc', 'Mikka Quickgrin',
            'op', '>=', 'value', 1)
        ),
        'advance_on', 'all_objectives_complete',
        'next_stage', 'second-string'
      ),
      jsonb_build_object(
        'id', 'second-string',
        'name', 'Trust deepens',
        'description', 'The bond grows beyond a single moment of leverage.',
        'objectives', jsonb_build_array(
          jsonb_build_object('kind', 'string_threshold', 'npc', 'Mikka Quickgrin',
            'op', '>=', 'value', 3)
        ),
        'advance_on', 'all_objectives_complete',
        'next_stage', null
      )
    ),
    'rewards', jsonb_build_object(
      'xp', 50,
      'memory', jsonb_build_object(
        'owner', 'Mikka Quickgrin', 'about', NULL,
        'text', 'Earned my trust without bedding me. Worth keeping around.',
        'importance', 0.75
      ),
      'permanent_field_patches', jsonb_build_array(
        jsonb_build_object('owner_entity_id', 200, 'field_key', 'info_discount_for_player', 'value', true)
      )
    ),
    'failure_conditions', '[]'::jsonb
  ),
  ARRAY['quest', 'social', 'mikka-arc']::text[]
)
ON CONFLICT (id) DO NOTHING;
