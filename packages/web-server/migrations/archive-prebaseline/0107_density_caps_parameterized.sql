-- 0107_density_caps_parameterized.sql
--
-- M-3 — make local-density rebuild caps cartridge-configurable.
--
-- 0104 introduced `rebuild_local_density(target_cartridge text)` with
-- hardcoded caps (16 npcs, 12 scenes / events / activities, 8 quests,
-- 24 child_locations). Operators or cartridge authors can now override
-- those caps without editing migrations:
--
--   UPDATE cartridge_meta
--      SET value = '{"npcs": 24, "scenes": 18}'::jsonb
--    WHERE key = 'density_caps';
--
-- Defaults stored in `cartridge_meta.density_caps` match the 0104
-- behavior bit-for-bit when missing. The TS wrapper in
-- `packages/web-server/src/density/index.ts` reads the row, sanitizes
-- per-key, and calls this function with explicit parameters.
--
-- ARCH-19 Phase 3 — this revision of the function also reads from
-- `entities.cartridge_id` and `entities.topology_parent_id` columns
-- instead of `profile->>'cartridge_id'` / `profile->>'topology_parent_id'`.
-- 0106 backfilled both columns; Phase 4 will eventually drop the legacy
-- JSONB keys.

-- The 0104 function had a single-text signature. Drop it before
-- creating the parameterized variant so a one-argument call resolves
-- unambiguously to the new function (overload disambiguation in
-- PostgreSQL fails otherwise: "function rebuild_local_density(unknown)
-- is not unique").
DROP FUNCTION IF EXISTS rebuild_local_density(text);

CREATE OR REPLACE FUNCTION rebuild_local_density(
  target_cartridge text,
  max_npcs int DEFAULT 16,
  max_child_locations int DEFAULT 24,
  max_scenes int DEFAULT 12,
  max_events int DEFAULT 12,
  max_activities int DEFAULT 12,
  max_quests int DEFAULT 8
)
RETURNS TABLE(location_id bigint, npc_count int, child_count int)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Phase 1: strict local density. Counts/arrays of direct ownership
  -- only, no UNION with previous values. Limits come from the
  -- parameters so cartridges can scale them via `cartridge_meta`.
  WITH strict_density AS (
    SELECT
      l.id AS loc_id,
      ARRAY(
        SELECT child.id
          FROM entities child
         WHERE child.kind IN ('location', 'district')
           AND child.topology_parent_id = l.id
           AND child.cartridge_id = target_cartridge
         ORDER BY child.id
         LIMIT max_child_locations
      ) AS child_location_ids,
      ARRAY(
        SELECT p.id
          FROM entities p
         WHERE p.kind = 'person'
           AND p.profile->>'home_id' = l.id::text
           AND p.cartridge_id = target_cartridge
         ORDER BY p.id
         LIMIT max_npcs
      ) AS npc_ids,
      ARRAY(
        SELECT s.id
          FROM entities s
         WHERE s.kind = 'scene'
           AND s.profile->>'location_id' = l.id::text
           AND s.cartridge_id = target_cartridge
         ORDER BY s.id
         LIMIT max_scenes
      ) AS scene_ids,
      ARRAY(
        SELECT e.id
          FROM entities e
         WHERE e.kind = 'event'
           AND e.profile->>'location_id' = l.id::text
           AND e.cartridge_id = target_cartridge
         ORDER BY e.id
         LIMIT max_events
      ) AS event_ids,
      ARRAY(
        SELECT a.id
          FROM entities a
         WHERE a.kind = 'activity'
           AND a.profile->>'location_id' = l.id::text
           AND a.cartridge_id = target_cartridge
         ORDER BY a.id
         LIMIT max_activities
      ) AS activity_ids,
      ARRAY(
        SELECT q.id
          FROM entities q
         WHERE q.kind = 'quest'
           AND q.profile->>'location_id' = l.id::text
           AND q.cartridge_id = target_cartridge
         ORDER BY q.id
         LIMIT max_quests
      ) AS quest_ids
    FROM entities l
    WHERE l.kind IN ('location', 'district')
      AND l.cartridge_id = target_cartridge
  )
  UPDATE entities target
     SET profile = COALESCE(target.profile, '{}'::jsonb)
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
   WHERE target.id = d.loc_id;

  -- Phase 2: transitive density rollup, depth-capped at 8 (matches
  -- 0093/0104). M-4 will instrument the depth cap with telemetry; the
  -- cap itself stays here for now.
  WITH RECURSIVE descendants(root_id, node_id, depth) AS (
    SELECT l.id, l.id, 0
      FROM entities l
     WHERE l.kind IN ('location', 'district')
       AND l.cartridge_id = target_cartridge
    UNION ALL
    SELECT d.root_id, child.id, d.depth + 1
      FROM descendants d
      JOIN entities child
        ON child.kind IN ('location', 'district')
       AND child.topology_parent_id = d.node_id
       AND child.cartridge_id = target_cartridge
     WHERE d.depth < 8
  ),
  rollup AS (
    SELECT
      d.root_id AS loc_id,
      SUM(COALESCE((n.profile->'local_density_summary'->>'npc_count')::int, 0))      AS npc_count,
      SUM(COALESCE((n.profile->'local_density_summary'->>'scene_count')::int, 0))    AS scene_count,
      SUM(COALESCE((n.profile->'local_density_summary'->>'event_count')::int, 0))    AS event_count,
      SUM(COALESCE((n.profile->'local_density_summary'->>'activity_count')::int, 0)) AS activity_count,
      SUM(COALESCE((n.profile->'local_density_summary'->>'quest_count')::int, 0))    AS quest_count,
      COUNT(*) FILTER (WHERE d.depth > 0)                                            AS descendant_location_count,
      MAX(d.depth)                                                                   AS max_depth
      FROM descendants d
      JOIN entities n ON n.id = d.node_id
     GROUP BY d.root_id
  )
  UPDATE entities target
     SET profile = COALESCE(target.profile, '{}'::jsonb)
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
   WHERE target.id = r.loc_id
     AND target.kind IN ('location', 'district');

  RETURN QUERY
    SELECT
      l.id AS location_id,
      COALESCE(
        (l.profile->'local_density_summary'->>'npc_count')::int,
        0
      ) AS npc_count,
      COALESCE(
        (l.profile->'local_density_summary'->>'child_location_count')::int,
        0
      ) AS child_count
    FROM entities l
    WHERE l.kind IN ('location', 'district')
      AND l.cartridge_id = target_cartridge
    ORDER BY l.id;
END;
$$;

COMMENT ON FUNCTION rebuild_local_density(text, int, int, int, int, int, int) IS
  'M-3: parameterized local_density / transitive_density rebuild. Default '
  'caps (16 npcs, 24 child_locations, 12 scenes / events / activities, 8 '
  'quests) match 0093/0104 behavior. Reads cartridge_id / '
  'topology_parent_id columns (ARCH-19 Phase 3). Depth cap stays 8 '
  '(M-4 will add telemetry). Idempotent.';

-- Seed default density_caps in cartridge_meta if absent. Existing
-- operator/cartridge values are preserved.
INSERT INTO cartridge_meta (key, value, description)
VALUES (
  'density_caps',
  jsonb_build_object(
    'npcs', 16,
    'child_locations', 24,
    'scenes', 12,
    'events', 12,
    'activities', 12,
    'quests', 8
  ),
  'M-3: local_density rebuild caps. Override via UPDATE to scale per cartridge.'
)
ON CONFLICT (key) DO NOTHING;

-- Apply once against the active fixture cartridge using the seeded
-- defaults. On a database that has already passed 0104 this is a
-- state-preserving no-op (the algorithm is deterministic in cap
-- values and inputs).
SELECT rebuild_local_density('grinhaven-full');
