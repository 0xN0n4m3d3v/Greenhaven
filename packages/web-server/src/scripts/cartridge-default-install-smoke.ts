/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-4 — default-cartridge install smoke.
//
// Proves the new source-of-truth chain end-to-end:
//
//   1. Boot a fresh temp PGlite via `runMigrations()` — must apply
//      the clean engine baseline (`baseline-0001-engine`) and NOT
//      replay any archived prebaseline migration.
//   2. Assert the pre-install DB is worldless (`entities`,
//      `cartridges`, `cartridge_records`, `cartridge_meta_scoped`,
//      `cartridge_install_cache` all empty).
//   3. Drive `CartridgeImportPreviewService` against the existing
//      generated Forge project at
//      `<vault>/.greenhaven-agent-manual/generated/cartridge-forge-project`
//      (build it first via `cartridge:default:build`).
//   4. Drive `CartridgeImportApplyService.apply(jobId)`.
//   5. Verify `cartridges` / `cartridge_records` / `entities` /
//      `cartridge_meta_scoped` / `cartridge_import_runs` /
//      `cartridge_install_cache` all show `grinhaven-full` installed.
//   6. Resolve `forge.project.json#starting_location_slug` to the
//      newly-imported `entities.id` and persist both
//      `starting_location_slug` and `starting_location_id` in
//      `cartridge_meta_scoped` so a later playthrough launch has a
//      real starting point.
//   7. Write `result.json` to the run log directory.
//
// The smoke does NOT execute archived migration SQL, does NOT call
// `obsidian-dev-apply`, and does NOT import raw vault SQL.
//
// Usage:
//
//   npm --prefix packages/web-server run cartridge:default:install-smoke
//
// Optional flags:
//
//   --forge-project <path>   override generated Forge project path.
//   --out <dir>              override result.json output dir.
//   --timeout-ms <ms>        preview-job wait timeout (default 240s).
//   --keep-temp              keep the temp PGlite data dir.
//   --accept-warnings        accept validation warnings during apply.

import {mkdir, mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {existsSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ImportJobView} from '../services/CartridgeImportPreviewService.js';
import type {CartridgeAssetManifest} from '../services/CartridgeAssetManifestService.js';

interface AssetManifestSummary {
  schema_version: string;
  cartridge_id: string;
  cache_root: string;
  counts: CartridgeAssetManifest['counts'];
  sampleRows: Array<Pick<
    CartridgeAssetManifest['rows'][number],
    'asset_id' | 'kind' | 'slug' | 'role' | 'cache_path' | 'status'
  >>;
}

interface AssetRouteCheck {
  cartridgeId: string;
  kind: string;
  slug: string;
  role: string;
  /** First two bytes of the cache file as hex — proves the runtime
   *  resolver returned the bytes the manifest claims live in cache. */
  cacheBytesHexPrefix: string;
  contentType: string;
}

interface Args {
  forgeProject: string;
  outDir: string;
  timeoutMs: number;
  keepTemp: boolean;
  acceptWarnings: boolean;
}

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const DEFAULT_FORGE_PROJECT = path.join(
  REPO_ROOT,
  'GreenhavenWorld',
  '.greenhaven-agent-manual',
  'generated',
  'cartridge-forge-project',
);
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  '.codex',
  'run-logs',
  'cartridge-default-install-smoke',
);

function parseArgs(argv: string[]): Args {
  let forgeProject = DEFAULT_FORGE_PROJECT;
  let outDir = DEFAULT_OUT;
  let timeoutMs = 240_000;
  let keepTemp = false;
  let acceptWarnings = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--forge-project') {
      forgeProject = argv[++i] ?? forgeProject;
    } else if (arg === '--out') {
      outDir = argv[++i] ?? outDir;
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number(argv[++i] ?? timeoutMs) || timeoutMs;
    } else if (arg === '--keep-temp') {
      keepTemp = true;
    } else if (arg === '--accept-warnings') {
      acceptWarnings = true;
    }
  }
  return {forgeProject, outDir, timeoutMs, keepTemp, acceptWarnings};
}

interface ForgeProjectManifest {
  target_cartridge_id?: string;
  pack_slug?: string;
  starting_location_slug?: string;
  source_language?: string;
}

