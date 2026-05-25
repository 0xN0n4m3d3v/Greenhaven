-- 0128_cartridge_playthrough_launch.sql — FEAT-CART-LIB-4.
--
-- Extends `hero_cartridge_states` with the launch/reset fields needed
-- by the playthrough preview/launch/new-game contract:
--
--   * `playthrough_id`   — UUID-shaped opaque id, fresh per
--                          new-game / first launch. Used by the GUI
--                          and telemetry to scope a continuous run.
--   * `reset_generation` — monotonic counter; incremented on every
--                          new-game so historical telemetry / logs
--                          can attribute events to a specific run.
--   * `hero_snapshot`    — JSONB blob the service uses to checkpoint
--                          the hero-side run state (location, scene,
--                          dialogue partner, last_session_id) when a
--                          run is left for another cartridge.
--   * `world_snapshot`   — JSONB blob reserved for cartridge-scoped
--                          world checkpoints (currency_total,
--                          last_seen, future scoped extras). Empty
--                          object by default so future writers don't
--                          need a schema change.
--
-- Backfill: every existing row gets a fresh `playthrough_id` (UUIDv4
-- via `gen_random_uuid()`), `reset_generation = 0`, and empty
-- snapshots. Newer rows inherit the column defaults.
--
-- FK / index hygiene:
--
--   * `playthrough_id` carries a UNIQUE constraint per
--     `(player_id, cartridge_id)` row (PK already enforces one row
--     per pair; this is purely defensive in case the table picks up
--     a non-pk surrogate later).
--   * An index supports the playthrough-id reverse lookup the
--     telemetry side will need: `(playthrough_id)`. (`playthrough_id`
--     is NOT NULL post-backfill, so no partial predicate is needed.)

BEGIN;

-- `gen_random_uuid()` lives in pg_catalog from PG14 onward, so no
-- extension is required. PGlite ships PG16-equivalent.

ALTER TABLE hero_cartridge_states
  ADD COLUMN IF NOT EXISTS playthrough_id    UUID    DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS reset_generation  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hero_snapshot     JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS world_snapshot    JSONB   NOT NULL DEFAULT '{}'::jsonb;

UPDATE hero_cartridge_states
   SET playthrough_id = gen_random_uuid()
 WHERE playthrough_id IS NULL;

ALTER TABLE hero_cartridge_states
  ALTER COLUMN playthrough_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hero_cartridge_states_playthrough_id
  ON hero_cartridge_states(playthrough_id);

COMMIT;
