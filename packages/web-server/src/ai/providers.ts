/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// AI SDK provider factory. broker + narrator slots.
//
// When FEATHERLESS_API_KEY is set, BOTH slots route through Featherless
// (OpenAI-compatible) using uncensored / lightly-moderated models —
// DeepSeek's soft-moderation at the broker tool-call level was breaking
// adult/violent commitment flow. Defaults: broker = Mistral Nemo 12B
// (fast, multilingual, tool-calling friendly), narrator = TheDrummer
// Cydonia 24B v4.3 (NSFW-tuned, Mistral Small base, multilingual).
//
// Without FEATHERLESS_API_KEY but with DEEPSEEK_API_KEY, falls back to
// the original DeepSeek pair (V4 Flash broker + V4 Pro narrator). For
// SFW cartridges this stays cheap; for 21+ cartridges expect tool-call
// soft-deflection.

import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { config } from '../config.js';

export type RunnerRole = 'broker' | 'narrator';

export interface RoleConfig {
  modelId: string;
  thinking: boolean;
}

export interface RunnerProviders {
  broker: LanguageModel;
  narrator: LanguageModel;
  brokerThinking: boolean;
  narratorThinking: boolean;
  brokerModelId: string;
  narratorModelId: string;
  brokerIsFeatherless: boolean;
  narratorIsFeatherless: boolean;
}

const FEATHERLESS_DEFAULT_BROKER = 'mistralai/Mistral-Nemo-Instruct-2407';
const FEATHERLESS_DEFAULT_NARRATOR = 'TheDrummer/Cydonia-24B-v4.3';
const DEEPSEEK_DEFAULT_BROKER = 'deepseek-v4-flash';
const DEEPSEEK_DEFAULT_NARRATOR = 'deepseek-v4-pro';

export function buildProviders(opts?: {
  broker?: Partial<RoleConfig>;
  narrator?: Partial<RoleConfig>;
}): RunnerProviders {
  const cfg = config();
  const featherlessKey = cfg.featherlessApiKey;
  const deepseekKey = cfg.deepseekApiKey;

  if (!featherlessKey && !deepseekKey) {
    throw new Error(
      'At least one of FEATHERLESS_API_KEY or DEEPSEEK_API_KEY must be set. ' +
        'Featherless: https://featherless.ai/account · DeepSeek: https://platform.deepseek.com/api_keys',
    );
  }

  // Build provider clients lazily — only instantiate the keys we need.
  const featherless = featherlessKey
    ? createOpenAICompatible({
        name: 'featherless',
        baseURL: 'https://api.featherless.ai/v1',
        apiKey: featherlessKey,
      })
    : null;
  const ds = deepseekKey ? createDeepSeek({ apiKey: deepseekKey }) : null;

  // Per-slot routing by model id prefix:
  //   `deepseek-*`  → DeepSeek API (cheap broker for non-sensitive flows)
  //   anything else → Featherless OpenAI-compat (uncensored RP-tuned for narrator)
  // This lets us mix providers — e.g. cheap DeepSeek broker + Magnum Diamond narrator.
  function pickProvider(
    modelId: string,
    fallback: 'featherless' | 'deepseek',
  ): {
    model: LanguageModel;
    isFeatherless: boolean;
  } {
    const isDeepSeek =
      modelId.startsWith('deepseek-') || modelId.startsWith('ds-');
    if (isDeepSeek) {
      if (!ds) throw new Error(`Model '${modelId}' requires DEEPSEEK_API_KEY`);
      return { model: ds(modelId), isFeatherless: false };
    }
    if (!featherless) {
      if (fallback === 'deepseek' && ds) {
        return { model: ds(modelId), isFeatherless: false };
      }
      throw new Error(`Model '${modelId}' requires FEATHERLESS_API_KEY`);
    }
    return { model: featherless(modelId), isFeatherless: true };
  }

  const brokerModelId =
    cfg.brokerModel ||
    opts?.broker?.modelId ||
    (featherless ? FEATHERLESS_DEFAULT_BROKER : DEEPSEEK_DEFAULT_BROKER);
  const { model: broker, isFeatherless: brokerIsFeatherless } = pickProvider(
    brokerModelId,
    'deepseek',
  );

  const narratorModelId =
    cfg.narratorModel ||
    opts?.narrator?.modelId ||
    (featherless ? FEATHERLESS_DEFAULT_NARRATOR : DEEPSEEK_DEFAULT_NARRATOR);
  const { model: narrator, isFeatherless: narratorIsFeatherless } =
    pickProvider(narratorModelId, 'featherless');

  return {
    broker,
    narrator,
    brokerThinking: opts?.broker?.thinking ?? false,
    narratorThinking: opts?.narrator?.thinking ?? !narratorIsFeatherless, // Featherless doesn't use thinking; DeepSeek V4 Pro does.
    brokerModelId,
    narratorModelId,
    brokerIsFeatherless,
    narratorIsFeatherless,
  };
}
