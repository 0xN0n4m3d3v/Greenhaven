-- 0104_density_rebuild_function.sql
--
-- M-1 — extract the final 0093 local-density / transitive-density rebuild
-- into a reusable server-side function.
--
-- History (see docs/db/density-history.md):
--   0091 — initial density rebuild from runtime contracts. Bugged: its CTE
--          UNION-ed existing local_density.npc_ids back in, so power-center
--          duplicates survived.
--   0092 — partial repair pass; still left drift.
--   0093 — strict local_density rebuild + transitive_density_summary. This
--          is the final correct algorithm.
--   0094 — district topology repair pass needed because forge upserts in
--          0082 and the desktop-electron migration snapshots (0078-0082,
--          0096, 0099, 0100, etc.) used `profile = EXCLUDED.profile`,
--          clobbering computed fields. M-2 (migration 0103) prevents
--          that recurrence at the forge layer.
--
-- After M-2, future migrations / re-imports no longer need to repair
-- density. But the rebuild algorithm is still useful for:
--   - explicit on-demand recomputation when a cartridge ships new
--     density-affecting entities;
--   - regression tests that deliberately dirty density rows and verify
--     the rebuild restores them.
--
-- This migration defines `rebuild_local_density(target_cartridge text)`,
-- then invokes it once against the active fixture cartridge
-- ('grinhaven-full'). The first invocation against a database that has
-- already passed through 0093 + 0094 + 0103 is a no-op in terms of state
-- because the algorithm is deterministic and the inputs have not
-- changed; the function is idempotent by construction. Tests in
-- src/__tests__/migrations/invariants.test.ts exercise the idempotence
-- and dirty-row repair contracts.

CREATE OR REPLACE FUNCTION rebuild_local_density(target_cartridge text)
RETURNS TABLE(location_id bigint, npc_count int, child_count int)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Phase 1: strict local density. Counts/arrays of direct ownership
  -- only (home_id / location_id / topology_parent_id pointing at this
  -- location). No UNION with previous values; this is the cache, not a
  -- denormalised mirror of the runtime UNION used by
  -- loadPresentPeopleAtLocation. Caps mirror 0093 (16 npcs, 12 scenes /
  -- events / activities, 8 quests, 24 child_locations) — parameterising
  -- the caps belongs to M-3.
  WITH strict_density AS (
    SELECT
      l.id AS loc_id,
      ARRAY(
        SELECT child.id
          FROM entities child
         WHERE child.kind IN ('location', 'district')
           AND child.profile->>'topology_parent_id' = l.id::text
           AND child.profile->>'cartridge_id' = target_cartridge
         ORDER BY child.id
         LIMIT 24
      ) AS child_location_ids,
      ARRAY(
        SELECT p.id
          FROM entities p
         WHERE p.kind = 'person'
           AND p.profile->>'home_id' = l.id::text
           AND p.profile->>'cartridge_id' = target_cartridge
         ORDER BY p.id
         LIMIT 16
      ) AS npc_ids,
      ARRAY(
        SELECT s.id
          FROM entities s
         WHERE s.kind = 'scene'
           AND s.profile->>'location_id' = l.id::text
           AND s.profile->>'cartridge_id' = target_cartridge
         ORDER BY s.id
         LIMIT 12
      ) AS scene_ids,
      ARRAY(
        SELECT e.id
          FROM entities e
         WHERE e.kind = 'event'
           AND e.profile->>'location_id' = l.id::text
           AND e.profile->>'cartridge_id' = target_cartridge
         ORDER BY e.id
         LIMIT 12
      ) AS event_ids,
      ARRAY(
        SELECT a.id
          FROM entities a
         WHERE a.kind = 'activity'
           AND a.profile->>'location_id' = l.id::text
           AND a.profile->>'cartridge_id' = target_cartridge
         ORDER BY a.id
         LIMIT 12
      ) AS activity_ids,
      ARRAY(
        SELECT q.id
          FROM entities q
         WHERE q.kind = 'quest'
           AND q.profile->>'location_id' = l.id::text
           AND q.profile->>'cartridge_id' = target_cartridge
         ORDER BY q.id
         LIMIT 8
      ) AS quest_ids
    FROM entities l
    WHERE l.kind IN ('location', 'district')
      AND l.profile->>'cartridge_id' = target_cartridge
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

  -- Phase 2: transitive density rollup, depth-capped at 8 (matches 0093).
  WITH RECURSIVE descendants(root_id, node_id, depth) AS (
    SELECT l.id, l.id, 0
      FROM entities l
     WHERE l.kind IN ('location', 'district')
       AND l.profile->>'cartridge_id' = target_cartridge
    UNION ALL
    SELECT d.root_id, child.id, d.depth + 1
      FROM descendants d
      JOIN entities child
        ON child.kind IN ('location', 'district')
       AND child.profile->>'topology_parent_id' = d.node_id::text
       AND child.profile->>'cartridge_id' = target_cartridge
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
      AND l.profile->>'cartridge_id' = target_cartridge
    ORDER BY l.id;
END;
$$;

COMMENT ON FUNCTION rebuild_local_density(text) IS
  'M-1: idempotent local_density + transitive_density_summary rebuild '
  'scoped to a single cartridge. Algorithm matches 0093 (strict local + '
  'depth-8 transitive rollup). Cap parameterisation is M-3 work.';

-- Apply once against the active fixture cartridge. On a fresh database
-- that has just run 0091-0094 the inputs are unchanged, so this call is
-- a state-preserving no-op (idempotence is a tested invariant).
SELECT rebuild_local_density('grinhaven-full');
