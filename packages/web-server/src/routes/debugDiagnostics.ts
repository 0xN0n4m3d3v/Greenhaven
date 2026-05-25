/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 thin Hono layer for debug diagnostics + admin usage. All
// business logic lives in DebugDiagnosticsService. Route handlers
// extract primitive inputs from query/body/header/params, call the
// service, and shape the response.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  DebugDiagnosticsService,
  type RouteOutcome,
} from '../services/DebugDiagnosticsService.js';

export const debugDiagnosticsRoutes = new Hono();

async function readJsonObjectBody(
  c: Context,
): Promise<Record<string, unknown>> {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) {
    return {};
  }
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function boolParam(
  c: Context,
  body: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const raw = c.req.query(name) ?? body[name];
  if (raw === true || raw === '1' || raw === 'true') return true;
  if (raw === false || raw === '0' || raw === 'false') return false;
  return undefined;
}

function numParam(
  c: Context,
  body: Record<string, unknown>,
  name: string,
): number | undefined {
  const raw = c.req.query(name) ?? body[name];
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function strParam(
  c: Context,
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const raw = c.req.query(name) ?? body[name];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

function respond(c: Context, outcome: RouteOutcome): Response {
  return c.json(
    outcome.body as Record<string, unknown>,
    outcome.status as ContentfulStatusCode,
  );
}

function sinceOpts(c: Context, defaultLimit: number): {
  minutes: number;
  since: string | null;
  limit: number;
} {
  return {
    minutes: Number(c.req.query('minutes') ?? 60),
    since: c.req.query('since') ?? null,
    limit: Number(c.req.query('limit') ?? defaultLimit),
  };
}

debugDiagnosticsRoutes.get('/debug/perf', async (c) =>
  respond(c, await DebugDiagnosticsService.getPerf(sinceOpts(c, 20))),
);

debugDiagnosticsRoutes.get('/debug/perf/hotspots', async (c) =>
  respond(c, await DebugDiagnosticsService.getPerfHotspots(sinceOpts(c, 30))),
);

debugDiagnosticsRoutes.get('/debug/perf/failures', async (c) =>
  respond(c, await DebugDiagnosticsService.getPerfFailures(sinceOpts(c, 50))),
);

debugDiagnosticsRoutes.get('/debug/perf/turn/:turnId', async (c) =>
  respond(c, await DebugDiagnosticsService.getPerfTurn(c.req.param('turnId'))),
);

debugDiagnosticsRoutes.get('/debug/telemetry/summary', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getTelemetrySummary(sinceOpts(c, 30)),
  ),
);

debugDiagnosticsRoutes.get('/debug/telemetry/health', async (c) =>
  respond(c, await DebugDiagnosticsService.getTelemetryHealth(sinceOpts(c, 0))),
);

debugDiagnosticsRoutes.get('/debug/telemetry/errors', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getTelemetryErrors(sinceOpts(c, 50)),
  ),
);

debugDiagnosticsRoutes.get('/debug/telemetry/quality', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getTelemetryQuality(sinceOpts(c, 50)),
  ),
);

debugDiagnosticsRoutes.get('/debug/telemetry/trace/:traceId', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getTelemetryTrace(c.req.param('traceId')),
  ),
);

debugDiagnosticsRoutes.get('/debug/telemetry/turn/:turnId', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getTelemetryTurn(c.req.param('turnId')),
  ),
);

debugDiagnosticsRoutes.post('/debug/telemetry/bundle', async (c) => {
  const body = await readJsonObjectBody(c);
  return respond(
    c,
    await DebugDiagnosticsService.postTelemetryBundle({
      since: strParam(c, body, 'since') ?? null,
      minutes: numParam(c, body, 'minutes'),
      limit: numParam(c, body, 'limit'),
      traceLimit: numParam(c, body, 'traceLimit'),
      persist:
        c.req.query('persist') === '1' ||
        c.req.query('write') === '1' ||
        body['persist'] === true ||
        body['write'] === true,
    }),
  );
});

