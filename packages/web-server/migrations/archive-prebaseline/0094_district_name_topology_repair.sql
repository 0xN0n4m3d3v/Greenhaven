-- Re-apply geographic district parenting after the Cartridge Forge upsert.
--
-- Background. 0082 (compile-grinhaven-cartridge.ts) computes the right
-- topology_parent_id for discovered venues by matching distinctive district
-- tokens in the venue's display name (Sunfields Fellowship Hall → district
-- 201007 The Sunfields, not power-center 201020 Authority). 0084
-- (Cartridge Forge upsert) re-INSERTs those same entity rows with
-- ON CONFLICT DO UPDATE SET profile = EXCLUDED.profile, which silently
-- restores whatever topology_parent_id was in the forge export — usually
-- the older power-center value or NULL. The compile-script fix is
-- therefore invisible at runtime.
--
-- This migration runs after 0084 and re-derives topology_parent_id from
-- the venue's display name (and source_path / source_slug) using the
-- same distinctive-token list as the compile script. The mapping is
-- hardcoded by district id so adding a new district is an explicit
-- act, not an over-greedy substring match.
--
-- Tokens chosen for high specificity:
--   steelgate  → 201001 Steelgate Ward
--   velvet     → 201002 The Velvet Quarter
--   holyhigh   → 201004 Holyhigh
--   hearthreach→ 201005 Hearthreach
--   sunfields  → 201007 The Sunfields
-- Coin Tier (201003) and The Silver Below (201006) are skipped: "coin"
-- and "silver" appear in too many unrelated venue names ("Silver Cellar"
-- is its own playable venue 201011). Add them later if/when the
-- cartridge data acquires distinctive Coin/Silver venues that need
-- routing.
--
-- We only re-parent when the current parent is NULL or one of the three
-- power-centers (201009 Guildhall, 201019 Ale & Eats, 201020 Authority).
-- Venues already parented to a real district or a specific venue chain
-- are left alone — geography wins over function, but a deliberate
-- non-power-center parent is treated as authored data.

WITH district_tokens(district_id, token) AS (
  VALUES
    (201001::bigint, 'steelgate'),
    (201002::bigint, 'velvet'),
    (201004::bigint, 'holyhigh'),
    (201005::bigint, 'hearthreach'),
    (201007::bigint, 'sunfields')
),
candidates AS (
  SELECT
    l.id AS location_id,
    dt.district_id,
    length(dt.token) AS specificity
    FROM entities l
    JOIN district_tokens dt
      ON l.kind = 'location'
     AND l.id <> dt.district_id
     AND (
       lower(l.display_name) LIKE '%' || dt.token || '%'
       OR lower(COALESCE(l.profile->>'source_slug', '')) LIKE '%' || dt.token || '%'
       OR lower(COALESCE(l.profile->>'source_path', '')) LIKE '%' || dt.token || '%'
       OR lower(COALESCE(l.profile->>'discovered_from', '')) LIKE '%' || dt.token || '%'
     )
   WHERE COALESCE(l.profile->>'location_kind', '') NOT IN ('district', 'hub')
     AND (
       l.profile->>'topology_parent_id' IS NULL
       OR (l.profile->>'topology_parent_id')::bigint IN (201009, 201019, 201020)
     )
),
ranked AS (
  -- A venue may match more than one district token (rare, but possible
  -- with composite names). Prefer the longer token = more specific.
  SELECT DISTINCT ON (location_id)
         location_id,
         district_id
    FROM candidates
   ORDER BY location_id, specificity DESC, district_id
)
UPDATE entities l
   SET profile = COALESCE(l.profile, '{}'::jsonb)
      || jsonb_build_object(
           'topology_parent_id',     r.district_id,
           'topology_parent_method', 'district_name_match_repair',
           'topology_layer',         'location'
         )
      -- Inherit the district's power_center_id/role so the venue keeps
      -- its political alignment for power-center-roster surfaces.
      || COALESCE(
           (SELECT jsonb_build_object(
                     'power_center_id',   d.profile->'power_center_id',
                     'power_center_role', d.profile->'power_center_role'
                   )
              FROM entities d
             WHERE d.id = r.district_id),
           '{}'::jsonb
         ),
       updated_at = now()
  FROM ranked r
 WHERE l.id = r.location_id;

-- After topology_parent_id moved, re-derive both local_density and
-- transitive_density_summary so districts immediately reflect their
-- new descendants and the rollup numbers stay consistent without
-- waiting for the next full migration sweep.

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
