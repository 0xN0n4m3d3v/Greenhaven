/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DeepSeek pricing per 1M tokens. Update when promo periods change.
// V4 Pro 75% promo expires 2026-05-31 — see plans/deepseek-migration.

export interface PriceTier {
  inputPerM: number;
  cacheHitPerM: number;
  outputPerM: number;
}

export const PRICING_USD_PER_M_TOKENS: Record<string, PriceTier> = {
  'deepseek-v4-flash': {inputPerM: 0.14, cacheHitPerM: 0.0028, outputPerM: 0.28},
  // Promo until 2026-05-31. After that, switch to {1.74, 0.0145, 3.48}.
  'deepseek-v4-pro': {inputPerM: 0.435, cacheHitPerM: 0.003625, outputPerM: 0.87},
  'deepseek-chat': {inputPerM: 0.14, cacheHitPerM: 0.0028, outputPerM: 0.28},
  'deepseek-reasoner': {inputPerM: 0.435, cacheHitPerM: 0.003625, outputPerM: 0.87},
};

export function computeCostUsd(opts: {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
}): number {
  const tier =
    PRICING_USD_PER_M_TOKENS[opts.modelId] ??
    PRICING_USD_PER_M_TOKENS['deepseek-v4-flash']!;
  const cacheHit = opts.cacheHitTokens ?? 0;
  const cacheMiss = Math.max(0, opts.inputTokens - cacheHit);
  return (
    (cacheMiss * tier.inputPerM) / 1_000_000 +
    (cacheHit * tier.cacheHitPerM) / 1_000_000 +
    (opts.outputTokens * tier.outputPerM) / 1_000_000
  );
}
