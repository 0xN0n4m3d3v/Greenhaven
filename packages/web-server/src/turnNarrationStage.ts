/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Tier} from './ai/classifier.js';
import {runNarrator} from './ai/handoff.js';
import type {RunnerProviders} from './ai/providers.js';
import {
  emitContentDelta,
  synthesiseNarrate,
} from './narrationSynthesis.js';
import type {Session} from './sessionManager.js';
import {telemetry, type TurnTelemetryRole} from './telemetry/index.js';
import type {ToolDefinition} from './tools/base.js';

export interface NarratorStageInput {
  session: Session;
  playerId: number;
  turnId: string;
  userText: string;
  providers: RunnerProviders;
  narratorSystemPrompt: string;
  narrateDef: ToolDefinition;
  signal: AbortSignal;
}

export async function runScriptedNarratorStage(
  input: NarratorStageInput,
): Promise<void> {
  const t0 = Date.now();
  const scriptedProviders = brokerAsNarratorProviders(input.providers);
  const out = await runNarrator({
    providers: scriptedProviders,
    systemPrompt: input.narratorSystemPrompt,
    userMessage: input.userText,
    narrateTool: input.narrateDef,
    signal: input.signal,
    onText: delta => {
      if (input.session.activeTurn) {
        input.session.activeTurn.streamedContent = true;
      }
      emitContentDelta(input.session, input.turnId, delta);
    },
  });
  telemetry.record({
    channel: 'turn',
    name: 'turn.role.narrator-scripted',
    sessionId: input.session.id,
    turnId: input.turnId,
    role: 'narrator-scripted',
    modelId: scriptedProviders.narratorModelId,
    thinking: scriptedProviders.narratorThinking,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
    cacheHitTokens: out.cacheHitTokens,
    cacheMissTokens: out.cacheMissTokens,
    durationMs: Date.now() - t0,
    tier: 'T0',
  });
  await synthesizeNarratorFallback(input, out, 'scripted');
}

export async function runNarratorOnlyStage(
  input: NarratorStageInput & {tier: Exclude<Tier, 'T0' | 'T4'>},
): Promise<void> {
  const tieredProviders = providersForTier(input.providers, input.tier);
  const t0 = Date.now();

  let out: Awaited<ReturnType<typeof runNarrator>>;
  let role: TurnTelemetryRole = 'narrator';
  let modelIdForTelemetry = tieredProviders.narratorModelId;
  let thinkingForTelemetry = tieredProviders.narratorThinking;

  const onText = (delta: string) => {
    if (input.session.activeTurn) {
      input.session.activeTurn.streamedContent = true;
    }
    emitContentDelta(input.session, input.turnId, delta);
  };

  if (input.tier === 'T2') {
    try {
      const {runScenePainter, SCENE_PAINTER_MODEL_ID} = await import(
        './agents/scenePainter.js'
      );
      out = await runScenePainter({
        providers: tieredProviders,
        systemPrompt: input.narratorSystemPrompt,
        userMessage: input.userText,
        narrateTool: input.narrateDef,
        signal: input.signal,
        onText,
      });
      role = 'narrator-scene-painter';
      modelIdForTelemetry = SCENE_PAINTER_MODEL_ID;
      thinkingForTelemetry = false;
    } catch (err) {
      telemetry.record({
        channel: 'gameplay',
        name: 'turn_narration.scene_painter_fallback',
        sessionId: input.session.id,
        playerId: input.playerId,
        turnId: input.turnId,
        error: err,
        data: {
          fallback: 'magnum_narrator',
          message: err instanceof Error ? err.message : String(err),
        },
      });
      out = await runNarrator({
        providers: tieredProviders,
        systemPrompt: input.narratorSystemPrompt,
        userMessage: input.userText,
        narrateTool: input.narrateDef,
        signal: input.signal,
        onText,
      });
      role = 'narrator-painter-fallback';
    }
  } else {
    out = await runNarrator({
      providers: tieredProviders,
      systemPrompt: input.narratorSystemPrompt,
      userMessage: input.userText,
      narrateTool: input.narrateDef,
      signal: input.signal,
      onText,
    });
  }

  telemetry.record({
    channel: 'turn',
    name: `turn.role.${role}`,
    sessionId: input.session.id,
    turnId: input.turnId,
    role,
    modelId: modelIdForTelemetry,
    thinking: thinkingForTelemetry,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
    cacheHitTokens: out.cacheHitTokens,
    cacheMissTokens: out.cacheMissTokens,
    durationMs: Date.now() - t0,
    tier: input.tier,
  });
  await synthesizeNarratorFallback(input, out, 'narrator-only');
}

export function hasVisibleNarrateMessage(
  session: Session,
  turnId: string,
): boolean {
  const active = session.activeTurn;
  return (
    active?.turnId === turnId &&
    typeof active.finalMessageId === 'number' &&
    Number.isFinite(active.finalMessageId)
  );
}

export function narrateArgsText(args?: Record<string, unknown>): string {
  const value = args?.['text'];
  return typeof value === 'string' ? value : '';
}

function providersForTier(
  providers: RunnerProviders,
  tier: Tier,
): RunnerProviders {
  if (tier === 'T1') {
    return brokerAsNarratorProviders(providers);
  }
  if (tier === 'T2') {
    return {...providers, narratorThinking: false};
  }
  return {...providers, narratorThinking: true};
}

function brokerAsNarratorProviders(providers: RunnerProviders): RunnerProviders {
  return {
    ...providers,
    narrator: providers.broker,
    narratorModelId: providers.brokerModelId,
    narratorThinking: false,
    narratorIsFeatherless: providers.brokerIsFeatherless,
  };
}

async function synthesizeNarratorFallback(
  input: NarratorStageInput,
  out: Awaited<ReturnType<typeof runNarrator>>,
  label: 'scripted' | 'narrator-only',
): Promise<void> {
  const fallbackArgs = out.lastNarrateInput;
  const fallbackArgText = narrateArgsText(fallbackArgs);
  const fallbackText = fallbackArgText.trim()
    ? fallbackArgText
    : out.contentBuffer;
  if (!hasVisibleNarrateMessage(input.session, input.turnId) && fallbackText.trim()) {
    if (out.toolCallsSeen > 0) {
      console.warn(
        `[turnNarrationStage ${input.turnId}] narrator tool-call produced no visible message; synthesising ${label} fallback`,
      );
    }
    await synthesiseNarrate(
      input.session,
      input.playerId,
      input.turnId,
      fallbackText,
      !fallbackArgText.trim() && !out.jsonDumpDetected,
      fallbackArgs,
    );
  }
}
