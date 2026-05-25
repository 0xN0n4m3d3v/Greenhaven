/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — broker LLM invocation and retry machinery extracted from
// `turnBrokerStage.ts` so `runBrokerStage` stays a thin orchestrator
// for pre-broker briefings, fallback hooks, narrator handoff,
// content-buffer synthesis, and no-visible-output fallback.
//
// `invokeBroker(input, cb)` owns:
//   1. `turn.prompt_budget` telemetry,
//   2. the broker `runBroker(...)` call (with the `tool.request` /
//      `tool.result` SSE markers wrapped in `SSE-OK` annotations),
//   3. empty-output retry telemetry +
//      `broker.empty_output_retry` / `broker.empty_output_fail_open`
//      events,
//   4. mutation-limit retry (telemetry, narrate + read-only tool
//      subset, `broker.mutation_limit_retry` /
//      `_failed` / `_empty`),
//   5. `turn.role.broker` telemetry for the final accepted attempt,
//   6. signal-abort short-circuit with the `cancelled` SSE marker.
//
// Behavior is unchanged byte-for-byte. Callers (currently
// `runBrokerStage`) pass three callbacks for fallback decisions so
// the intimacy / combat fallback prose stays in `turnBrokerStage.ts`
// for this slice.

import {zodToJsonSchema} from 'zod-to-json-schema';
import type {Mode} from '../../ai/classifier.js';
import {
  brokerStageOverrideForTools,
  isBrokerEmptyOutputError,
  MAX_MUTATION_TOOLS,
  MUTATION_LIMIT_WARNING,
  READ_ONLY_TOOL_NAMES,
  runBroker,
  type BrokerOutcome,
} from '../../ai/handoff.js';
import type {RunnerProviders} from '../../ai/providers.js';
import type {Session} from '../../sessionManager.js';
import {telemetry} from '../../telemetry/index.js';
import type {ToolDefinition} from '../../tools/base.js';
import {brokerEmptyIntimacyRecoveryText} from '../brokerEmptyText.js';
import {BrokerMutationLimitError, getTurnErrorCode} from '../errors.js';

export interface BrokerInvocationInput {
  session: Session;
  playerId: number;
  turnId: string;
  mode: Mode;
  providers: RunnerProviders;
  brokerSystemPrompt: string;
  brokerTools: Map<string, ToolDefinition>;
  brokerToolProfile?: string;
  /** Player message after pre-broker briefing concatenation. */
  userTextWithBriefings: string;
  signal: AbortSignal;
  recoveryDirective: string;
  /**
   * S-8 — player's active language code (e.g. `'ru'`, `'ja-JP'`).
   * Used to localize the intimacy-mode recovery prose appended to the
   * empty-output retry prompt. Undefined falls back to English.
   */
  playerLang?: string;
  promptBudgetBreakdown?: Record<string, number>;
}

export interface BrokerInvocationCallbacks {
  /**
   * Called when the very first broker attempt returns
   * empty-output, BEFORE the retry. Return `true` to signal that
   * an intimacy / combat fallback handled the turn; `invokeBroker`
   * then returns `{kind: 'handled'}` and `runBrokerStage` returns
   * without further work.
   */
  tryEmptyOutputFallback(): Promise<boolean>;
  /**
   * Called after the recovery-directive retry also returns
   * empty-output, BEFORE the fail-open narration. Same semantics
   * as `tryEmptyOutputFallback`.
   */
  tryEmptyOutputRetryFallback(): Promise<boolean>;
  /**
   * Called when both broker attempts return empty-output and
   * neither fallback resolved the turn. The implementation owns
   * `suppressPostTurn = true` + the fail-open `synthesiseNarrate`
   * call against `input.failOpenText`.
   */
  emitFailOpenNarration(): Promise<void>;
}

export type BrokerInvocationResult =
  | {kind: 'handled'}
  | {kind: 'cancelled'}
  | {kind: 'broker'; broker: BrokerOutcome};

