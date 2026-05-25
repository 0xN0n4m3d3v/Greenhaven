/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 36 §1 carried-over — mechanic-vocabulary i18n endpoint.
//
// GET /api/i18n/mechanic?lang=ru → {key: value} map of every
// (key, lang) pair, plus 'en' fallback when ru entry missing.
// Client (useMechI18n hook) caches indefinitely; restart server to
// pick up cartridge edits.

import {Hono} from 'hono';
import {MechanicI18nService} from '../services/MechanicI18nService.js';

export const mechanicI18nRoutes = new Hono();

mechanicI18nRoutes.get('/mechanic', async c => {
  return c.json(await MechanicI18nService.map(c.req.query('lang')));
});
