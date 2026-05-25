-- 0125_cartridge_library.sql — FEAT-CART-LIB-1.
--
-- Backend cartridge registry, scoped cartridge metadata, and hero/
-- playthrough state tables. This migration introduces explicit
-- multi-cartridge backend state without changing gameplay behavior:
--
--   * `cartridges` — installed cartridge registry (one row per
--     installed world/content pack).
--   * `cartridge_import_runs` — audit log of install / reimport /
--     repair / dry-run import attempts.
--   * `cartridge_records` — per-cartridge stable record map for
--     reimport safety (record_id ↔ imported_entity_id).
--   * `cartridge_meta_scoped` — per-cartridge key/value metadata
--     (the multi-cartridge analogue of legacy global
--     `cartridge_meta`).
--   * `hero_cartridge_states` — per-hero per-cartridge playthrough
--     state (location/scene/snapshot/compatibility). Hero identity
--     stays in `players` / `entities`; this table is the
--     playthrough relationship layer.
--
-- Backfill semantics (idempotent, safe on re-run):
--
--   * The current default cartridge is taken from
--     `cartridge_meta.key = 'cartridge_id'` and copied into
--     `cartridges` with `source_kind = 'builtin'`. Its `title` /
--     `version` come from `cartridge_meta.cartridge_id` and
--     `cartridge_meta.cartridge_version` when present.
--   * Every legacy `cartridge_meta` row is copied into
--     `cartridge_meta_scoped` keyed by that same cartridge id so
--     scoped-helper readers can resolve everything they need.
--   * Every existing player gets one `hero_cartridge_states` row
--     pointing at the default cartridge with status `available`
--     and the current `current_location_id` / `current_scene_id`
--     copied in. No player rows are deleted, rebound, or moved.
--
-- This is the FEAT-CART-LIB-1 slice. Later slices (-2 through -5)
-- own import preview, safe apply/reimport, hero+cartridge launch,
-- and the GUI; this migration must not change the way gameplay
-- launches today.

