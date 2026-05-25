/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 — thin Hono wiring for /api/telemetry/{frontend,desktop}.
// Sanitization, batch limits, sink calls, and accepted-count
// accounting live in TelemetryIngestionService.
//
// DEEP-10 — both endpoints are rate-limited at 60 events / minute per
// source IP, with the `frontend` and `desktop` channels holding fully
// independent buckets (one channel cannot starve the other). Desktop
// builds bypass entirely: the only caller is loopback and we never
// want to drop oncall's only signal during a local incident.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {rateLimitTelemetryIngest} from '../middleware/rateLimit.js';
import {
  TelemetryIngestionService,
  type RouteOutcome,
} from '../services/TelemetryIngestionService.js';

export const telemetryRoutes = new Hono();

function respond(c: Context, outcome: RouteOutcome): Response {
  return c.json(
    outcome.body as Record<string, unknown>,
    outcome.status as ContentfulStatusCode,
  );
}

telemetryRoutes.post(
  '/frontend',
  rateLimitTelemetryIngest('frontend'),
  async (c) =>
    respond(
      c,
      await TelemetryIngestionService.ingestBatch(
        await c.req.json().catch(() => null),
        'frontend',
      ),
    ),
);

telemetryRoutes.post(
  '/desktop',
  rateLimitTelemetryIngest('desktop'),
  async (c) =>
    respond(
      c,
      await TelemetryIngestionService.ingestBatch(
        await c.req.json().catch(() => null),
        'desktop',
      ),
    ),
);
