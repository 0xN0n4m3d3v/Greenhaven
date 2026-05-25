-- Rebuild location density from the runtime contracts the game actually uses.
--
-- Root cause fixed here: the imported cartridge can connect content through
-- home/location fields, local_density, scene participants, activity NPC links,
-- and quest givers. Runtime surfaces must see the same graph instead of
-- trusting only a stale generated local_density blob.

WITH density AS (
  SELECT
    l.id AS location_id,
    ARRAY(
     SELECT DISTINCT linked.id
       FROM (
          SELECT p.id
            FROM entities p
           WHERE p.kind = 'person'
             AND (
               p.profile->>'home_id' = l.id::text
               OR p.profile->>'current_location_id' = l.id::text
               OR p.profile->>'location_id' = l.id::text
             )

          UNION ALL
          SELECT value::bigint AS id
            FROM jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(l.profile->'local_density'->'npc_ids') = 'array'
                THEN l.profile->'local_density'->'npc_ids'
                ELSE '[]'::jsonb
              END
            ) AS value
           WHERE value ~ '^[0-9]+$'

          UNION ALL
          SELECT value::bigint AS id
            FROM entities s
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(s.profile->'participant_entity_ids') = 'array'
                THEN s.profile->'participant_entity_ids'
                ELSE '[]'::jsonb
              END
            ) AS value
           WHERE s.kind = 'scene'
             AND s.profile->>'location_id' = l.id::text
             AND value ~ '^[0-9]+$'

          UNION ALL
          SELECT (a.profile->>'npc_entity_id')::bigint AS id
            FROM entities a
           WHERE a.kind = 'activity'
             AND a.profile->>'location_id' = l.id::text
             AND a.profile->>'npc_entity_id' ~ '^[0-9]+$'

          UNION ALL
          SELECT giver.value::bigint AS id
            FROM entities q
            CROSS JOIN LATERAL (
              VALUES
                (q.profile->>'giver_entity_id'),
                (q.profile->>'giver_id'),
                (q.profile->>'quest_giver_id'),
                (q.profile->>'source_entity_id')
            ) AS giver(value)
           WHERE q.kind = 'quest'
             AND q.profile->>'location_id' = l.id::text
             AND giver.value ~ '^[0-9]+$'
        ) linked
       JOIN entities p ON p.id = linked.id AND p.kind = 'person'
       ORDER BY linked.id
       LIMIT 32
    ) AS npc_ids,
    ARRAY(
      SELECT child.id
        FROM entities child
       WHERE child.kind IN ('location', 'district')
         AND child.profile->>'topology_parent_id' = l.id::text
       ORDER BY child.id
       LIMIT 24
    ) AS child_location_ids,
    ARRAY(
      SELECT s.id
        FROM entities s
       WHERE s.kind = 'scene'
         AND s.profile->>'location_id' = l.id::text
       ORDER BY s.id
       LIMIT 24
    ) AS scene_ids,
    ARRAY(
      SELECT e.id
        FROM entities e
       WHERE e.kind = 'event'
         AND e.profile->>'location_id' = l.id::text
       ORDER BY e.id
       LIMIT 16
    ) AS event_ids,
    ARRAY(
      SELECT a.id
        FROM entities a
       WHERE a.kind = 'activity'
         AND a.profile->>'location_id' = l.id::text
       ORDER BY a.id
       LIMIT 16
    ) AS activity_ids,
    ARRAY(
      SELECT q.id
        FROM entities q
       WHERE q.kind = 'quest'
         AND q.profile->>'location_id' = l.id::text
       ORDER BY q.id
       LIMIT 12
    ) AS quest_ids
  FROM entities l
  WHERE l.kind IN ('location', 'district')
)
UPDATE entities l
   SET profile = COALESCE(l.profile, '{}'::jsonb)
      || jsonb_build_object(
           'local_density',
           jsonb_build_object(
             'child_location_ids', to_jsonb(d.child_location_ids),
             'npc_ids', to_jsonb(d.npc_ids),
             'scene_ids', to_jsonb(d.scene_ids),
             'event_ids', to_jsonb(d.event_ids),
             'activity_ids', to_jsonb(d.activity_ids),
             'quest_ids', to_jsonb(d.quest_ids)
           ),
           'local_density_summary',
           jsonb_build_object(
             'child_location_count', cardinality(d.child_location_ids),
             'npc_count', cardinality(d.npc_ids),
             'scene_count', cardinality(d.scene_ids),
             'event_count', cardinality(d.event_ids),
             'activity_count', cardinality(d.activity_ids),
             'quest_count', cardinality(d.quest_ids)
           )
         ),
       updated_at = now()
  FROM density d
 WHERE l.id = d.location_id;
