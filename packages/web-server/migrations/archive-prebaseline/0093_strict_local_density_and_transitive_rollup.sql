-- Strict local_density rebuild + transitive_density_summary for districts/hubs.
--
-- Background. 0091 was meant to rebuild density from runtime contracts, but
-- its CTE UNION-ed the existing local_density.npc_ids back in, so the
-- pre-existing power-center duplicates (NPCs of every district stuffed into
-- Guildhall, scenes/activities of every venue stuffed into Ale & Eats)
-- survived the "rebuild". The cartridge importer (compile-grinhaven-cartridge.ts)
-- has been changed in the same commit to stop emitting those duplicates;
-- this migration purges them from already-applied DBs.
--
-- New contract for local_density:
--   npc_ids       = persons with home_id        = this location
--   scene_ids     = scenes  with location_id    = this location
--   event_ids     = events  with location_id    = this location
--   activity_ids  = activities with location_id = this location
--   quest_ids     = quests  with location_id    = this location
--   child_location_ids = locations/districts whose topology_parent_id = this
-- "Reachable through scene/activity/quest" remains a *runtime* concern of
-- loadPresentPeopleAtLocation — local_density is now the cache of direct
-- ownership only, not a denormalised mirror of the runtime UNION.
--
-- transitive_density_summary aggregates the summary counts of this location
-- plus all its descendants (via topology_parent_id), so districts and hubs
-- can show their true reach without polluting their direct npc/scene lists.

WITH strict_density AS (
  SELECT
    l.id AS location_id,
    ARRAY(
      SELECT child.id
        FROM entities child
       WHERE child.kind IN ('location', 'district')
         AND child.profile->>'topology_parent_id' = l.id::text
       ORDER BY child.id
       LIMIT 24
    ) AS child_location_ids,
    ARRAY(
      SELECT p.id
        FROM entities p
       WHERE p.kind = 'person'
         AND p.profile->>'home_id' = l.id::text
       ORDER BY p.id
       LIMIT 16
    ) AS npc_ids,
    ARRAY(
      SELECT s.id
        FROM entities s
       WHERE s.kind = 'scene'
         AND s.profile->>'location_id' = l.id::text
       ORDER BY s.id
       LIMIT 12
    ) AS scene_ids,
    ARRAY(
      SELECT e.id
        FROM entities e
       WHERE e.kind = 'event'
         AND e.profile->>'location_id' = l.id::text
       ORDER BY e.id
       LIMIT 12
    ) AS event_ids,
    ARRAY(
      SELECT a.id
        FROM entities a
       WHERE a.kind = 'activity'
         AND a.profile->>'location_id' = l.id::text
       ORDER BY a.id
       LIMIT 12
    ) AS activity_ids,
    ARRAY(
      SELECT q.id
        FROM entities q
       WHERE q.kind = 'quest'
         AND q.profile->>'location_id' = l.id::text
       ORDER BY q.id
       LIMIT 8
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
             'npc_ids',            to_jsonb(d.npc_ids),
             'scene_ids',          to_jsonb(d.scene_ids),
             'event_ids',          to_jsonb(d.event_ids),
             'activity_ids',       to_jsonb(d.activity_ids),
             'quest_ids',          to_jsonb(d.quest_ids)
           ),
           'local_density_summary',
           jsonb_build_object(
             'child_location_count', cardinality(d.child_location_ids),
             'npc_count',            cardinality(d.npc_ids),
             'scene_count',          cardinality(d.scene_ids),
             'event_count',          cardinality(d.event_ids),
             'activity_count',       cardinality(d.activity_ids),
             'quest_count',          cardinality(d.quest_ids)
           )
         ),
       updated_at = now()
  FROM strict_density d
 WHERE l.id = d.location_id;

-- Transitive rollup: for each location L, sum the local_density_summary
-- counts of L and every descendant reachable via topology_parent_id.
WITH RECURSIVE descendants(root_id, node_id, depth) AS (
  SELECT l.id, l.id, 0
    FROM entities l
   WHERE l.kind IN ('location', 'district')
  UNION ALL
  SELECT d.root_id, child.id, d.depth + 1
    FROM descendants d
    JOIN entities child ON child.kind IN ('location', 'district')
                       AND child.profile->>'topology_parent_id' = d.node_id::text
   WHERE d.depth < 8
),
rollup AS (
  SELECT
    d.root_id AS location_id,
    SUM(COALESCE((n.profile->'local_density_summary'->>'npc_count')::int, 0))            AS npc_count,
    SUM(COALESCE((n.profile->'local_density_summary'->>'scene_count')::int, 0))          AS scene_count,
    SUM(COALESCE((n.profile->'local_density_summary'->>'event_count')::int, 0))          AS event_count,
    SUM(COALESCE((n.profile->'local_density_summary'->>'activity_count')::int, 0))       AS activity_count,
    SUM(COALESCE((n.profile->'local_density_summary'->>'quest_count')::int, 0))          AS quest_count,
    -- descendant_count excludes the root itself; depth=0 row is the root.
    COUNT(*) FILTER (WHERE d.depth > 0)                                                  AS descendant_location_count,
    MAX(d.depth)                                                                         AS max_depth
    FROM descendants d
    JOIN entities n ON n.id = d.node_id
   GROUP BY d.root_id
)
UPDATE entities l
   SET profile = COALESCE(l.profile, '{}'::jsonb)
      || jsonb_build_object(
           'transitive_density_summary',
           jsonb_build_object(
             'npc_count',                  r.npc_count,
             'scene_count',                r.scene_count,
             'event_count',                r.event_count,
             'activity_count',             r.activity_count,
             'quest_count',                r.quest_count,
             'descendant_location_count',  r.descendant_location_count,
             'max_depth',                  r.max_depth
           )
         ),
       updated_at = now()
  FROM rollup r
 WHERE l.id = r.location_id
   AND l.kind IN ('location', 'district');
