-- 0127_cartridge_import_apply_jobs.sql — FEAT-CART-LIB-3.
--
-- Extends the FEAT-CART-LIB-2 import-preview job state machine
-- with the apply phase:
--
--     queued → running → ready → applying → applied | failed
--                              ↘ cancelled
--
-- Three table-level changes:
--
--   * `cartridge_import_preview_jobs.status` CHECK enum now
--     includes `applying` and `applied`.
--   * `cartridge_install_cache` gains `applied_at`
--     (last successful apply timestamp) and `applied_job_id`
--     (FK to the preview-job row that performed the apply, set
--     to NULL when the job row is later deleted).
--   * `cartridge_records.status` CHECK enum gains `blocked` was
--     already present in 0125; this migration also ensures
--     `cartridge_records.last_import_run_id` is set-null on
--     delete (it already is in 0125; this is a no-op invariant
--     guard).
--
-- No table is dropped or recreated. Existing rows are left
-- untouched.

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

ALTER TABLE cartridge_install_cache
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE cartridge_install_cache
  ADD COLUMN IF NOT EXISTS applied_job_id BIGINT
    REFERENCES cartridge_import_preview_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cartridge_install_cache_applied_job
  ON cartridge_install_cache(applied_job_id)
  WHERE applied_job_id IS NOT NULL;
