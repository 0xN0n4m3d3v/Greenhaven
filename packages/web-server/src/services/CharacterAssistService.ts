/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 — service ownership for the character-creation AI assists
// (suggest-appearance/background/skills, polish-description/history,
// parse-freeform). Prompts and model invocation live here; the route
// only validates input and shapes responses.

import { generateText } from 'ai';
import { z } from 'zod';
import { errorOutcome as makeErrorOutcome } from '../httpErrors.js';
import {
  polishCharacterDescriptionPrompt,
  polishCharacterHistoryPrompt,
} from '../ai/characterSheetPrompt.js';
import { buildProviders } from '../ai/providers.js';
import { extractPolishedText, safeJsonExtract } from '../safeJson.js';

export interface RouteOutcome {
  status: number;
  body: unknown;
}

const nullToUndefined = (value: unknown) =>
  value === null ? undefined : value;

const optionalString = (max: number) =>
  z.preprocess(nullToUndefined, z.string().trim().max(max).optional());

const optionalLanguage = z.preprocess(
  (value) => (value == null || value === '' ? undefined : value),
  z.string().min(2).max(16).optional(),
);

const optionalInt = (min?: number, max?: number) =>
  z.preprocess(
    (value) => {
      if (value == null || value === '') return undefined;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const numeric = Number(trimmed);
        return Number.isFinite(numeric) ? numeric : value;
      }
      return value;
    },
    z
      .number()
      .int()
      .min(min ?? Number.MIN_SAFE_INTEGER)
      .max(max ?? Number.MAX_SAFE_INTEGER)
      .optional(),
  );

const optionalStringArray = (itemMax: number, arrayMax: number) =>
  z.preprocess((value) => {
    if (value == null) return undefined;
    if (!Array.isArray(value)) return value;
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, arrayMax);
  }, z.array(z.string().max(itemMax)).max(arrayMax).optional());

export const Identity = z.object({
  // Spec 38 — display name surfaced to NPCs (also written to
  // entities.display_name by the PATCH handler when present).
  name: optionalString(120),
  pronouns: optionalString(40),
  gender_expression: optionalString(120),
  race: optionalString(60),
  anatomy: optionalString(400),
  attractions: optionalString(200),
  age: optionalInt(18, 10000),
});

export const Physical = z.object({
  build: optionalString(200),
  voice: optionalString(200),
  skin: optionalString(200),
  hair: optionalString(200),
  eyes: optionalString(200),
  distinguishing_marks: optionalString(400),
});

export const Background = z.object({
  origin_paragraph: optionalString(6000),
  motivation: optionalString(200),
  temperament: optionalString(160),
  notable_skills: optionalStringArray(120, 10),
});

export const SuggestAppearanceArgs = z.object({
  identity: Identity.optional(),
  partial_physical: Physical.optional(),
  free_text: z.string().max(400).optional(),
});

export const SuggestBackgroundArgs = z.object({
  identity: Identity.optional(),
  physical: Physical.optional(),
  partial_background: Background.optional(),
  starting_class_id: z.number().int().optional(),
});

export const PolishDescriptionArgs = z.object({
  name: z.string().max(120).optional(),
  description: z.string().min(1).max(6000),
  history: z.string().max(6000).optional(),
  language: optionalLanguage,
});

export const PolishHistoryArgs = z
  .object({
    name: z.string().max(120).optional(),
    description: z.string().max(6000).optional(),
    history: z.string().max(6000).optional(),
    language: optionalLanguage,
  })
  .refine(
    (value) =>
      Boolean(value.description?.trim()) || Boolean(value.history?.trim()),
    { message: 'description or history required' },
  );

export const SuggestSkillsArgs = z.object({
  identity: Identity.optional(),
  physical: Physical.optional(),
  background: Background,
  starting_class_id: z.number().int().optional(),
  allowed_skills: z.array(z.string()).optional(),
  count: z.number().int().min(1).max(8).default(4),
});

export const ParseFreeformArgs = z.object({
  paragraph: z.string().min(20).max(4000),
});

