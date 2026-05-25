/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// /api/player/:id/profile        GET full profile, PATCH partial update.
// /api/character/suggest-*       AI-assist endpoints (broker model).
// /api/character/parse-freeform  paragraph → structured profile fields.
//
// ARCH-18 — thin Hono wiring. Business logic lives in ProfileService
// (profile read/patch) and CharacterAssistService (AI-assist methods +
// prompts + JSON fallback). safeJsonExtract / extractPolishedText now
// live in ../safeJson.ts so non-route consumers can import without
// a route-to-route dependency.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  Background,
  CharacterAssistService,
  Identity,
  ParseFreeformArgs,
  Physical,
  PolishDescriptionArgs,
  PolishHistoryArgs,
  SuggestAppearanceArgs,
  SuggestBackgroundArgs,
  SuggestSkillsArgs,
  type RouteOutcome,
} from '../services/CharacterAssistService.js';
import { ProfileService } from '../services/ProfileService.js';

export const profileRoutes = new Hono();

const nullToUndefined = (value: unknown) =>
  value === null ? undefined : value;

const optionalObject = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(nullToUndefined, schema.optional());

const optionalString = (max: number) =>
  z.preprocess(nullToUndefined, z.string().trim().max(max).optional());

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

const optionalNumberArray = (arrayMax = 200) =>
  z.preprocess((value) => {
    if (value == null) return undefined;
    if (!Array.isArray(value)) return value;
    return value
      .map((item) => {
        if (typeof item === 'number') return item;
        if (typeof item === 'string' && item.trim()) {
          const numeric = Number(item.trim());
          return Number.isFinite(numeric) ? numeric : null;
        }
        return null;
      })
      .filter((item): item is number => item != null)
      .slice(0, arrayMax);
  }, z.array(z.number().int()).optional());

const CreatorSheet = z.object({
  name: optionalString(120),
  description: optionalString(6000),
  history: optionalString(6000),
  rawDescription: optionalString(6000),
  rawHistory: optionalString(6000),
});

const ProfilePatch = z.object({
  identity: optionalObject(Identity),
  physical: optionalObject(Physical),
  background: optionalObject(Background),
  starting_class_id: optionalInt(),
  starting_inventory: optionalNumberArray(),
  created: z.boolean().optional(),
  examiner_transcript: z
    .array(
      z.object({
        q: z.string().max(500),
        qKey: z.string().max(80).optional(),
        a: z.string().max(2000),
      }),
    )
    .max(20)
    .optional(),
  creator_sheet: optionalObject(CreatorSheet),
  synthesized_class_overridden: z.boolean().optional(),
});

async function readBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

function respond(c: Context, outcome: RouteOutcome): Response {
  return c.json(
    outcome.body as Record<string, unknown>,
    outcome.status as ContentfulStatusCode,
  );
}

profileRoutes.get('/:id/profile', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ error: 'invalid id' }, 400);
  const profile = await ProfileService.get(id);
  if (!profile) return c.json({ error: 'unknown player' }, 404);
  return c.json({
    display_name: profile.display_name,
    profile: profile.profile,
  });
});

profileRoutes.patch('/:id/profile', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ error: 'invalid id' }, 400);
  const body = await readBody(c);
  const parsed = ProfilePatch.safeParse(body);
  if (!parsed.success) {
    console.warn(
      '[profile] invalid patch',
      JSON.stringify({
        playerId: id,
        keys:
          body && typeof body === 'object' && !Array.isArray(body)
            ? Object.keys(body as Record<string, unknown>)
            : [],
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    );
    return c.json(
      { error: 'invalid patch', issues: parsed.error.issues },
      400,
    );
  }

  const fresh = await ProfileService.patch(
    id,
    parsed.data as Record<string, unknown>,
  );
  if (!fresh) return c.json({ error: 'unknown player' }, 404);
  return c.json({ profile: fresh.profile });
});

// ── AI-assist endpoints ────────────────────────────────────────────────

profileRoutes.post('/character/suggest-appearance', async (c) => {
  const parsed = SuggestAppearanceArgs.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid args' }, 400);
  return respond(c, await CharacterAssistService.suggestAppearance(parsed.data));
});

profileRoutes.post('/character/suggest-background', async (c) => {
  const parsed = SuggestBackgroundArgs.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid args' }, 400);
  return respond(c, await CharacterAssistService.suggestBackground(parsed.data));
});

profileRoutes.post('/character/polish-description', async (c) => {
  const parsed = PolishDescriptionArgs.safeParse(await readBody(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid args', issues: parsed.error.issues }, 400);
  }
  return respond(c, await CharacterAssistService.polishDescription(parsed.data));
});

profileRoutes.post('/character/polish-history', async (c) => {
  const parsed = PolishHistoryArgs.safeParse(await readBody(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid args', issues: parsed.error.issues }, 400);
  }
  return respond(c, await CharacterAssistService.polishHistory(parsed.data));
});

profileRoutes.post('/character/suggest-skills', async (c) => {
  const parsed = SuggestSkillsArgs.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid args' }, 400);
  return respond(c, await CharacterAssistService.suggestSkills(parsed.data));
});

profileRoutes.post('/character/parse-freeform', async (c) => {
  const parsed = ParseFreeformArgs.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid args' }, 400);
  return respond(
    c,
    await CharacterAssistService.parseFreeform(parsed.data.paragraph),
  );
});
