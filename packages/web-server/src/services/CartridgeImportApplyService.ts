/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-3 — safe apply / reimport.
//
// Consumes a `ready` cartridge import-preview job and atomically
// writes installed-cartridge registry/import-run/record/static-
// entity/scoped-metadata/install-cache state inside a single
// `withTransaction(...)` boundary. Player / runtime state is
// **never** mutated. Static rows marked `dynamic_origin = true`
// are likewise never overwritten — incoming records that conflict
// with them are stored as `blocked` in `cartridge_records` and
// reported in the diff so the GUI can surface them.
//
// Record matching order (per the master spec):
//   1. by stable `record_id` against existing `cartridge_records`,
//   2. otherwise — for the default cartridge bootstrap path where
//      `cartridge_records` is empty — by
//      `(cartridge_id, kind, lower(display_name))` against
//      existing `entities` rows so the very first apply does not
//      duplicate the in-DB world.
//
// Diff buckets (per-record content-hash compare):
//   * `new`        — no existing match
//   * `changed`    — match found, content_hash differs
//   * `unchanged`  — match found, content_hash equal
//   * `deprecated` — existing cartridge_records row whose
//                    `record_id` is not in the incoming set
//   * `blocked`    — matched entity row carries
//                    `dynamic_origin = true` (or any other
//                    runtime-conflict marker); apply leaves the
//                    entity row alone and stores the
//                    cartridge_records row as `blocked`.

import {randomUUID} from 'node:crypto';
import {clearMetaCache} from '../cartridge.js';
import {query, withTransaction} from '../db.js';
import {stripEntityProfileAliases} from '../entities/profileSanitizer.js';
import {telemetry} from '../telemetry/index.js';
import {
  ASSET_MANIFEST_META_KEY,
  buildCartridgeAssetManifest,
  type CartridgeAssetEntry,
  type CartridgeAssetManifest,
} from './CartridgeAssetManifestService.js';
import {
  buildScopedBridgeWritePlan,
  loadForgeBridgeArtifacts,
  tombstoneBridgeArtifacts,
  type ForgeBridgeArtifacts,
} from './ForgeBridgeArtifactsService.js';
import {
  CartridgeImportPreviewService,
  loadForgeProjectForApply,
  type CartridgeIngestRecord,
  type ImportJobView,
} from './CartridgeImportPreviewService.js';
import {UniverseInstanceService} from './UniverseInstanceService.js';

export interface ApplyJobOptions {
  jobId: string;
  acceptWarnings?: boolean;
  /**
   * When provided, apply rejects with `cartridge_id_mismatch`
   * before any DB write or job status flip if the preview job's
   * resolved cartridge id does not match this value. The
   * `/cartridges/:id/reimport/apply` route forwards its URL `:id`
   * here so reimport cannot mutate a different cartridge than the
   * URL targeted, even when the preview job was created against
   * an unrelated source.
   */
  expectedCartridgeId?: string;
}

export interface ApplyDiff {
  new: number;
  changed: number;
  unchanged: number;
  deprecated: number;
  blocked: number;
}

export interface ApplyResult {
  cartridgeId: string;
  contentHash: string;
  totalRecords: number;
  diff: ApplyDiff;
  importRunId: number;
  applyJobId: string;
  blockedRecordIds: string[];
  deprecatedRecordIds: string[];
}

export interface ApplyError {
  code: string;
  message: string;
  details?: unknown;
}

class ApplyServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApplyServiceError';
  }
}

// ──────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────

export class CartridgeImportApplyService {
  /**
   * Apply a ready preview job. Returns the final apply view; on
   * success the underlying job row is in status `applied` with
   * the apply result attached, install-cache state is refreshed,
   * and `cartridge.clearMetaCache()` has been called so the
   * default-cartridge getMeta cache picks up any new values.
   *
   * Errors are reported on the same job row (status `failed`) so
   * the caller can fetch them via `getJob`. The thrown
   * `ApplyServiceError` mirrors that view for synchronous
   * callers.
   */
  static async apply(opts: ApplyJobOptions): Promise<ImportJobView> {
    if (typeof opts.jobId !== 'string' || opts.jobId.length === 0) {
      throw new ApplyServiceError('invalid_job_id', 'jobId is required');
    }
    const job = await CartridgeImportPreviewService.getJob(opts.jobId);
    if (!job) {
      throw new ApplyServiceError('unknown_job', `job ${opts.jobId} not found`);
    }
    if (job.status !== 'ready') {
      throw new ApplyServiceError(
        'job_not_ready',
        `job ${opts.jobId} is in status '${job.status}'; apply requires 'ready'`,
      );
    }
    if (!job.result) {
      throw new ApplyServiceError(
        'job_no_result',
        `job ${opts.jobId} has no preview result attached`,
      );
    }
    // Validation gate (FEAT-CART-LIB-3 corrective):
    //   * `validation.errors > 0` is ALWAYS terminal — `acceptWarnings`
    //     never bypasses it. Apply against a broken preview would be a
    //     foot-gun.
    //   * `validation.warnings > 0` requires explicit `acceptWarnings`,
    //     otherwise the caller gets a retryable 409-style
    //     `validation_warnings` error so the GUI can prompt the user.
    if ((job.result.validation?.errors ?? 0) > 0) {
      throw new ApplyServiceError(
        'validation_errors',
        `preview reported ${job.result.validation.errors} validation error(s); resolve before applying`,
      );
    }
    if (
      (job.result.validation?.warnings ?? 0) > 0 &&
      !opts.acceptWarnings
    ) {
      throw new ApplyServiceError(
        'validation_warnings',
        `preview reported ${job.result.validation.warnings} validation warning(s); pass acceptWarnings=true to accept`,
      );
    }
    const cartridgeId = job.result.cartridgeId;
    if (!cartridgeId) {
      throw new ApplyServiceError(
        'no_cartridge_id',
        `preview result is missing a target_cartridge_id`,
      );
    }
    // Pre-flight cartridge-id match — runs BEFORE we flip the job to
    // `applying` so a mismatched reimport can never mutate the wrong
    // cartridge or leave the job in a half-applied state.
    if (
      opts.expectedCartridgeId != null &&
      opts.expectedCartridgeId !== cartridgeId
    ) {
      throw new ApplyServiceError(
        'cartridge_id_mismatch',
        `reimport URL targeted '${opts.expectedCartridgeId}' but preview job applies to '${cartridgeId}'`,
      );
    }
    const sourcePath = (job.result as unknown as {forgeProjectPath?: string})
      .forgeProjectPath;
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      throw new ApplyServiceError(
        'no_source_path',
        `preview result is missing forgeProjectPath`,
      );
    }
    const manifestFile =
      job.sourceKind === 'agent_pack' ? 'manifest.json' : 'forge.project.json';

    // Flip the job to `applying` so concurrent GETs see the in-
    // flight state.
    await updatePreviewJob(opts.jobId, {
      status: 'applying',
      phase: 'apply',
    });

    let load;
    try {
      load = await loadForgeProjectForApply(sourcePath, manifestFile);
    } catch (err) {
      const e = mapApplyError(err, 'load_failed');
      await updatePreviewJob(opts.jobId, {
        status: 'failed',
        phase: 'failed',
        error: e,
        finishedAt: new Date(),
      });
      throw new ApplyServiceError(e.code, e.message);
    }

