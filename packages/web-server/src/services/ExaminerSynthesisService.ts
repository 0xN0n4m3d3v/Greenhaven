/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 — service ownership for /api/character/sheet/synthesize.
// Owns provider/model selection, generateText invocation, JSON repair,
// stats validation, language normalization, and class clamp. The route
// is reduced to Hono wiring + Zod validation only.

import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { examinerSynthesisPrompt } from '../ai/examinerPrompt.js';
import { pointBuySpend, validatePointBuy } from '../character/pointBuy.js';
import { config } from '../config.js';
import { errorOutcome as makeErrorOutcome } from '../httpErrors.js';
import { safeJsonExtract } from '../safeJson.js';

export interface RouteOutcome {
  status: number;
  body: unknown;
}

export const Transcript = z
  .array(
    z.object({
      q: z.string().min(1).max(800),
      a: z.string().min(1).max(4000),
    }),
  )
  .min(1)
  .max(40);

const optionalLanguage = z.preprocess(
  (value) => (value == null || value === '' ? undefined : value),
  z.string().min(2).max(16).optional(),
);

export const SynthesizeArgs = z.object({
  transcript: Transcript,
  partialState: z.unknown().optional(),
  language: optionalLanguage,
});

const DEFAULT_SYNTHESIS_STATS = {
  STR: 13,
  DEX: 14,
  CON: 12,
  INT: 10,
  WIS: 15,
  CHA: 8,
};

const CLASS_SKILL_CHOICES: Record<number, { from: string[]; pick: number }> = {
  600: {
    from: [
      'Acrobatics',
      'Animal Handling',
      'Athletics',
      'History',
      'Insight',
      'Intimidation',
      'Perception',
      'Survival',
    ],
    pick: 2,
  },
  601: {
    from: [
      'Acrobatics',
      'Athletics',
      'Deception',
      'Insight',
      'Intimidation',
      'Investigation',
      'Perception',
      'Performance',
      'Persuasion',
      'Sleight of Hand',
      'Stealth',
    ],
    pick: 4,
  },
  602: {
    from: ['Arcana', 'Sleight of Hand', 'Deception', 'Insight', 'Investigation'],
    pick: 3,
  },
  603: {
    from: ['Athletics', 'Religion', 'Insight', 'Intimidation', 'Medicine'],
    pick: 3,
  },
  604: {
    from: ['Perception', 'Investigation', 'Arcana', 'Insight', 'Survival'],
    pick: 3,
  },
  605: {
    from: [
      'Investigation',
      'Arcana',
      'Sleight of Hand',
      'History',
      'Perception',
    ],
    pick: 3,
  },
  606: {
    from: ['Persuasion', 'Deception', 'Insight', 'Performance', 'Investigation'],
    pick: 4,
  },
  607: {
    from: ['Stealth', 'Sleight of Hand', 'Athletics', 'Deception', 'Perception'],
    pick: 3,
  },
  608: {
    from: ['Arcana', 'History', 'Religion', 'Investigation', 'Insight'],
    pick: 3,
  },
  609: {
    from: ['Athletics', 'Survival', 'Intimidation', 'Medicine', 'Perception'],
    pick: 3,
  },
  610: {
    from: ['Insight', 'History', 'Investigation', 'Religion', 'Perception'],
    pick: 4,
  },
  611: {
    from: ['Persuasion', 'Insight', 'Performance', 'Medicine', 'Deception'],
    pick: 3,
  },
};

