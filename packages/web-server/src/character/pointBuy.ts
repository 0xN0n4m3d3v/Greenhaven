/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 38 §5.5 — D&D 5e point-buy validator. Used by /examiner/synthesize
// to verify the LLM's stat block before returning to the player.
//
// Single source of truth for COSTS + BUDGET is skills.ts (spec 27); this
// module wraps them in a boolean-returning validator + numeric spend
// helper for the synthesis path.

import {POINT_BUY_BUDGET, POINT_BUY_COSTS} from './skills.js';

export function validatePointBuy(stats: Record<string, number>): boolean {
  let sum = 0;
  for (const v of Object.values(stats)) {
    if (typeof v !== 'number' || v < 8 || v > 15) return false;
    const c = POINT_BUY_COSTS[v];
    if (c === undefined) return false;
    sum += c;
  }
  return sum === POINT_BUY_BUDGET;
}

export function pointBuySpend(stats: Record<string, number>): number {
  let sum = 0;
  for (const v of Object.values(stats)) {
    const c = POINT_BUY_COSTS[v];
    if (c !== undefined) sum += c;
  }
  return sum;
}