    // Validate the source did not change under our feet.
    if (load.contentHash !== job.result.contentHash) {
      const e: ApplyError = {
        code: 'source_changed',
        message: `source content_hash drifted from preview (${job.result.contentHash} → ${load.contentHash}); rerun preview before apply`,
      };
      await updatePreviewJob(opts.jobId, {
        status: 'failed',
        phase: 'failed',
        error: e,
        finishedAt: new Date(),
      });
      throw new ApplyServiceError(e.code, e.message);
    }
    if (load.cartridgeId !== cartridgeId) {
      const e: ApplyError = {
        code: 'cartridge_id_drift',
        message: `manifest cartridge id changed since preview (${cartridgeId} → ${load.cartridgeId})`,
      };
      await updatePreviewJob(opts.jobId, {
        status: 'failed',
        phase: 'failed',
        error: e,
        finishedAt: new Date(),
      });
      throw new ApplyServiceError(e.code, e.message);
    }

    // FEAT-ENGINE-BASELINE-5 — build the cartridge-scoped asset
    // manifest BEFORE the apply transaction so the file copies land
    // on disk first. The transaction below persists the manifest into
    // `cartridge_meta_scoped.forge_visual_assets`. Source files are
    // content-hashed into `<data-dir>/cartridges/<cartridge-id>/assets/`,
    // so a retried apply reuses the cache without re-copying. A
    // missing `audit/visual-assets.jsonl` is silently a no-op
    // (returns a manifest with `counts.total = 0`).
    let assetManifest: CartridgeAssetManifest | null = null;
    try {
      const built = await buildCartridgeAssetManifest({
        cartridgeId,
        sourcePath,
      });
      assetManifest = built.manifest;
    } catch (err) {
      // Asset build is best-effort: a missing JSONL or a permissions
      // hiccup must not prevent the cartridge install from landing.
      // The scoped meta key is simply omitted; legacy global
      // `forge_visual_assets` (OWV-17) keeps working.
      telemetry.record({
        channel: 'gameplay',
        name: 'cartridge_asset_manifest_failed',
        data: {
          cartridge_id: cartridgeId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    // OBSIDIAN-VAULT-IMPORT-2 (2026-05-18) — load the four runtime
    // bridge artifacts (`audit/currency-rates.json`,
    // `merchant-contracts.jsonl`, `materializes.jsonl`,
    // `scene-instructions.jsonl`). Missing files surface as
    // tombstone v1 documents so the apply transaction always writes
    // a valid scoped row per bridge key, even if the writer has not
    // authored that surface yet. The actual write happens inside
    // `applyTransactionally` to keep the row commit-coupled with the
    // other scoped meta.
    let bridgeArtifacts: ForgeBridgeArtifacts;
    try {
      bridgeArtifacts = await loadForgeBridgeArtifacts({
        sourcePath,
        sourceProject: cartridgeId,
      });
    } catch (err) {
      telemetry.record({
        channel: 'gameplay',
        name: 'cartridge_bridge_artifacts_failed',
        data: {
          cartridge_id: cartridgeId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      bridgeArtifacts = tombstoneBridgeArtifacts(cartridgeId);
    }

    let result: ApplyResult;
    try {
      result = await applyTransactionally({
        previewJobId: opts.jobId,
        cartridgeId,
        sourcePath,
        sourceKind: job.sourceKind,
        manifest: load.manifest,
        contentHash: load.contentHash,
        records: load.records,
        validationReport: {
          errors: load.warnings.filter((w) => w.level === 'error').length,
          warnings: load.warnings.filter((w) => w.level === 'warning').length,
          items: load.warnings,
        },
        assetManifest,
        bridgeArtifacts,
      });
    } catch (err) {
      const e = mapApplyError(err, 'apply_failed');
      await updatePreviewJob(opts.jobId, {
        status: 'failed',
        phase: 'failed',
        error: e,
        finishedAt: new Date(),
      });
      telemetry.record({
        channel: 'gameplay',
        name: 'cartridge.import_apply.failed',
        error: err instanceof Error ? err : undefined,
        data: {
          job_id: opts.jobId,
          cartridge_id: cartridgeId,
          code: e.code,
          message: e.message,
        },
      });
      throw new ApplyServiceError(e.code, e.message);
    }

    // Clear cached cartridge metadata so the next `getMeta` call
    // sees the freshly written scoped values.
    clearMetaCache();

    // Update the preview job row → applied + final result merged
    // with the apply diff.
    const mergedResult = {...job.result, applyResult: result};
    await updatePreviewJob(opts.jobId, {
      status: 'applied',
      phase: 'applied',
      finishedAt: new Date(),
      cartridgeId,
      result: mergedResult,
    });
    telemetry.record({
      channel: 'gameplay',
      name: 'cartridge.import_apply.ready',
      data: {
        job_id: opts.jobId,
        cartridge_id: cartridgeId,
        new: result.diff.new,
        changed: result.diff.changed,
        unchanged: result.diff.unchanged,
        deprecated: result.diff.deprecated,
        blocked: result.diff.blocked,
      },
    });

    const after = await CartridgeImportPreviewService.getJob(opts.jobId);
    if (!after) {
      throw new ApplyServiceError(
        'job_vanished',
        `job ${opts.jobId} not readable after apply`,
      );
    }
    return after;
  }
}

// ──────────────────────────────────────────────────────────────
// Transactional apply body
// ──────────────────────────────────────────────────────────────

interface ApplyContext {
  previewJobId: string;
  cartridgeId: string;
  sourcePath: string;
  sourceKind: string;
  manifest: Record<string, unknown>;
  contentHash: string;
  records: CartridgeIngestRecord[];
  validationReport: {
    errors: number;
    warnings: number;
    items: Array<{level: string; message: string}>;
  };
  assetManifest: CartridgeAssetManifest | null;
  /** OBSIDIAN-VAULT-IMPORT-2 — pre-loaded OWV bridge artifacts. Always
   *  present; missing source files surface as tombstone v1 documents
   *  so reimport replaces any stale scoped row instead of leaking
   *  legacy global bridge data into this cartridge. */
  bridgeArtifacts: ForgeBridgeArtifacts;
}

interface ExistingCartridgeRecord {
  record_id: string;
  kind: string;
  slug: string;
  content_hash: string;
  imported_entity_id: number | null;
}

interface ExistingEntity {
  id: number;
  display_name: string;
  dynamic_origin: boolean;
}

function kindSlugKey(kind: string, slug: string): string {
  return `${kind}::${slug.trim().toLowerCase()}`;
}

function assetUrl(
  cartridgeId: string,
  kind: string,
  slug: string,
  role: string,
): string {
  return `/api/assets/cartridges/${encodeURIComponent(cartridgeId)}/world/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}/${encodeURIComponent(role)}`;
}

function assetRowsForRecord(
  ctx: ApplyContext,
  rec: CartridgeIngestRecord,
): CartridgeAssetEntry[] {
  if (!ctx.assetManifest) return [];
  const kind = rec.kind.trim().toLowerCase();
  const slug = rec.slug.trim().toLowerCase();
  return ctx.assetManifest.rows.filter(
    (row) =>
      row.status === 'available' &&
      row.kind === kind &&
      row.slug === slug &&
      row.role.trim().length > 0,
  );
}

function readRecordPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function portraitKeyForRole(role: string): string | null {
  const normalized = role.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'portrait' || normalized === 'portrait_default') {
    return 'default';
  }
  if (normalized.startsWith('portrait_')) {
    return normalized.slice('portrait_'.length) || 'default';
  }
  return null;
}

function payloadWithRuntimeAssetLinks(
  ctx: ApplyContext,
  rec: CartridgeIngestRecord,
): Record<string, unknown> {
  const basePayload = stripEntityProfileAliases(rec.payload);
  const rows = assetRowsForRecord(ctx, rec);
  if (rows.length === 0) return basePayload;

  const payload = {...basePayload};
  const existingAssetUrls = readRecordPayload(payload['visual_asset_urls']);
  const assetUrls: Record<string, string> = {...existingAssetUrls} as Record<
    string,
    string
  >;
  for (const row of rows) {
    if (typeof assetUrls[row.role] !== 'string' || !assetUrls[row.role]) {
      assetUrls[row.role] = assetUrl(
        ctx.cartridgeId,
        row.kind,
        row.slug,
        row.role,
      );
    }
  }
  payload['visual_asset_urls'] = assetUrls;

  if (rec.kind.trim().toLowerCase() === 'person') {
    const existingPortraits = readRecordPayload(payload['portrait_set']);
    const portraitSet: Record<string, string | null> = {
      ...(existingPortraits as Record<string, string | null>),
    };
    for (const row of rows) {
      const key = portraitKeyForRole(row.role);
      if (!key) continue;
      const current = portraitSet[key];
      if (typeof current !== 'string' || current.trim().length === 0) {
        portraitSet[key] = assetUrl(ctx.cartridgeId, 'person', rec.slug, row.role);
      }
    }
    if (Object.keys(portraitSet).length > 0) {
      payload['portrait_set'] = portraitSet;
    }
  }

  return payload;
}

async function applyTransactionally(ctx: ApplyContext): Promise<ApplyResult> {
  const applyJobId = randomUUID();
  return await withTransaction(async () => {
    // 1. Upsert the cartridges row (target of the apply).
    const title =
      readManifestString(ctx.manifest, 'title') ??
      readManifestString(ctx.manifest, 'project_slug') ??
      ctx.cartridgeId;
    const version =
      readManifestString(ctx.manifest, 'version') ??
      readManifestString(ctx.manifest, 'schema_version') ??
      '0.0.0';
    const schemaVersion =
      readManifestString(ctx.manifest, 'schema_version') ?? '1';
    await query(
      `INSERT INTO cartridges (
         id, title, version, schema_version, source_kind, source_path,
         content_hash, manifest, validation_report, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'installed')
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         version = EXCLUDED.version,
         schema_version = EXCLUDED.schema_version,
         source_kind = EXCLUDED.source_kind,
         source_path = EXCLUDED.source_path,
         content_hash = EXCLUDED.content_hash,
         manifest = EXCLUDED.manifest,
         validation_report = EXCLUDED.validation_report,
         updated_at = now()`,
      [
        ctx.cartridgeId,
        title,
        version,
        schemaVersion,
        normaliseCartridgeSourceKind(ctx.sourceKind),
        ctx.sourcePath,
        ctx.contentHash,
        JSON.stringify(ctx.manifest),
        JSON.stringify(ctx.validationReport),
      ],
    );

    // 2. Insert a `cartridge_import_runs` row to anchor the
    //    per-record `last_import_run_id` FKs.
    const importRun = await query<{id: number}>(
      `INSERT INTO cartridge_import_runs (
         cartridge_id, mode, source_kind, source_path,
         content_hash_after, status, applied_at
       )
       VALUES ($1, 'install', $2, $3, $4, 'applied', now())
       RETURNING id`,
      [
        ctx.cartridgeId,
        normaliseCartridgeSourceKind(ctx.sourceKind),
        ctx.sourcePath,
        ctx.contentHash,
      ],
    );
    const importRunId = Number(importRun.rows[0]?.id);

    // 3. Pull existing cartridge_records + per-record entity rows
    //    so we can compute the diff buckets in one pass. We index
    //    by both `record_id` (primary key) and `(kind, slug)` so
    //    a writer-side record_id rename of the same logical
    //    (kind, slug) reuses the existing entity instead of
    //    duplicating or hitting the unique constraint.
    const existingRows = await query<ExistingCartridgeRecord>(
      `SELECT record_id, kind, slug, content_hash, imported_entity_id
         FROM cartridge_records
        WHERE cartridge_id = $1`,
      [ctx.cartridgeId],
    );
    const existingByRecordId = new Map<string, ExistingCartridgeRecord>();
    const existingByKindSlug = new Map<string, ExistingCartridgeRecord>();
    for (const row of existingRows.rows) {
      existingByRecordId.set(row.record_id, row);
      existingByKindSlug.set(kindSlugKey(row.kind, row.slug), row);
    }
    const bootstrap = existingRows.rows.length === 0;

    // For the default-cartridge bootstrap, load existing entities
    // and index by `source_slug`, `source_tag`, and lower-cased
    // display name. Source-slug / source-tag carry stable writer-
    // facing identifiers when present (set on import), so they
    // are preferred over display-name matching for reuse.
    const entitiesBySourceSlug = new Map<string, ExistingEntity>();
    const entitiesBySourceTag = new Map<string, ExistingEntity>();
    const entitiesByName = new Map<string, ExistingEntity>();
    if (bootstrap) {
      const ents = await query<{
        id: number;
        kind: string;
        display_name: string;
        dynamic_origin: boolean;
        source_slug: string | null;
        source_tag: string | null;
      }>(
        `SELECT id,
                kind,
                display_name,
                COALESCE(dynamic_origin, false) AS dynamic_origin,
                profile->>'source_slug' AS source_slug,
                profile->>'source_tag' AS source_tag
           FROM entities
          WHERE cartridge_id = $1`,
        [ctx.cartridgeId],
      );
      for (const row of ents.rows) {
        const ent: ExistingEntity = {
          id: row.id,
          display_name: row.display_name,
          dynamic_origin: row.dynamic_origin,
        };
        if (row.source_slug) {
          entitiesBySourceSlug.set(kindSlugKey(row.kind, row.source_slug), ent);
        }
        if (row.source_tag) {
          entitiesBySourceTag.set(kindSlugKey(row.kind, row.source_tag), ent);
        }
        entitiesByName.set(bootstrapKey(row.kind, row.display_name), ent);
      }
    }

    const incomingRecordIds = new Set<string>();
    // record_ids in the existingRows snapshot we "consumed" via the
    // (kind, slug) drift fallback. These must NOT be deprecated by
    // Step F since their underlying row was migrated, not dropped.
    const consumedExistingRecordIds = new Set<string>();
    let counterNew = 0;
    let counterChanged = 0;
    let counterUnchanged = 0;
    let counterBlocked = 0;
    const blockedRecordIds: string[] = [];

    for (const rec of ctx.records) {
      incomingRecordIds.add(rec.recordId);

      // Step A — match by stable `record_id` against existing
      // cartridge_records.
      let existing: ExistingCartridgeRecord | undefined =
        existingByRecordId.get(rec.recordId);
      // record_id we'll DELETE before re-inserting under the new
      // record_id when a (kind, slug) fallback rescues us from
      // writer-side record_id drift.
      let migrateFromRecordId: string | null = null;

      // Step B — `(cartridge_id, kind, slug)` fallback against
      // existing cartridge_records. Catches writer-side record_id
      // renames where the logical record (same kind + slug) keeps
      // identity but its record_id changed.
      if (!existing) {
        const ksMatch = existingByKindSlug.get(kindSlugKey(rec.kind, rec.slug));
        if (
          ksMatch &&
          ksMatch.record_id !== rec.recordId &&
          !consumedExistingRecordIds.has(ksMatch.record_id)
        ) {
          existing = ksMatch;
          migrateFromRecordId = ksMatch.record_id;
          consumedExistingRecordIds.add(ksMatch.record_id);
        }
      }

      let entityId: number | null = existing?.imported_entity_id ?? null;
      let isBlocked = false;
      const prevHash: string | null = existing?.content_hash ?? null;

      // Step C — bootstrap matching against existing entities,
      // ONLY when this cartridge has zero cartridge_records yet.
      // Preference order: `source_slug` → `source_tag` →
      // lower(display_name). Source-slug / source-tag carry stable
      // writer-facing identifiers and are preferred when present.
      if (entityId == null && bootstrap) {
        const slugKey = kindSlugKey(rec.kind, rec.slug);
        let match: ExistingEntity | undefined =
          entitiesBySourceSlug.get(slugKey) ??
          entitiesBySourceTag.get(slugKey);
        if (!match) {
          match = entitiesByName.get(bootstrapKey(rec.kind, rec.displayName));
        }
        if (match) {
          entityId = match.id;
          if (match.dynamic_origin) {
            isBlocked = true;
          }
        }
      }

      // Step D — re-probe dynamic_origin live before writing. The
      // bootstrap snapshot might be stale if a runtime promotion
      // raced us.
      if (entityId != null && !isBlocked) {
        const probe = await query<{dynamic_origin: boolean}>(
          `SELECT COALESCE(dynamic_origin, false) AS dynamic_origin
             FROM entities WHERE id = $1`,
          [entityId],
        );
        if (probe.rows[0]?.dynamic_origin) {
          isBlocked = true;
        }
      }

      if (isBlocked) {
        // Static apply is forbidden against dynamic_origin = true
        // rows. Record the conflict and skip the entity write.
        counterBlocked++;
        blockedRecordIds.push(rec.recordId);
        await writeCartridgeRecordRow({
          cartridgeId: ctx.cartridgeId,
          newRecordId: rec.recordId,
          kind: rec.kind,
          slug: rec.slug,
          contentHash: rec.contentHash,
          entityId,
          importRunId,
          status: 'blocked',
          migrateFromRecordId,
        });
        continue;
      }

      // Step E — upsert the static entity row.
      const payload = payloadWithRuntimeAssetLinks(ctx, rec);
      if (entityId == null) {
        const inserted = await query<{id: number}>(
          `INSERT INTO entities
             (kind, display_name, summary, profile, tags,
              cartridge_id, dynamic_origin)
           VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, false)
           RETURNING id`,
          [
            rec.kind,
            rec.displayName,
            rec.summary,
            JSON.stringify(payload),
            rec.tags,
            ctx.cartridgeId,
          ],
        );
        entityId = Number(inserted.rows[0]?.id);
      } else {
        await query(
          `UPDATE entities
              SET kind = $1,
                  display_name = $2,
                  summary = $3,
                  profile = $4::jsonb,
                  tags = $5::text[],
                  cartridge_id = $6
            WHERE id = $7`,
          [
            rec.kind,
            rec.displayName,
            rec.summary,
            JSON.stringify(payload),
            rec.tags,
            ctx.cartridgeId,
            entityId,
          ],
        );
      }

      // Step F — write/migrate the cartridge_records row + tally.
      await writeCartridgeRecordRow({
        cartridgeId: ctx.cartridgeId,
        newRecordId: rec.recordId,
        kind: rec.kind,
        slug: rec.slug,
        contentHash: rec.contentHash,
        entityId,
        importRunId,
        status: 'active',
        migrateFromRecordId,
      });

      if (prevHash == null) counterNew++;
      else if (prevHash === rec.contentHash) counterUnchanged++;
      else counterChanged++;
    }

    // Step G — anything previously known and absent in this run
    // is `deprecated`. We do NOT delete the entity row; runtime
    // state may still reference it. Rows we "consumed" via the
    // (kind, slug) drift fallback above were migrated under a new
    // record_id and must not be counted as deprecated.
    let counterDeprecated = 0;
    const deprecatedRecordIds: string[] = [];
    for (const row of existingRows.rows) {
      if (incomingRecordIds.has(row.record_id)) continue;
      if (consumedExistingRecordIds.has(row.record_id)) continue;
      counterDeprecated++;
      deprecatedRecordIds.push(row.record_id);
      await query(
        `UPDATE cartridge_records
            SET status = 'deprecated',
                last_import_run_id = $1,
                updated_at = now()
          WHERE cartridge_id = $2 AND record_id = $3`,
        [importRunId, ctx.cartridgeId, row.record_id],
      );
    }

    // Step H — resolve author-facing slug links into runtime ids.
    //
    // Obsidian / Forge records deliberately speak in stable slugs:
    // `exits`, `parent_slug`, `resident_npc_slugs`, `home_slug`,
    // `location_slug`, `participant_slugs`, `giver_slug`, etc. The
    // live game, however, resolves movement and presence through
    // numeric entity ids (`profile.exits`, `home_id`, `location_id`,
    // `participant_entity_ids`, `topology_parent_id`). Without this
    // pass a correctly installed cartridge can look empty at runtime:
    // the port exists, but its exits and NPCs are still only strings.
    await normalizeAppliedEntityLinks(ctx.cartridgeId);
    await refreshLocationIntroBubblesFromAppliedCartridge(ctx.cartridgeId);

    // Step I — refresh scoped metadata + install cache.
    const scopedKeys: Array<[string, unknown, string]> = [
      [
        'cartridge_id',
        ctx.cartridgeId,
        'Cartridge id last applied to this cartridge.',
      ],
      [
        'cartridge_version',
        version,
        'Cartridge version recorded at apply time.',
      ],
      [
        'schema_version',
        schemaVersion,
        'Schema version recorded at apply time.',
      ],
    ];
    for (const [key, value, description] of scopedKeys) {
      await query(
        `INSERT INTO cartridge_meta_scoped
           (cartridge_id, key, value, description)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (cartridge_id, key) DO UPDATE SET
           value = EXCLUDED.value,
           description = EXCLUDED.description,
           updated_at = now()`,
        [ctx.cartridgeId, key, JSON.stringify(value), description],
      );
    }

    // FEAT-ENGINE-BASELINE-6 — persist starting_location_slug and the
    // resolved starting_location_id for any cartridge whose Forge
    // manifest declares one. Previously the resolution lived only
    // inside `cartridge:default:install-smoke`, so a GUI-driven
    // import/apply landed without a launch anchor and
    // `CartridgePlaythroughService.preview` flagged
    // `no_starting_location` for the first spawn. We resolve the slug
    // to an entity id via `cartridge_records` (kind='location'), which
    // was just upserted by Step E for this same apply.
    //
    // FEAT-ENGINE-BASELINE-6 corrective (2026-05-17): when a reimport
    // ships a manifest WITHOUT `starting_location_slug`, both scoped
    // rows are deleted so a stale launch anchor cannot survive a
    // cartridge that no longer declares one. Playthrough preview will
    // then surface `no_starting_location` and the GUI repair gate
    // kicks in.
    const startingSlug = readManifestString(ctx.manifest, 'starting_location_slug');
    if (!startingSlug) {
      await query(
        `DELETE FROM cartridge_meta_scoped
          WHERE cartridge_id = $1
            AND key IN ('starting_location_slug', 'starting_location_id')`,
        [ctx.cartridgeId],
      );
    } else {
      await query(
        `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
         VALUES ($1, 'starting_location_slug', to_jsonb($2::text), $3)
         ON CONFLICT (cartridge_id, key) DO UPDATE SET
           value = EXCLUDED.value,
           description = EXCLUDED.description,
           updated_at = now()`,
        [
          ctx.cartridgeId,
          startingSlug,
          'FEAT-ENGINE-BASELINE-6 — slug copied from forge.project.json#starting_location_slug.',
        ],
      );
      const loc = await query<{imported_entity_id: number | null}>(
        `SELECT imported_entity_id
           FROM cartridge_records
          WHERE cartridge_id = $1
            AND kind = 'location'
            AND slug = $2
            AND status = 'active'
          LIMIT 1`,
        [ctx.cartridgeId, startingSlug],
      );
      const resolved = loc.rows[0]?.imported_entity_id;
      if (resolved != null) {
        await query(
          `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
           VALUES ($1, 'starting_location_id', to_jsonb($2::int), $3)
           ON CONFLICT (cartridge_id, key) DO UPDATE SET
             value = EXCLUDED.value,
             description = EXCLUDED.description,
             updated_at = now()`,
          [
            ctx.cartridgeId,
            Number(resolved),
            'FEAT-ENGINE-BASELINE-6 — resolved from starting_location_slug via cartridge_records.',
          ],
        );
      } else {
        // The slug points at a record we did not import (typo,
        // misaligned slug, manifest pre-rename). Drop any stale id row
        // so playthrough preview returns `no_starting_location` rather
        // than launching at a wrong entity from a previous apply. The
        // declared slug stays so the GUI can show it as the missing
        // target.
        await query(
          `DELETE FROM cartridge_meta_scoped
            WHERE cartridge_id = $1 AND key = 'starting_location_id'`,
          [ctx.cartridgeId],
        );
        telemetry.record({
          channel: 'gameplay',
          name: 'cartridge.starting_location_unresolved',
          data: {
            cartridge_id: ctx.cartridgeId,
            starting_location_slug: startingSlug,
          },
        });
      }
    }

    // FEAT-ENGINE-BASELINE-5 — persist the cartridge-scoped visual
    // asset manifest. The file bytes were already copied into the
    // cache by `buildCartridgeAssetManifest()` before the
    // transaction; this row is the runtime index callers consult to
    // resolve `(kind, slug, role?)` triples to cache paths. On
    // reimport, ON CONFLICT replaces the row so removed assets do
    // not leave stale DB references.
    //
    // BASELINE-5 corrective (2026-05-17): the manifest is written
    // even when `counts.total === 0`. A reimport that drops every
    // asset (e.g. removes `audit/visual-assets.jsonl` from the
    // source) must replace any previous non-empty row with an empty
    // v1 manifest so the runtime route stops resolving the removed
    // entries. The empty-row path is reached only when manifest
    // building succeeded (`ctx.assetManifest !== null`); a thrown
    // build error leaves the row alone — see the catch around
    // `buildCartridgeAssetManifest` in `apply()`.
    const worldAnchor = await deriveAppliedWorldAnchor(
      ctx.cartridgeId,
      startingSlug,
    );
    if (worldAnchor) {
      await query(
        `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
         VALUES ($1, 'world_entity_id', to_jsonb($2::int), $3)
         ON CONFLICT (cartridge_id, key) DO UPDATE SET
           value = EXCLUDED.value,
           description = EXCLUDED.description,
           updated_at = now()`,
        [
          ctx.cartridgeId,
          worldAnchor.id,
          'Derived from the imported cartridge topology root during apply.',
        ],
      );
      if (worldAnchor.slug) {
        await query(
          `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
           VALUES ($1, 'world_entity_slug', to_jsonb($2::text), $3)
           ON CONFLICT (cartridge_id, key) DO UPDATE SET
             value = EXCLUDED.value,
             description = EXCLUDED.description,
             updated_at = now()`,
          [
            ctx.cartridgeId,
            worldAnchor.slug,
            'Stable slug of the topology root used as world_entity_id.',
          ],
        );
      }
      await ensureWorldClockRuntimeFields(worldAnchor.id);
      await mirrorWorldAnchorIfDefault(ctx.cartridgeId, worldAnchor.id);
    } else {
      await query(
        `DELETE FROM cartridge_meta_scoped
          WHERE cartridge_id = $1
            AND key IN ('world_entity_id', 'world_entity_slug')`,
        [ctx.cartridgeId],
      );
      await clearDefaultWorldAnchorIfCurrent(ctx.cartridgeId);
    }

    if (ctx.assetManifest) {
      await query(
        `INSERT INTO cartridge_meta_scoped
           (cartridge_id, key, value, description)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (cartridge_id, key) DO UPDATE SET
           value = EXCLUDED.value,
           description = EXCLUDED.description,
           updated_at = now()`,
        [
          ctx.cartridgeId,
          ASSET_MANIFEST_META_KEY,
          JSON.stringify(ctx.assetManifest),
          'FEAT-ENGINE-BASELINE-5 — cartridge-scoped visual asset manifest (cache_path is relative to <data-dir>/cartridges/<cartridge-id>/assets/).',
        ],
      );
    }

    // OBSIDIAN-VAULT-IMPORT-2 (2026-05-18) — persist the four OWV
    // runtime bridge artifacts into `cartridge_meta_scoped` so the
    // runtime bridge services (currency / merchant / materializer /
    // scene-instructions) resolve per-cartridge state instead of the
    // legacy global `cartridge_meta` (which conflates multi-cartridge
    // sessions). On reimport, ON CONFLICT replaces stale rows; if the
    // source dropped an artifact, the in-memory plan was built from a
    // tombstone v1 document so the row still lands and prevents
    // fallback to global cartridge_meta for this cartridge.
    for (const entry of buildScopedBridgeWritePlan(ctx.bridgeArtifacts)) {
      await query(
        `INSERT INTO cartridge_meta_scoped
           (cartridge_id, key, value, description)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (cartridge_id, key) DO UPDATE SET
           value = EXCLUDED.value,
           description = EXCLUDED.description,
           updated_at = now()`,
        [
          ctx.cartridgeId,
          entry.key,
          JSON.stringify(entry.value),
          entry.description,
        ],
      );
    }

    const isDefault = await isDefaultCartridge(ctx.cartridgeId);
    const installState = isDefault ? 'active_db' : 'ready';
    // Pull the install-cache's underlying preview-job DB id so
    // `applied_job_id` is a real FK target.
    const previewRow = await query<{id: number}>(
      `SELECT id FROM cartridge_import_preview_jobs WHERE job_id = $1`,
      [ctx.previewJobId],
    );
    const previewDbId = previewRow.rows[0]?.id ?? null;
    await query(
      `INSERT INTO cartridge_install_cache (
         cartridge_id, state, content_hash, record_count,
         last_verified_at, applied_at, applied_job_id, notes
       )
       VALUES ($1, $2, $3, $4, now(), now(), $5, $6::jsonb)
       ON CONFLICT (cartridge_id) DO UPDATE SET
         state = EXCLUDED.state,
         content_hash = EXCLUDED.content_hash,
         record_count = EXCLUDED.record_count,
         last_verified_at = now(),
         applied_at = now(),
         applied_job_id = EXCLUDED.applied_job_id,
         notes = EXCLUDED.notes`,
      [
        ctx.cartridgeId,
        installState,
        ctx.contentHash,
        ctx.records.length,
        previewDbId,
        JSON.stringify({applyJobId, importRunId}),
      ],
    );

    // FEAT-HERO-CONTINUITY-2 (2026-05-17) — every freshly applied
    // cartridge has a default `local_single_player` universe
    // instance. Migration 0129 backfilled the historical case;
    // calling ensure here keeps the contract for every future
    // import without a second migration. Idempotent — re-imports
    // hit the partial unique index and resolve to the existing
    // default row.
    await UniverseInstanceService.ensureDefaultForCartridge(
      ctx.cartridgeId,
    );

    return {
      cartridgeId: ctx.cartridgeId,
      contentHash: ctx.contentHash,
      totalRecords: ctx.records.length,
      diff: {
        new: counterNew,
        changed: counterChanged,
        unchanged: counterUnchanged,
        deprecated: counterDeprecated,
        blocked: counterBlocked,
      },
      importRunId,
      applyJobId,
      blockedRecordIds,
      deprecatedRecordIds,
    };
  });
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function readManifestString(
  manifest: Record<string, unknown>,
  key: string,
): string | null {
  const v = manifest[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

const VALID_SOURCE_KINDS_FOR_CARTRIDGES = new Set([
  'builtin',
  'forge_pack',
  'zip_upload',
  'folder',
  'dev_path',
  'obsidian_vault',
  'forge_project',
  'agent_pack',
]);

function normaliseCartridgeSourceKind(kind: string): string {
  return VALID_SOURCE_KINDS_FOR_CARTRIDGES.has(kind) ? kind : 'folder';
}

function bootstrapKey(kind: string, displayName: string): string {
  return `${kind}::${displayName.trim().toLowerCase()}`;
}

interface AppliedWorldAnchor {
  id: number;
  slug: string | null;
}

async function deriveAppliedWorldAnchor(
  cartridgeId: string,
  startingSlug: string | null,
): Promise<AppliedWorldAnchor | null> {
  const rows = await query<AppliedWorldAnchor>(
    `WITH RECURSIVE active_records AS (
       SELECT cr.kind,
              cr.slug,
              cr.imported_entity_id AS id,
              e.topology_parent_id
         FROM cartridge_records cr
         JOIN entities e ON e.id = cr.imported_entity_id
        WHERE cr.cartridge_id = $1
          AND cr.status = 'active'
          AND cr.imported_entity_id IS NOT NULL
     ),
     seed AS (
       SELECT id, slug, kind, topology_parent_id
         FROM active_records
        WHERE (
              $2::text IS NOT NULL
              AND slug = $2::text
              AND kind IN ('world', 'location', 'district')
            )
            OR (
              $2::text IS NULL
              AND kind IN ('world', 'location', 'district')
              AND topology_parent_id IS NULL
            )
        ORDER BY
          CASE
            WHEN $2::text IS NOT NULL AND slug = $2::text THEN 0
            WHEN kind = 'world' THEN 1
            WHEN slug IN ('greenhaven-city', 'world', 'root') THEN 2
            ELSE 3
          END,
          id
        LIMIT 1
     ),
     chain AS (
       SELECT id, slug, kind, topology_parent_id, 0 AS depth
         FROM seed
       UNION ALL
       SELECT parent.id,
              parent.slug,
              parent.kind,
              parent.topology_parent_id,
              child.depth + 1
         FROM chain child
         JOIN active_records parent ON parent.id = child.topology_parent_id
        WHERE child.topology_parent_id IS NOT NULL
          AND child.depth < 32
     )
     SELECT id, slug
       FROM chain
      ORDER BY depth DESC
      LIMIT 1`,
    [cartridgeId, startingSlug],
  );
  const row = rows.rows[0];
  if (row) return {id: Number(row.id), slug: row.slug ?? null};
  if (startingSlug != null) return deriveAppliedWorldAnchor(cartridgeId, null);
  return null;
}

async function ensureWorldClockRuntimeFields(
  worldEntityId: number,
): Promise<void> {
  await query(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value,
        allowed_values, scope, scope_per_player, description)
     VALUES
       ($1, 'time_of_day', 'string', '"morning"'::jsonb, NULL,
        'session', false,
        'World time-of-day derived from world_time_minutes.'),
       ($1, 'weather', 'string', '"clear"'::jsonb, NULL,
        'session', false,
        'World weather for atmosphere rendering.'),
       ($1, 'world_time_minutes', 'int', '450'::jsonb, NULL,
        'session', false,
        'World time accumulator in minutes. Drives time_of_day.')
     ON CONFLICT (owner_entity_id, field_key) DO UPDATE SET
       value_type = EXCLUDED.value_type,
       default_value = COALESCE(runtime_fields.default_value,
                                EXCLUDED.default_value),
       allowed_values = COALESCE(runtime_fields.allowed_values,
                                 EXCLUDED.allowed_values),
       scope = EXCLUDED.scope,
       scope_per_player = false,
       description = COALESCE(runtime_fields.description,
                              EXCLUDED.description)`,
    [worldEntityId],
  );
  await query(
    `INSERT INTO runtime_values (field_id, value, source)
       SELECT id, default_value, 'cartridge_apply'
         FROM runtime_fields
        WHERE owner_entity_id = $1
          AND field_key IN ('time_of_day', 'weather', 'world_time_minutes')
          AND default_value IS NOT NULL
     ON CONFLICT (field_id) DO NOTHING`,
    [worldEntityId],
  );
}

async function mirrorWorldAnchorIfDefault(
  cartridgeId: string,
  worldEntityId: number,
): Promise<void> {
  if (!(await isDefaultCartridge(cartridgeId))) return;
  await query(
    `INSERT INTO cartridge_meta (key, value, description)
     VALUES ('world_entity_id', to_jsonb($1::int),
             'World entity id mirrored from cartridge_meta_scoped for the active launched cartridge.')
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       description = EXCLUDED.description,
       updated_at = now()`,
    [worldEntityId],
  );
  clearMetaCache();
}

async function clearDefaultWorldAnchorIfCurrent(
  cartridgeId: string,
): Promise<void> {
  if (!(await isDefaultCartridge(cartridgeId))) return;
  await query(`DELETE FROM cartridge_meta WHERE key = 'world_entity_id'`);
  clearMetaCache();
}

async function refreshLocationIntroBubblesFromAppliedCartridge(
  cartridgeId: string,
): Promise<void> {
  // BRIDGE-ENGLISH-HEADINGS-1: Obsidian location notes can author a
  // `First Entry Bubble`. The compiler stores it in the location
  // payload, and apply must materialize it into the existing runtime
  // read table so first visits do not fall back to generic summaries.
  await query(
    `DELETE FROM location_intro_bubbles b
      USING cartridge_records cr
     WHERE cr.cartridge_id = $1
       AND cr.kind IN ('location', 'district')
       AND cr.status = 'active'
       AND cr.imported_entity_id = b.location_entity_id
       AND b.lang = 'en'
       AND b.source = 'cartridge_apply:first_entry_bubble'`,
    [cartridgeId],
  );
  await query(
    `INSERT INTO location_intro_bubbles
       (location_entity_id, lang, bubble_text, source, updated_at)
     SELECT
       cr.imported_entity_id,
       'en',
       trim(e.profile->>'first_entry_bubble'),
       'cartridge_apply:first_entry_bubble',
       now()
      FROM cartridge_records cr
      JOIN entities e ON e.id = cr.imported_entity_id
     WHERE cr.cartridge_id = $1
       AND cr.kind IN ('location', 'district')
       AND cr.status = 'active'
       AND cr.imported_entity_id IS NOT NULL
       AND nullif(trim(e.profile->>'first_entry_bubble'), '') IS NOT NULL
     ON CONFLICT (location_entity_id, lang) DO UPDATE SET
       bubble_text = EXCLUDED.bubble_text,
       source = EXCLUDED.source,
       updated_at = now()`,
    [cartridgeId],
  );
}

async function normalizeAppliedEntityLinks(cartridgeId: string): Promise<void> {
  await query(
    `WITH record_map AS (
       SELECT cr.kind, cr.slug, cr.imported_entity_id AS id
         FROM cartridge_records cr
        WHERE cr.cartridge_id = $1
          AND cr.status = 'active'
          AND cr.imported_entity_id IS NOT NULL
     ),
     location_links AS (
       SELECT e.id,
              parent.id AS parent_id,
              ARRAY(
                SELECT resolved_id
                  FROM (
                    SELECT CASE
                             WHEN elem.value ~ '^[0-9]+$'
                               THEN elem.value::bigint
                             ELSE target.id
                           END AS resolved_id,
                           elem.ord
                      FROM jsonb_array_elements_text(
                        safe_jsonb_array(e.profile->'exits')
                      ) WITH ORDINALITY AS elem(value, ord)
                      LEFT JOIN record_map target
                        ON target.slug = elem.value
                       AND target.kind IN ('location', 'district')
                  ) resolved
                 WHERE resolved_id IS NOT NULL
                 ORDER BY ord
              ) AS exit_ids,
              ARRAY(
                SELECT target.id
                  FROM jsonb_array_elements_text(
                    safe_jsonb_array(e.profile->'resident_npc_slugs')
                  ) WITH ORDINALITY AS elem(value, ord)
                  JOIN record_map target
                    ON target.slug = elem.value
                   AND target.kind = 'person'
                 ORDER BY elem.ord
              ) AS npc_ids,
              ARRAY(
                SELECT target.id
                  FROM jsonb_array_elements_text(
                    safe_jsonb_array(e.profile->'child_location_slugs')
                  ) WITH ORDINALITY AS elem(value, ord)
                  JOIN record_map target
                    ON target.slug = elem.value
                   AND target.kind IN ('location', 'district')
                 ORDER BY elem.ord
              ) AS child_location_ids,
              ARRAY(
                SELECT target.id
                  FROM jsonb_array_elements_text(
                    safe_jsonb_array(e.profile->'scene_slugs')
                  ) WITH ORDINALITY AS elem(value, ord)
                  JOIN record_map target
                    ON target.slug = elem.value
                   AND target.kind = 'scene'
                 ORDER BY elem.ord
              ) AS scene_ids,
              ARRAY(
                SELECT target.id
                  FROM jsonb_array_elements_text(
                    safe_jsonb_array(e.profile->'quest_slugs')
                  ) WITH ORDINALITY AS elem(value, ord)
                  JOIN record_map target
                    ON target.slug = elem.value
                   AND target.kind = 'quest'
                 ORDER BY elem.ord
              ) AS quest_ids
         FROM record_map rec
         JOIN entities e ON e.id = rec.id
         LEFT JOIN record_map parent
           ON parent.slug = e.profile->>'parent_slug'
          AND parent.kind IN ('location', 'district')
        WHERE rec.kind IN ('location', 'district')
     )
     UPDATE entities e
        SET profile = jsonb_set(
              jsonb_set(
                CASE
                  WHEN e.profile ? 'exits' THEN
                    e.profile
                    || jsonb_build_object(
                         'exit_slugs', e.profile->'exits',
                         'exits', to_jsonb(location_links.exit_ids)
                       )
                  ELSE e.profile
                END,
                '{local_density}',
                COALESCE(e.profile->'local_density', '{}'::jsonb)
                || jsonb_build_object(
                     'npc_ids', to_jsonb(location_links.npc_ids),
                     'child_location_ids', to_jsonb(location_links.child_location_ids),
                     'scene_ids', to_jsonb(location_links.scene_ids),
                     'quest_ids', to_jsonb(location_links.quest_ids)
                   ),
                true
              ),
              '{local_density_summary}',
              jsonb_build_object(
                'npc_count', cardinality(location_links.npc_ids),
                'child_location_count', cardinality(location_links.child_location_ids),
                'scene_count', cardinality(location_links.scene_ids),
                'quest_count', cardinality(location_links.quest_ids)
              ),
              true
            ),
            topology_parent_id = location_links.parent_id
       FROM location_links
      WHERE e.id = location_links.id`,
    [cartridgeId],
  );

  await query(
    `WITH record_map AS (
       SELECT cr.kind, cr.slug, cr.imported_entity_id AS id
         FROM cartridge_records cr
        WHERE cr.cartridge_id = $1
          AND cr.status = 'active'
          AND cr.imported_entity_id IS NOT NULL
     ),
     person_links AS (
       SELECT e.id, home.id AS home_id
         FROM record_map rec
         JOIN entities e ON e.id = rec.id
         LEFT JOIN record_map home
           ON home.slug = e.profile->>'home_slug'
          AND home.kind IN ('location', 'district')
        WHERE rec.kind = 'person'
     )
     UPDATE entities e
        SET profile = jsonb_strip_nulls(
              e.profile || jsonb_build_object('home_id', person_links.home_id)
            )
       FROM person_links
      WHERE e.id = person_links.id`,
    [cartridgeId],
  );

  await query(
    `WITH record_map AS (
       SELECT cr.kind, cr.slug, cr.imported_entity_id AS id
         FROM cartridge_records cr
        WHERE cr.cartridge_id = $1
          AND cr.status = 'active'
          AND cr.imported_entity_id IS NOT NULL
     ),
     scene_links AS (
       SELECT e.id,
              loc.id AS location_id,
              owner.id AS owner_entity_id,
              ARRAY(
                SELECT target.id
                  FROM jsonb_array_elements_text(
                    safe_jsonb_array(e.profile->'participant_slugs')
                  ) WITH ORDINALITY AS elem(value, ord)
                  JOIN record_map target
                    ON target.slug = elem.value
                   AND target.kind = 'person'
                  JOIN entities target_entity
                    ON target_entity.id = target.id
                   AND (
                     e.profile->>'source_markdown' IS NULL
                     OR e.profile->>'owner_npc_slug' = target.slug
                     OR position(
                       '@' || target_entity.display_name
                       IN e.profile->>'source_markdown'
                     ) > 0
                   )
                 ORDER BY elem.ord
              ) AS participant_entity_ids
         FROM record_map rec
         JOIN entities e ON e.id = rec.id
         LEFT JOIN record_map loc
           ON loc.slug = e.profile->>'location_slug'
          AND loc.kind IN ('location', 'district')
         LEFT JOIN record_map owner
           ON owner.slug = e.profile->>'owner_npc_slug'
          AND owner.kind = 'person'
        WHERE rec.kind = 'scene'
     )
     UPDATE entities e
        SET profile = jsonb_strip_nulls(
              e.profile
              || jsonb_build_object(
                   'location_id', scene_links.location_id,
                   'owner_entity_id', scene_links.owner_entity_id,
                   'participant_entity_ids',
                   to_jsonb(scene_links.participant_entity_ids)
                 )
            )
       FROM scene_links
      WHERE e.id = scene_links.id`,
    [cartridgeId],
  );

  await query(
    `WITH record_map AS (
       SELECT cr.kind, cr.slug, cr.imported_entity_id AS id
         FROM cartridge_records cr
        WHERE cr.cartridge_id = $1
          AND cr.status = 'active'
          AND cr.imported_entity_id IS NOT NULL
     ),
     quest_links AS (
       SELECT e.id,
              loc.id AS location_id,
              giver.id AS giver_entity_id,
              source_item.id AS source_item_entity_id
         FROM record_map rec
         JOIN entities e ON e.id = rec.id
         LEFT JOIN record_map loc
           ON loc.slug = COALESCE(
                e.profile->>'start_location_slug',
                e.profile->>'location_slug'
              )
          AND loc.kind IN ('location', 'district')
         LEFT JOIN record_map giver
           ON giver.slug = COALESCE(
                e.profile->>'giver_slug',
                e.profile->>'quest_source_slug'
              )
          AND giver.kind = 'person'
         LEFT JOIN record_map source_item
           ON source_item.slug = e.profile->>'source_item_slug'
          AND source_item.kind = 'item'
        WHERE rec.kind = 'quest'
     )
     UPDATE entities e
        SET profile = jsonb_strip_nulls(
              e.profile
              || jsonb_build_object(
                   'location_id', quest_links.location_id,
                   'giver_entity_id', quest_links.giver_entity_id,
                   'source_entity_id',
                   COALESCE(
                     quest_links.giver_entity_id,
                     quest_links.source_item_entity_id
                   )
                 )
            )
       FROM quest_links
      WHERE e.id = quest_links.id`,
    [cartridgeId],
  );

  await query(
    `WITH record_map AS (
       SELECT cr.kind, cr.slug, cr.imported_entity_id AS id
         FROM cartridge_records cr
        WHERE cr.cartridge_id = $1
          AND cr.status = 'active'
          AND cr.imported_entity_id IS NOT NULL
     ),
     item_links AS (
       SELECT e.id,
              loc.id AS location_id,
              holder.id AS holder_entity_id
         FROM record_map rec
         JOIN entities e ON e.id = rec.id
         LEFT JOIN record_map loc
           ON loc.slug = e.profile->>'location_slug'
          AND loc.kind IN ('location', 'district')
         LEFT JOIN record_map holder
           ON holder.slug = e.profile->>'holder_slug'
        WHERE rec.kind = 'item'
     )
     UPDATE entities e
        SET profile = jsonb_strip_nulls(
              e.profile
              || jsonb_build_object(
                   'location_id', item_links.location_id,
                   'holder_entity_id', item_links.holder_entity_id
                 )
            )
       FROM item_links
      WHERE e.id = item_links.id`,
    [cartridgeId],
  );

  await query(`SELECT rebuild_local_density($1)`, [cartridgeId]);
}

/**
 * Upsert a `cartridge_records` row, optionally migrating an
 * existing row with a different `record_id` over to the new one
 * (used when the (kind, slug) fallback rescued us from writer-side
 * record_id drift). DELETE+INSERT keeps the SQL straight and lets
 * the ON CONFLICT path stay a vanilla upsert.
 */
async function writeCartridgeRecordRow(args: {
  cartridgeId: string;
  newRecordId: string;
  kind: string;
  slug: string;
  contentHash: string;
  entityId: number | null;
  importRunId: number;
  status: 'active' | 'blocked';
  migrateFromRecordId: string | null;
}): Promise<void> {
  if (args.migrateFromRecordId) {
    await query(
      `DELETE FROM cartridge_records
        WHERE cartridge_id = $1 AND record_id = $2`,
      [args.cartridgeId, args.migrateFromRecordId],
    );
  }
  await query(
    `INSERT INTO cartridge_records (
       cartridge_id, record_id, kind, slug, content_hash,
       imported_entity_id, last_import_run_id, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (cartridge_id, record_id) DO UPDATE SET
       kind = EXCLUDED.kind,
       slug = EXCLUDED.slug,
       content_hash = EXCLUDED.content_hash,
       imported_entity_id = EXCLUDED.imported_entity_id,
       last_import_run_id = EXCLUDED.last_import_run_id,
       status = EXCLUDED.status,
       updated_at = now()`,
    [
      args.cartridgeId,
      args.newRecordId,
      args.kind,
      args.slug,
      args.contentHash,
      args.entityId,
      args.importRunId,
      args.status,
    ],
  );
}

async function isDefaultCartridge(cartridgeId: string): Promise<boolean> {
  const r = await query<{value: string | null}>(
    `SELECT (value #>> '{}')::text AS value
       FROM cartridge_meta WHERE key = 'cartridge_id'`,
  );
  return r.rows[0]?.value === cartridgeId;
}

function mapApplyError(err: unknown, fallbackCode: string): ApplyError {
  if (err instanceof ApplyServiceError) {
    return {code: err.code, message: err.message};
  }
  return {
    code: fallbackCode,
    message: err instanceof Error ? err.message : String(err),
  };
}

async function updatePreviewJob(
  jobId: string,
  patch: {
    status?: string;
    phase?: string;
    cartridgeId?: string | null;
    result?: Record<string, unknown>;
    error?: ApplyError;
    finishedAt?: Date;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.status) push('status', patch.status);
  if (patch.phase) push('phase', patch.phase);
  if (patch.cartridgeId !== undefined) push('cartridge_id', patch.cartridgeId);
  if (patch.result) push('result', JSON.stringify(patch.result));
  if (patch.error) push('error', JSON.stringify(patch.error));
  if (patch.finishedAt) push('finished_at', patch.finishedAt.toISOString());
  sets.push(`updated_at = now()`);
  params.push(jobId);
  await query(
    `UPDATE cartridge_import_preview_jobs
        SET ${sets.join(', ')}
      WHERE job_id = $${params.length}`,
    params,
  );
}

export {ApplyServiceError};
