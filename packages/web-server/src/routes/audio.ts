/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 37 §3 — ambient bed config endpoint.
//
// Client (useAmbientBed hook) fetches /api/audio/bed/:slug to pick up
// drone_url, room_tone_url, foley_pool, sting_pool, cross_fade_ms.

import {Hono} from 'hono';
import {AudioService} from '../services/AudioService.js';

export const audioRoutes = new Hono();

audioRoutes.get('/bed/:slug', async c => {
  const bed = await AudioService.bed(c.req.param('slug'));
  if (!bed) return c.json({error: 'unknown bed'}, 404);
  return c.json(bed);
});

audioRoutes.get('/beds', async c => {
  return c.json({beds: await AudioService.beds()});
});
