/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mode } from './ai/classifier.js';
import {
  buildNarratorHandoffMessage,
  runNarrator,
  type BrokerOutcome,
} from './ai/handoff.js';
import type { RunnerProviders } from './ai/providers.js';
import type { PreBrokerHook, SpecialistContext } from './agents/base.js';
import {
  currentLocationAuthorId,
  synthesiseNarrate,
} from './narrationSynthesis.js';
import type { Session } from './sessionManager.js';
import { telemetry } from './telemetry/index.js';
import {
  ensureSceneItemPickupBeforeNarrate,
  tryResolveBrokerToolsNoVisibleFallback,
  tryResolveCombatNegotiationEmptyBrokerFallback,
  tryResolveIntimacyEmptyBrokerFallback,
  tryResolveIntimacyNarrateOnlyBrokerFallback,
} from './turn/broker/BrokerFallbacks.js';
import { invokeBroker } from './turn/broker/BrokerInvocation.js';
import {
  type ToolDefinition,
} from './tools/base.js';

export interface BrokerStageInput {
  session: Session;
  playerId: number;
  turnId: string;
  rawPlayerText: string;
  userText: string;
  mode: Mode;
  playerLang: string;
  providers: RunnerProviders;
  brokerSystemPrompt: string;
  brokerTools: Map<string, ToolDefinition>;
  brokerToolProfile?: string;
  narratorSystemPrompt: string;
  narrateDef: ToolDefinition;
  signal: AbortSignal;
  preBrokerHooks: readonly PreBrokerHook[];
  recoveryDirective: string;
  failOpenText: string;
  promptBudgetBreakdown?: Record<string, number>;
}

