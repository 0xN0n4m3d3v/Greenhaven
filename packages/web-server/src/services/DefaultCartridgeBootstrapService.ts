/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Desktop/default-world bootstrap.
//
// The packaged app ships a curated default cartridge into its runtime
// assets. Electron copies that source into the user data directory and
// sets GREENHAVEN_DEFAULT_FORGE_PROJECT to the copied Forge project.
// This service installs that cartridge once into a clean engine DB and
// then leaves the DB alone on later starts.

import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {config} from '../config.js';
import {query} from '../db.js';
import {DEFAULT_GENERATED} from '../scripts/cartridge-default-build.js';
import {
  CartridgeImportPreviewService,
  loadForgeProjectForApply,
  readInstallCache,
  type ImportJobView,
} from './CartridgeImportPreviewService.js';
import {CartridgeImportApplyService} from './CartridgeImportApplyService.js';

export interface DefaultForgeProjectResolution {
  forgeProject: string;
  manifestPath: string;
  available: boolean;
}

export interface DefaultCartridgeBootstrapResult {
  status:
    | 'disabled'
    | 'unavailable'
    | 'already_installed'
    | 'installed'
    | 'updated'
    | 'skipped_test';
  forgeProject: string;
  cartridgeId: string | null;
  jobId: string | null;
}

const DEFAULT_CARTRIDGE_ID = 'greenhaven-world';
const PORTABLE_DEFAULT_SOURCE_ROOT = 'greenhaven://default-cartridge/source';
const PORTABLE_DEFAULT_FORGE_PROJECT =
  `${PORTABLE_DEFAULT_SOURCE_ROOT}/.greenhaven-agent-manual/generated/cartridge-forge-project`;
const PREVIEW_POLL_INTERVAL_MS = 500;
const PREVIEW_TIMEOUT_MS = 180_000;

export function resolveDefaultForgeProject(
  env: NodeJS.ProcessEnv = process.env,
): DefaultForgeProjectResolution {
  const forgeProject = path.resolve(
    env['GREENHAVEN_DEFAULT_FORGE_PROJECT'] || DEFAULT_GENERATED,
  );
  const manifestPath = path.join(forgeProject, 'forge.project.json');
  return {
    forgeProject,
    manifestPath,
    available: existsSync(manifestPath),
  };
}

async function readDefaultCartridgeId(
  manifestPath: string,
): Promise<string> {
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const id = parsed['target_cartridge_id'];
    return typeof id === 'string' && id.trim()
      ? id.trim()
      : DEFAULT_CARTRIDGE_ID;
  } catch {
    return DEFAULT_CARTRIDGE_ID;
  }
}

async function cartridgeExists(cartridgeId: string): Promise<boolean> {
  const row = await query<{id: string}>(
    `SELECT id FROM cartridges WHERE id = $1 LIMIT 1`,
    [cartridgeId],
  );
  return Boolean(row.rows[0]);
}

async function defaultForgeContentHash(
  forgeProject: string,
  cartridgeId: string,
): Promise<string> {
  const loaded = await loadForgeProjectForApply(forgeProject, 'forge.project.json');
  if (loaded.cartridgeId && loaded.cartridgeId !== cartridgeId) {
    throw new Error(
      `default cartridge manifest id mismatch: expected=${cartridgeId} actual=${loaded.cartridgeId}`,
    );
  }
  return loaded.contentHash;
}

async function defaultAssetManifestNeedsRepair(
  forgeProject: string,
  cartridgeId: string,
): Promise<boolean> {
  if (!existsSync(path.join(forgeProject, 'audit', 'visual-assets.jsonl'))) {
    return false;
  }
  const row = await query<{value: unknown}>(
    `SELECT value
       FROM cartridge_meta_scoped
      WHERE cartridge_id = $1
        AND key = 'forge_visual_assets'
      LIMIT 1`,
    [cartridgeId],
  );
  const value = row.rows[0]?.value;
  if (!value || typeof value !== 'object') return true;
  const counts = (value as {counts?: Record<string, unknown>}).counts;
  if (!counts || typeof counts !== 'object') return true;
  const total = Number(counts['total'] ?? 0);
  const missing = Number(counts['missing'] ?? 0);
  const available = Number(counts['available'] ?? 0);
  return total > 0 && missing > 0 && available === 0;
}

