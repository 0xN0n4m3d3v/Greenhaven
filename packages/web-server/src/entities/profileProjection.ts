/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 Phase 2A — shared projection helper.
//
// Every writer that touches `entities.profile.cartridge_id`,
// `entities.profile.topology_parent_id`, `entities.profile.origin`, or
// the `'dynamic'` tag has to keep the normalized columns added in
// Phase 1 (migration 0105) in sync. This module is the single point
// of derivation so the projection logic does not drift between
// callers.
//
// Phase 3 switched runtime readers off the JSONB keys onto the
// columns. Phase 4 (migration 0123, 2026-05-17 local/dev) drops the
// keys from stored rows and adds a row-level CHECK that non-player,
// non-dynamic rows must carry a `cartridge_id`. The projection
// helper still reads the legacy keys from INCOMING tool payloads
// (operator/broker can author either shape), but writers MUST run
// `stripRetiredProfileKeysForPersist` and `stripRetiredTagsForPersist`
// before persisting so the stored JSONB / tags array never carries
// the retired entries again.

export interface NormalizedEntityProjection {
  cartridge_id: string | null;
  topology_parent_id: number | null;
  dynamic_origin: boolean;
}

export interface ProjectEntityNormalizedInput {
  profile?: Record<string, unknown> | null;
  tags?: readonly string[] | null;
}

export function projectEntityNormalizedColumns(
  input: ProjectEntityNormalizedInput,
): NormalizedEntityProjection {
  const profile = input.profile ?? {};
  const tags = input.tags ?? [];

  const cartridgeRaw = profile['cartridge_id'];
  let cartridge_id: string | null = null;
  if (typeof cartridgeRaw === 'string') {
    const trimmed = cartridgeRaw.trim();
    if (trimmed.length > 0) cartridge_id = trimmed;
  }

  const topology_parent_id = parseTopologyParentId(profile['topology_parent_id']);

  const dynamic_origin =
    profile['origin'] === 'dynamic' || tags.includes('dynamic');

  return { cartridge_id, topology_parent_id, dynamic_origin };
}

// PostgreSQL bigint range. Anything outside this — including JS
// "unsafe" integers (>2^53) that lose precision under Number(...) —
// must project to NULL so downstream `$N::bigint` casts cannot
// silently truncate or fail the INSERT.
const PG_BIGINT_MIN = -(2n ** 63n);
const PG_BIGINT_MAX = 2n ** 63n - 1n;

/**
 * ARCH-19 Phase 4 (2026-05-17) writer guard. Returns a shallow copy
 * of `profile` with the three retired top-level keys removed
 * (`cartridge_id`, `topology_parent_id`, `origin`). The normalized
 * columns are the only canonical home for these values; persisting
 * them in JSONB would violate the migration 0123 contract and trip
 * the source-sweep guard.
 *
 * The caller should still run `projectEntityNormalizedColumns(...)`
 * on the ORIGINAL (un-stripped) profile so the normalized columns
 * pick up any retired-key inputs from the broker / tool payload.
 */
export const ARCH19_RETIRED_PROFILE_KEYS = [
  'cartridge_id',
  'topology_parent_id',
  'origin',
] as const satisfies readonly string[];

export function stripRetiredProfileKeysForPersist(
  profile: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (profile == null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if ((ARCH19_RETIRED_PROFILE_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * ARCH-19 Phase 4 writer guard for the `tags` array. Drops the
 * retired `'dynamic'` and `'support-smoke'` markers — the canonical
 * homes are the `dynamic_origin` column and the
 * `cartridge_id = 'support-smoke'` column respectively. Other tags
 * (`'language'`, kind-shadow tags, `'quest'`, `'item'`, fixture-
 * specific identity tags etc.) are preserved verbatim.
 * Deduplicates but preserves first-occurrence order.
 *
 * Migration 0124 retired the `'support-smoke'` tag at the row
 * level after migrating `devtools/supportSmoke.ts` cleanup queries
 * to filter by `cartridge_id = 'support-smoke'` instead.
 */
export const ARCH19_RETIRED_TAGS = [
  'dynamic',
  'support-smoke',
] as const satisfies readonly string[];

export function stripRetiredTagsForPersist(
  tags: readonly string[] | null | undefined,
): string[] {
  if (!tags || tags.length === 0) return [];
  const retired = new Set<string>(ARCH19_RETIRED_TAGS);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    if (retired.has(tag)) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function parseTopologyParentId(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    return value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  let asBigInt: bigint;
  try {
    asBigInt = BigInt(trimmed);
  } catch {
    return null;
  }
  if (asBigInt <= 0n) return null;
  if (asBigInt < PG_BIGINT_MIN || asBigInt > PG_BIGINT_MAX) return null;
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(asBigInt);
}
