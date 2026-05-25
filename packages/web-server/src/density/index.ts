/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// M-3 — local-density cap wrapper.
//
// Reads density caps from `cartridge_meta.density_caps` (seeded by
// migration 0107) and calls `rebuild_local_density(...)` with
// explicit parameters. Operators or cartridge authors can override
// individual caps without editing migrations:
//
//   UPDATE cartridge_meta
//      SET value = COALESCE(value, '{}'::jsonb) || '{"npcs": 24}'::jsonb
//    WHERE key = 'density_caps';
//
// Missing or malformed keys fall through to DEFAULT_DENSITY_CAPS —
// the only TypeScript-side hardcoded fallback. There is no
// `quickgrin-lane` shortcut here: cartridges target their own ids via
// `activeCartridgeId()` (which uses `getMetaRequired`).

import {activeCartridgeId} from '../cartridgeScope.js';
import {getMeta} from '../cartridge.js';
import {query} from '../db.js';
import {telemetry} from '../telemetry/index.js';

export interface DensityCaps {
  npcs: number;
  child_locations: number;
  scenes: number;
  events: number;
  activities: number;
  quests: number;
}

export const DEFAULT_DENSITY_CAPS: DensityCaps = {
  npcs: 16,
  child_locations: 24,
  scenes: 12,
  events: 12,
  activities: 12,
  quests: 8,
};

export function normalizeDensityCaps(value: unknown): DensityCaps {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    npcs: pickPositiveInt(raw['npcs'], DEFAULT_DENSITY_CAPS.npcs),
    child_locations: pickPositiveInt(
      raw['child_locations'],
      DEFAULT_DENSITY_CAPS.child_locations,
    ),
    scenes: pickPositiveInt(raw['scenes'], DEFAULT_DENSITY_CAPS.scenes),
    events: pickPositiveInt(raw['events'], DEFAULT_DENSITY_CAPS.events),
    activities: pickPositiveInt(
      raw['activities'],
      DEFAULT_DENSITY_CAPS.activities,
    ),
    quests: pickPositiveInt(raw['quests'], DEFAULT_DENSITY_CAPS.quests),
  };
}

function pickPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return fallback;
}

export interface RebuildLocalDensityRow {
  location_id: number;
  npc_count: number;
  child_count: number;
}

export async function loadDensityCaps(): Promise<DensityCaps> {
  const stored = await getMeta<unknown>('density_caps');
  return normalizeDensityCaps(stored ?? {});
}

export interface DepthCapDiagnosticRow {
  root_id: string | number;
  truncated_child_count: string | number | null;
}

export interface DepthCapTelemetryPayload {
  target_cartridge: string;
  depth_cap: 8;
  warning_count: number;
  truncated_child_count_total: number;
  root_ids: number[];
}

/** M-4 — build the gameplay telemetry payload for a batch of
 *  `migration_diagnostics` warn rows produced by a single
 *  `rebuild_local_density` call. Returns `null` when there is
 *  nothing to emit so the caller can short-circuit. Pure: no SQL,
 *  no telemetry side effect. */
export function buildDepthCapTelemetryPayload(opts: {
  cartridgeId: string;
  rows: readonly DepthCapDiagnosticRow[];
}): DepthCapTelemetryPayload | null {
  if (opts.rows.length === 0) return null;
  const rootIds = opts.rows.map((row) => Number(row.root_id));
  const truncatedChildTotal = opts.rows.reduce(
    (acc, row) => acc + Number(row.truncated_child_count ?? 0),
    0,
  );
  return {
    target_cartridge: opts.cartridgeId,
    depth_cap: 8,
    warning_count: opts.rows.length,
    truncated_child_count_total: truncatedChildTotal,
    root_ids: rootIds,
  };
}

/** Rebuild local + transitive density for the given cartridge using
 *  the configured caps. Defaults to the active cartridge when no id
 *  is supplied. */
export async function rebuildLocalDensity(opts: {
  cartridgeId?: string;
  caps?: Partial<DensityCaps>;
} = {}): Promise<RebuildLocalDensityRow[]> {
  const cartridgeId = opts.cartridgeId ?? (await activeCartridgeId());
  const stored = opts.caps
    ? {...(await loadDensityCaps()), ...opts.caps}
    : await loadDensityCaps();
  const caps = normalizeDensityCaps(stored);
  // M-4: snapshot the diagnostics tail before the rebuild so we can
  // pick out only the warn rows produced by this call.  Reading the
  // current max id is cheaper and less timezone-fragile than a
  // TIMESTAMPTZ comparison.  Pre-snapshot is best-effort: if the
  // diagnostics table is missing (migration drift, pruned schema),
  // we still run the rebuild — we just skip telemetry because we
  // have no isolation boundary to safely attribute new warn rows.
  let beforeId: number | null = null;
  try {
    const before = await query<{max_id: string | number | null}>(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM migration_diagnostics`,
    );
    beforeId =
      before.rows[0]?.max_id != null ? Number(before.rows[0].max_id) : 0;
  } catch (err) {
    telemetry.record({
      channel: 'gameplay',
      name: 'density.depth_cap_diagnostic_failed',
      error: err,
      data: {
        cartridgeId,
        stage: 'pre_snapshot',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    console.warn(
      '[density] depth-cap diagnostics pre-snapshot failed; skipping telemetry',
      {
        cartridgeId,
        err: err instanceof Error ? err.message : err,
      },
    );
  }
  const r = await query<RebuildLocalDensityRow>(
    `SELECT * FROM rebuild_local_density($1, $2, $3, $4, $5, $6, $7)`,
    [
      cartridgeId,
      caps.npcs,
      caps.child_locations,
      caps.scenes,
      caps.events,
      caps.activities,
      caps.quests,
    ],
  );
  if (beforeId !== null) {
    try {
      const diag = await query<DepthCapDiagnosticRow>(
        `SELECT
           (payload->>'root_id')::bigint AS root_id,
           (payload->>'truncated_child_count')::bigint AS truncated_child_count
         FROM migration_diagnostics
         WHERE id > $1
           AND source = 'rebuild_local_density.depth_cap'
           AND level = 'warn'
           AND payload->>'target_cartridge' = $2
         ORDER BY id ASC`,
        [beforeId, cartridgeId],
      );
      const payload = buildDepthCapTelemetryPayload({
        cartridgeId,
        rows: diag.rows,
      });
      if (payload) {
        telemetry.record({
          channel: 'gameplay',
          name: 'gameplay:density_depth_cap_hit',
          data: {...payload},
        });
      }
    } catch (err) {
      // Post-rebuild diagnostics/telemetry is best-effort: a failure
      // here must not invalidate a successful density rebuild.
      telemetry.record({
        channel: 'gameplay',
        name: 'density.depth_cap_telemetry_failed',
        error: err,
        data: {
          cartridgeId,
          stage: 'post_rebuild_emit',
          message: err instanceof Error ? err.message : String(err),
        },
      });
      console.warn('[density] depth-cap diagnostics emit failed', {
        cartridgeId,
        err: err instanceof Error ? err.message : err,
      });
    }
  }
  return r.rows;
}