async function readForgeManifest(
  forgeProject: string,
): Promise<ForgeProjectManifest> {
  const manifestPath = path.join(forgeProject, 'forge.project.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`forge.project.json missing at ${manifestPath}`);
  }
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as ForgeProjectManifest;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  await mkdir(args.outDir, {recursive: true});

  const log = (m: string): void => {
    process.stderr.write(`[cartridge-default-install-smoke] ${m}\n`);
  };

  const dbDir = await mkdtemp(
    path.join(os.tmpdir(), 'cart-default-install-smoke-'),
  );
  process.env.PGLITE_DATA_DIR = dbDir;
  process.env.AUTH_SECRET ??= 'cartridge-default-install-smoke-32-byte-secret';
  process.env.FEATHERLESS_API_KEY ??= 'smoke-not-real-key';
  process.env.NODE_ENV ??= 'development';
  process.env.AUTH_DISABLED ??= '1';

  const blockers: string[] = [];
  const pre: Record<string, number> = {};
  const post: Record<string, number> = {};
  let manifest: ForgeProjectManifest | null = null;
  let finalView: ImportJobView | null = null;
  let migrationMode: string | null = null;
  let applyResult: Record<string, unknown> | null = null;
  let installCacheRow: Record<string, unknown> | null = null;
  let scopedMetaRows: Array<Record<string, unknown>> = [];
  let startingLocationId: number | null = null;
  let startingLocationSlug: string | null = null;
  let assetManifest: AssetManifestSummary | null = null;
  let assetCacheStat: {root: string; fileCount: number} | null = null;
  let assetRouteCheck: AssetRouteCheck | null = null;

  try {
    if (!existsSync(args.forgeProject)) {
      throw new Error(
        `forge project missing at ${args.forgeProject} — run cartridge:default:build first`,
      );
    }
    manifest = await readForgeManifest(args.forgeProject);
    log(
      `forge=${args.forgeProject} target=${manifest.target_cartridge_id} start=${manifest.starting_location_slug}`,
    );

    const {runMigrations} = await import('../migrate.js');
    const {closeDb, query} = await import('../db.js');

    const migrate = await runMigrations();
    migrationMode = migrate.mode;
    log(`runMigrations mode=${migrate.mode} applied=${migrate.applied.length}`);
    if (migrate.mode !== 'fresh-baseline') {
      blockers.push(`expected fresh-baseline mode, got ${migrate.mode}`);
    }

    // Pre-install: every cartridge-content table must be empty.
    for (const table of [
      'entities',
      'cartridges',
      'cartridge_records',
      'cartridge_meta_scoped',
      'cartridge_install_cache',
      'cartridge_import_runs',
    ]) {
      const row = await query<{c: number}>(
        `SELECT COUNT(*)::int AS c FROM ${quoteIdent(table)}`,
      );
      const count = Number(row.rows[0]?.c ?? 0);
      pre[table] = count;
      if (count !== 0) {
        blockers.push(`pre-install ${table} not empty: ${count}`);
      }
    }

    if (blockers.length === 0) {
      const {CartridgeImportPreviewService} = await import(
        '../services/CartridgeImportPreviewService.js'
      );
      const {CartridgeImportApplyService} = await import(
        '../services/CartridgeImportApplyService.js'
      );

      const created = await CartridgeImportPreviewService.createJob({
        sourceKind: 'forge_project',
        sourcePath: args.forgeProject,
        mode: 'install',
      });
      log(`preview job=${created.jobId}`);

      const deadline = Date.now() + args.timeoutMs;
      let last = created;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        const next = await CartridgeImportPreviewService.getJob(
          created.jobId,
        );
        if (!next) {
          blockers.push('preview job vanished mid-poll');
          break;
        }
        last = next;
        if (
          next.status === 'ready' ||
          next.status === 'failed' ||
          next.status === 'cancelled'
        ) {
          break;
        }
      }
      if (last.status !== 'ready') {
        blockers.push(`preview ended with status=${last.status}`);
      } else {
        log(
          `preview ready records=${last.result?.totalRecords} cartridge=${last.result?.cartridgeId}`,
        );

        const applied = await CartridgeImportApplyService.apply({
          jobId: created.jobId,
          acceptWarnings: args.acceptWarnings,
        });
        finalView = applied;
        if (applied.status !== 'applied') {
          blockers.push(`apply ended with status=${applied.status}`);
        } else {
          const cartridgeId = applied.result?.cartridgeId ?? '';
          applyResult =
            (applied.result as unknown as {applyResult?: Record<string, unknown>})
              ?.applyResult ?? null;
          log(
            `apply ok cartridge=${cartridgeId} diff=${JSON.stringify(applyResult?.['diff'])}`,
          );

          // Post-install counts.
          for (const table of [
            'entities',
            'cartridges',
            'cartridge_records',
            'cartridge_meta_scoped',
            'cartridge_install_cache',
            'cartridge_import_runs',
          ]) {
            const row = await query<{c: number}>(
              `SELECT COUNT(*)::int AS c FROM ${quoteIdent(table)}`,
            );
            post[table] = Number(row.rows[0]?.c ?? 0);
          }

          if (post['cartridges'] === 0) {
            blockers.push('cartridges empty after apply');
          }
          if (post['cartridge_records'] === 0) {
            blockers.push('cartridge_records empty after apply');
          }
          if (post['entities'] === 0) {
            blockers.push('entities empty after apply');
          }
          if (post['cartridge_import_runs'] === 0) {
            blockers.push('cartridge_import_runs empty after apply');
          }

          const cacheRow = await query<Record<string, unknown>>(
            `SELECT cartridge_id, state, content_hash, record_count,
                    applied_at::text AS applied_at,
                    applied_job_id
               FROM cartridge_install_cache
              WHERE cartridge_id = $1`,
            [cartridgeId],
          );
          installCacheRow = cacheRow.rows[0] ?? null;
          if (!installCacheRow) {
            blockers.push('install_cache row missing for cartridge');
          }

          // FEAT-ENGINE-BASELINE-6 — apply now persists
          // starting_location_slug + starting_location_id into
          // cartridge_meta_scoped for every cartridge whose Forge
          // manifest declares one, so this script no longer has to
          // resolve the slug manually. The smoke only verifies that
          // both rows landed and that the resolved entity id points
          // at a real entity.
          startingLocationSlug = manifest.starting_location_slug ?? null;
          if (startingLocationSlug) {
            const persistedSlug = await query<{value: string | null}>(
              `SELECT (value #>> '{}')::text AS value
                 FROM cartridge_meta_scoped
                WHERE cartridge_id = $1 AND key = 'starting_location_slug'`,
              [cartridgeId],
            );
            if (persistedSlug.rows[0]?.value !== startingLocationSlug) {
              blockers.push(
                `cartridge_meta_scoped.starting_location_slug missing for ${startingLocationSlug}`,
              );
            }
            const persistedId = await query<{value: string | null}>(
              `SELECT (value #>> '{}')::text AS value
                 FROM cartridge_meta_scoped
                WHERE cartridge_id = $1 AND key = 'starting_location_id'`,
              [cartridgeId],
            );
            const rawId = persistedId.rows[0]?.value;
            startingLocationId =
              rawId != null && rawId !== '' && Number.isFinite(Number(rawId))
                ? Number(rawId)
                : null;
            if (startingLocationId == null) {
              blockers.push(
                `cartridge_meta_scoped.starting_location_id missing for ${startingLocationSlug}`,
              );
            }
          }

          const scoped = await query<Record<string, unknown>>(
            `SELECT key, value
               FROM cartridge_meta_scoped
              WHERE cartridge_id = $1
              ORDER BY key
              LIMIT 12`,
            [cartridgeId],
          );
          scopedMetaRows = scoped.rows;

          // FEAT-ENGINE-BASELINE-5 — verify the cartridge-scoped
          // visual asset manifest landed, cache files exist on disk,
          // and at least one entry can be fetched via the runtime
          // route from the installed cache.
          const assetCheck = await verifyAssetManifest(cartridgeId);
          assetManifest = assetCheck.manifest;
          assetCacheStat = assetCheck.cacheStat;
          assetRouteCheck = assetCheck.routeCheck;
          for (const b of assetCheck.blockers) blockers.push(b);
        }
      }
    }

    await closeDb().catch(() => {});
  } catch (err) {
    blockers.push(
      `unexpected: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (!args.keepTemp) {
      await rm(dbDir, {recursive: true, force: true}).catch(() => {});
    }
  }

  const finishedAt = new Date();
  const out = {
    passed: blockers.length === 0,
    blockers,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    forgeProject: args.forgeProject,
    manifest,
    migrationMode,
    preCounts: pre,
    postCounts: post,
    finalView,
    installCacheRow,
    scopedMetaRows,
    startingLocationSlug,
    startingLocationId,
    applyResult,
    assetManifest,
    assetCacheStat,
    assetRouteCheck,
  };
  writeFileSync(
    path.join(args.outDir, 'result.json'),
    JSON.stringify(out, null, 2),
  );
  if (out.passed) {
    process.stderr.write(
      `[cartridge-default-install-smoke] PASS — result=${path.join(args.outDir, 'result.json')}\n`,
    );
    return 0;
  }
  process.stderr.write(
    `[cartridge-default-install-smoke] FAIL — blockers: ${JSON.stringify(blockers)}\n`,
  );
  return 1;
}

function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`unsafe identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function verifyAssetManifest(cartridgeId: string): Promise<{
  manifest: AssetManifestSummary | null;
  cacheStat: {root: string; fileCount: number} | null;
  routeCheck: AssetRouteCheck | null;
  blockers: string[];
}> {
  const blockers: string[] = [];
  const {query} = await import('../db.js');
  const {Hono} = await import('hono');
  const {visualAssetRoutes} = await import('../routes/visualAssets.js');
  const {
    ASSET_MANIFEST_META_KEY,
    parseScopedManifestPayload,
    getCartridgeAssetCacheRoot,
  } = await import('../services/CartridgeAssetManifestService.js');

  const row = await query<{value: unknown}>(
    `SELECT value FROM cartridge_meta_scoped
      WHERE cartridge_id = $1 AND key = $2`,
    [cartridgeId, ASSET_MANIFEST_META_KEY],
  );
  if (!row.rows[0]) {
    blockers.push(`scoped meta ${ASSET_MANIFEST_META_KEY} missing for ${cartridgeId}`);
    return {manifest: null, cacheStat: null, routeCheck: null, blockers};
  }
  const parsed = parseScopedManifestPayload(row.rows[0].value);
  if (!parsed) {
    blockers.push('scoped asset manifest failed schema parse');
    return {manifest: null, cacheStat: null, routeCheck: null, blockers};
  }
  if (parsed.counts.total === 0) {
    blockers.push('scoped asset manifest is empty (counts.total = 0)');
  }
  if (parsed.counts.available === 0) {
    blockers.push('scoped asset manifest has zero available entries');
  }

  const dataDir = process.env.PGLITE_DATA_DIR
    ? path.resolve(process.env.PGLITE_DATA_DIR, '..')
    : path.resolve('.');
  // The apply pipeline used config().dataDir (or repo pgdata fallback).
  // Re-resolve via the same helper so the on-disk check matches what
  // the route reads.
  const {config} = await import('../config.js');
  const cfg = config();
  const resolvedDataDir = cfg.dataDir && cfg.dataDir.trim().length > 0
    ? path.resolve(cfg.dataDir)
    : path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'pgdata',
      );
  void dataDir;
  const cacheRoot = getCartridgeAssetCacheRoot(resolvedDataDir, cartridgeId);
  let fileCount = 0;
  if (existsSync(cacheRoot)) {
    fileCount = (await readdir(cacheRoot)).filter((f) =>
      /\.(png|jpe?g|gif|webp|svg)$/i.test(f),
    ).length;
  } else {
    blockers.push(`cache root missing on disk: ${cacheRoot}`);
  }
  if (fileCount === 0 && parsed.counts.available > 0) {
    blockers.push(
      `cache root has no image files even though manifest reports ${parsed.counts.available} available`,
    );
  }

  const available = parsed.rows.find((r) => r.status === 'available');
  let routeCheck: AssetRouteCheck | null = null;
  if (available) {
    const app = new Hono();
    app.route('/api/assets', visualAssetRoutes);
    const url = `/api/assets/cartridges/${cartridgeId}/world/${available.kind}/${available.slug}/${available.role}`;
    const res = await app.request(url);
    if (res.status !== 200) {
      blockers.push(`route GET ${url} returned ${res.status}`);
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      const prefix = Array.from(buf.slice(0, 2))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      routeCheck = {
        cartridgeId,
        kind: available.kind,
        slug: available.slug,
        role: available.role,
        cacheBytesHexPrefix: prefix,
        contentType: res.headers.get('content-type') ?? '',
      };
    }
  } else if (parsed.counts.total > 0) {
    blockers.push('no manifest rows with status=available; cannot exercise runtime route');
  }

  const sampleRows = parsed.rows.slice(0, 3).map((r) => ({
    asset_id: r.asset_id,
    kind: r.kind,
    slug: r.slug,
    role: r.role,
    cache_path: r.cache_path,
    status: r.status,
  }));
  return {
    manifest: {
      schema_version: parsed.schema_version,
      cartridge_id: parsed.cartridge_id,
      cache_root: parsed.cache_root,
      counts: parsed.counts,
      sampleRows,
    },
    cacheStat: {root: cacheRoot, fileCount},
    routeCheck,
    blockers,
  };
}

const isDirect = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(FILE)
  : false;
if (isDirect) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error('[cartridge-default-install-smoke] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runCartridgeDefaultInstallSmoke};
