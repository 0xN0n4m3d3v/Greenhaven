-- 0126_cartridge_import_preview_jobs.sql — FEAT-CART-LIB-2.
--
-- Adds two tables backing the cartridge-library import-preview
-- pipeline:
--
--   * `cartridge_install_cache` — per-cartridge install-readiness
--     state surfaced through `CartridgeSummary.installCache`. The
--     pinned FEAT-CART-LIB-1 contract called for an install-cache
--     read state but FEAT-CART-LIB-1 only wrote registry / scoped-
--     meta / playthrough tables. This migration closes that drift
--     and seeds every existing cartridge as `active_db` / `ready`
--     using its current `content_hash` so the API can report
--     readiness on day one.
--   * `cartridge_import_preview_jobs` — durable job log for the
--     long-running import-preview pipeline. Each row tracks one
--     attempt to preview an Obsidian vault, a generated Forge
--     project, or an exported agent pack. The job moves
--     `queued → running → ready | failed | cancelled`, surfaces
--     phase + progress counters for the GUI, and stores the full
--     preview result + error JSON for later inspection.
--
-- No `entities`, `cartridges`, `cartridge_records`,
-- `cartridge_meta_scoped`, players, or runtime tables are
-- mutated by this migration. The preview pipeline is read-only
-- with respect to gameplay state; safe apply / reimport lands in
-- FEAT-CART-LIB-3.

-- ── 1. Install cache ───────────────────────────────────────────

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

-- ── 2. Import preview jobs ─────────────────────────────────────

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
  status              TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'cancelled')),
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

CREATE INDEX IF NOT EXISTS idx_cartridge_import_preview_jobs_status
  ON cartridge_import_preview_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cartridge_import_preview_jobs_cartridge
  ON cartridge_import_preview_jobs(cartridge_id, id DESC)
  WHERE cartridge_id IS NOT NULL;

-- ── 3. Backfill install-cache for existing cartridges ──────────

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
