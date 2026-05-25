-- Repair density lists after generalized linkage rebuild:
-- every local_density bucket must contain only entities of the matching kind.

WITH fixed AS (
  SELECT
    l.id AS location_id,
    ARRAY(
      SELECT DISTINCT value::bigint
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(l.profile->'local_density'->'npc_ids') = 'array'
            THEN l.profile->'local_density'->'npc_ids'
            ELSE '[]'::jsonb
          END
        ) AS value
        JOIN entities e ON e.id = value::bigint AND e.kind = 'person'
       WHERE value ~ '^[0-9]+$'
       ORDER BY value::bigint
    ) AS npc_ids,
    ARRAY(
      SELECT DISTINCT value::bigint
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(l.profile->'local_density'->'child_location_ids') = 'array'
            THEN l.profile->'local_density'->'child_location_ids'
            ELSE '[]'::jsonb
          END
        ) AS value
        JOIN entities e ON e.id = value::bigint AND e.kind IN ('location', 'district')
       WHERE value ~ '^[0-9]+$'
       ORDER BY value::bigint
    ) AS child_location_ids,
    ARRAY(
      SELECT DISTINCT value::bigint
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(l.profile->'local_density'->'scene_ids') = 'array'
            THEN l.profile->'local_density'->'scene_ids'
            ELSE '[]'::jsonb
          END
        ) AS value
        JOIN entities e ON e.id = value::bigint AND e.kind = 'scene'
       WHERE value ~ '^[0-9]+$'
       ORDER BY value::bigint
    ) AS scene_ids,
    ARRAY(
      SELECT DISTINCT value::bigint
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(l.profile->'local_density'->'event_ids') = 'array'
            THEN l.profile->'local_density'->'event_ids'
            ELSE '[]'::jsonb
          END
        ) AS value
        JOIN entities e ON e.id = value::bigint AND e.kind = 'event'
       WHERE value ~ '^[0-9]+$'
       ORDER BY value::bigint
    ) AS event_ids,
    ARRAY(
      SELECT DISTINCT value::bigint
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(l.profile->'local_density'->'activity_ids') = 'array'
            THEN l.profile->'local_density'->'activity_ids'
            ELSE '[]'::jsonb
          END
        ) AS value
        JOIN entities e ON e.id = value::bigint AND e.kind = 'activity'
       WHERE value ~ '^[0-9]+$'
       ORDER BY value::bigint
    ) AS activity_ids,
    ARRAY(
      SELECT DISTINCT value::bigint
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(l.profile->'local_density'->'quest_ids') = 'array'
            THEN l.profile->'local_density'->'quest_ids'
            ELSE '[]'::jsonb
          END
        ) AS value
        JOIN entities e ON e.id = value::bigint AND e.kind = 'quest'
       WHERE value ~ '^[0-9]+$'
       ORDER BY value::bigint
    ) AS quest_ids
  FROM entities l
  WHERE l.kind IN ('location', 'district')
)
UPDATE entities l
   SET profile = COALESCE(l.profile, '{}'::jsonb)
      || jsonb_build_object(
           'local_density',
           jsonb_build_object(
             'child_location_ids', to_jsonb(f.child_location_ids),
             'npc_ids', to_jsonb(f.npc_ids),
             'scene_ids', to_jsonb(f.scene_ids),
             'event_ids', to_jsonb(f.event_ids),
             'activity_ids', to_jsonb(f.activity_ids),
             'quest_ids', to_jsonb(f.quest_ids)
           ),
           'local_density_summary',
           jsonb_build_object(
             'child_location_count', cardinality(f.child_location_ids),
             'npc_count', cardinality(f.npc_ids),
             'scene_count', cardinality(f.scene_ids),
             'event_count', cardinality(f.event_ids),
             'activity_count', cardinality(f.activity_ids),
             'quest_count', cardinality(f.quest_ids)
           )
         ),
       updated_at = now()
  FROM fixed f
 WHERE l.id = f.location_id;
