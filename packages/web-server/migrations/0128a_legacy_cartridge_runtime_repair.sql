-- FEAT-ENGINE-BASELINE corrective (2026-05-18).
--
-- Some local desktop/dev databases were created before the engine
-- baseline cutover and have schema_migrations rows through 0124 but no
-- baseline marker. Runtime runMigrations() correctly treats those as
-- legacy-chain databases and skips the archived prebaseline files, but
-- that leaves the cartridge library/import/playthrough tables from
-- 0125-0128 absent. The GUI then fails import preview with PostgreSQL
-- code 42P01 (undefined table).
--
-- This post-baseline delta is intentionally ordered before 0129 so
-- legacy-chain databases get the missing 0125-0128 schema before
-- 0129_hero_universe_instances.sql references hero_cartridge_states.
-- On a fresh baseline database every CREATE/ALTER/INSERT below is
-- idempotent and should be a no-op.

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

CREATE TABLE IF NOT EXISTS cartridge_meta_scoped (
  cartridge_id  TEXT NOT NULL REFERENCES cartridges(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value         JSONB NOT NULL,
  description   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cartridge_id, key)
);

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

DO $$
DECLARE
  v_cartridge_id  TEXT;
  v_version       TEXT := '0.0.0';
  v_title         TEXT;
BEGIN
  IF to_regclass('public.cartridge_meta') IS NOT NULL THEN
    SELECT (value #>> '{}')::text INTO v_cartridge_id
      FROM cartridge_meta WHERE key = 'cartridge_id';

    SELECT (value #>> '{}')::text INTO v_version
      FROM cartridge_meta WHERE key = 'cartridge_version';
    IF v_version IS NULL OR length(v_version) = 0 THEN
      v_version := '0.0.0';
    END IF;
  END IF;

  IF v_cartridge_id IS NULL OR length(v_cartridge_id) = 0 THEN
    RETURN;
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

  IF to_regclass('public.cartridge_meta') IS NOT NULL THEN
    INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
    SELECT v_cartridge_id, cm.key, cm.value, cm.description
      FROM cartridge_meta cm
     WHERE NOT EXISTS (
       SELECT 1 FROM cartridge_meta_scoped s
        WHERE s.cartridge_id = v_cartridge_id AND s.key = cm.key
     );
  END IF;

  IF to_regclass('public.players') IS NOT NULL THEN
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
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS cartridge_install_cache (
  cartridge_id        TEXT PRIMARY KEY REFERENCES cartridges(id) ON DELETE CASCADE,
  state               TEXT NOT NULL DEFAULT 'ready'
    CHECK (state IN (
      'ready',
      'active_db',
      'stale',
      'invalid',
      'missing',
      'rebuild_required'
    )),
  content_hash        TEXT NOT NULL,
  record_count        INTEGER NOT NULL DEFAULT 0
    CHECK (record_count >= 0),
  last_verified_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes               JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_cartridge_install_cache_state
  ON cartridge_install_cache(state);

CREATE TABLE IF NOT EXISTS cartridge_import_preview_jobs (
  id                  BIGSERIAL PRIMARY KEY,
  job_id              TEXT NOT NULL UNIQUE,
  cartridge_id        TEXT REFERENCES cartridges(id) ON DELETE SET NULL,
  mode                TEXT NOT NULL
    CHECK (mode IN ('install', 'reimport', 'repair', 'dry_run')),
  source_kind         TEXT NOT NULL
    CHECK (source_kind IN (
      'obsidian_vault',
      'forge_project',
      'agent_pack'
    )),
  source_path         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  phase               TEXT NOT NULL DEFAULT 'queued',
  progress_processed  INTEGER NOT NULL DEFAULT 0
    CHECK (progress_processed >= 0),
  progress_total      INTEGER NOT NULL DEFAULT 0
    CHECK (progress_total >= 0),
  result              JSONB NOT NULL DEFAULT '{}'::jsonb,
  error               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cartridge_import_preview_jobs
  DROP CONSTRAINT IF EXISTS cartridge_import_preview_jobs_status_check;
ALTER TABLE cartridge_import_preview_jobs
  ADD CONSTRAINT cartridge_import_preview_jobs_status_check
  CHECK (status IN (
    'queued',
    'running',
    'ready',
    'failed',
    'cancelled',
    'applying',
    'applied'
  ));

CREATE INDEX IF NOT EXISTS idx_cartridge_import_preview_jobs_status
  ON cartridge_import_preview_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cartridge_import_preview_jobs_cartridge
  ON cartridge_import_preview_jobs(cartridge_id, id DESC)
  WHERE cartridge_id IS NOT NULL;

INSERT INTO cartridge_install_cache (
  cartridge_id, state, content_hash, record_count
)
SELECT
  c.id,
  CASE
    WHEN cm.value IS NOT NULL AND (cm.value #>> '{}') = c.id THEN 'active_db'
    ELSE 'ready'
  END AS state,
  c.content_hash,
  COALESCE(rc.count, 0) AS record_count
FROM cartridges c
LEFT JOIN cartridge_meta cm
  ON cm.key = 'cartridge_id'
LEFT JOIN (
  SELECT cartridge_id, COUNT(*)::int AS count
    FROM cartridge_records
   GROUP BY cartridge_id
) rc ON rc.cartridge_id = c.id
WHERE NOT EXISTS (
  SELECT 1 FROM cartridge_install_cache cache
   WHERE cache.cartridge_id = c.id
);

ALTER TABLE cartridge_install_cache
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE cartridge_install_cache
  ADD COLUMN IF NOT EXISTS applied_job_id BIGINT
    REFERENCES cartridge_import_preview_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cartridge_install_cache_applied_job
  ON cartridge_install_cache(applied_job_id)
  WHERE applied_job_id IS NOT NULL;

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
