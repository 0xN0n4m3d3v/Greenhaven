/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// /api/character/* — wizard-facing endpoints for stats + skills + class
// metadata. Spec 27 — see the spec body for the long contract.

import {Hono} from 'hono';
import {z} from 'zod';
import {type Ability} from '../character/skills.js';
import {resolveLanguage} from '../i18n.js';
import {CharacterService} from '../services/CharacterService.js';

export const characterRoutes = new Hono();

characterRoutes.get('/meta', c => c.json(CharacterService.meta()));

characterRoutes.get('/classes', async c => {
  const language = resolveLanguage({turnLang: c.req.query('language') ?? null});
  return c.json({classes: await CharacterService.listClasses(language)});
});

// GET /api/character/origins. BG3-style preset data seeded in
// cartridge_meta (migration 0048). Origin presets are data only; the
// unified character creator is the only profile creation flow.
characterRoutes.get('/origins', async c => {
  const language = resolveLanguage({turnLang: c.req.query('language') ?? null});
  return c.json({origins: await CharacterService.listOrigins(language)});
});

// Spec 32 §A.1 (audit follow-up) — bulk portrait_set + persona_slug
// fetch for all kind='person' entities. Bridge calls once on session
// bootstrap; App.tsx caches as a Map<id, {portrait_set, persona_slug,
// persona_hue, name}>. Any NPC bubble can then resolve its portrait
// without per-bubble fetches.
characterRoutes.get('/persons', async c => {
  return c.json({persons: await CharacterService.listPersons()});
});

characterRoutes.post('/roll-stats', c => {
  return c.json({scores: CharacterService.rollStats()});
});

const StatsApply = z.object({
  scores: z.object({
    STR: z.number().int().min(3).max(20),
    DEX: z.number().int().min(3).max(20),
    CON: z.number().int().min(3).max(20),
    INT: z.number().int().min(3).max(20),
    WIS: z.number().int().min(3).max(20),
    CHA: z.number().int().min(3).max(20),
  }),
  method: z.enum(['standard_array', 'point_buy', 'rolled']),
});

characterRoutes.post('/:id/stats', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({error: 'invalid id'}, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StatsApply.safeParse(body);
  if (!parsed.success) {
    return c.json({error: 'invalid stats', issues: parsed.error.issues}, 400);
  }

  const result = await CharacterService.applyStats(
    id,
    parsed.data.scores as Record<Ability, number>,
    parsed.data.method,
  );
  if (!result.ok) return c.json({error: result.error}, 400);
  return c.json({ok: true});
});

const SkillsApply = z.object({
  picks: z.array(z.string().max(40)).min(0).max(10),
});

characterRoutes.post('/:id/skills', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({error: 'invalid id'}, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = SkillsApply.safeParse(body);
  if (!parsed.success) return c.json({error: 'invalid skills'}, 400);

  const result = await CharacterService.applySkills(id, parsed.data.picks);
  if (!result.ok) return c.json({error: result.error}, 400);
  return c.json({ok: true});
});
