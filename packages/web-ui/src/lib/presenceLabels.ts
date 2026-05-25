/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-PRESENCE-1 — shared types + i18n helpers for the relationship
// band and public actor-status badges that the server-canonical
// `/api/session/:id/locations` payload now carries in `nearby[]`.
//
// The band vocabulary mirrors the server's `stringBandForCount` ladder
// in `packages/web-server/src/stringsContract.ts`. The UI never owns
// the band threshold logic — it only renders the band the server
// passed through.

export type RelationshipBand =
  | 'hostile'
  | 'wary'
  | 'neutral'
  | 'friendly'
  | 'trusted'
  | 'bonded';

export interface NearbyRelationship {
  band: RelationshipBand | null;
  count: number | null;
}

export interface NearbyStatusBadge {
  kind: string;
  value: string;
  intensity: number;
}

const BAND_KEYS: Record<RelationshipBand, string> = {
  hostile: 'ui.presence.band.hostile',
  wary: 'ui.presence.band.wary',
  neutral: 'ui.presence.band.neutral',
  friendly: 'ui.presence.band.friendly',
  trusted: 'ui.presence.band.trusted',
  bonded: 'ui.presence.band.bonded',
};

const BAND_FALLBACKS: Record<RelationshipBand, string> = {
  hostile: 'Hostile',
  wary: 'Wary',
  neutral: 'Neutral',
  friendly: 'Friendly',
  trusted: 'Trusted',
  bonded: 'Bonded',
};

/**
 * Resolve a presentation label for the given relationship band. Falls
 * back to the English label baked into the extras dictionary when the
 * active translation hasn't provided a localized string yet (the
 * standard `t(key) === key` heuristic the rail/modal already uses).
 */
export function relationshipBandLabel(
  band: RelationshipBand | null,
  t: (key: string) => string,
): string {
  if (!band) {
    const v = t('ui.presence.band.unknown');
    return v === 'ui.presence.band.unknown' ? 'Unknown' : v;
  }
  const key = BAND_KEYS[band];
  const v = t(key);
  return v === key ? BAND_FALLBACKS[band] : v;
}
