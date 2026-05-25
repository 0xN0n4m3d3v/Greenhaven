/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {activeCartridgeEntityPredicate} from './cartridgeScope.js';
import {query} from './db.js';
import {qualitySqlPredicate} from './contentQuality.js';

export interface VisibleReachableLocation {
  id: number;
  kind: string;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown> | null;
  tags: string[] | null;
  i18n?: Record<string, Record<string, unknown>> | null;
}

/**
 * Shared visible-travel graph.
 *
 * Travel can be authored in profile.exits, or created at runtime as a
 * topology child/parent. Movement already accepts all three shapes; this
 * helper keeps the UI, affordances, and broker context aligned with that
 * movement contract.
 *
 * FEAT-CART-LIB-7 (2026-05-17) — when `cartridgeId` is supplied, the
 * child sweep and the final entity fetch both gate on
 * `activeCartridgeEntityPredicate` so a hero in cartridge X never sees
 * exits from a different cartridge's location graph. The parameter is
 * optional so the legacy callers (scripts, audits) that have no player
 * context keep working unchanged.
 */
export async function loadVisibleReachableLocations(
  currentLocationId: number,
  cartridgeId?: string,
): Promise<VisibleReachableLocation[]> {
  // ARCH-19 pre-Phase-4 hardening — read the parent edge from the
  // normalized `entities.topology_parent_id` column added in 0105 so
  // the upcoming JSONB drop cannot silently sever travel reachability.
  // The other exit shapes (`profile.exits`, `profile.home_id`,
  // `profile.power_center_id`) remain JSONB authoring concerns that
  // Phase 4 does not touch.
  const current = await query<{
    profile: Record<string, unknown> | null;
    topology_parent_id: number | string | null;
  }>(
    `SELECT profile, topology_parent_id
       FROM entities
      WHERE id = $1`,
    [currentLocationId],
  );
  const profile = current.rows[0]?.profile ?? {};
  const ids = new Set<number>();

  for (const exitId of readIdArray(profile['exits'])) {
    ids.add(exitId);
  }

  const parentId = readPositiveId(current.rows[0]?.topology_parent_id);
  if (parentId != null) ids.add(parentId);
  const homeParentId = readPositiveId(profile['home_id']);
  if (homeParentId != null) ids.add(homeParentId);
  const powerCenterId = readPositiveId(profile['power_center_id']);
  if (powerCenterId != null && powerCenterId !== currentLocationId) {
    ids.add(powerCenterId);
  }

  const childCartridgeGate = cartridgeId
    ? `AND ${activeCartridgeEntityPredicate('entities', '$2')}`
    : '';
  const childParams: Array<number | string> = cartridgeId
    ? [currentLocationId, cartridgeId]
    : [currentLocationId];
  const children = await query<{id: number}>(
    `SELECT id
       FROM entities
      WHERE kind IN ('location', 'district')
        AND (profile->>'hidden_until_stage') IS NULL
        AND COALESCE(profile->>'source_category', '') <> 'discovered-location-ref'
        AND ${qualitySqlPredicate('entities')}
        ${childCartridgeGate}
        AND (
          topology_parent_id = $1::bigint
          OR profile->>'home_id' = $1::text
        )`,
    childParams,
  );
  for (const child of children.rows) {
    ids.add(Number(child.id));
  }

  if (ids.size === 0) return [];

  const resultCartridgeGate = cartridgeId
    ? `AND ${activeCartridgeEntityPredicate('entities', '$2')}`
    : '';
  const resultParams: Array<number[] | string> = cartridgeId
    ? [[...ids], cartridgeId]
    : [[...ids]];
  const rows = await query<VisibleReachableLocation>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
      FROM entities
      WHERE id = ANY($1::bigint[])
        AND kind IN ('location', 'district')
        AND (profile->>'hidden_until_stage') IS NULL
        AND ${qualitySqlPredicate('entities')}
        ${resultCartridgeGate}
      ORDER BY CASE
                 WHEN (profile->>'navigation_priority') ~ '^[0-9]+$'
                   THEN (profile->>'navigation_priority')::int
                 ELSE 9
               END,
               display_name
      LIMIT 24`,
    resultParams,
  );
  return rows.rows;
}

function readPositiveId(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readExitId)
    .filter(item => Number.isInteger(item) && item > 0);
}

function readExitId(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Number((value as Record<string, unknown>)['id']);
  }
  return Number(value);
}