export async function relocateDefaultCartridgeInstall(): Promise<{
  status: 'unavailable' | 'not_installed' | 'relocated';
  forgeProject: string;
  cartridgeId: string | null;
  rowsTouched: number;
}> {
  const resolved = resolveDefaultForgeProject();
  if (!resolved.available) {
    return {
      status: 'unavailable',
      forgeProject: resolved.forgeProject,
      cartridgeId: null,
      rowsTouched: 0,
    };
  }
  const cartridgeId = await readDefaultCartridgeId(resolved.manifestPath);
  if (!(await cartridgeExists(cartridgeId))) {
    return {
      status: 'not_installed',
      forgeProject: resolved.forgeProject,
      cartridgeId,
      rowsTouched: 0,
    };
  }

  let rowsTouched = 0;
  const cartridgeRows = await query(
    `UPDATE cartridges
        SET source_path = $2,
            updated_at = now()
      WHERE id = $1
        AND source_path IS DISTINCT FROM $2`,
    [cartridgeId, resolved.forgeProject],
  );
  rowsTouched += cartridgeRows.rowCount;

  const importRows = await query(
    `UPDATE cartridge_import_runs
        SET source_path = $2
      WHERE cartridge_id = $1
        AND source_kind = 'forge_project'
        AND source_path IS DISTINCT FROM $2`,
    [cartridgeId, resolved.forgeProject],
  );
  rowsTouched += importRows.rowCount;

  const previewRows = await query(
    `UPDATE cartridge_import_preview_jobs
        SET source_path = $2,
            result = CASE
              WHEN result IS NULL THEN result
              ELSE jsonb_set(
                jsonb_set(
                  result,
                  '{forgeProjectPath}',
                  to_jsonb($2::text),
                  true
                ),
                '{generatedArtifacts}',
                jsonb_build_array($2::text),
                true
              )
            END
      WHERE cartridge_id = $1
        AND source_kind = 'forge_project'
        AND (
          source_path IS DISTINCT FROM $2
          OR result->>'forgeProjectPath' IS DISTINCT FROM $2
          OR result->>'forgeProjectPath' = $3
        )`,
    [cartridgeId, resolved.forgeProject, PORTABLE_DEFAULT_FORGE_PROJECT],
  );
  rowsTouched += previewRows.rowCount;

  const assetRows = await query(
    `UPDATE cartridge_meta_scoped
        SET value = jsonb_set(value, '{source_path}', to_jsonb($2::text), true),
            updated_at = now()
      WHERE cartridge_id = $1
        AND key = 'forge_visual_assets'
        AND jsonb_typeof(value) = 'object'
        AND (
          value->>'source_path' IS DISTINCT FROM $2
          OR value->>'source_path' = $3
        )`,
    [cartridgeId, resolved.forgeProject, PORTABLE_DEFAULT_FORGE_PROJECT],
  );
  rowsTouched += assetRows.rowCount;

  return {
    status: 'relocated',
    forgeProject: resolved.forgeProject,
    cartridgeId,
    rowsTouched,
  };
}

async function waitForPreviewReady(jobId: string): Promise<ImportJobView> {
  const deadline = Date.now() + PREVIEW_TIMEOUT_MS;
  let last: ImportJobView | null = null;
  while (Date.now() <= deadline) {
    last = await CartridgeImportPreviewService.getJob(jobId);
    if (!last) {
      throw new Error(`default cartridge preview job disappeared: ${jobId}`);
    }
    if (last.status === 'ready') return last;
    if (last.status === 'failed' || last.status === 'cancelled') {
      const message = last.error?.message ?? last.phase ?? last.status;
      throw new Error(`default cartridge preview ${last.status}: ${message}`);
    }
    await delay(PREVIEW_POLL_INTERVAL_MS);
  }
  throw new Error(
    `default cartridge preview timed out after ${PREVIEW_TIMEOUT_MS}ms; last status=${last?.status ?? 'unknown'}`,
  );
}

function autoInstallEnabled(): boolean {
  const raw = process.env['GREENHAVEN_AUTO_INSTALL_DEFAULT_CARTRIDGE'];
  if (raw === '0' || raw === 'false') return false;
  if (config().nodeEnv === 'test' && raw !== '1' && raw !== 'true') {
    return false;
  }
  return true;
}

export async function ensureDefaultCartridgeInstalled(): Promise<DefaultCartridgeBootstrapResult> {
  const resolved = resolveDefaultForgeProject();
  if (!autoInstallEnabled()) {
    return {
      status: config().nodeEnv === 'test' ? 'skipped_test' : 'disabled',
      forgeProject: resolved.forgeProject,
      cartridgeId: null,
      jobId: null,
    };
  }
  if (!resolved.available) {
    return {
      status: 'unavailable',
      forgeProject: resolved.forgeProject,
      cartridgeId: null,
      jobId: null,
    };
  }

  const cartridgeId = await readDefaultCartridgeId(resolved.manifestPath);
  const exists = await cartridgeExists(cartridgeId);
  if (exists) {
    const [cache, currentContentHash] = await Promise.all([
      readInstallCache(cartridgeId),
      defaultForgeContentHash(resolved.forgeProject, cartridgeId),
    ]);
    if (cache?.content_hash === currentContentHash) {
      const needsAssetRepair = await defaultAssetManifestNeedsRepair(
        resolved.forgeProject,
        cartridgeId,
      );
      if (!needsAssetRepair) {
        return {
          status: 'already_installed',
          forgeProject: resolved.forgeProject,
          cartridgeId,
          jobId: null,
        };
      }
    }
  }

  const created = await CartridgeImportPreviewService.createJob({
    sourceKind: 'forge_project',
    sourcePath: resolved.forgeProject,
    mode: exists ? 'reimport' : 'install',
    cartridgeId: exists ? cartridgeId : null,
  });
  await waitForPreviewReady(created.jobId);
  const applied = await CartridgeImportApplyService.apply({
    jobId: created.jobId,
    acceptWarnings: true,
    expectedCartridgeId: cartridgeId,
  });
  if (applied.status !== 'applied') {
    throw new Error(
      `default cartridge apply finished with unexpected status=${applied.status}`,
    );
  }
  return {
    status: exists ? 'updated' : 'installed',
    forgeProject: resolved.forgeProject,
    cartridgeId,
    jobId: created.jobId,
  };
}