-- ── 1. Registry tables ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cartridges (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  version          TEXT NOT NULL,
  schema_version   TEXT NOT NULL,
  source_kind      TEXT NOT NULL
    CHECK (source_kind IN (
      'builtin',
      'forge_pack',
      'zip_upload',
      'folder',
      'dev_path',
      'obsidian_vault',
      'forge_project',
      'agent_pack'
    )),
  source_path      TEXT,
  content_hash     TEXT NOT NULL,
  manifest         JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'installed'
    CHECK (status IN ('installed', 'invalid', 'needs_review', 'deprecated')),
  installed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cartridges_status
  ON cartridges(status);

CREATE TABLE IF NOT EXISTS cartridge_import_runs (
  id                  BIGSERIAL PRIMARY KEY,
  cartridge_id        TEXT NOT NULL REFERENCES cartridges(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL
    CHECK (mode IN ('install', 'reimport', 'repair', 'dry_run')),
  source_kind         TEXT NOT NULL,
  source_path         TEXT,
  content_hash_before TEXT,
  content_hash_after  TEXT,
  diff_summary        JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_report   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL
    CHECK (status IN ('previewed', 'applied', 'rejected', 'failed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cartridge_import_runs_cartridge
  ON cartridge_import_runs(cartridge_id, id DESC);

CREATE TABLE IF NOT EXISTS cartridge_records (
  cartridge_id        TEXT NOT NULL REFERENCES cartridges(id) ON DELETE CASCADE,
  record_id           TEXT NOT NULL,
  kind                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  imported_entity_id  BIGINT REFERENCES entities(id) ON DELETE SET NULL,
  last_import_run_id  BIGINT REFERENCES cartridge_import_runs(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deprecated', 'conflict', 'blocked')),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cartridge_id, record_id),
  UNIQUE (cartridge_id, kind, slug)
);

CREATE INDEX IF NOT EXISTS idx_cartridge_records_entity
  ON cartridge_records(imported_entity_id)
  WHERE imported_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cartridge_records_kind
  ON cartridge_records(cartridge_id, kind);

-- ── 2. Scoped metadata ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cartridge_meta_scoped (
  cartridge_id  TEXT NOT NULL REFERENCES cartridges(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value         JSONB NOT NULL,
  description   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cartridge_id, key)
);

-- ── 3. Hero ↔ cartridge playthrough state ──────────────────────
--
-- The hero stays a `players` row (one entity-id per hero identity).
-- This table records the per-cartridge relationship: which run is
-- active, the last-known location/scene inside that world, and an
-- opaque `snapshot` JSONB so later slices can stash
-- session/inventory/quest/strings checkpoints without another
-- schema change.

CREATE TABLE IF NOT EXISTS hero_cartridge_states (
  player_id              BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  cartridge_id           TEXT NOT NULL REFERENCES cartridges(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'active', 'incompatible', 'archived')),
  last_session_id        TEXT,
  current_location_id    BIGINT REFERENCES entities(id) ON DELETE SET NULL,
  current_scene_id       BIGINT REFERENCES entities(id) ON DELETE SET NULL,
  snapshot               JSONB NOT NULL DEFAULT '{}'::jsonb,
  compatibility_report   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, cartridge_id)
);

CREATE INDEX IF NOT EXISTS idx_hero_cartridge_states_player
  ON hero_cartridge_states(player_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hero_cartridge_states_cartridge
  ON hero_cartridge_states(cartridge_id, updated_at DESC);

-- ── 4. Backfill the default cartridge from cartridge_meta ──────
--
-- Pull the active cartridge id + version from legacy global
-- `cartridge_meta`; fall back to deterministic defaults if either
-- key is missing so the migration still establishes a valid
-- registry row on a hypothetical fresh DB.
--
-- The `content_hash` here is a deterministic legacy marker
-- (`legacy:<cartridge_id>`). Real import-pack hashing belongs to
-- FEAT-CART-LIB-2; this slice just needs a nonempty value so the
-- NOT NULL constraint is satisfied and future hash diffs have a
-- starting point.

DO $$
DECLARE
  v_cartridge_id  TEXT;
  v_version       TEXT;
  v_title         TEXT;
BEGIN
  SELECT (value #>> '{}')::text INTO v_cartridge_id
    FROM cartridge_meta WHERE key = 'cartridge_id';
  IF v_cartridge_id IS NULL OR length(v_cartridge_id) = 0 THEN
    v_cartridge_id := 'default';
  END IF;

  SELECT (value #>> '{}')::text INTO v_version
    FROM cartridge_meta WHERE key = 'cartridge_version';
  IF v_version IS NULL OR length(v_version) = 0 THEN
    v_version := '0.0.0';
  END IF;

  v_title := v_cartridge_id;

  INSERT INTO cartridges (
    id, title, version, schema_version, source_kind, source_path,
    content_hash, manifest, validation_report, status
  )
  VALUES (
    v_cartridge_id,
    v_title,
    v_version,
    '1',
    'builtin',
    NULL,
    'legacy:' || v_cartridge_id,
    '{}'::jsonb,
    '{}'::jsonb,
    'installed'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Mirror every legacy `cartridge_meta` row into the scoped
  -- table under the active cartridge id. Skip rows already
  -- present (re-running this migration must be a no-op).
  INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
  SELECT v_cartridge_id, cm.key, cm.value, cm.description
    FROM cartridge_meta cm
    WHERE NOT EXISTS (
      SELECT 1 FROM cartridge_meta_scoped s
       WHERE s.cartridge_id = v_cartridge_id AND s.key = cm.key
    );

  -- Backfill every existing player as `available` on the default
  -- cartridge, carrying their current location/scene. We don't
  -- touch `players.current_location_id` itself — gameplay still
  -- reads from there. This is purely a parallel record so the
  -- library API has something to show on day one.
  INSERT INTO hero_cartridge_states (
    player_id, cartridge_id, status,
    current_location_id, current_scene_id,
    snapshot, compatibility_report
  )
  SELECT
    p.entity_id,
    v_cartridge_id,
    'available',
    p.current_location_id,
    p.current_scene_id,
    '{}'::jsonb,
    '{}'::jsonb
  FROM players p
  WHERE NOT EXISTS (
    SELECT 1 FROM hero_cartridge_states h
     WHERE h.player_id = p.entity_id
       AND h.cartridge_id = v_cartridge_id
  );
END $$;