function appearancePrompt(a: z.infer<typeof SuggestAppearanceArgs>): string {
  const id = a.identity ?? {};
  const phys = a.partial_physical ?? {};
  const idLines = [
    `pronouns: ${id.pronouns ?? '<unspecified>'}`,
    `gender_expression: ${id.gender_expression ?? '<unspecified>'}`,
    `race: ${id.race ?? '<unspecified>'}`,
    `anatomy: ${id.anatomy ?? '<unspecified>'}`,
    `attractions: ${id.attractions ?? '<unspecified>'}`,
    `age: ${id.age != null ? String(id.age) : '<unspecified>'}`,
  ].join('\n  ');
  const lockedLines = Object.entries(phys)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: "${v}"`);
  return `You are helping a player create a hero for the 21+ adult RPG Greenhaven (post-steampunk world with succubus ancestry).
Suggest a vivid, concrete physical appearance whose every detail is GROUNDED in the identity below. Output ONE JSON object:
{ "build": "...", "voice": "...", "skin": "...", "hair": "...", "eyes": "...", "distinguishing_marks": "..." }

Identity (use ALL fields — anatomy informs build, attractions inform body language, age informs wear-and-tear, race informs skin / horns / eyes):
  ${idLines}

Free-text hint from player: ${a.free_text ?? '<none>'}

${lockedLines.length > 0 ? `LOCKED — keep these fields verbatim, only fill the missing ones:\n  ${lockedLines.join('\n  ')}\n\n` : ''}Rules:
- Every distinguishing_mark must trace to identity (e.g., a Tiefling has horn shape; succubus heritage shows in eye-glint or skin-warmth).
- "anatomy" trumps "gender_expression" for body shape (a feminine Tiefling with intersex anatomy must read as such in the build line).
- Don't invent backstory; stay physical.
- Each field 1-2 sentences, specific (measurements, textures, scents OK).
Output JSON only, no markdown fences.`;
}

function backgroundPrompt(a: z.infer<typeof SuggestBackgroundArgs>): string {
  const id = a.identity ?? {};
  const phys = a.physical ?? {};
  const bg = a.partial_background ?? {};
  const idLines = [
    `pronouns: ${id.pronouns ?? '<unspecified>'}`,
    `race: ${id.race ?? '<unspecified>'}`,
    `gender_expression: ${id.gender_expression ?? '<unspecified>'}`,
    `attractions: ${id.attractions ?? '<unspecified>'}`,
    `age: ${id.age != null ? String(id.age) : '<unspecified>'}`,
  ].join('\n  ');
  const physLines = [
    `build: ${phys.build ?? '<unspecified>'}`,
    `voice: ${phys.voice ?? '<unspecified>'}`,
    `distinguishing_marks: ${phys.distinguishing_marks ?? '<unspecified>'}`,
  ].join('\n  ');
  const bgLocked = Object.entries(bg)
    .filter(
      ([, v]) =>
        v != null &&
        (typeof v !== 'string' || v.trim() !== '') &&
        (!Array.isArray(v) || v.length > 0),
    )
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `You are helping create a hero for Greenhaven (21+ post-steampunk RPG, world has succubus ancestry).
Generate a personal history that USES the identity + body the player has already chosen. Output ONE JSON object:
{ "origin_paragraph": "<2-4 paragraph personal history>", "motivation": "<one-sentence current drive>", "temperament": "<3-5 adjectives>", "notable_skills": ["..."] }

Identity:
  ${idLines}

Physical (the body shaped events; let it):
  ${physLines}

starting_class_id: ${a.starting_class_id ?? '<unspecified>'}
${bgLocked.length > 0 ? `\nLOCKED — keep these fields verbatim, only fill missing ones:\n  ${bgLocked.join('\n  ')}\n` : ''}
Rules:
- The origin must EXPLAIN how this body + identity came to be. A 28-year-old Tiefling charmer's history is different from a 60-year-old human veteran's.
- Reference Greenhaven specifics: portals, post-industrial revolution, succubus heritage themes if the race + attractions support it.
- notable_skills should be 3-5 skills/talents the history would actually grant (used by the Skills step).
- Don't invent stats — those come later.
Output JSON only.`;
}

function skillsPrompt(a: z.infer<typeof SuggestSkillsArgs>): string {
  const id = a.identity ?? {};
  const phys = a.physical ?? {};
  const allowed =
    a.allowed_skills && a.allowed_skills.length > 0
      ? `Pick ONLY from this class-allowed list: ${a.allowed_skills.join(', ')}.`
      : 'Pick from any of the 18 D&D 5e skills.';
  return `You are picking D&D 5e skill proficiencies for a hero. The pick must trace through identity → body → background → class — every chosen skill should have a concrete rationale grounded in the player's earlier choices.

The 18 D&D 5e skills (tied ability):
  STR: Athletics
  DEX: Acrobatics, Sleight of Hand, Stealth
  INT: Arcana, History, Investigation, Nature, Religion
  WIS: Animal Handling, Insight, Medicine, Perception, Survival
  CHA: Deception, Intimidation, Performance, Persuasion

Identity:
  pronouns: ${id.pronouns ?? '<unspecified>'}
  race: ${id.race ?? '<unspecified>'}
  attractions: ${id.attractions ?? '<unspecified>'}
  age: ${id.age != null ? String(id.age) : '<unspecified>'}

Physical:
  build: ${phys.build ?? '<unspecified>'}
  distinguishing_marks: ${phys.distinguishing_marks ?? '<unspecified>'}

Background:
  origin_paragraph: ${a.background.origin_paragraph ?? '<none>'}
  motivation: ${a.background.motivation ?? '<none>'}
  temperament: ${a.background.temperament ?? '<none>'}
  notable_skills mentioned: ${(a.background.notable_skills ?? []).join('; ') || '<none>'}

Class id: ${a.starting_class_id ?? '<unspecified>'}
${allowed}

Pick ${a.count} skills. For each, rationale must reference a SPECIFIC source — not "fits the class" but "the origin says they grew up running rooftops → Acrobatics".

Output JSON:
{ "picks": [
  {"skill": "Stealth", "rationale": "background: 'lived as a runaway' → moves unseen by habit"},
  ...
] }
Output JSON only.`;
}

function parsePrompt(p: string): string {
  return `Parse a freeform character description into structured Greenhaven profile fields. Extract whatever the text supports — leave fields null when absent.
Output JSON:
{
  "identity": {"pronouns": "...", "gender_expression": "...", "race": "...", "anatomy": "...", "attractions": "...", "age": ...},
  "physical": {"build": "...", "voice": "...", "skin": "...", "hair": "...", "eyes": "...", "distinguishing_marks": "..."},
  "background": {"origin_paragraph": "...", "motivation": "...", "temperament": "...", "notable_skills": [...]}
}

Description:
"""${p.slice(0, 3500)}"""

Output JSON only. Do not invent details the description doesn't support.`;
}

