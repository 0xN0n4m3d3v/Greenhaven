/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 44 — Scene Painter.
//
// Cheaper alternative to Magnum Diamond for T2 ambient turns.
// Wraps runNarrator with:
//   - deepseek-chat as the narrator model (instead of Magnum on Featherless)
//   - SCENE_PAINTER_ADDENDUM appended to the loaded greenhaven.md prompt
//   - same NarratorOutcome shape so turnRunnerV2 can swap it in/out
//     transparently
//
// Per-turn failures (timeout / abort / init throw) bubble up so
// turnRunnerV2's catch-and-fallback path retries with full Magnum.

import { createDeepSeek } from '@ai-sdk/deepseek';
import { config } from '../config.js';
import { runNarrator, type NarratorOutcome } from '../ai/handoff.js';
import type { RunnerProviders } from '../ai/providers.js';
import type { ToolDefinition } from '../tools/base.js';
import { SCENE_PAINTER_ADDENDUM } from './scenePainterPrompt.js';

export interface ScenePainterArgs {
  providers: RunnerProviders;
  systemPrompt: string;
  userMessage: string;
  narrateTool: ToolDefinition;
  signal: AbortSignal;
  onText?: (delta: string) => void;
}

export const SCENE_PAINTER_MODEL_ID = 'deepseek-chat';

/**
 * Run Scene Painter as a drop-in replacement for runNarrator on T2
 * turns. Throws on init / mid-stream failure so the caller can
 * fall back to Magnum.
 */
export async function runScenePainter(
  args: ScenePainterArgs,
): Promise<NarratorOutcome> {
  const deepseekKey = config().deepseekApiKey;
  if (!deepseekKey) {
    // Without a DeepSeek key Painter can't run. Throw so caller falls
    // back to Magnum (which uses Featherless / its own provider).
    throw new Error('scene_painter_no_deepseek_key');
  }
  const painterModel = createDeepSeek({ apiKey: deepseekKey })(
    SCENE_PAINTER_MODEL_ID,
  );

  const painterProviders: RunnerProviders = {
    ...args.providers,
    narrator: painterModel,
    narratorModelId: SCENE_PAINTER_MODEL_ID,
    narratorIsFeatherless: false,
    narratorThinking: false,
  };

  const systemPrompt = args.systemPrompt + '\n\n' + SCENE_PAINTER_ADDENDUM;

  return runNarrator({
    providers: painterProviders,
    systemPrompt,
    userMessage: args.userMessage,
    narrateTool: args.narrateTool,
    signal: args.signal,
    onText: args.onText,
  });
}
