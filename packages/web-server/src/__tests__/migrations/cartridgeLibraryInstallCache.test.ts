/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-2 — migration 0126 invariants.
//
// Pins `cartridge_install_cache` and
// `cartridge_import_preview_jobs` table shapes + backfill of the
// default cartridge as `active_db` / `ready`.

import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {rm} from 'node:fs/promises';
import {
  cleanupMigrationTemplates,
  createPristineDataDir,
  withPristineDb,
} from './framework.js';

afterAll(async () => {
  await cleanupMigrationTemplates();
});

beforeAll(async () => {
  const dataDir = await createPristineDataDir();
  await rm(dataDir, {recursive: true, force: true});
}, 600_000);

describe.sequential('FEAT-CART-LIB-2 cartridge install cache + preview jobs (0126)', () => {
  test('cartridge_install_cache has the expected columns + state CHECK', async () => {
    await withPristineDb(async (db) => {
      const cols = await db.query<{column_name: string}>(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'cartridge_install_cache'
         ORDER BY column_name
      `);
      // FEAT-CART-LIB-3 (0127) extended this table with applied_at +
      // applied_job_id; the FEAT-CART-LIB-3 migration test pins those.
      // Here we just assert the original 0126 columns are present.
      const names = new Set(cols.rows.map((r) => r.column_name));
      for (const required of [
        'cartridge_id',
        'content_hash',
        'last_verified_at',
        'notes',
        'record_count',
        'state',
      ]) {
        expect(names.has(required)).toBe(true);
      }
      // CHECK enforces the documented state enum.
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO cartridge_install_cache (cartridge_id, state, content_hash)
           VALUES ('grinhaven-full', 'not_a_state', 'h')
           ON CONFLICT (cartridge_id) DO UPDATE SET state = EXCLUDED.state`,
        );
      } catch (err) {
        rejected =
          err instanceof Error && /(check|constraint)/i.test(err.message);
      }
      expect(rejected).toBe(true);
    });
  });

  test('cartridge_import_preview_jobs has the expected columns + status CHECK', async () => {
    await withPristineDb(async (db) => {
      const cols = await db.query<{column_name: string}>(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'cartridge_import_preview_jobs'
         ORDER BY column_name
      `);
      const names = cols.rows.map((r) => r.column_name).sort();
      expect(names).toContain('job_id');
      expect(names).toContain('status');
      expect(names).toContain('phase');
      expect(names).toContain('progress_processed');
      expect(names).toContain('progress_total');
      expect(names).toContain('result');
      expect(names).toContain('error');
      expect(names).toContain('source_kind');
      // job_id unique
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO cartridge_import_preview_jobs
             (job_id, mode, source_kind, source_path, status)
           VALUES ('dup-job', 'dry_run', 'forge_project', '/tmp/a', 'queued')`,
        );
        await db.query(
          `INSERT INTO cartridge_import_preview_jobs
             (job_id, mode, source_kind, source_path, status)
           VALUES ('dup-job', 'dry_run', 'forge_project', '/tmp/b', 'queued')`,
        );
      } catch (err) {
        rejected =
          err instanceof Error &&
          /(unique|duplicate|constraint)/i.test(err.message);
      }
      expect(rejected).toBe(true);
    });
  });

  test('install cache is backfilled for the default cartridge as active_db', async () => {
    await withPristineDb(async (db) => {
      const id = await db.query<{value: string}>(
        `SELECT value#>>'{}' AS value FROM cartridge_meta WHERE key = 'cartridge_id'`,
      );
      const cartridgeId = id.rows[0]?.value;
      expect(cartridgeId).toBeTruthy();
      const cache = await db.query<{state: string; content_hash: string}>(
        `SELECT state, content_hash FROM cartridge_install_cache
          WHERE cartridge_id = $1`,
        [cartridgeId],
      );
      expect(cache.rows[0]?.state).toBe('active_db');
      // The 0125 backfill used `'legacy:<cartridge_id>'`; mirror that.
      expect(cache.rows[0]?.content_hash).toBe(`legacy:${cartridgeId}`);
    });
  });

  test('non-default cartridges land as state=ready (not active_db)', async () => {
    await withPristineDb(async (db) => {
      await db.query(
        `INSERT INTO cartridges (id, title, version, schema_version,
                                  source_kind, content_hash)
         VALUES ('extra-world', 'Extra', '0.1', '1', 'forge_project',
                 'sha256:abc')`,
      );
      // Re-run the backfill SELECT (the migration's body); 0125
      // backfill only seeds players, so we just re-test the
      // install-cache backfill semantics by calling the same SQL
      // shape directly.
      await db.query(
        `INSERT INTO cartridge_install_cache (
           cartridge_id, state, content_hash, record_count
         )
         SELECT
           c.id,
           CASE
             WHEN cm.value IS NOT NULL AND (cm.value #>> '{}') = c.id THEN 'active_db'
             ELSE 'ready'
           END AS state,
           c.content_hash,
           0
         FROM cartridges c
         LEFT JOIN cartridge_meta cm ON cm.key = 'cartridge_id'
         WHERE c.id = 'extra-world'
           AND NOT EXISTS (
             SELECT 1 FROM cartridge_install_cache cache
              WHERE cache.cartridge_id = c.id
           )`,
      );
      const r = await db.query<{state: string}>(
        `SELECT state FROM cartridge_install_cache WHERE cartridge_id = 'extra-world'`,
      );
      expect(r.rows[0]?.state).toBe('ready');
    });
  });
});
