/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-3 — baseline-first runtime migration runner.
//
// `runMigrations()` boots a Greenhaven database from one of three shapes:
//
//   1. Fresh DB (empty `schema_migrations`): apply
//      `packages/web-server/baseline/0001_engine_baseline.sql` once and
//      record `baseline-0001-engine`. Then apply any post-baseline
//      delta migrations — `migrations/*.sql` files whose basename is
//      NOT listed in `migrations/PREBASELINE_MANIFEST.txt`. Historical
//      prebaseline migrations (0001..0128) are skipped entirely.
//
//   2. Baseline-bootstrapped DB (`baseline-0001-engine` present): apply
//      only post-baseline deltas. Prebaseline migrations are skipped.
//
//   3. Legacy DB (historical migration names present, no
//      `baseline-0001-engine` row): the database already holds the
//      schema the baseline would have created. Skip the baseline,
//      apply any unrecorded historical migrations to keep legacy
//      shape intact, and log a one-shot compatibility notice. This
//      branch keeps long-running local dev pgdata directories from
//      breaking the day the baseline cutover lands.
//
// No down-migrations. Fix forward.

import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execMulti, query} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled output sits at dist/migrate.js, but the .sql files stay in
// the source tree at packages/web-server/migrations/. From either
// location the resolver walks up to the package root.
//
// FEAT-ENGINE-BASELINE-3 — top-level `migrations/` now contains only
// post-baseline deltas and the bookkeeping manifest; the 128
// historical migrations live under `migrations/archive-prebaseline/`.
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const BASELINE_DIR = path.resolve(__dirname, '..', 'baseline');
const BASELINE_PATH = path.join(BASELINE_DIR, '0001_engine_baseline.sql');
const BASELINE_VERSION = 'baseline-0001-engine';
const PREBASELINE_MANIFEST_PATH = path.join(
  MIGRATIONS_DIR,
  'PREBASELINE_MANIFEST.txt',
);

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
  mode: 'fresh-baseline' | 'baseline-deltas' | 'legacy-chain';
}

async function loadPrebaselineManifest(): Promise<Set<string>> {
  const raw = await readFile(PREBASELINE_MANIFEST_PATH, 'utf8');
  const names = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!trimmed.endsWith('.sql')) continue;
    names.add(trimmed);
  }
  return names;
}

async function listMigrationSqlFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function applyOne(file: string): Promise<void> {
  const sqlPath = path.join(MIGRATIONS_DIR, file);
  const sql = await readFile(sqlPath, 'utf8');
  try {
    await execMulti(`BEGIN; ${sql}; COMMIT;`);
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  } catch (err) {
    throw new Error(
      `migration ${file} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function applyBaseline(): Promise<void> {
  const sql = await readFile(BASELINE_PATH, 'utf8');
  try {
    // The baseline file itself contains the
    // `INSERT INTO schema_migrations ... 'baseline-0001-engine'` line,
    // so we do not re-record it here.
    await execMulti(`BEGIN; ${sql}; COMMIT;`);
  } catch (err) {
    throw new Error(
      `baseline ${BASELINE_VERSION} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export async function runMigrations(): Promise<RunMigrationsResult> {
  // Ensure the bookkeeping table exists even before the baseline runs
  // — the baseline itself recreates it idempotently, but bootstrapping
  // here means we can read existing rows to decide which branch we
  // are on without a chicken-and-egg.
  await execMulti(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const existingRows = await query<{name: string}>(
    `SELECT name FROM schema_migrations`,
  );
  const applied = new Set(existingRows.rows.map((r) => r.name));

  const manifest = await loadPrebaselineManifest();
  const allFiles = await listMigrationSqlFiles();
  const baselineRecorded = applied.has(BASELINE_VERSION);
  const hasHistoricalRows = [...applied].some((name) => manifest.has(name));

  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  let mode: RunMigrationsResult['mode'];
  if (baselineRecorded) {
    // Baseline already applied. Future deltas only.
    mode = 'baseline-deltas';
  } else if (hasHistoricalRows) {
    // Legacy dev pgdata predates the baseline cutover. The DB already
    // holds the schema/state the baseline would have created.
    mode = 'legacy-chain';
    console.warn(
      '[migrate] legacy schema_migrations rows detected without ' +
        `${BASELINE_VERSION}; skipping baseline and continuing the ` +
        'historical chain. Reset the local pgdata to migrate this DB ' +
        'onto the clean baseline.',
    );
  } else {
    // Fresh DB. Apply baseline once, then continue with deltas.
    mode = 'fresh-baseline';
    await applyBaseline();
    newlyApplied.push(BASELINE_VERSION);
    applied.add(BASELINE_VERSION);
  }

  for (const file of allFiles) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }
    if (manifest.has(file)) {
      // Prebaseline migration. Never reapplied on fresh/baseline-
      // deltas runs (the baseline already captures that state) and
      // never reapplied on legacy-chain runs (the legacy chain
      // already produced an equivalent schema; replaying these
      // files would now hit post-baseline check constraints that
      // did not exist when the migration was originally authored).
      // Legacy DBs that are mid-chain must be reset locally — the
      // warning emitted above is the user-visible signal.
      skipped.push(file);
      continue;
    }
    // Post-baseline delta — applied in every mode.
    await applyOne(file);
    newlyApplied.push(file);
    applied.add(file);
  }

  return {applied: newlyApplied, skipped, mode};
}

export {BASELINE_VERSION, BASELINE_PATH, BASELINE_DIR, PREBASELINE_MANIFEST_PATH};