function buildJsonOrRawResponse(rawText: string): RouteOutcome {
  const json = safeJsonExtract(rawText);
  return {
    status: 200,
    body: (json as Record<string, unknown> | null) ?? { raw: rawText },
  };
}

function buildPolishedResponse(
  rawText: string,
  fallback: string,
): RouteOutcome {
  const text = extractPolishedText(rawText);
  return { status: 200, body: { text: text || fallback } };
}

function errorOutcome(err: unknown): RouteOutcome {
  // SEC-3 / DEEP-7 — opaque body + correlation id; full error
  // captured via `http.error` telemetry + console.error.
  return makeErrorOutcome(500, 'character_assist_failed', {internal: err});
}

export class CharacterAssistService {
  static async suggestAppearance(
    args: z.infer<typeof SuggestAppearanceArgs>,
  ): Promise<RouteOutcome> {
    try {
      const providers = buildProviders();
      const r = await generateText({
        model: providers.broker,
        prompt: appearancePrompt(args),
        temperature: 0.8,
        maxOutputTokens: 600,
      });
      return buildJsonOrRawResponse(r.text);
    } catch (err) {
      return errorOutcome(err);
    }
  }

  static async suggestBackground(
    args: z.infer<typeof SuggestBackgroundArgs>,
  ): Promise<RouteOutcome> {
    try {
      const providers = buildProviders();
      const r = await generateText({
        model: providers.broker,
        prompt: backgroundPrompt(args),
        temperature: 0.85,
        maxOutputTokens: 600,
      });
      return buildJsonOrRawResponse(r.text);
    } catch (err) {
      return errorOutcome(err);
    }
  }

  static async polishDescription(
    args: z.infer<typeof PolishDescriptionArgs>,
  ): Promise<RouteOutcome> {
    try {
      const providers = buildProviders();
      const r = await generateText({
        model: providers.broker,
        prompt: polishCharacterDescriptionPrompt(args),
        temperature: 0.7,
        maxOutputTokens: 1000,
      });
      return buildPolishedResponse(r.text, args.description);
    } catch (err) {
      return errorOutcome(err);
    }
  }

  static async polishHistory(
    args: z.infer<typeof PolishHistoryArgs>,
  ): Promise<RouteOutcome> {
    try {
      const providers = buildProviders();
      const r = await generateText({
        model: providers.broker,
        prompt: polishCharacterHistoryPrompt(args),
        temperature: 0.75,
        maxOutputTokens: 1200,
      });
      return buildPolishedResponse(r.text, args.history || '');
    } catch (err) {
      return errorOutcome(err);
    }
  }

  static async suggestSkills(
    args: z.infer<typeof SuggestSkillsArgs>,
  ): Promise<RouteOutcome> {
    try {
      const providers = buildProviders();
      const r = await generateText({
        model: providers.broker,
        prompt: skillsPrompt(args),
        temperature: 0.4,
        maxOutputTokens: 400,
      });
      return buildJsonOrRawResponse(r.text);
    } catch (err) {
      return errorOutcome(err);
    }
  }

  static async parseFreeform(paragraph: string): Promise<RouteOutcome> {
    try {
      const providers = buildProviders();
      const r = await generateText({
        model: providers.broker,
        prompt: parsePrompt(paragraph),
        temperature: 0.2,
        maxOutputTokens: 800,
      });
      return buildJsonOrRawResponse(r.text);
    } catch (err) {
      return errorOutcome(err);
    }
  }
}

export const characterAssistServiceInternals = {
  appearancePrompt,
  backgroundPrompt,
  skillsPrompt,
  parsePrompt,
  buildJsonOrRawResponse,
  buildPolishedResponse,
  errorOutcome,
  optionalLanguage,
};
