-- FEAT-HERO-CONTINUITY-2 (2026-05-17) — universe-instance identity.
--
-- Adds the first piece of the post-cartridge live-world identity
-- layer described in
-- `docs/specs/hero-continuity-parallel-universes.md`:
--
--   * `universe_instances` — explicit live-world row. One default
--     `local_single_player` instance per installed cartridge today;
--     future multiplayer can add `local_party` and `network_shard`
--     rows that share a `cartridge_id` template.
--   * `hero_cartridge_states.universe_instance_id` — nullable
--     pointer from the existing (player_id, cartridge_id) playthrough
--     row to the universe it actually belongs to. Nullable so the
--     migration is safe on a fresh baseline and so future
--     `hero_cartridge_states` writers can land before all readers
--     have been moved off the legacy `cartridge_id` key.
--
-- Forward-only. No down migration. Idempotent: ALTERs use
-- `ADD COLUMN IF NOT EXISTS`, the `universe_instances` create uses
-- `CREATE TABLE IF NOT EXISTS`, and the backfill INSERTs gate on
-- `ON CONFLICT DO NOTHING`.

CREATE TABLE IF NOT EXISTS universe_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cartridge_id    TEXT NOT NULL REFERENCES cartridges(id) ON DELETE CASCADE,
  content_hash    TEXT NOT NULL,
  title           TEXT,
  mode            TEXT NOT NULL DEFAULT 'local_single_player'
    CHECK (mode IN ('local_single_player', 'local_party', 'network_shard')),
  owner_player_id BIGINT REFERENCES players(entity_id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived', 'incompatible')),
  is_default      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_universe_instances_cartridge
  ON universe_instances(cartridge_id);

-- One default per cartridge. Future passes can add named non-default
-- instances; the playthrough launch path keys off this row when no
-- caller-supplied universe id is present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_universe_instances_cartridge_default
  ON universe_instances(cartridge_id)
  WHERE is_default;

-- Backfill: one default `local_single_player` instance per installed
-- cartridge. `gen_random_uuid()` produces the row id; the migration
-- inserts via SELECT so multiple cartridges seed at once.
INSERT INTO universe_instances (cartridge_id, content_hash, title, mode, is_default)
  SELECT
    c.id,
    c.content_hash,
    c.title,
    'local_single_player',
    true
    FROM cartridges c
   WHERE NOT EXISTS (
     SELECT 1 FROM universe_instances u
      WHERE u.cartridge_id = c.id AND u.is_default
   );

ALTER TABLE hero_cartridge_states
  ADD COLUMN IF NOT EXISTS universe_instance_id UUID
    REFERENCES universe_instances(id) ON DELETE CASCADE;

-- Backfill: link every existing hero_cartridge_states row to its
-- cartridge's default universe.
UPDATE hero_cartridge_states hcs
   SET universe_instance_id = u.id
  FROM universe_instances u
 WHERE hcs.universe_instance_id IS NULL
   AND u.cartridge_id = hcs.cartridge_id
   AND u.is_default;

-- Lookup index for (player, universe_instance) so future readers can
-- swap from `(player_id, cartridge_id)` to
-- `(player_id, universe_instance_id)` without scanning every row.
-- The PRIMARY KEY (player_id, cartridge_id) stays in place; this
-- index is supplementary and only covers rows that have already
-- been linked.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hero_cartridge_states_player_universe
  ON hero_cartridge_states(player_id, universe_instance_id)
  WHERE universe_instance_id IS NOT NULL;
