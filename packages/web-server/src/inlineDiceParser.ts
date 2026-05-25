/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ID-1 / ID-3 — the shared regex, cap constants, `InlineDiceMatch`,
// `InlineDiceRoll`, `InlineDiceParseResult`, `findInlineDice`,
// `isWithinCaps`, `replaceWithChips`, and the single-pass
// `rewriteInlineDice(prose, rollDie)` helper all live in
// `@greenhaven/shared/inline-dice`. This module is the server-side
// `rollInlineDice` driver: it supplies a `Math.random`-backed
// `rollDie` to the shared single-pass rewriter and re-exports the
// shared public surface so existing server callers keep their
// import paths.

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