// Synthesis routes through a NON-REASONING broker so we don't burn the
// entire output budget on hidden reasoning tokens (DeepSeek V4 Flash/Pro
// emit reasoning aggressively on multilingual prompts).
//
// Preference: DEEPSEEK_API_KEY → deepseek-chat (V3.2, non-thinking,
// strong multilingual); FEATHERLESS_API_KEY → Mistral Nemo (fast
// fallback; weaker on Russian).
function pickSynthesisModel(): LanguageModel {
  const { deepseekApiKey, featherlessApiKey } = config();
  if (deepseekApiKey) {
    const ds = createDeepSeek({ apiKey: deepseekApiKey });
    return ds('deepseek-chat');
  }
  if (featherlessApiKey) {
    const fl = createOpenAICompatible({
      name: 'featherless',
      baseURL: 'https://api.featherless.ai/v1',
      apiKey: featherlessApiKey,
    });
    return fl('mistralai/Mistral-Nemo-Instruct-2407');
  }
  throw new Error(
    'Examiner synthesis needs either DEEPSEEK_API_KEY or FEATHERLESS_API_KEY.',
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function cleanInteger(value: unknown, min: number, max: number): number | null {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  const integer = Math.trunc(numeric);
  if (integer < min || integer > max) return null;
  return integer;
}

function requiredText(
  value: unknown,
  maxLength: number,
  fallback: string,
): string {
  return cleanText(value, maxLength) ?? fallback.slice(0, maxLength);
}

function transcriptAnswer(
  transcript: Array<{ q: string; a: string }>,
  index: number,
  maxLength: number,
): string | null {
  return cleanText(transcript[index]?.a, maxLength);
}

function buildCompletionHints(
  transcript: Array<{ q: string; a: string }>,
  partialState: unknown,
): { name: string | null; description: string | null; history: string | null } {
  const partial = asRecord(partialState);
  const sheet = asRecord(partial['sheet']);
  const identity = asRecord(partial['identity']);
  const background = asRecord(partial['background']);
  return {
    name:
      cleanText(sheet['name'], 120) ??
      cleanText(identity['name'], 120) ??
      transcriptAnswer(transcript, 0, 120),
    description:
      cleanText(sheet['description'], 6000) ??
      transcriptAnswer(transcript, 1, 6000),
    history:
      cleanText(sheet['history'], 6000) ??
      cleanText(background['origin_paragraph'], 6000) ??
      transcriptAnswer(transcript, 2, 6000),
  };
}

function sourceText(
  hints: {
    name: string | null;
    description: string | null;
    history: string | null;
  },
  maxLength: number,
): string | null {
  return (
    cleanText(hints.description, maxLength) ??
    cleanText(hints.history, maxLength) ??
    cleanText(hints.name, maxLength)
  );
}

function deriveNotableSkills(hints: {
  name: string | null;
  description: string | null;
  history: string | null;
}): string[] {
  const source = sourceText(hints, 800);
  if (!source)
    return ['Greenhaven survival', 'improvisation', 'reading danger'];
  const fragments = source
    .split(/[.,;:!?()[\]\n\r]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4)
    .slice(0, 3);
  return fragments.length > 0
    ? fragments.map((part) => part.slice(0, 120))
    : [source.slice(0, 120)];
}

function cleanStats(value: unknown): Record<string, number> {
  const src = asRecord(value);
  const stats: Record<string, number> = {};
  for (const key of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) {
    const score = cleanInteger(src[key], 8, 15);
    if (score == null) return { ...DEFAULT_SYNTHESIS_STATS };
    stats[key] = score;
  }
  return validatePointBuy(stats) ? stats : { ...DEFAULT_SYNTHESIS_STATS };
}

function cleanSkillRationales(
  input: unknown,
  skills: string[],
  fallback: string,
): Record<string, string> {
  const src = asRecord(input);
  const out: Record<string, string> = {};
  for (const skill of skills) {
    out[skill] = requiredText(src[skill], 500, fallback);
  }
  return out;
}

function stripNullish(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item != null)
      .map((item) => stripNullish(item));
  }
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (child == null) continue;
      out[key] = stripNullish(child);
    }
    return out;
  }
  return value;
}