export async function runBrokerStage(input: BrokerStageInput): Promise<void> {
  let userTextWithBriefings = input.userText;
  if (input.preBrokerHooks.length > 0) {
    const ctxForAgents: SpecialistContext = {
      sessionId: input.session.id,
      playerId: input.playerId,
      turnId: input.turnId,
      language: input.playerLang,
      signal: input.signal,
    };
    for (const hook of input.preBrokerHooks) {
      try {
        const briefing = await hook.run(ctxForAgents, {
          text: input.rawPlayerText,
          mode: input.mode,
        });
        if (briefing) {
          userTextWithBriefings = `${userTextWithBriefings}\n\n${briefing}`;
        }
      } catch (err) {
        console.warn(
          `[preBrokerPhase ${hook.name}] failed (continuing with broker default):`,
          err instanceof Error ? err.message : err,
        );
        telemetry.record({
          channel: 'gameplay',
          name: 'broker.pre_broker_hook_failed',
          sessionId: input.session.id,
          playerId: input.playerId,
          turnId: input.turnId,
          error: err,
          data: {
            stage: 'pre_broker_hook',
            hook_name: hook.name,
            mode: input.mode,
            broker_tool_profile: input.brokerToolProfile ?? null,
            raw_message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }
  // ARCH-1 — broker LLM invocation + empty-output retry + mutation-
  // limit retry + prompt-budget / turn.role.broker telemetry live in
  // `turn/broker/BrokerInvocation.ts`. `runBrokerStage` only owns
  // pre-broker briefings (above), fallback decisions (callbacks),
  // narrator handoff, content synthesis, and no-visible fallback.
  const invocation = await invokeBroker(
    {
      session: input.session,
      playerId: input.playerId,
      turnId: input.turnId,
      mode: input.mode,
      providers: input.providers,
      brokerSystemPrompt: input.brokerSystemPrompt,
      brokerTools: input.brokerTools,
      brokerToolProfile: input.brokerToolProfile,
      userTextWithBriefings,
      signal: input.signal,
      recoveryDirective: input.recoveryDirective,
      playerLang: input.playerLang,
      promptBudgetBreakdown: input.promptBudgetBreakdown,
    },
    {
      tryEmptyOutputFallback: async () => {
        if (await tryResolveIntimacyEmptyBrokerFallback(input)) return true;
        return await tryResolveCombatNegotiationEmptyBrokerFallback(input);
      },
      tryEmptyOutputRetryFallback: async () => {
        if (await tryResolveIntimacyEmptyBrokerFallback(input)) return true;
        return await tryResolveCombatNegotiationEmptyBrokerFallback(input);
      },
      emitFailOpenNarration: async () => {
        if (input.session.activeTurn) {
          input.session.activeTurn.suppressPostTurn = true;
        }
        const failOpenAuthor = await currentLocationAuthorId(input.playerId);
        await synthesiseNarrate(
          input.session,
          input.playerId,
          input.turnId,
          input.failOpenText,
          false,
          {
            ...(failOpenAuthor != null ? { author: failOpenAuthor } : {}),
            tone: 'narrator',
            text: input.failOpenText,
            done: true,
          },
        );
      },
    },
  );
  if (invocation.kind !== 'broker') return;
  const broker: BrokerOutcome = invocation.broker;

  if (broker.narrateRequest) {
    const recovered = await tryResolveIntimacyNarrateOnlyBrokerFallback(input);
    if (recovered) return;
    await ensureSceneItemPickupBeforeNarrate(input);
    await runBrokerNarrateHandoff(input, broker);
    return;
  }

  if (broker.contentBuffer.trim()) {
    await synthesiseNarrate(
      input.session,
      input.playerId,
      input.turnId,
      broker.contentBuffer,
      false,
    );
    return;
  }

  const recovered = await tryResolveBrokerToolsNoVisibleFallback(input, broker);
  if (recovered) {
    return;
  }
}

// S-9 \u2014 the legacy keyword-overlay obligation helper and its call site
// were removed. The contracts it used to nudge the broker toward live
// in the prompt fragments (commerce.md, commerce-bargain.md,
// intimacy.md, intimacy-beat.md, dynamic-quests.md, quest-mechanics.md,
// adventure-accept.md, companions.md, movement.md, scene-trade.md) and
// are loaded by the classifier-driven mode + tool-profile pipeline. If
// a specific obligation needs stronger emphasis in the future, tighten
// the prompt fragment instead of re-introducing a keyword overlay.

// ARCH-1 — `emptyOutputModeRecovery` and `estimateToolPromptBudget`
// moved to `turn/broker/BrokerInvocation.ts`; the deterministic
// broker fallbacks (intimacy / combat negotiation / scene-item
// pickup / no-visible-output) plus their SQL loaders, dispatch
// helpers, regex constants, and prose builders moved to
// `turn/broker/BrokerFallbacks.ts`. `turnBrokerStage.ts` now only
// owns `runBrokerStage` orchestration and `runBrokerNarrateHandoff`.

async function runBrokerNarrateHandoff(
  input: BrokerStageInput,
  broker: BrokerOutcome,
): Promise<void> {
  const narrateRequest = broker.narrateRequest;
  if (!narrateRequest) return;

  const requestedText =
    typeof narrateRequest['text'] === 'string'
      ? (narrateRequest['text'] as string)
      : '';
  if (requestedText.trim()) {
    // Fast path: broker already provided prose — synthesise directly
    const tFastNarrate = Date.now();
    await synthesiseNarrate(
      input.session,
      input.playerId,
      input.turnId,
      requestedText,
      false,
      narrateRequest,
      'broker_narrate_fast_path',
    );
    telemetry.record({
      channel: 'performance',
      name: 'turn.narrator_bypass',
      sessionId: input.session.id,
      playerId: input.playerId,
      turnId: input.turnId,
      traceId: input.turnId,
      kind: 'turn',
      phase: 'turn.narrator_bypass',
      status: 'ok',
      durationMs: Date.now() - tFastNarrate,
      metadata: {
        reason: 'broker_narrate_request',
        tier: 'T4',
        mode: input.mode,
        requested_chars: requestedText.length,
      },
    });
    return;
  }

  // Full narrator path: broker requested narration without prose
  const tNarr = Date.now();
  const out = await runNarrator({
    providers: input.providers,
    systemPrompt: input.narratorSystemPrompt,
    userMessage: buildNarratorHandoffMessage(input.userText, narrateRequest),
    narrateTool: input.narrateDef,
    signal: input.signal,
    onText: undefined,
  });
  telemetry.record({
    channel: 'turn',
    name: 'turn.role.narrator',
    sessionId: input.session.id,
    turnId: input.turnId,
    role: 'narrator',
    modelId: input.providers.narratorModelId,
    thinking: input.providers.narratorThinking ?? false,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
    cacheHitTokens: out.cacheHitTokens,
    cacheMissTokens: out.cacheMissTokens,
    durationMs: Date.now() - tNarr,
  });
}
