-- 0109_density_depth_cap_diagnostics_guard.sql
--
-- M-4 hardening — guard the depth-cap diagnostic INSERT against a
-- missing `migration_diagnostics` table.
--
-- 0108 added the table and the diagnostic INSERT in the same
-- migration, so the function and table ship together for any
-- forward-only deployment. This migration covers the operator-drift
-- case where the table is dropped or renamed after 0108 has run:
-- without a guard, every subsequent direct SQL `SELECT
-- rebuild_local_density(...)` call would fail with `undefined_table`
-- even though the density rebuild itself does not depend on the
-- table.
--
-- Body changes vs 0108:
--   - The diagnostic INSERT is wrapped in a PL/pgSQL sub-block with
--     an EXCEPTION WHEN undefined_table handler that swallows the
--     error. Other exceptions still propagate.
--   - Nothing else changes. The data-mutating Phase 1 + Phase 2
--     blocks are byte-for-byte identical to 0108. Signature,
--     defaults, return shape, normalized-column reads, and
--     one-argument call compatibility are preserved.
--
-- The TypeScript wrapper in `packages/web-server/src/density/index.ts`
-- carries the same best-effort discipline on the pre-rebuild
-- snapshot and the post-rebuild diagnostics read: the rebuild
-- always runs, telemetry emits only when diagnostics can be safely
-- read, and both diagnostic failures are logged-but-swallowed.

DROP FUNCTION IF EXISTS rebuild_local_density(text, int, int, int, int, int, int);

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
  -- Phase 1: strict local density. Same body as 0107/0108 — direct
  -- ownership only, parameterised caps, ARCH-19 Phase 3 columns.
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

  -- Phase 2: transitive rollup, depth-capped at 8. Same body as
  -- 0108. The depth check stays `< 8` so density JSON output is
  -- unchanged from 0107/0108.
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

  -- M-4 diagnostic INSERT, now wrapped in an exception sub-block so
  -- the rebuild succeeds even if `migration_diagnostics` was dropped
  -- after 0108 applied (operator drift). Other errors still
  -- propagate. Same payload shape as 0108: only fires for real
  -- truncation past depth 8, not for happy depth-8 alignment.
  BEGIN
    INSERT INTO migration_diagnostics (level, source, payload)
    SELECT
      'warn',
      'rebuild_local_density.depth_cap',
      jsonb_build_object(
        'target_cartridge',       target_cartridge,
        'root_id',                d8.root_id,
        'depth_cap',              8,
        'depth_cap_hit',          true,
        'truncated_child_count',  d8.truncated_child_count
      )
      FROM (
        WITH RECURSIVE walk(root_id, node_id, depth) AS (
          SELECT l.id, l.id, 0
            FROM entities l
           WHERE l.kind IN ('location', 'district')
             AND l.cartridge_id = target_cartridge
          UNION ALL
          SELECT w.root_id, child.id, w.depth + 1
            FROM walk w
            JOIN entities child
              ON child.kind IN ('location', 'district')
             AND child.topology_parent_id = w.node_id
             AND child.cartridge_id = target_cartridge
           WHERE w.depth < 8
        )
        SELECT
          w.root_id,
          COUNT(beyond.id) AS truncated_child_count
          FROM walk w
          JOIN entities beyond
            ON beyond.kind IN ('location', 'district')
           AND beyond.topology_parent_id = w.node_id
           AND beyond.cartridge_id = target_cartridge
         WHERE w.depth = 8
         GROUP BY w.root_id
        HAVING COUNT(beyond.id) > 0
      ) d8;
  EXCEPTION
    WHEN undefined_table THEN
      -- migration_diagnostics is gone: skip silently. The density
      -- rebuild has already mutated the rollup state successfully,
      -- and the TS wrapper carries the same best-effort discipline
      -- for its own diagnostics read.
      NULL;
  END;

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
  'M-3 + M-4 (0109): parameterised local_density / transitive_density '
  'rebuild with depth-cap diagnostics whose INSERT is guarded against '
  'undefined_table drift. Inserts a warn row into migration_diagnostics '
  'when the recursive descendants CTE truncates real topology past '
  'depth 8 (depth-8 alignment with no deeper descendants stays silent). '
  'Defaults match 0093/0104/0107/0108.';

-- No tail `SELECT rebuild_local_density(...)` here.  0109 only
-- replaces the function definition; the data-mutating phases are
-- byte-for-byte identical to 0108, so re-running on grinhaven-full
-- would be a state-preserving no-op for the density JSON and would
-- add ~25s to every cold migration template build.  0107 already
-- exercised the function once against the active fixture cartridge.
