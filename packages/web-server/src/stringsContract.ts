/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-6 / ARCH-7 — relationship-string category. The union was
// previously named `StringEdgeKind` and listed several values that
// `stringKindForCount` never produced (`love`, `desire`, `debt`,
// `rivalry`, `fear`, `awe`). The trimmed union below mirrors only the
// outcomes the runtime can actually emit; renamed to
// `RelationshipKind` to distinguish from the unrelated `kind`
// concepts used by tool schemas, DB columns, and quest nodes.
export type RelationshipKind = 'trust' | 'resentment' | 'loyalty' | 'contempt';

export type StringValence = 'positive' | 'negative' | 'ambivalent';

export function clampStringCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-10, Math.min(10, Math.trunc(value)));
}

export function stringEdgeId(playerId: number, npcId: number): string {
  return `string_${playerId}_${npcId}`;
}

export function stringKindForCount(count: number): RelationshipKind {
  if (count <= -5) return 'contempt';
  if (count < 0) return 'resentment';
  if (count >= 8) return 'loyalty';
  return 'trust';
}

export function stringValenceForCount(count: number): StringValence {
  if (count > 0) return 'positive';
  if (count < 0) return 'negative';
  return 'ambivalent';
}

export function stringIntensityForCount(count: number): number {
  const clamped = clampStringCount(count);
  return Math.round(Math.min(1, Math.abs(clamped) / 10) * 100) / 100;
}

export function stringFallbackSummary(args: {
  npcName: string;
  count: number;
  band: string;
}): string {
  return `${args.npcName}: ${args.count} strings (${args.band})`;
}

// FEAT-PRESENCE-1 — presentation-facing relationship band derived from
// the clamped string count. Distinct from the
// `RelationshipKind` runtime-mutation classifier above: bands describe
// where the bond *sits* for UI rendering (rail bubble, NPC profile),
// while `RelationshipKind` describes which side of the trust/loyalty
// axis a single mutation pushes toward. Six tiers map the [-10..10]
// clamp into a steady ladder; the boundaries match the bands that
// `PlayerStringsService` already emits to the strings graph so server
// and UI agree on band naming.
export type RelationshipBand =
  | 'hostile'
  | 'wary'
  | 'neutral'
  | 'friendly'
  | 'trusted'
  | 'bonded';

export function stringBandForCount(count: number): RelationshipBand {
  const clamped = clampStringCount(count);
  if (clamped <= -5) return 'hostile';
  if (clamped <= -2) return 'wary';
  if (clamped <= 1) return 'neutral';
  if (clamped <= 4) return 'friendly';
  if (clamped <= 7) return 'trusted';
  return 'bonded';
}