export async function invokeBroker(
  input: BrokerInvocationInput,
  cb: BrokerInvocationCallbacks,
): Promise<BrokerInvocationResult> {
  const tBroker = Date.now();
  const runBrokerAttempt = (userMessage: string): Promise<BrokerOutcome> =>
    runBroker({
      providers: input.providers,
      systemPrompt: input.brokerSystemPrompt,
      userMessage,
      tools: input.brokerTools,
      signal: input.signal,
      onText: undefined,
      onToolCall: (callId, name, args) => {
        // SSE-OK: emit outside tx (reason: broker tool-call
        // dispatch marker for UI; the tool's own DB write — if
        // any — happens inside its handler).
        input.session.sse.emit('tool.request', {callId, name, args});
      },
      onToolResult: (callId, output, isError) =>
        // SSE-OK: emit outside tx (reason: broker tool-call
        // completion marker; mirrors tool.request, the tool
        // handler already committed its own writes).
        input.session.sse.emit('tool.result', {
          callId,
          status: isError ? 'error' : 'success',
          display: '',
          error: isError
            ? {type: 'TOOL_EXECUTION_ERROR', message: String(output)}
            : undefined,
        }),
    });

  const brokerStageOverride = brokerStageOverrideForTools(input.brokerTools);
  const toolBudget = estimateToolPromptBudget(input.brokerTools);

  telemetry.record({
    channel: 'performance',
    name: 'turn.prompt_budget',
    sessionId: input.session.id,
    playerId: input.playerId,
    turnId: input.turnId,
    traceId: input.turnId,
    kind: 'turn',
    phase: 'turn.prompt_budget',
    status: 'ok',
    durationMs: 0,
    metadata: {
      mode: input.mode,
      tool_profile: input.brokerToolProfile ?? 'default',
      broker_system_chars: input.brokerSystemPrompt.length,
      broker_stage_override_chars: brokerStageOverride.length,
      broker_effective_system_chars:
        input.brokerSystemPrompt.length + brokerStageOverride.length,
      user_message_chars: input.userTextWithBriefings.length,
      ...(input.promptBudgetBreakdown ?? {}),
      tool_count: input.brokerTools.size,
      tool_names: [...input.brokerTools.keys()],
      tool_description_chars: toolBudget.descriptionChars,
      tool_schema_chars: toolBudget.schemaChars,
      tool_estimated_chars: toolBudget.estimatedChars,
    },
  });

  let broker: BrokerOutcome;
  try {
    broker = await runBrokerAttempt(input.userTextWithBriefings);
  } catch (err) {
    if (!isBrokerEmptyOutputError(err)) throw err;
    if (await cb.tryEmptyOutputFallback()) return {kind: 'handled'};
    console.warn(
      `[turnBrokerStage ${input.turnId}] broker returned empty output; retrying once with recovery directive`,
    );
    telemetry.record({
      channel: 'gameplay',
      name: 'broker.empty_output_retry',
      sessionId: input.session.id,
      playerId: input.playerId,
      turnId: input.turnId,
      error: err,
      data: {
        stage: 'broker_empty_output_retry',
        attempt: 1,
        mode: input.mode,
        broker_tool_profile: input.brokerToolProfile ?? null,
        retry_directive: 'recovery_directive',
        error_code: getTurnErrorCode(err) ?? 'BROKER_EMPTY_OUTPUT',
        raw_message: err instanceof Error ? err.message : String(err),
      },
    });
    try {
      broker = await runBrokerAttempt(
        `${input.userTextWithBriefings}\n\n${input.recoveryDirective}${intimacyRecoverySuffix(input)}`,
      );
    } catch (retryErr) {
      if (!isBrokerEmptyOutputError(retryErr)) throw retryErr;
      if (await cb.tryEmptyOutputRetryFallback()) return {kind: 'handled'};
      console.warn(
        `[turnBrokerStage ${input.turnId}] broker returned empty output twice; emitting fail-open narration`,
      );
      telemetry.record({
        channel: 'gameplay',
        name: 'broker.empty_output_fail_open',
        sessionId: input.session.id,
        playerId: input.playerId,
        turnId: input.turnId,
        error: retryErr,
        data: {
          stage: 'broker_empty_output_fail_open',
          attempt: 2,
          mode: input.mode,
          broker_tool_profile: input.brokerToolProfile ?? null,
          fallback: 'fail_open_narration',
          error_code: getTurnErrorCode(retryErr) ?? 'BROKER_EMPTY_OUTPUT',
          raw_message:
            retryErr instanceof Error ? retryErr.message : String(retryErr),
        },
      });
      await cb.emitFailOpenNarration();
      return {kind: 'handled'};
    }
  }

  // GH-BUG-031: If broker exceeded mutation tool limit without
  // calling narrate, retry once with a warning and only narrate +
  // read-only tools. This prevents the player from waiting with no
  // visible response while the broker chains many mutations without
  // producing prose.
  if (
    broker.mutationLimitExceeded &&
    !broker.narrateRequest &&
    !broker.contentBuffer.trim()
  ) {
    console.warn(
      `[turnBrokerStage ${input.turnId}] mutation limit (${MAX_MUTATION_TOOLS}) exceeded without narrate; retrying with warning`,
    );
    telemetry.record({
      channel: 'gameplay',
      name: 'broker.mutation_limit_retry',
      sessionId: input.session.id,
      playerId: input.playerId,
      turnId: input.turnId,
      data: {
        stage: 'broker_mutation_limit_retry',
        attempt: 2,
        mode: input.mode,
        broker_tool_profile: input.brokerToolProfile ?? null,
        retry_directive: 'mutation_limit_warning',
        mutation_limit: MAX_MUTATION_TOOLS,
        error_code: new BrokerMutationLimitError().code,
      },
    });
    const mutationWarning = MUTATION_LIMIT_WARNING.replace(
      '%d',
      String(MAX_MUTATION_TOOLS),
    );
    const warningPrompt = `${input.brokerSystemPrompt}\n\n${mutationWarning}`;
    // Filter tools to only narrate + read-only for the retry —
    // mutation tools are blocked so the model can only produce
    // visible output.
    const filteredTools = new Map<string, ToolDefinition>();
    for (const [name, def] of input.brokerTools) {
      if (name === 'narrate' || READ_ONLY_TOOL_NAMES.has(name)) {
        filteredTools.set(name, def);
      }
    }
    let retrySucceeded = false;
    try {
      const retryOutcome = await runBroker({
        providers: input.providers,
        systemPrompt: warningPrompt,
        userMessage: input.userTextWithBriefings,
        tools: filteredTools,
        signal: input.signal,
        onText: undefined,
        onToolCall: (callId, name, args) => {
          // SSE-OK: emit outside tx (reason: broker tool-call
          // dispatch marker on the mutation-limit retry path).
          input.session.sse.emit('tool.request', {callId, name, args});
        },
        onToolResult: (callId, output, isError) =>
          // SSE-OK: emit outside tx (reason: broker tool-call
          // completion marker on the mutation-limit retry path).
          input.session.sse.emit('tool.result', {
            callId,
            status: isError ? 'error' : 'success',
            display: '',
            error: isError
              ? {type: 'TOOL_EXECUTION_ERROR', message: String(output)}
              : undefined,
          }),
      });
      if (retryOutcome.narrateRequest || retryOutcome.contentBuffer.trim()) {
        broker = retryOutcome;
        retrySucceeded = true;
      }
    } catch (retryErr) {
      console.warn(
        `[turnBrokerStage ${input.turnId}] mutation limit retry failed:`,
        retryErr instanceof Error ? retryErr.message : retryErr,
      );
      telemetry.record({
        channel: 'gameplay',
        name: 'broker.mutation_limit_retry_failed',
        sessionId: input.session.id,
        playerId: input.playerId,
        turnId: input.turnId,
        error: retryErr,
        data: {
          stage: 'broker_mutation_limit_retry',
          attempt: 2,
          mode: input.mode,
          broker_tool_profile: input.brokerToolProfile ?? null,
          mutation_limit: MAX_MUTATION_TOOLS,
          fallback: 'synth_fallback',
          error_code:
            getTurnErrorCode(retryErr) ?? new BrokerMutationLimitError().code,
          raw_message:
            retryErr instanceof Error ? retryErr.message : String(retryErr),
        },
      });
    }
    if (!retrySucceeded) {
      console.warn(
        `[turnBrokerStage ${input.turnId}] mutation limit retry produced no narrate; falling back to synth`,
      );
      telemetry.record({
        channel: 'gameplay',
        name: 'broker.mutation_limit_retry_empty',
        sessionId: input.session.id,
        playerId: input.playerId,
        turnId: input.turnId,
        data: {
          stage: 'broker_mutation_limit_retry',
          attempt: 2,
          mode: input.mode,
          broker_tool_profile: input.brokerToolProfile ?? null,
          mutation_limit: MAX_MUTATION_TOOLS,
          fallback: 'synth_fallback',
          error_code: new BrokerMutationLimitError().code,
        },
      });
    }
  }

  telemetry.record({
    channel: 'turn',
    name: 'turn.role.broker',
    sessionId: input.session.id,
    turnId: input.turnId,
    role: 'broker',
    modelId: input.providers.brokerModelId,
    thinking: input.providers.brokerThinking,
    inputTokens: broker.inputTokens,
    outputTokens: broker.outputTokens,
    cacheHitTokens: broker.cacheHitTokens,
    cacheMissTokens: broker.cacheMissTokens,
    durationMs: Date.now() - tBroker,
    tier: 'T4',
  });

  if (input.signal.aborted) {
    // SSE-OK: emit outside tx (reason: turn-lifecycle marker for
    // signal-abort; the cancel write is registered on the queue
    // row elsewhere).
    input.session.sse.emit('cancelled', {turnId: input.turnId});
    return {kind: 'cancelled'};
  }

  return {kind: 'broker', broker};
}

