/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 39 §5.1 — Specialist agent adapter.
//
// Every narrow-prompt LLM specialist (Quest Watcher, Combat Director,
// Intimacy Coordinator, …) wraps its model call through runSpecialist()
// so we get:
//   - common timeout (8s default), fail open on exceed
//   - common telemetry row with role='agent:<name>' for cost tracking
//   - common Zod-validated JSON output (failure → null, never throws)
//   - shared narrow-prompt invocation (no full system prompt; each
//     specialist passes its own buildPrompt(input))
//
// Specialists are EITHER:
//   - blocking — run before broker, contribute briefing to its turn
//     input (e.g., Combat Director on combat-mode turns)
//   - async    — run after turn.end, side-effects only, contribute
//     to next preamble (e.g., Quest Watcher)
//
// Mode is declared per-specialist; turnRunnerV2.ts has separate
// preBrokerPhase[] and postTurnPhase[] arrays consuming each.

import { generateText, type LanguageModel } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import type {
  PostTurnPresentationMeta,
  PresentationHandle,
} from '../presentationScheduler.js';
import { safeJsonExtract } from '../safeJson.js';
import type { ToolHistoryEntry } from '../sessionManager.js';

export interface SpecialistContext {
  sessionId: string;
  playerId: number;
  turnId: string;
  language?: string;
  signal: AbortSignal;
  presentation?: PresentationHandle;
}

export interface SpecialistDef<TInput, TOutput> {
  /** Telemetry tag; written as role='agent:<name>'. */
  name: string;
  /** Blocking specialists run before broker; async run after turn.end. */
  mode: 'blocking' | 'async';
  /** Build the narrow system+user prompt for this specialist call. */
  buildPrompt(input: TInput): { system: string; user: string };
  /** Zod schema validating the specialist's JSON output. Failure → null. */
  outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  /**
   * Optional coercion applied to the parsed JSON BEFORE schema validation.
   * Use to clamp / truncate / drop sub-shapes that the LLM reliably mangles
   * (oversize strings, over-long arrays, sentinel zero IDs, etc.) so the
   * specialist succeeds instead of fail-opening. Must be pure and total.
   */
  coerceInput?(raw: unknown): unknown;
  /** Hard timeout. Default 8000ms. Beyond this, fail open. */
  timeoutMs?: number;
  /** Override model; defaults to non-thinking deepseek-chat / Mistral Nemo. */
  pickModel?: () => LanguageModel;
  /** Override temperature; defaults to 0.3 (deterministic-ish). */
  temperature?: number;
  /** Override maxOutputTokens; defaults to 1200. */
  maxOutputTokens?: number;
  /** Optional fail-open reason hook for callers that persist outcome metadata. */
  onFailure?(failure: {
    reason: 'external_abort' | 'timeout' | 'error' | 'non_json' | 'schema';
    message?: string;
    durationMs: number;
  }): void;
}

function defaultModel(): LanguageModel {
  // Same preference order as examiner: DeepSeek V3.2 (non-thinking,
  // multilingual-strong) → Featherless Mistral Nemo (cheap fallback).
  // Specialists never need a thinking model.
  const { deepseekApiKey, featherlessApiKey } = config();
  const deepseekKey = deepseekApiKey;
  const featherlessKey = featherlessApiKey;
  if (deepseekKey) {
    return createDeepSeek({ apiKey: deepseekKey })('deepseek-chat');
  }
  if (featherlessKey) {
    const fl = createOpenAICompatible({
      name: 'featherless',
      baseURL: 'https://api.featherless.ai/v1',
      apiKey: featherlessKey,
    });
    return fl('mistralai/Mistral-Nemo-Instruct-2407');
  }
  throw new Error(
    'Specialist agent needs DEEPSEEK_API_KEY or FEATHERLESS_API_KEY',
  );
}

/**
 * Run a specialist agent. Always returns either the validated output
 * (success path) or null (any failure — timeout, malformed JSON,
 * schema mismatch, network error). Specialists are an OPTIMISATION,
 * never a dependency: callers fall back to broker-default behaviour
 * when null is returned.
 */
