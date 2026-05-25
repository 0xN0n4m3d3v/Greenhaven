-- 0106_normalize_entity_profile_phase3_reader_cleanup.sql
--
-- ARCH-19 — Phase 3 of the entities.profile normalization.
--
-- Phase 1 (0105) added the columns and ran a one-shot backfill. Phase 2
-- (writers in tools/entity.ts, tools/quest.ts, devtools fixtures,
-- forge exporter) keeps them in sync from the application side. This
-- migration is an idempotent forward-only cleanup that catches rows
-- that were added between 0105 and Phase 2 shipping, plus any
-- support-smoke fixtures whose runtime path landed a row before the
-- writer migration was wired up.
--
-- After this migration runs, the Phase 3 reader switch (rewritten
-- cartridgeScope.ts predicate) is safe: every entities row in scope
-- has cartridge_id, topology_parent_id, and dynamic_origin populated
-- to the same value the JSONB/tag-based predicate would have
-- produced. Phase 4 (drop the legacy JSONB keys + 'dynamic' tag)
-- remains soak-gated and is NOT done here.
--
-- Idempotent: safe to re-run. Every UPDATE is bounded by a WHERE
-- clause that excludes already-correct rows.

-- ──────────────────────────────────────────────────────────────────────
-- 1. cartridge_id: trim whitespace from any existing value, then
--    copy from profile->>'cartridge_id' for rows that still have a
--    NULL column.
-- ──────────────────────────────────────────────────────────────────────
UPDATE entities
   SET cartridge_id = NULLIF(TRIM(cartridge_id), '')
 WHERE cartridge_id IS NOT NULL
   AND cartridge_id <> TRIM(cartridge_id);

UPDATE entities
   SET cartridge_id = NULLIF(TRIM(profile->>'cartridge_id'), '')
 WHERE cartridge_id IS NULL
   AND profile ? 'cartridge_id'
   AND NULLIF(TRIM(profile->>'cartridge_id'), '') IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 2. support-smoke fixture entities: any non-player row tagged
--    'support-smoke' that still has no cartridge_id was seeded
--    before Phase 2B wired its writer to set the column. Stamp it
--    explicitly so the Phase 3 reader can drop the tag carve-out.
-- ──────────────────────────────────────────────────────────────────────
UPDATE entities
   SET cartridge_id = 'support-smoke'
 WHERE cartridge_id IS NULL
   AND kind <> 'player'
   AND 'support-smoke' = ANY(tags);

-- ──────────────────────────────────────────────────────────────────────
-- 3. dynamic_origin: collapse the legacy origin='dynamic' / 'dynamic'
--    tag double representation into a single column. Phase 4 will
--    drop the legacy signals; until then this just keeps the column
--    truthful.
-- ──────────────────────────────────────────────────────────────────────
UPDATE entities
   SET dynamic_origin = true
 WHERE dynamic_origin = false
   AND (
     profile->>'origin' = 'dynamic'
     OR 'dynamic' = ANY(tags)
   );

-- ──────────────────────────────────────────────────────────────────────
-- 4. topology_parent_id: recompute from profile->>'topology_parent_id'
--    via safe_to_bigint + location/district existence check, for
--    rows whose column is still NULL. Skips invalid / dangling
--    profile values silently — those stay NULL.
-- ──────────────────────────────────────────────────────────────────────
WITH candidates AS (
  SELECT
    e.id,
    safe_to_bigint(e.profile->>'topology_parent_id') AS parent_id
    FROM entities e
   WHERE e.profile ? 'topology_parent_id'
     AND e.topology_parent_id IS NULL
)
UPDATE entities child
   SET topology_parent_id = c.parent_id
  FROM candidates c
  JOIN entities parent
    ON parent.id = c.parent_id
   AND parent.kind IN ('location', 'district')
 WHERE child.id = c.id
   AND c.parent_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 5. Mirror the Phase 1 quickgrin-lane fallback for any non-player,
--    non-dynamic, non-support-smoke entity that's still unmarked.
--    The Phase 3 reader predicate no longer carries the
--    `cartridgeParam = 'quickgrin-lane' AND NOT (profile ?
--    'cartridge_id')` fallback, so the data has to satisfy the
--    column-based contract directly.
-- ──────────────────────────────────────────────────────────────────────
UPDATE entities
   SET cartridge_id = 'quickgrin-lane'
 WHERE cartridge_id IS NULL
   AND kind <> 'player'
   AND dynamic_origin = false
   AND NOT ('support-smoke' = ANY(tags));
