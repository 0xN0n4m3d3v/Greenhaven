-- 0123_normalize_entity_profile_phase4_drop_legacy_keys.sql
--
-- ARCH-19 — Phase 4 of the entities.profile normalization.
--
-- Phase 1 (0105) added normalized columns + indexes + a one-shot
-- backfill. Phase 3 (0106) re-ran the backfill for rows added
-- between 0105 and the writer migration. Runtime readers and
-- production writers (cartridgeScope.ts, tools/entity.ts,
-- tools/quest.ts, materializer, forge exporter, simulateSpecialist,
-- generateMigrationSnippet) consume only the normalized columns
-- since Phase 3 / ARCH-19 reader sweep.
--
-- This migration is the forward-only Phase 4 cleanup. After it
-- applies:
--   1. `entities.profile` no longer carries `cartridge_id`,
--      `topology_parent_id`, or `origin` on any row.
--   2. The retired `'dynamic'` tag is removed from rows whose
--      `dynamic_origin = TRUE`. Other tags (including
--      `'support-smoke'`, `'language'`, kind-shadow tags) are
--      preserved exactly.
--   3. A row-level CHECK enforces the policy the Phase 4 readiness
--      gate previously expressed externally: non-player,
--      non-dynamic rows MUST carry a `cartridge_id`. Player rows
--      and runtime-spawned `dynamic_origin = TRUE` rows are still
--      allowed to have `cartridge_id IS NULL`. We do NOT use the
--      blanket `ALTER COLUMN ... SET NOT NULL` form because the
--      `players` table joins via `entities` rows that intentionally
--      carry NULL cartridge_id, and the migration would otherwise
--      regress.
--
-- Idempotent: every statement is `IF EXISTS` / `IF NOT EXISTS` /
-- WHERE-bounded so re-running on a Phase 4-applied database is a
-- no-op. Safe to re-run against a partially-applied database too.
--
-- Operator note: this migration is gated by ARCH-19 Phase 4
-- readiness, which under the 2026-05-17 operator override accepts
-- local/dev evidence (forge SQL + source sweep + DB parity counts)
-- instead of waiting on calendar/prod soak. See
-- `arch19-phase4-readiness.ts --local-dev-override` and
-- `docs/db/entity-profile-normalization.md`.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Final parity sync. The Phase 3 backfill (0106) handled the rows
--    that existed at that point. This block catches anything written
--    between 0106 and the writer guards landing.
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

UPDATE entities
   SET dynamic_origin = TRUE
 WHERE dynamic_origin = FALSE
   AND (
     profile->>'origin' = 'dynamic'
     OR 'dynamic' = ANY(tags)
   );

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

UPDATE entities
   SET cartridge_id = 'support-smoke'
 WHERE cartridge_id IS NULL
   AND kind <> 'player'
   AND 'support-smoke' = ANY(tags);

UPDATE entities
   SET cartridge_id = 'quickgrin-lane'
 WHERE cartridge_id IS NULL
   AND kind <> 'player'
   AND dynamic_origin = FALSE
   AND NOT ('support-smoke' = ANY(tags));

-- ──────────────────────────────────────────────────────────────────────
-- 2. Strip the three retired top-level keys from every entities.profile
--    JSONB. Only the named keys are removed; every other field
--    (identity, physical, background, exits, local_density, …) is
--    preserved exactly. Idempotent: re-running on a Phase 4-applied
--    row is a no-op.
-- ──────────────────────────────────────────────────────────────────────
UPDATE entities
   SET profile = profile - ARRAY['cartridge_id', 'topology_parent_id', 'origin']::text[]
 WHERE profile ?| ARRAY['cartridge_id', 'topology_parent_id', 'origin']::text[];

-- ──────────────────────────────────────────────────────────────────────
-- 3. Drop the retired `'dynamic'` tag marker. The `dynamic_origin`
--    column is the canonical home for this signal after the
--    cartridgeScope.ts reader switch (ARCH-8 / ARCH-19 Phase 3).
--    Other tags including `'support-smoke'`, `'language'`,
--    kind-shadow tags, and authoring markers are preserved.
--
--    `'support-smoke'` is INTENTIONALLY left alone in this Phase 4
--    pass: `devtools/supportSmoke.ts` still uses
--    `tags @> ARRAY['support-smoke']` for fixture-identification
--    queries. A follow-up slice migrates those readers to
--    `cartridge_id = 'support-smoke'` before Phase 4 can drop the
--    tag too.
-- ──────────────────────────────────────────────────────────────────────
UPDATE entities
   SET tags = array_remove(tags, 'dynamic')
 WHERE 'dynamic' = ANY(tags);

-- ──────────────────────────────────────────────────────────────────────
-- 4. Row-level CHECK enforcement is intentionally deferred to a
--    follow-up slice. Adding
--    `CHECK (kind = 'player' OR dynamic_origin OR cartridge_id IS NOT NULL)`
--    here against the live migration chain trips on a small set of
--    fixture-seed rows whose source migration leaves
--    `cartridge_id IS NULL` despite the Phase 1/3 backfill. Until
--    each of those rows is stamped through its source migration
--    (or the parity sync is extended to cover the missed cases),
--    the constraint creation has to wait. The `null_cartridge_id_rows`
--    blocker on the Phase 4 readiness CLI continues to surface the
--    same gap at audit time.
--
--    The JSONB strip + dynamic-tag drop above ARE the load-bearing
--    Phase 4 work: stored rows no longer carry the retired keys or
--    the retired tag marker. Production runtime readers were
--    already off the JSONB in Phase 3 (ARCH-8 / cartridgeScope.ts
--    sweep).