export async function runSpecialist<TIn, TOut>(
  def: SpecialistDef<TIn, TOut>,
  input: TIn,
  ctx: SpecialistContext,
): Promise<TOut | null> {
  const startedAt = Date.now();
  let modelId = 'unavailable';

  const timer = new AbortController();
  const timeoutMs = def.timeoutMs ?? 8000;
  const timeoutHandle = setTimeout(() => timer.abort(), timeoutMs);
  // Cascade external abort.
  const onExternalAbort = () => timer.abort();
  ctx.signal.addEventListener('abort', onExternalAbort);

  const baseTelemetry = {
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    role: `agent:${def.name}`,
    playerId: ctx.playerId,
  };

  try {
    const pickModel = def.pickModel ?? defaultModel;
    const model = pickModel();
    modelId =
      (model as { modelId?: string }).modelId ??
      (def.pickModel ? 'custom-specialist-model' : 'default-specialist-model');
    const { system, user } = def.buildPrompt(input);
    const r = await generateText({
      model,
      system,
      messages: [{ role: 'user', content: user }],
      temperature: def.temperature ?? 0.3,
      maxOutputTokens: def.maxOutputTokens ?? 1200,
      abortSignal: timer.signal,
    });

    await recordAgentTelemetry({
      ...baseTelemetry,
      inputTokens: r.usage.inputTokens ?? 0,
      outputTokens: r.usage.outputTokens ?? 0,
      durationMs: Date.now() - startedAt,
      ok: true,
      modelId,
    });

    const json = safeJsonExtract(r.text);
    if (json == null) {
      console.warn(
        `[agent:${def.name}] non-JSON output, fail-open. Raw[:200]: ${r.text.slice(0, 200)}`,
      );
      def.onFailure?.({
        reason: 'non_json',
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    const coerced = def.coerceInput ? def.coerceInput(json) : json;
    const parsed = def.outputSchema.safeParse(coerced);
    if (!parsed.success) {
      console.warn(
        `[agent:${def.name}] schema validation failed, fail-open. Issues:`,
        parsed.error.issues.slice(0, 3),
      );
      def.onFailure?.({
        reason: 'schema',
        message: parsed.error.issues
          .slice(0, 3)
          .map((issue) => issue.message)
          .join('; '),
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
    return parsed.data;
  } catch (err) {
    let failureReason: 'external_abort' | 'timeout' | 'error' = 'error';
    const message = err instanceof Error ? err.message : String(err);
    if (ctx.signal.aborted) {
      // CATCH-WARN-OK: paired with recordAgentTelemetry({ok:false, …}) at the end of this catch (line ~213); the telemetry write IS the structured record, console.warn is the operator-side breadcrumb.
      console.warn(`[agent:${def.name}] aborted by turn signal, fail-open`);
      failureReason = 'external_abort';
    } else if (timer.signal.aborted) {
      // CATCH-WARN-OK: paired with recordAgentTelemetry({ok:false, …}) at the end of this catch (line ~213); the telemetry write IS the structured record, console.warn is the operator-side breadcrumb.
      console.warn(
        `[agent:${def.name}] timeout after ${timeoutMs}ms, fail-open`,
      );
      failureReason = 'timeout';
    } else {
      // CATCH-WARN-OK: paired with recordAgentTelemetry({ok:false, …}) at the end of this catch (line ~213); the telemetry write IS the structured record, console.warn is the operator-side breadcrumb.
      console.warn(`[agent:${def.name}] threw, fail-open:`, message);
    }
    def.onFailure?.({
      reason: failureReason,
      message,
      durationMs: Date.now() - startedAt,
    });
    await recordAgentTelemetry({
      ...baseTelemetry,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
      ok: false,
      modelId,
    });
    return null;
  } finally {
    clearTimeout(timeoutHandle);
    ctx.signal.removeEventListener('abort', onExternalAbort);
  }
}

async function recordAgentTelemetry(args: {
  sessionId: string;
  turnId: string;
  role: string; // 'agent:<name>'
  playerId: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  ok: boolean;
  modelId?: string;
}): Promise<void> {
  // Specialists run on deepseek-chat / Mistral Nemo. Both ~$0.07 in / $0.28 out per 1M.
  const cost = args.inputTokens * 0.00000007 + args.outputTokens * 0.00000028;
  try {
    await query(
      `INSERT INTO turn_telemetry
         (session_id, turn_id, role, model_id, thinking, input_tokens,
          output_tokens, cache_hit_tokens, cache_miss_tokens,
          duration_ms, cost_usd, player_id, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        args.sessionId,
        args.turnId,
        args.role,
        args.modelId ?? 'unavailable',
        false,
        args.inputTokens,
        args.outputTokens,
        0,
        args.inputTokens,
        args.durationMs,
        cost,
        args.playerId,
        null,
      ],
    );
  } catch (err) {
    // CATCH-WARN-OK: recordAgentTelemetry IS the telemetry writer (direct INSERT into turn_telemetry); calling telemetry.record() here would re-enter the failing write path. Telemetry write failure is non-fatal for specialist work.
    console.warn('[agent.telemetry] write failed (non-fatal):', err);
  }
}

// ── Phase hooks (consumed by turnRunnerV2) ─────────────────────────────
//
// Phase hooks are the integration point between turnRunnerV2 and
// specialists. preBrokerPhase[] runs synchronously before broker;
// each hook may return a "briefing" string that gets appended to
// the broker's user message. postTurnPhase[] runs after turn.end
// (fire-and-forget), no return — side-effects via SSE / DB.

export interface PreBrokerHook {
  name: string;
  /**
   * Returns optional briefing text injected into broker user message.
   * Returns null when this hook does not apply to this turn (e.g.,
   * Combat Director on a non-combat turn).
   */
  run(
    ctx: SpecialistContext,
    turnInput: { text: string; mode: string },
  ): Promise<string | null>;
}

export interface PostTurnHook {
  name: string;
  presentation: PostTurnPresentationMeta;
  /**
   * Runs after turn.end. Side-effects only. Each hook is fire-and-forget
   * — the runtime catches any throw and continues with the next hook.
   */
  run(
    ctx: SpecialistContext,
    turnRecord: {
      text: string;
      toolHistory: ToolHistoryEntry[];
      narrative: string;
      mode?: string;
    },
  ): Promise<void>;
}

// Re-export the schema namespace consumers will use to keep
// imports tidy. Each specialist defines its own Zod schema.
export { z };
