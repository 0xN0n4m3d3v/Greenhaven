/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Tier} from './ai/classifier.js';
import {computeCostUsd} from './ai/pricing.js';
import {query} from './db.js';
import {recordPerformanceEvent} from './performanceTelemetry.js';

export type TurnTelemetryRole =
  | 'broker'
  | 'narrator'
  | 'narrator-scripted'
  | 'narrator-scene-painter'
  | 'narrator-painter-fallback';

export async function recordTurnTelemetry(opts: {
  sessionId: string;
  turnId: string;
  role: TurnTelemetryRole;
  modelId: string;
  thinking: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  durationMs: number;
  tier?: Tier;
}): Promise<void> {
  const cost = computeCostUsd({
    modelId: opts.modelId,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    cacheHitTokens: opts.cacheHitTokens,
  });
  let playerId: number | null = null;
  try {
    const {currentToolContext} = await import('./tools/base.js');
    playerId = currentToolContext().playerId;
  } catch {
    // Telemetry can be emitted outside a tool context in support fixtures.
  }
  try {
    await query(
      `INSERT INTO turn_telemetry
         (session_id, turn_id, role, model_id, thinking, input_tokens,
          output_tokens, cache_hit_tokens, cache_miss_tokens,
          duration_ms, cost_usd, player_id, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        opts.sessionId,
        opts.turnId,
        opts.role,
        opts.modelId,
        opts.thinking,
        opts.inputTokens,
        opts.outputTokens,
        opts.cacheHitTokens,
        opts.cacheMissTokens,
        opts.durationMs,
        cost,
        playerId,
        opts.tier ?? null,
      ],
    );
  } catch (err) {
    console.error('[turnTelemetry] telemetry insert failed', err);
  }
  await recordPerformanceEvent({
    sessionId: opts.sessionId,
    playerId,
    turnId: opts.turnId,
    traceId: opts.turnId,
    kind: 'llm',
    phase: `llm.${opts.role}`,
    status: 'ok',
    durationMs: opts.durationMs,
    metadata: {
      role: opts.role,
      model_id: opts.modelId,
      thinking: opts.thinking,
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
      cache_hit_tokens: opts.cacheHitTokens,
      cache_miss_tokens: opts.cacheMissTokens,
      cost_usd: cost,
      tier: opts.tier ?? null,
    },
  });
}