export function repairSynthesisJson(
  json: Record<string, unknown>,
  transcript: Array<{ q: string; a: string }>,
  partialState?: unknown,
): Record<string, unknown> {
  const hints = buildCompletionHints(transcript, partialState);
  const source = sourceText(hints, 400);
  const shortSource = sourceText(hints, 200);
  const identity = asRecord(json['identity']);
  const physical = asRecord(json['physical']);
  const background = asRecord(json['background']);

  const startingClassId =
    cleanInteger(json['starting_class_id'], 600, 611) ?? 600;
  const skillChoice =
    CLASS_SKILL_CHOICES[startingClassId] ?? CLASS_SKILL_CHOICES[600]!;
  const rawSkills = Array.isArray(json['skills'])
    ? json['skills']
        .map((skill) => cleanText(skill, 40))
        .filter((skill): skill is string => skill != null)
    : [];
  const skills = Array.from(
    new Set(rawSkills.filter((skill) => skillChoice.from.includes(skill))),
  );
  for (const skill of skillChoice.from) {
    if (skills.length >= skillChoice.pick) break;
    if (!skills.includes(skill)) skills.push(skill);
  }

  const notable = Array.isArray(background['notable_skills'])
    ? Array.from(
        new Set(
          background['notable_skills']
            .map((skill) => cleanText(skill, 120))
            .filter((skill): skill is string => skill != null),
        ),
      ).slice(0, 10)
    : deriveNotableSkills(hints);

  const repaired: Record<string, unknown> = {
    ...json,
    identity: {
      name: requiredText(
        identity['name'],
        120,
        hints.name ?? 'Unnamed Greenhaven traveler',
      ),
      pronouns: requiredText(
        identity['pronouns'],
        40,
        'player-defined pronouns',
      ),
      gender_expression: requiredText(
        identity['gender_expression'],
        120,
        'player-authored presentation',
      ),
      race: requiredText(identity['race'], 60, 'custom Greenhaven ancestry'),
      anatomy: requiredText(
        identity['anatomy'],
        400,
        source ?? 'body details drawn from the creator sheet',
      ),
      attractions: requiredText(
        identity['attractions'],
        200,
        'private; defined by the player character',
      ),
      age: cleanInteger(identity['age'], 18, 10000) ?? 30,
    },
    physical: {
      build: requiredText(
        physical['build'],
        200,
        shortSource ?? 'build drawn from the creator sheet',
      ),
      voice: requiredText(
        physical['voice'],
        200,
        shortSource ?? 'voice drawn from the creator sheet',
      ),
      skin: requiredText(
        physical['skin'],
        200,
        shortSource ?? 'skin details drawn from the creator sheet',
      ),
      hair: requiredText(
        physical['hair'],
        200,
        shortSource ?? 'hair details drawn from the creator sheet',
      ),
      eyes: requiredText(
        physical['eyes'],
        200,
        shortSource ?? 'eye details drawn from the creator sheet',
      ),
      distinguishing_marks: requiredText(
        physical['distinguishing_marks'],
        400,
        source ?? 'distinguishing marks drawn from the creator sheet',
      ),
    },
    background: {
      origin_paragraph: requiredText(
        background['origin_paragraph'],
        6000,
        hints.history ??
          hints.description ??
          'The character arrives in Greenhaven with a personal history to uncover in play.',
      ),
      motivation: requiredText(
        background['motivation'],
        200,
        shortSource ?? 'find a reason to survive Greenhaven',
      ),
      temperament: requiredText(
        background['temperament'],
        160,
        shortSource ?? 'watchful, adaptable, hard to reduce to one mood',
      ),
      notable_skills: notable.length > 0 ? notable : deriveNotableSkills(hints),
    },
    starting_class_id: startingClassId,
    class_pick_rationale: requiredText(
      json['class_pick_rationale'],
      500,
      shortSource ?? 'Picked as the closest fit to the creator sheet.',
    ),
    stats: cleanStats(json['stats']),
    skills: skills.slice(0, skillChoice.pick),
    skill_picks_rationale: cleanSkillRationales(
      json['skill_picks_rationale'],
      skills.slice(0, skillChoice.pick),
      shortSource ?? 'Chosen from the creator sheet.',
    ),
  };

  return stripNullish(repaired) as Record<string, unknown>;
}

function buildPromptState(
  args: z.infer<typeof SynthesizeArgs>,
): Parameters<typeof examinerSynthesisPrompt>[1] {
  const partial = asRecord(args.partialState);
  return {
    ...partial,
    language:
      args.language ??
      (typeof partial['language'] === 'string' ? partial['language'] : undefined),
  } as Parameters<typeof examinerSynthesisPrompt>[1];
}

function normalizeDetectedLanguage(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0
    ? value.toLowerCase().slice(0, 2)
    : null;
}

function applyStatsValidation(json: Record<string, unknown>): void {
  const stats = json['stats'] as Record<string, number> | undefined;
  if (!stats) return;
  const valid = validatePointBuy(stats);
  const spent = pointBuySpend(stats);
  json['stats_valid'] = valid;
  json['stats_spent'] = spent;
  if (!valid) {
    console.warn(
      '[examiner] non-point-buy stats from model (spend=' + spent + '):',
      stats,
    );
  }
}

function clampStartingClassId(json: Record<string, unknown>): void {
  const cid = Number(json['starting_class_id']);
  if (Number.isFinite(cid) && (cid < 600 || cid > 611)) {
    json['starting_class_id'] = 600;
  }
}

function finalizeSynthesisJson(
  rawJson: Record<string, unknown>,
  transcript: Array<{ q: string; a: string }>,
  partialState: unknown,
): Record<string, unknown> {
  const json = repairSynthesisJson(rawJson, transcript, partialState);
  const detectedLang = normalizeDetectedLanguage(json['detected_language']);
  if (detectedLang) {
    json['input_language'] = detectedLang;
    json['detected_language'] = detectedLang;
  }
  applyStatsValidation(json);
  clampStartingClassId(json);
  return json;
}

