-- 0124_normalize_entity_profile_phase4_enforce_cartridge_scope.sql
--
-- ARCH-19 — Phase 4 final enforcement.
--
-- Migration 0123 dropped the retired `entities.profile` JSONB keys
-- and the retired `'dynamic'` tag marker. The deferred items were:
--
--   1. The `entities_cartridge_id_required_ck` row-level CHECK
--      enforcing `kind = 'player' OR dynamic_origin OR
--      cartridge_id IS NOT NULL`.
--   2. Retirement of the `'support-smoke'` tag marker from stored
--      tag arrays. The runtime now scopes support-smoke fixtures
--      via the `cartridge_id = 'support-smoke'` column.
--
-- Both land here, in append-only fashion, after a defensive final
-- parity sweep that stamps any remaining unmarked rows so the CHECK
-- can apply without surprises. Idempotent: re-running on a
-- 0124-applied database is a no-op.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Defensive final parity sweep. The Phase 1/3/4-drop chain
--    (0105/0106/0123) already populates `cartridge_id` for
--    non-player non-dynamic rows. This block is the last line of
--    defense: if any seed migration emitted a row that the prior
--    parity sync didn't reach (the documented blocker from the
--    Phase 4 drop slice), stamp it now via the same fallback chain.
--    Order matters: `support-smoke`-tagged rows get the
--    `support-smoke` cartridge before we drop the tag, then
--    everything else falls back to `quickgrin-lane`.
-- ──────────────────────────────────────────────────────────────────────
UPDATE entities
   SET cartridge_id = 'support-smoke'
 WHERE cartridge_id IS NULL
   AND kind <> 'player'
   AND 'support-smoke' = ANY(tags);

UPDATE entities
   SET cartridge_id = 'quickgrin-lane'
 WHERE cartridge_id IS NULL
   AND kind <> 'player'
   AND dynamic_origin = FALSE;

-- ──────────────────────────────────────────────────────────────────────
-- 2. Retire the `'support-smoke'` tag marker. The
--    `cartridge_id = 'support-smoke'` column is the canonical
--    scope after Phase 4; persisted tag arrays no longer need
--    the marker. Other tags (`quest`, `item`, `language`,
--    `delivery`, etc.) are preserved.
-- ──────────────────────────────────────────────────────────────────────
UPDATE entities
   SET tags = array_remove(tags, 'support-smoke')
 WHERE 'support-smoke' = ANY(tags);

-- ──────────────────────────────────────────────────────────────────────
-- 3. Row-level CHECK: every non-player non-dynamic row must carry
--    a normalized `cartridge_id`. Players (NULL cartridge) and
--    runtime-spawned `dynamic_origin = TRUE` rows are explicitly
--    allowed. Idempotent — re-running the DO block is a no-op
--    when the constraint already exists.
-- ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'entities_cartridge_id_required_ck'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_cartridge_id_required_ck
      CHECK (
        kind = 'player'
        OR dynamic_origin = TRUE
        OR cartridge_id IS NOT NULL
      );
  END IF;
END;
$$;

COMMENT ON CONSTRAINT entities_cartridge_id_required_ck ON entities IS
  'ARCH-19 Phase 4 (migration 0124): every non-player, non-dynamic '
  'row must carry a normalized cartridge_id. Replaces the external '
  'null_cartridge_id_rows blocker the readiness CLI previously '
  'reported.';
