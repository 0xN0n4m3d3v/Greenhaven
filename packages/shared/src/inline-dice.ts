/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ID-1 / ID-3 — shared Foundry VTT-style inline dice parser and
// rewriter.
//
// Player input "I attack [[1d20+5]] for [[2d6]] damage" produces two
// matches. The server rolls and rewrites authoritatively; the UI
// mirrors the parsing so it can pre-flight rejected formulae and
// pre-render chips. Caps (spec 37 §6 gotcha 6): sides <= 1000,
// count <= 20, |mod| <= 100.
//
// Owned here:
//   - dice regex factory (returns a fresh stateful `/g` regex per
//     call so callers can't accidentally share `lastIndex`)
//   - cap constants
//   - `InlineDiceMatch`, `InlineDiceRoll`, `InlineDiceParseResult`
//     interfaces
//   - `findInlineDice` (parse only — keeps existing callers/tests)
//   - `isWithinCaps`
//   - `rewriteInlineDice(prose, rollDie)` — single-pass
//     parse-and-rewrite that walks `prose` once via
//     `String.prototype.replace`, rolls accepted matches with the
//     supplied `rollDie`, and returns the rewritten prose plus the
//     accepted rolls and over-cap rejects
//   - `replaceWithChips` — kept for backward compatibility; built
//     on top of the same single-pass `prose.replace` walk
//
// Each runtime (server, UI) supplies its own `rollDie` callback so
// `Math.random` and any per-runtime event bookkeeping stay local.

export const MAX_SIDES = 1000;
export const MAX_COUNT = 20;
export const MAX_MOD = 100;

/**
 * Build a fresh inline-dice regex. The returned regex carries the
 * `g` flag so callers can use `.exec(...)` in a loop, but each call
 * gets a new instance so concurrent scanners cannot collide on
 * shared `lastIndex` state. The exported constant `INLINE_DICE_RE`
 * is kept for backwards-compatible imports.
 */
export function createInlineDiceRegex(): RegExp {
  return /\[\[(\d*)d(\d+)([+-]\d+)?\]\]/g;
}

export const INLINE_DICE_RE = createInlineDiceRegex();

export interface InlineDiceMatch {
  text: string;
  notation: string;
  count: number;
  sides: number;
  mod: number;
}

export interface InlineDiceRoll {
  match: InlineDiceMatch;
  rolls: number[];
  total: number;
}

export interface InlineDiceParseResult {
  rolls: InlineDiceRoll[];
  rejected: InlineDiceMatch[];
  rewritten: string;
}

function parseDiceGroups(
  raw: string,
  countGroup: string | undefined,
  sidesGroup: string,
  modGroup: string | undefined,
): InlineDiceMatch {
  const count = countGroup ? parseInt(countGroup, 10) : 1;
  const sides = parseInt(sidesGroup, 10);
  const mod = modGroup ? parseInt(modGroup, 10) : 0;
  return {
    text: raw,
    notation: `${count}d${sides}${modGroup ?? ''}`,
    count,
    sides,
    mod,
  };
}

export function findInlineDice(prose: string): InlineDiceMatch[] {
  const matches: InlineDiceMatch[] = [];
  const re = createInlineDiceRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    matches.push(parseDiceGroups(m[0], m[1], m[2]!, m[3]));
  }
  return matches;
}

export function isWithinCaps(m: InlineDiceMatch): boolean {
  if (m.count <= 0 || m.count > MAX_COUNT) return false;
  if (m.sides <= 0 || m.sides > MAX_SIDES) return false;
  if (Math.abs(m.mod) > MAX_MOD) return false;
  return true;
}

function chipPlaceholder(match: InlineDiceMatch, total: number): string {
  return `[INLINE_DICE_CHIP notation="${match.notation}" total="${total}"]`;
}

/**
 * ID-3 — single-pass parse-and-rewrite. Walks `prose` exactly once
 * via `String.prototype.replace` with the shared dice regex. For
 * each `[[NdM±K]]` span the helper parses groups, checks caps, asks
 * the caller's `rollDie` for individual die values, and substitutes
 * an `INLINE_DICE_CHIP` placeholder when accepted. Over-cap spans
 * remain in the rewritten prose verbatim and surface in `rejected`,
 * matching the historical contract.
 */
export function rewriteInlineDice(
  prose: string,
  rollDie: (sides: number) => number,
): InlineDiceParseResult {
  const rolls: InlineDiceRoll[] = [];
  const rejected: InlineDiceMatch[] = [];
  const rewritten = prose.replace(
    createInlineDiceRegex(),
    (raw, countGroup, sidesGroup, modGroup) => {
      const match = parseDiceGroups(raw, countGroup, sidesGroup, modGroup);
      if (!isWithinCaps(match)) {
        rejected.push(match);
        return raw;
      }
      const rollResults: number[] = [];
      for (let i = 0; i < match.count; i++) {
        rollResults.push(rollDie(match.sides));
      }
      const total = rollResults.reduce((a, b) => a + b, 0) + match.mod;
      rolls.push({match, rolls: rollResults, total});
      return chipPlaceholder(match, total);
    },
  );
  return {rolls, rejected, rewritten};
}

/**
 * ID-3 — single-pass chip substitution kept for backwards
 * compatibility. The walk consumes `results` in order: each regex
 * match dequeues the head when its `match.text` agrees, leaving
 * unmatched spans raw. The implementation is one
 * `prose.replace(...)` call so the rewrite is O(prose.length)
 * regardless of how many chips are queued.
 */
export function replaceWithChips(
  prose: string,
  results: Array<{match: InlineDiceMatch; total: number}>,
): string {
  const queue = [...results];
  return prose.replace(createInlineDiceRegex(), (raw) => {
    const head = queue[0];
    if (head && head.match.text === raw) {
      queue.shift();
      return chipPlaceholder(head.match, head.total);
    }
    return raw;
  });
}
