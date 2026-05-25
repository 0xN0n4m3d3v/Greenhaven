/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Cartridge metadata accessor — engine-side decoupling from cartridge
// constants (starting location, currency item id, reset-state seeds,
// etc.). Reads from `cartridge_meta` (migration
// 0018). Cached in-process; clear on cartridge swap (none today).
//
// Engine code should NEVER reference numeric entity ids of cartridge
// content directly. Always go through getMeta() / getMetaRequired().

import {query} from './db.js';
import {telemetry} from './telemetry/index.js';

const cache = new Map<string, unknown>();

export async function getMeta<T = unknown>(
  key: string,
  fallback?: T,
): Promise<T | undefined> {
  if (cache.has(key)) return cache.get(key) as T;
  try {
    const r = await query<{value: T}>(
      `SELECT value FROM cartridge_meta WHERE key = $1`,
      [key],
    );
    if (r.rows.length === 0) return fallback;
    cache.set(key, r.rows[0]!.value);
    return r.rows[0]!.value;
  } catch (err) {
    // Table might not exist on a very old DB. Fall back gracefully so
    // the engine survives a cartridge_meta-less deployment.
    telemetry.record({
      channel: 'gameplay',
      name: 'cartridge.meta_read_failed',
      error: err,
      data: {
        meta_key: key,
        fallback_provided: fallback !== undefined,
        message: err instanceof Error ? err.message : String(err),
      },
    });
    console.warn(`[cartridge] getMeta('${key}') failed (using fallback):`, err);
    return fallback;
  }
}

export async function getMetaRequired<T>(key: string): Promise<T> {
  const v = await getMeta<T>(key);
  if (v === undefined || v === null) {
    throw new Error(`cartridge_meta missing required key: '${key}'`);
  }
  return v as T;
}

export function clearMetaCache(): void {
  cache.clear();
  scopedCache.clear();
}

// ── FEAT-CART-LIB-1 — scoped cartridge metadata ─────────────────
//
// Multi-cartridge readers go through `getCartridgeMeta` /
// `getCartridgeMetaRequired` against the per-cartridge
// `cartridge_meta_scoped` table introduced in migration 0125.
// Legacy callers continue to use `getMeta` / `getMetaRequired`
// against the global `cartridge_meta` table; that path is
// preserved for compatibility with the current default-cartridge
// gameplay launch. Migration 0125 backfills every legacy row into
// the scoped table for the current default cartridge, so a new
// scoped reader sees the same values without any data migration
// on the caller side.

const scopedCache = new Map<string, unknown>();

function scopedCacheKey(cartridgeId: string, key: string): string {
  // FEAT-CART-LIB-2 — ASCII `::` separator. Earlier passes used a
  // NUL byte here which flipped this file to binary mode in `rg`
  // and `git` greps; `::` is unambiguous because cartridge ids and
  // meta keys never contain a colon in canonical cartridges.
  return `${cartridgeId}::${key}`;
}

export async function getCartridgeMeta<T = unknown>(
  cartridgeId: string,
  key: string,
  fallback?: T,
): Promise<T | undefined> {
  const cacheKey = scopedCacheKey(cartridgeId, key);
  if (scopedCache.has(cacheKey)) return scopedCache.get(cacheKey) as T;
  try {
    const r = await query<{value: T}>(
      `SELECT value FROM cartridge_meta_scoped
        WHERE cartridge_id = $1 AND key = $2`,
      [cartridgeId, key],
    );
    if (r.rows.length === 0) return fallback;
    scopedCache.set(cacheKey, r.rows[0]!.value);
    return r.rows[0]!.value;
  } catch (err) {
    // Table might be absent on a pre-0125 DB. Fall back gracefully.
    telemetry.record({
      channel: 'gameplay',
      name: 'cartridge.meta_scoped_read_failed',
      error: err,
      data: {
        cartridge_id: cartridgeId,
        meta_key: key,
        fallback_provided: fallback !== undefined,
        message: err instanceof Error ? err.message : String(err),
      },
    });
    console.warn(
      `[cartridge] getCartridgeMeta('${cartridgeId}', '${key}') failed (using fallback):`,
      err,
    );
    return fallback;
  }
}

export async function getCartridgeMetaRequired<T>(
  cartridgeId: string,
  key: string,
): Promise<T> {
  const v = await getCartridgeMeta<T>(cartridgeId, key);
  if (v === undefined || v === null) {
    throw new Error(
      `cartridge_meta_scoped missing required key: '${cartridgeId}/${key}'`,
    );
  }
  return v as T;
}

// ARCH-9 — typed world-clock config. `tickWorldClock` used to hardcode
// the world entity id, tick minutes, and default minutes inside the
// transition engine; those constants now live in
// `cartridge_meta.world_clock` (seeded by migration 0115) and are
// clamped here so a malformed cartridge value doesn't drag the clock
// outside the day-minute range.
export interface WorldClockConfig {
  tickMinutes: number;
  defaultMinutes: number;
}

const DAY_MINUTES = 24 * 60;
const DEFAULT_WORLD_CLOCK: WorldClockConfig = {
  tickMinutes: 10,
  defaultMinutes: 450,
};

function clampTickMinutes(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(DAY_MINUTES, Math.floor(n)));
}

function clampDefaultMinutes(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.max(0, Math.min(DAY_MINUTES - 1, Math.floor(n)));
}

export async function getWorldClockConfig(): Promise<WorldClockConfig> {
  const raw = await getMeta<unknown>('world_clock');
  if (!raw || typeof raw !== 'object') return {...DEFAULT_WORLD_CLOCK};
  const obj = raw as Record<string, unknown>;
  return {
    tickMinutes: clampTickMinutes(
      obj['tick_minutes'],
      DEFAULT_WORLD_CLOCK.tickMinutes,
    ),
    defaultMinutes: clampDefaultMinutes(
      obj['default_minutes'],
      DEFAULT_WORLD_CLOCK.defaultMinutes,
    ),
  };
}

// Cartridge translations all live in migrations now:
//   0023/0024 historical i18n       - summaries + narrator_brief; display_name
//                                     values are normalized back to canonical
//                                     @mention keys by later migrations.
// The DB is the source of truth for cartridge data. No translations live in code.
