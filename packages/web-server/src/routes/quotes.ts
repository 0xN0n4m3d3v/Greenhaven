/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 37 §8 — Pillars-style mid-load quote pool.
//
// GET /api/quotes?tags=tavern,combat → returns quotes whose scene_tags
// overlap (or empty scene_tags = always-eligible). Client picks one
// weighted random, looks up text via mechanicI18n.tMech.

import {Hono} from 'hono';
import {parseQuoteTags, QuoteService} from '../services/QuoteService.js';

export const quotesRoutes = new Hono();

quotesRoutes.get('/quotes/inspirational', async c => {
  return c.json({
    quote: await QuoteService.inspirationalQuote(
      c.req.query('language'),
      parseQuoteTags(c.req.query('tags')),
    ),
  });
});

quotesRoutes.get('/quotes', async c => {
  return c.json({
    quotes: await QuoteService.quotes(parseQuoteTags(c.req.query('tags'))),
  });
});
