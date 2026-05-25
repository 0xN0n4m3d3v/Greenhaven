-- Spec 20 — Sex moves (per-NPC) + Trauma (per-player).
--
-- Sex moves: each NPC with intimacy hooks ships a `profile.sex_move`
-- JSONB defining a permanent post-encounter effect. After the matching
-- intimacy quest completes, broker reads the sex_move and fires the
-- indicated effect_tool with the indicated effect_args.
--
-- Trauma: per-player runtime_field (id = 7000 + entity_id), JSONB array
-- of tag strings. Same shape as conditions (8000+) and strings (9000+),
-- so apply_runtime_field_patch op:append/op:remove from spec 17 just
-- works without bespoke SQL.

-- Mikka Quickgrin (200): post-climax intel leverage.
UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
         'sex_move', jsonb_build_object(
           'trigger', 'post_climax',
           'narrate_hint', 'Mikka now holds a piece of intel about the active player. She decides whether to keep it private or sell it on the next public scene where the topic could come up. Roll d20+CHA against DC 12 when that scene fires.',
           'effect_tool', 'add_memory',
           'effect_args', jsonb_build_object(
             'owner', 'Mikka Quickgrin',
             'about', NULL,
             'text', 'Knows something about the active player from intimate exposure. Pending: roll vs DC 12 on next public bargain.',
             'importance', 0.7,
             'tags', jsonb_build_array('intimate-aftermath', 'leverage', 'pending-roll')
           )
         )
       )
 WHERE id = 200 AND kind = 'person';

-- Borek (220): post-climax free-lodging effect at the Lantern.
UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
         'sex_move', jsonb_build_object(
           'trigger', 'post_climax',
           'narrate_hint', 'The active player now sleeps free at the Quiet Lantern Inn. Borek will not ask. Persists until the active player crosses Borek (then revoked).',
           'effect_tool', 'apply_runtime_field_patch',
           'effect_args', jsonb_build_object(
             'target_entity_id', 110,
             'patches', jsonb_build_array(
               jsonb_build_object('field_key', 'free_lodging_for_player_ids', 'value', 'add_current_player')
             )
           )
         )
       )
 WHERE id = 220 AND kind = 'person';

-- Supporting runtime_field on the Lantern (110) for the Borek effect.
INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  8110, 110, 'free_lodging_for_player_ids', 'json', '[]'::jsonb, NULL,
  'permanent', false,
  'Player ids who sleep free at the Lantern (post-Borek-intimacy effect).'
WHERE EXISTS (SELECT 1 FROM entities WHERE id = 110)
  AND NOT EXISTS (
    SELECT 1 FROM runtime_fields WHERE id = 8110
  );

-- Trauma runtime_field per existing player. New players get the field
-- seeded by createAnonymousPlayer (server code change in this spec).
INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
SELECT
  7000 + p.entity_id,
  p.entity_id,
  'trauma',
  'json',
  '[]'::jsonb,
  NULL,
  'permanent',
  false,
  'Accumulated Trauma tags from combat-resistance failures and quest catastrophes. After 4 entries, the character retires.'
FROM players p
WHERE NOT EXISTS (
  SELECT 1 FROM runtime_fields rf
  WHERE rf.owner_entity_id = p.entity_id AND rf.field_key = 'trauma'
);
