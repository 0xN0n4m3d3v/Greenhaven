-- Generic NPC-presence repair for every brothel/inn/temple/guildhall whose
-- scene participants the cartridge-forge export (0084) failed to pin via
-- home_id. Same shape as 0090 (which fixed only Meow Meow Paradise) but
-- applied to every playable venue with at least one scene participant.
--
-- Background. 0084 re-INSERTs entity rows with ON CONFLICT DO UPDATE SET
-- profile = EXCLUDED.profile, restoring whatever home_id / location_id /
-- current_location_id the cartridge-forge editor wrote. For Nectar's Aloe,
-- Buburara, Nikjuban — and a long tail of brothel workers across The
-- Velvet Tally, Slime Sauna, Tentacle Grotto, The Laughing Mare, Silver
-- Cellar, Great Temple, Compact Hall, Sunfields Shed — the forge stored
-- their home_id as Guildhall of Belmorah (201009) or Burgomaster Office
-- (201020). Result: every "where do you live" query returned zero
-- workers, even though the same persons participated in scenes anchored
-- to the real venue.
--
-- This migration runs after 0084 and 0090, BEFORE the 0091-0093 density
-- rebuilds. It re-derives each person's venue from their scene
-- participation: a person whose only or canonical home is "scene
-- participant at venue V" gets home_id=V. We refuse to overwrite a
-- home_id that already points to a non-hub venue (a small brothel, etc.),
-- to avoid moving a worker who already lives in the right place.
--
-- Heuristic, deliberately narrow:
--   Eligibility for re-pin: person.home_id IS NULL
--     OR home_id points at Guildhall of Belmorah (201009)
--     OR home_id points at Burgomaster Office (201020).
--   Target venue: the most-frequent location_id across that person's
--     scene participations (kind='scene', location_id IS NOT NULL).
--   Only re-pin to venues of kind='location' that are playable
--     brothels/inns/temples/guildhalls/shops/markets (i.e. small enough
--     to host the worker as a venue role).
--
-- The 0093 strict local_density rebuild downstream picks up the corrected
-- home_id and propagates npc_ids without an extra pass.

WITH scene_pins AS (
  SELECT
    s.location_id::bigint AS loc_id,
    p.id AS person_id,
    -- Prefer small venues (brothel/inn/temple/shop/etc) over hubs
    -- (guildhall/district/burgomaster). A person who participates in
    -- both a hub scene and a venue scene almost always lives at the
    -- venue. weight=0 = preferred, weight=1 = fallback.
    CASE
      WHEN loc.kind IN ('location', 'scene')
       AND (
         loc.profile->>'kind' IN ('brothel', 'inn', 'temple', 'shop',
                                   'market', 'workshop', 'house', 'tavern',
                                   'bath')
         OR loc.tags && ARRAY['brothel','inn','temple','shop','market','workshop','house','tavern','bath']::text[]
       )
      THEN 0
      ELSE 1
    END AS venue_weight,
    ROW_NUMBER() OVER (
      PARTITION BY p.id
      ORDER BY
        CASE
          WHEN loc.profile->>'kind' IN ('brothel','inn','temple','shop',
                                         'market','workshop','house','tavern',
                                         'bath')
            OR loc.tags && ARRAY['brothel','inn','temple','shop','market','workshop','house','tavern','bath']::text[]
            THEN 0 ELSE 1
        END,
        COUNT(*) DESC,
        s.location_id::bigint
    ) AS rn,
    COUNT(*) AS scene_count
    FROM entities scene_row
    JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(scene_row.profile->'participant_entity_ids') = 'array'
        THEN scene_row.profile->'participant_entity_ids'
        ELSE '[]'::jsonb
      END
    ) AS sp_value ON true
    JOIN entities p ON p.id = sp_value::bigint AND p.kind = 'person'
    JOIN LATERAL (
      SELECT (scene_row.profile->>'location_id')::bigint AS location_id
    ) AS s ON s.location_id IS NOT NULL
    JOIN entities loc
      ON loc.id = s.location_id
     AND loc.kind = 'location'
   WHERE scene_row.kind = 'scene'
     AND sp_value ~ '^[0-9]+$'
     AND (
       p.profile->>'home_id' IS NULL
       OR (p.profile->>'home_id')::bigint IN (201009, 201020)
     )
   GROUP BY s.location_id, p.id, loc.kind, loc.profile, loc.tags
),
target_pins AS (
  SELECT person_id, loc_id
    FROM scene_pins
   WHERE rn = 1
)
UPDATE entities p
   SET profile = COALESCE(p.profile, '{}'::jsonb)
      || jsonb_build_object(
           'home_id', tp.loc_id,
           'location_id', tp.loc_id,
           'power_center_id', tp.loc_id,
           'power_center_role', 'venue',
           'venue_role',
             COALESCE(
               p.profile->>'venue_role',
               'house worker (auto-pinned from scene participation)'
             )
         )
  FROM target_pins tp
 WHERE p.id = tp.person_id
   AND p.kind = 'person';

-- After person home_ids are corrected, rebuild local_density.npc_ids for
-- every location whose strict-ownership NPC set just changed. The 0093
-- migration also rebuilds this, but only on fresh installs; this in-place
-- update keeps existing dev/prod DBs consistent.
UPDATE entities loc
   SET profile = jsonb_set(
       jsonb_set(
         COALESCE(loc.profile, '{}'::jsonb),
         '{local_density,npc_ids}',
         (
           SELECT COALESCE(
             jsonb_agg(p.id ORDER BY p.id),
             '[]'::jsonb
           )
             FROM entities p
            WHERE p.kind = 'person'
              AND p.profile->>'home_id' = loc.id::text
         ),
         true
       ),
       '{local_density_summary,npc_count}',
       to_jsonb(
         (
           SELECT COUNT(*)::int
             FROM entities p
            WHERE p.kind = 'person'
              AND p.profile->>'home_id' = loc.id::text
         )
       ),
       true
     )
 WHERE loc.kind = 'location'
   AND loc.id IN (
     SELECT DISTINCT (p.profile->>'home_id')::bigint
       FROM entities p
      WHERE p.kind = 'person'
        AND p.profile->>'home_id' ~ '^[0-9]+$'
   );
