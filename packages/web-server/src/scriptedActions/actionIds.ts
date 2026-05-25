/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-13 — typed scripted action-id parser.
//
// The wire format for scripted player actions is `<prefix>:<segments...>`
// where the prefix picks the resolver and the remaining segments carry
// numeric ids and/or string sub-kinds. Three shapes exist today:
//
//   social:<npcId>:<checkKind>      → scriptSocialCheck
//   item-check:<itemId>:<checkKind> → scriptItemCheck
//   attack:<npcId>                  → scriptAttack
//
// Previously `scriptedActions.ts` parsed each shape inline with
// `startsWith(...)` + `split(':')` + manual numeric coercion. This
// module centralises the parsing into a single function returning a
// discriminated union, so the router stays a thin switch and a new
// shape only forces one new arm here. Free-text turns and unknown
// prefixes return `null`; malformed numeric segments and bad segment
// counts also return `null` so the router falls through to the
// non-scripted path.

export type ParsedScriptedAction =
  | {kind: 'social'; npcId: number; checkKind: string}
  | {kind: 'item-check'; itemId: number; checkKind: string}
  | {kind: 'attack'; npcId: number}
  | {kind: 'scene-choice'; sceneSlug: string; choiceNumber: number};

function positiveIntegerOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function nonEmptyOrNull(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) return null;
  return raw;
}

/** Parse a scripted action id into a discriminated union, or return
 *  `null` for free-text turns, unknown prefixes, malformed numeric
 *  segments, missing/extra segments, and empty string sub-kinds. */
export function parseScriptedActionId(
  actionId: string | null | undefined,
): ParsedScriptedAction | null {
  if (typeof actionId !== 'string' || actionId.length === 0) return null;
  const parts = actionId.split(':');
  const prefix = parts[0];
  switch (prefix) {
    case 'social': {
      if (parts.length !== 3) return null;
      const npcId = positiveIntegerOrNull(parts[1]);
      const checkKind = nonEmptyOrNull(parts[2]);
      if (npcId === null || checkKind === null) return null;
      return {kind: 'social', npcId, checkKind};
    }
    case 'item-check': {
      if (parts.length !== 3) return null;
      const itemId = positiveIntegerOrNull(parts[1]);
      const checkKind = nonEmptyOrNull(parts[2]);
      if (itemId === null || checkKind === null) return null;
      return {kind: 'item-check', itemId, checkKind};
    }
    case 'attack': {
      if (parts.length !== 2) return null;
      const npcId = positiveIntegerOrNull(parts[1]);
      if (npcId === null) return null;
      return {kind: 'attack', npcId};
    }
    case 'scene.choose': {
      if (parts.length !== 3) return null;
      const sceneSlug = nonEmptyOrNull(parts[1]);
      const choiceNumber = positiveIntegerOrNull(parts[2]);
      if (sceneSlug === null || choiceNumber === null) return null;
      return {kind: 'scene-choice', sceneSlug, choiceNumber};
    }
    default:
      return null;
  }
}
