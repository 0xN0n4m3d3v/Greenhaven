/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — pure tender/change planner for multi-denomination payments.
//
// Bridges authored merchant offers with a player's actual currency
// inventory:
//
//   * `decomposeCanonical(coins, amount)` greedy-DESC over the
//     bridge catalog to build a canonical breakdown of `amount`
//     copper. Used to credit the merchant and to return change.
//   * `planTender(coins, available, required)` bounded enumeration
//     that picks the player coins to spend so the tender meets
//     `required` while minimizing overpay first, then total coin
//     count, then catalog order (descending by copper value, then
//     slug).
//
// Pure: no I/O, no transaction, no SSE. The merchant payment tool
// runs the planner inside its `withTransaction` block after locking
// player currency rows so concurrent payments cannot double-spend
// the same stacks.

import type {CurrencyCoin} from './CurrencyBridgeService.js';

/** Planner output for a single tender attempt. `tendered` maps
 *  `items.id` → quantity the player must hand over. */
export interface TenderPlan {
  tendered: Map<number, number>;
  totalCopper: number;
  coinCount: number;
}

function sortedByValueDesc(coins: CurrencyCoin[]): CurrencyCoin[] {
  return [...coins].sort(
    (a, b) =>
      b.copperValue - a.copperValue || a.slug.localeCompare(b.slug),
  );
}

/** Decompose `amount` copper into canonical coin rows using the
 *  bridge catalog. Greedy DESC by `copperValue`; returns `null`
 *  when the catalog cannot reach `amount` exactly (e.g. the
 *  smallest denomination is larger than the remainder). */
export function decomposeCanonical(
  coins: CurrencyCoin[],
  amount: number,
): Map<number, number> | null {
  if (!Number.isInteger(amount) || amount < 0) return null;
  const out = new Map<number, number>();
  if (amount === 0) return out;
  let remaining = amount;
  for (const coin of sortedByValueDesc(coins)) {
    if (remaining <= 0) break;
    if (!Number.isInteger(coin.copperValue) || coin.copperValue <= 0) continue;
    if (coin.copperValue > remaining) continue;
    const k = Math.floor(remaining / coin.copperValue);
    if (k > 0) {
      out.set(coin.itemId, k);
      remaining -= k * coin.copperValue;
    }
  }
  if (remaining !== 0) return null;
  return out;
}

/** Plan the player tender for a copper-denominated payment.
 *  Enumerates subsets of `available` coins to find one with sum
 *  ≥ `required` minimizing `(sum − required)` then `coin count`.
 *  Returns `null` when even spending every available coin would
 *  fall short of `required`. */
export function planTender(
  coins: CurrencyCoin[],
  available: Map<number, number>,
  required: number,
): TenderPlan | null {
  if (!Number.isInteger(required) || required < 0) return null;
  if (required === 0) {
    return {tendered: new Map(), totalCopper: 0, coinCount: 0};
  }
  const sorted = sortedByValueDesc(coins);
  const suffixCapacity: number[] = new Array(sorted.length + 1).fill(0);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const coin = sorted[i]!;
    const qty = Math.max(0, available.get(coin.itemId) ?? 0);
    const cv = Math.max(0, coin.copperValue);
    const next = suffixCapacity[i + 1] ?? 0;
    suffixCapacity[i] = next + cv * qty;
  }
  if ((suffixCapacity[0] ?? 0) < required) return null;

  let best: TenderPlan | null = null;
  const stack: Array<{itemId: number; qty: number}> = [];

  function commit(sum: number, count: number): void {
    if (
      best &&
      (sum > best.totalCopper ||
        (sum === best.totalCopper && count >= best.coinCount))
    ) {
      return;
    }
    const tendered = new Map<number, number>();
    for (const entry of stack) tendered.set(entry.itemId, entry.qty);
    best = {tendered, totalCopper: sum, coinCount: count};
  }

  function recurse(idx: number, sum: number, count: number): void {
    if (sum >= required) {
      commit(sum, count);
      return;
    }
    if (idx >= sorted.length) return;
    if (sum + (suffixCapacity[idx] ?? 0) < required) return;
    if (best && sum >= best.totalCopper) return;

    const coin = sorted[idx]!;
    const maxQty = Math.max(0, available.get(coin.itemId) ?? 0);
    const cv = coin.copperValue;
    if (cv <= 0 || maxQty <= 0) {
      recurse(idx + 1, sum, count);
      return;
    }
    for (let k = 0; k <= maxQty; k++) {
      const newSum = sum + k * cv;
      if (best && newSum > best.totalCopper && newSum >= required) {
        // Larger k only worsens overpay from here.
        break;
      }
      if (k > 0) stack.push({itemId: coin.itemId, qty: k});
      recurse(idx + 1, newSum, count + k);
      if (k > 0) stack.pop();
    }
  }

  recurse(0, 0, 0);
  return best;
}