function buildUnparseableOutcome(
  rawText: string,
  finishReason: unknown,
  usage: unknown,
): RouteOutcome {
  // SEC-3 / DEEP-7 — `console.warn` still captures the raw model
  // sample for operator triage; the client-facing body only carries
  // the stable code + correlation id (no `raw`, no `finishReason`,
  // no `usage`). The same fields ride along on the `http.error`
  // telemetry record via `errorOutcome`'s `data` arg.
  console.warn('[examiner] synthesis empty/unparseable:', {
    finishReason,
    usage,
    raw: rawText?.slice(0, 400),
  });
  return makeErrorOutcome(500, 'synthesis_unparseable', {
    data: {
      finish_reason: finishReason ?? null,
      usage: (usage as Record<string, unknown> | null) ?? null,
      raw_preview: rawText?.slice(0, 400) ?? null,
    },
  });
}

function buildThrowOutcome(err: unknown): RouteOutcome {
  // SEC-3 / DEEP-7 — opaque body + correlation id; full error
  // captured via `http.error` telemetry + console.error.
  return makeErrorOutcome(500, 'synthesis_failed', {internal: err});
}

export class ExaminerSynthesisService {
  static async synthesize(
    args: z.infer<typeof SynthesizeArgs>,
  ): Promise<RouteOutcome> {
    try {
      if (
        process.env.MOCK_SYNTHESIS === '1' ||
        process.env.FEATHERLESS_API_KEY === 'smoke-not-real-key'
      ) {
        const partial = asRecord(args.partialState);
        const sheet = asRecord(partial['sheet']);
        const nameHint = cleanText(sheet['name'], 120) ?? 'Hero Continuity Smoke';
        const descHint = cleanText(sheet['description'], 6000) ?? 'Pale hands, a quiet city shadow, speaks slow when sober.';
        const histHint = cleanText(sheet['history'], 6000) ?? 'Carried a heavy leather-bound ledger from the old world.';

        const mockJson = {
          detected_language: 'en',
          identity: {
            name: nameHint,
            pronouns: 'they/them',
            gender_expression: 'shadowy',
            race: 'human',
            anatomy: descHint,
            attractions: 'none',
            age: 30,
          },
          physical: {
            build: 'slender',
            voice: 'soft whisper',
            skin: 'pale',
            hair: 'black',
            eyes: 'dark',
            distinguishing_marks: 'none',
          },
          background: {
            origin_paragraph: histHint,
            motivation: 'find the truth',
            temperament: 'watchful',
            notable_skills: ['survival', 'ledger keeping'],
          },
          starting_class_id: 600,
          class_pick_rationale: 'Closest fit to the starting description.',
          stats: {
            STR: 13,
            DEX: 14,
            CON: 12,
            INT: 10,
            WIS: 15,
            CHA: 8,
          },
          skills: ['Acrobatics', 'Athletics'],
          skill_picks_rationale: {
            Acrobatics: 'Needed for agility.',
            Athletics: 'Needed for strength.',
          },
        };
        return {
          status: 200,
          body: finalizeSynthesisJson(mockJson, args.transcript, args.partialState),
        };
      }

      const model = pickSynthesisModel();
      const promptState = buildPromptState(args);
      const r = await generateText({
        model,
        prompt: examinerSynthesisPrompt(args.transcript, promptState),
        temperature: 0.7,
        maxOutputTokens: 2000,
      });
      const json = safeJsonExtract(r.text) as Record<string, unknown> | null;
      if (!json) {
        return buildUnparseableOutcome(r.text, r.finishReason, r.usage);
      }
      return {
        status: 200,
        body: finalizeSynthesisJson(json, args.transcript, args.partialState),
      };
    } catch (err) {
      return buildThrowOutcome(err);
    }
  }
}

export const examinerSynthesisServiceInternals = {
  pickSynthesisModel,
  repairSynthesisJson,
  cleanStats,
  finalizeSynthesisJson,
  normalizeDetectedLanguage,
  applyStatsValidation,
  clampStartingClassId,
  buildUnparseableOutcome,
  buildThrowOutcome,
  buildPromptState,
  optionalLanguage,
  DEFAULT_SYNTHESIS_STATS,
  CLASS_SKILL_CHOICES,
};
