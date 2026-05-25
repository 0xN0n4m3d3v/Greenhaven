/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-3 — migration 0127 invariants.
//
// Pins the extended status CHECK on
// `cartridge_import_preview_jobs` and the new
// `applied_at` / `applied_job_id` columns on
// `cartridge_install_cache`.

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

describe.sequential('FEAT-CART-LIB-3 cartridge apply jobs (0127)', () => {
  test('preview-jobs status CHECK accepts applying/applied', async () => {
    await withPristineDb(async (db) => {
      // queued/running/ready/failed/cancelled (from 0126) + new applying/applied.
      const validStatuses = [
        'queued',
        'running',
        'ready',
        'failed',
        'cancelled',
        'applying',
        'applied',
      ];
      for (const status of validStatuses) {
        const jobId = `job-${status}-${Math.random().toString(36).slice(2)}`;
        await db.query(
          `INSERT INTO cartridge_import_preview_jobs
             (job_id, mode, source_kind, source_path, status)
           VALUES ($1, 'dry_run', 'forge_project', '/tmp/x', $2)`,
          [jobId, status],
        );
      }
      // bogus status should still be rejected.
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO cartridge_import_preview_jobs
             (job_id, mode, source_kind, source_path, status)
           VALUES ('bogus', 'dry_run', 'forge_project', '/tmp/x', 'wat')`,
        );
      } catch (err) {
        rejected =
          err instanceof Error && /(check|constraint)/i.test(err.message);
      }
      expect(rejected).toBe(true);
    });
  });

  test('cartridge_install_cache gained applied_at + applied_job_id', async () => {
    await withPristineDb(async (db) => {
      const cols = await db.query<{column_name: string; is_nullable: string}>(`
        SELECT column_name, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'cartridge_install_cache'
         ORDER BY column_name
      `);
      const names = cols.rows.map((r) => r.column_name);
      expect(names).toContain('applied_at');
      expect(names).toContain('applied_job_id');
      const appliedAt = cols.rows.find((r) => r.column_name === 'applied_at');
      const appliedJobId = cols.rows.find(
        (r) => r.column_name === 'applied_job_id',
      );
      expect(appliedAt?.is_nullable).toBe('YES');
      expect(appliedJobId?.is_nullable).toBe('YES');
    });
  });

  test('applied_job_id FK is SET NULL on preview-job delete', async () => {
    await withPristineDb(async (db) => {
      const fks = await db.query<{delete_rule: string}>(`
        SELECT rc.delete_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = 'cartridge_install_cache'
           AND kcu.column_name = 'applied_job_id'
      `);
      expect(fks.rows[0]?.delete_rule).toBe('SET NULL');
    });
  });
});
