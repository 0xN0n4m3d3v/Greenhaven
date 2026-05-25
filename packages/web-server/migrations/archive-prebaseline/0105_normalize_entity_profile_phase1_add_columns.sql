-- 0105_normalize_entity_profile_phase1_add_columns.sql
--
-- ARCH-19 — Phase 1 of the entities.profile normalization.
--
-- entities.profile has historically stored 10+ heterogeneous concepts
-- (cartridge_id, topology_parent_id, origin, identity, physical,
-- background, exits, local_density, ...). ON CONFLICT rewrites
-- clobbered the whole blob; M-2 (migration 0103) plugged that for the
-- forge re-import path. ARCH-19 now pulls the hottest read fields out
-- of JSONB into normalized columns so cartridge-scope predicates,
-- topology lookups, and the dynamic/static partition can use real
-- indexes.
--
-- Staging (do NOT collapse into one pass):
--   * Phase 1 (this migration, 0105) — add columns + indexes +
--     backfill from profile/tags. Reader (cartridgeScope.ts) is NOT
--     switched; legacy JSONB keys are NOT removed.
--   * Phase 2 — switch writers (forge upsert, runtime mutations) to
--     populate the new columns alongside profile.
--   * Phase 3 — switch readers (cartridgeScope.ts predicate + every
--     callsite that reads profile->>'cartridge_id', etc.) to use the
--     columns; backfill cleanup for stale rows.
--   * Phase 4 — drop the now-unused JSONB keys.
--
-- Phase 4 requires a soak window on dev + prod with the new readers
-- in production before drop. See docs/db/entity-profile-normalization.md.

-- ──────────────────────────────────────────────────────────────────────
-- safe_to_bigint(value text) → bigint
--
-- M-5 will later replace ad-hoc regex+cast patterns across the
-- codebase. For Phase 1 we only need a small immutable helper to keep
-- this migration's backfill from crashing on malformed or
-- out-of-range topology_parent_id values inside profile.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION safe_to_bigint(value text)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
BEGIN
  IF value !~ '^-?[0-9]+$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN value::bigint;
  EXCEPTION
    WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      RETURN NULL;
  END;
END;
$$;

COMMENT ON FUNCTION safe_to_bigint(text) IS
  'ARCH-19 Phase 1: returns the bigint value of a text input, or NULL '
  'when the input does not match an integer pattern or overflows '
  'bigint. Immutable + strict so it can be used inside index '
  'expressions or backfill UPDATE predicates without aborting the '
  'transaction. M-5 may replace ad-hoc regex+cast patterns elsewhere.';

-- ──────────────────────────────────────────────────────────────────────
-- entities: normalized columns.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS cartridge_id        text NULL,
  ADD COLUMN IF NOT EXISTS topology_parent_id  bigint NULL,
  ADD COLUMN IF NOT EXISTS dynamic_origin      boolean NOT NULL DEFAULT false;

-- topology_parent_id is an adjacency-list pointer. FK with
-- ON DELETE SET NULL so detaching a parent location/district doesn't
-- cascade-delete the children. Children whose parent is removed end
-- up with a NULL topology_parent_id and become root locations again
-- until an operator re-parents them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'entities_topology_parent_id_fkey'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_topology_parent_id_fkey
      FOREIGN KEY (topology_parent_id)
      REFERENCES entities(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

-- Narrow indexes — we only need to scan the populated rows.
CREATE INDEX IF NOT EXISTS entities_cartridge_id_idx
  ON entities(cartridge_id)
  WHERE cartridge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entities_topology_parent_id_idx
  ON entities(topology_parent_id)
  WHERE topology_parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entities_dynamic_origin_idx
  ON entities(dynamic_origin)
  WHERE dynamic_origin = true;

-- ──────────────────────────────────────────────────────────────────────
-- Backfill from existing JSONB profile / tags.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Explicit cartridge_id authored in profile.
UPDATE entities
   SET cartridge_id = profile->>'cartridge_id'
 WHERE profile ? 'cartridge_id'
   AND cartridge_id IS NULL;

-- 2) dynamic_origin: legacy entities used either
--    profile->>'origin' = 'dynamic' or the 'dynamic' tag (sometimes
--    both). Collapse to a single boolean. We do not touch the legacy
--    JSON / tag yet — Phase 4 will drop them.
UPDATE entities
   SET dynamic_origin = true
 WHERE dynamic_origin = false
   AND (
     profile->>'origin' = 'dynamic'
     OR 'dynamic' = ANY(tags)
   );

-- 3) topology_parent_id: backfill only when the JSON value safely
--    parses to bigint AND resolves to an existing location/district.
--    Anything else (garbage strings, overflows, dangling ids) stays
--    NULL; an operator can re-parent later. We use a CTE to avoid
--    evaluating safe_to_bigint twice per row.
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

-- 4) Preserve the current cartridgeScope.ts fallback: unmarked
--    static entities (no cartridge_id in profile, not players, not
--    dynamic, not support-smoke fixture rows) are treated as
--    quickgrin-lane content by the predicate at
--    cartridgeScope.ts:19. Replicate that here so column-based
--    readers added in Phase 3 see the same scope without breaking
--    support-smoke fixtures (they keep their tag-based scoping
--    until a later phase migrates them).
UPDATE entities
   SET cartridge_id = 'quickgrin-lane'
 WHERE cartridge_id IS NULL
   AND kind <> 'player'
   AND dynamic_origin = false
   AND NOT ('support-smoke' = ANY(tags));