debugDiagnosticsRoutes.post('/debug/telemetry/retention', async (c) => {
  const body = await readJsonObjectBody(c);
  return respond(
    c,
    await DebugDiagnosticsService.postTelemetryRetention({
      safeDays: numParam(c, body, 'safeDays'),
      debugDays: numParam(c, body, 'debugDays'),
      sensitiveDays: numParam(c, body, 'sensitiveDays'),
      metricDays: numParam(c, body, 'metricDays'),
      performanceDays: numParam(c, body, 'performanceDays'),
      artifactDays: numParam(c, body, 'artifactDays'),
      maxArtifactBytes: numParam(c, body, 'maxArtifactBytes'),
      dryRun:
        boolParam(c, body, 'dryRun') ?? boolParam(c, body, 'dry') ?? false,
    }),
  );
});

debugDiagnosticsRoutes.post('/debug/telemetry/developer-export', async (c) => {
  const body = await readJsonObjectBody(c);
  const rawFormats =
    c.req.queries('format') ??
    (Array.isArray(body['formats'])
      ? body['formats']
      : typeof body['format'] === 'string'
        ? [body['format']]
        : undefined);
  const formats = rawFormats
    ?.map((format) => String(format))
    .filter((format) => format === 'jsonl' || format === 'otlp') as
    | Array<'jsonl' | 'otlp'>
    | undefined;
  return respond(
    c,
    await DebugDiagnosticsService.postTelemetryDeveloperExport({
      since: strParam(c, body, 'since') ?? null,
      minutes: numParam(c, body, 'minutes'),
      limit: numParam(c, body, 'limit'),
      formats,
      write:
        boolParam(c, body, 'write') ?? boolParam(c, body, 'persist') ?? false,
      postOtlp:
        boolParam(c, body, 'postOtlp') ?? boolParam(c, body, 'post') ?? false,
      otlpEndpoint: strParam(c, body, 'otlpEndpoint') ?? null,
      allowRemote: boolParam(c, body, 'allowRemote') ?? false,
    }),
  );
});

debugDiagnosticsRoutes.get('/debug/session-messages-diag', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getSessionMessagesDiag({
      sessionId: c.req.query('sessionId') ?? null,
      limit: numParam(c, {}, 'limit'),
    }),
  ),
);

debugDiagnosticsRoutes.get('/debug/recent-entities', async (c) =>
  respond(c, await DebugDiagnosticsService.getRecentEntities()),
);

debugDiagnosticsRoutes.get('/debug/tools', async (c) =>
  respond(c, await DebugDiagnosticsService.getTools()),
);

debugDiagnosticsRoutes.get('/debug/live-state', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getLiveState({
      playerId: numParam(c, {}, 'playerId'),
      sessionId: c.req.query('sessionId') ?? null,
      limit: numParam(c, {}, 'limit'),
    }),
  ),
);

debugDiagnosticsRoutes.post('/debug/live-ops', async (c) => {
  const body = await readJsonObjectBody(c);
  return respond(
    c,
    await DebugDiagnosticsService.postLiveOps({
      playerId: numParam(c, body, 'playerId'),
      sessionId: strParam(c, body, 'sessionId') ?? null,
      limit: numParam(c, body, 'limit'),
      ops: Array.isArray(body['ops']) ? (body['ops'] as unknown[]) : [],
    }),
  );
});

debugDiagnosticsRoutes.post('/debug/live-preset', async (c) => {
  const body = await readJsonObjectBody(c);
  return respond(
    c,
    await DebugDiagnosticsService.postLivePreset({
      playerId: numParam(c, body, 'playerId'),
      sessionId: strParam(c, body, 'sessionId') ?? null,
      limit: numParam(c, body, 'limit'),
      preset: strParam(c, body, 'preset') ?? null,
      options: body['options'],
    }),
  );
});

debugDiagnosticsRoutes.get('/debug/session-diag', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getSessionDiag({
      date: c.req.query('date') ?? null,
    }),
  ),
);

debugDiagnosticsRoutes.get('/debug/cost', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getCost({
      since: c.req.query('since') ?? null,
    }),
  ),
);

debugDiagnosticsRoutes.get('/admin/usage', async (c) =>
  respond(
    c,
    await DebugDiagnosticsService.getAdminUsage({
      adminKeyHeader: c.req.header('x-admin-key') ?? null,
      since: c.req.query('since') ?? null,
      playerId: numParam(c, {}, 'playerId'),
    }),
  ),
);
