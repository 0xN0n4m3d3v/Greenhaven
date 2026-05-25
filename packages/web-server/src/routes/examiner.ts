/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 — thin Hono wiring for /api/character/sheet/synthesize.
// All synthesis business logic (model picker, prompt, JSON repair,
// stats validation, language normalization, class clamp) lives in
// ExaminerSynthesisService. This file only does request parsing,
// Zod validation, and response shaping.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ExaminerSynthesisService,
  SynthesizeArgs,
  type RouteOutcome,
} from '../services/ExaminerSynthesisService.js';

export const examinerRoutes = new Hono();

function respond(c: Context, outcome: RouteOutcome): Response {
  return c.json(
    outcome.body as Record<string, unknown>,
    outcome.status as ContentfulStatusCode,
  );
}

examinerRoutes.post('/character/sheet/synthesize', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = SynthesizeArgs.safeParse(body);
  if (!parsed.success) {
    console.warn(
      '[examiner] invalid args. body shape:',
      JSON.stringify({
        hasTranscript: Array.isArray(
          (body as Record<string, unknown>).transcript,
        ),
        len: Array.isArray((body as Record<string, unknown>).transcript)
          ? ((body as Record<string, unknown>).transcript as unknown[]).length
          : 0,
        first: Array.isArray((body as Record<string, unknown>).transcript)
          ? ((body as Record<string, unknown>).transcript as unknown[])[0]
          : null,
        issues: parsed.error.issues,
      }),
    );
    return c.json({ error: 'invalid args', issues: parsed.error.issues }, 400);
  }
  return respond(c, await ExaminerSynthesisService.synthesize(parsed.data));
});
