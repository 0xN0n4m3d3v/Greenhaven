/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `CurrencyChangePlanner` contract.
//
// Pure unit tests for the tender + change planner. The merchant
// payment tool wires the planner into its `withTransaction` block
// so the heavy integration coverage lives in
// `tools/merchantTool.test.ts`. This file pins the deterministic
// math:
//
//   * `decomposeCanonical` greedily prefers the highest-value coin
//     that fits, returns `null` when the catalog cannot represent
//     the amount, and the empty map for `0`.
//   * `planTender` minimizes overpay first, then coin count, then
//     catalog order; returns the exact-tender plan when one
//     exists; refuses when total capacity is below the required
//     amount.

import {describe, expect, it} from 'vitest';
import {
  decomposeCanonical,
  planTender,
} from '../../services/CurrencyChangePlanner.js';
import type {CurrencyCoin} from '../../services/CurrencyBridgeService.js';

function coin(opts: Partial<CurrencyCoin> & {itemId: number; copperValue: number; slug: string}): CurrencyCoin {
  return {
    itemId: opts.itemId,
    slug: opts.slug,
    legacyEntityId: opts.legacyEntityId ?? null,
    mention: opts.mention ?? `@${opts.slug}`,
    copperValue: opts.copperValue,
    sourcePath: opts.sourcePath ?? null,
    bridgeBacked: opts.bridgeBacked ?? true,
  };
}

const COPPER = coin({itemId: 1, slug: 'copper', copperValue: 1});
const SILVER = coin({itemId: 2, slug: 'silver', copperValue: 10});
const GOLD = coin({itemId: 3, slug: 'gold', copperValue: 100});

describe('decomposeCanonical (OWV-17)', () => {
  it('returns an empty map for amount 0', () => {
    const out = decomposeCanonical([COPPER, SILVER, GOLD], 0);
    expect(out).not.toBeNull();
    expect([...out!.entries()]).toEqual([]);
  });

  it('greedy DESC by copper value', () => {
    const out = decomposeCanonical([COPPER, SILVER, GOLD], 123);
    expect(out).not.toBeNull();
    expect(out!.get(GOLD.itemId)).toBe(1);
    expect(out!.get(SILVER.itemId)).toBe(2);
    expect(out!.get(COPPER.itemId)).toBe(3);
  });

  it('returns null when the catalog cannot represent the amount exactly', () => {
    // Catalog has only silver (cv=10); 13 copper cannot be made.
    expect(decomposeCanonical([SILVER], 13)).toBeNull();
  });

  it('returns null for negative or non-integer amounts', () => {
    expect(decomposeCanonical([COPPER], -1)).toBeNull();
    expect(decomposeCanonical([COPPER], 1.5)).toBeNull();
  });
});

describe('planTender (OWV-17)', () => {
  it('returns an empty plan for required 0', () => {
    const plan = planTender([COPPER, SILVER], new Map([[COPPER.itemId, 5]]), 0);
    expect(plan).toEqual({tendered: new Map(), totalCopper: 0, coinCount: 0});
  });

  it('returns null when player capacity is below required', () => {
    const plan = planTender(
      [COPPER, SILVER],
      new Map([
        [COPPER.itemId, 4],
        [SILVER.itemId, 0],
      ]),
      10,
    );
    expect(plan).toBeNull();
  });

  it('uses exact-amount tender when one exists', () => {
    const plan = planTender(
      [COPPER, SILVER, GOLD],
      new Map([
        [COPPER.itemId, 5],
        [SILVER.itemId, 1],
      ]),
      15,
    );
    expect(plan).not.toBeNull();
    expect(plan!.totalCopper).toBe(15);
    expect(plan!.tendered.get(SILVER.itemId)).toBe(1);
    expect(plan!.tendered.get(COPPER.itemId)).toBe(5);
  });

  it('minimizes overpay first, then coin count', () => {
    // Player has only one gold; required 15. Overpay-minimum plan
    // is the single gold (overpay 85) since gold is the only way
    // to reach 15. With copper also available, exact 15 wins.
    const onlyGold = planTender(
      [COPPER, SILVER, GOLD],
      new Map([[GOLD.itemId, 1]]),
      15,
    );
    expect(onlyGold!.totalCopper).toBe(100);
    expect(onlyGold!.tendered.get(GOLD.itemId)).toBe(1);

    // Same required + gold but with 20 coppers: exact plan {silver:0, copper:15}
    // wins because overpay = 0 beats overpay = 85.
    const goldPlusCopper = planTender(
      [COPPER, SILVER, GOLD],
      new Map([
        [GOLD.itemId, 1],
        [COPPER.itemId, 20],
      ]),
      15,
    );
    expect(goldPlusCopper!.totalCopper).toBe(15);
    expect(goldPlusCopper!.tendered.get(COPPER.itemId)).toBe(15);
    expect(goldPlusCopper!.tendered.has(GOLD.itemId)).toBe(false);
  });

  it('minimizes coin count when overpay ties', () => {
    // Required 30. Player has plenty. Two zero-overpay plans:
    //   {silver:3} = count 3 ← preferred
    //   {copper:30} = count 30
    const plan = planTender(
      [COPPER, SILVER],
      new Map([
        [SILVER.itemId, 5],
        [COPPER.itemId, 30],
      ]),
      30,
    );
    expect(plan!.totalCopper).toBe(30);
    expect(plan!.coinCount).toBe(3);
    expect(plan!.tendered.get(SILVER.itemId)).toBe(3);
    expect(plan!.tendered.has(COPPER.itemId)).toBe(false);
  });

  it('handles overpay when exact change is impossible', () => {
    // Player has only silver (cv=10); required 25 copper. Best plan:
    // 3 silver = 30, overpay 5.
    const plan = planTender(
      [COPPER, SILVER],
      new Map([[SILVER.itemId, 5]]),
      25,
    );
    expect(plan).not.toBeNull();
    expect(plan!.totalCopper).toBe(30);
    expect(plan!.tendered.get(SILVER.itemId)).toBe(3);
  });
});