// S-8 — intimacy-mode suffix for the recovery-directive retry prompt.
// Returns an empty string outside the intimacy gate, mirroring the
// previous `emptyOutputModeRecovery` behavior. The leading space
// preserves the byte-for-byte separator the old helper produced via
// `['', ...].join(' ')`, so the concatenated prompt structure
// (`${recoveryDirective} ${catalog text}`) is unchanged.
function intimacyRecoverySuffix(input: BrokerInvocationInput): string {
  if (
    input.mode !== 'intimacy' &&
    input.brokerToolProfile !== 'intimacy_social'
  ) {
    return '';
  }
  return ` ${brokerEmptyIntimacyRecoveryText(input.playerLang)}`;
}

function estimateToolPromptBudget(tools: ReadonlyMap<string, ToolDefinition>): {
  descriptionChars: number;
  schemaChars: number;
  estimatedChars: number;
} {
  let descriptionChars = 0;
  let schemaChars = 0;
  for (const [name, def] of tools) {
    descriptionChars += name.length + def.description.length;
    try {
      schemaChars += JSON.stringify(
        zodToJsonSchema(def.paramsSchema, name),
      ).length;
    } catch {
      schemaChars += JSON.stringify({name}).length;
    }
  }
  return {
    descriptionChars,
    schemaChars,
    estimatedChars: descriptionChars + schemaChars,
  };
}
