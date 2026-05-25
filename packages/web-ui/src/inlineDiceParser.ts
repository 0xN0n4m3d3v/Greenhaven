// ID-1 / ID-3 — Foundry-style inline dice (UI side). All parsing,
// caps, `InlineDiceMatch`/`InlineDiceRoll`/`InlineDiceParseResult`,
// `findInlineDice`, `isWithinCaps`, `replaceWithChips`, and the
// single-pass `rewriteInlineDice(prose, rollDie)` helper live in
// `@greenhaven/shared/inline-dice`. The UI's `rollInlineDice`
// supplies a `Math.random`-backed `rollDie` to the shared rewriter
// because the send() path emits 'dice:rolled' per roll before
// forwarding the rewritten text to the broker.

import {
  findInlineDice,
  isWithinCaps,
  replaceWithChips,
  rewriteInlineDice,
  type InlineDiceMatch,
  type InlineDiceParseResult,
  type InlineDiceRoll,
} from '@greenhaven/shared';

export {findInlineDice, isWithinCaps, replaceWithChips};
export type {InlineDiceMatch, InlineDiceParseResult, InlineDiceRoll};

function rollDie(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

export function rollInlineDice(prose: string): InlineDiceParseResult {
  return rewriteInlineDice(prose, rollDie);
}
