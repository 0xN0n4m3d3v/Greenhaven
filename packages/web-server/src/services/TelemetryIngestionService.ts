/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 — service ownership for /api/telemetry/{frontend,desktop}
// ingestion. Owns batch limits, payload sanitization, accepted-count
// accounting, and sink calls to telemetryLake + telemetryArtifacts.
// `buildBatch` is exposed via `telemetryIngestionServiceInternals`
// so sanitization can be tested deterministically without DB writes.

import {
  recordTelemetryEvent,
  recordTelemetryMetric,
  recordTelemetrySpan,
  type TelemetryRedactionTier,
} from '../telemetryLake.js';
import { indexTelemetryArtifactFile } from '../telemetryArtifacts.js';

export interface RouteOutcome {
  status: number;
  body: unknown;
}

export type TelemetrySource = 'frontend' | 'desktop';

const MAX_BATCH_ITEMS = 50;
const MAX_STRING = 1200;
const MAX_ARRAY = 50;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 5;

interface TelemetryContextShape {
  sessionId?: string | null;
  playerId?: number | null;
  turnId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  eventId?: number | null;
  releaseSeq?: number | null;
  installId?: string | null;
  buildId?: string | null;
  appVersion?: string | null;
}

interface PreparedBatch {
  events: Array<ReturnType<typeof sanitizeEvent> & object>;
  spans: Array<ReturnType<typeof sanitizeSpan> & object>;
  metrics: Array<ReturnType<typeof sanitizeMetric> & object>;
  artifacts: Array<ReturnType<typeof sanitizeArtifact> & object>;
  accepted: number;
}

type BatchResult = { ok: false } | ({ ok: true } & PreparedBatch);

function buildBatch(body: unknown, source: TelemetrySource): BatchResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false };
  }
  const payload = body as Record<string, unknown>;
  const context = sanitizeContext(payload['context']);
  const eventsRaw = asArray(payload['events']).slice(0, MAX_BATCH_ITEMS);
  const spansRaw = asArray(payload['spans']).slice(0, MAX_BATCH_ITEMS);
  const metricsRaw = asArray(payload['metrics']).slice(0, MAX_BATCH_ITEMS);
  const artifactsRaw = asArray(payload['artifacts']).slice(0, MAX_BATCH_ITEMS);

  const events: PreparedBatch['events'] = [];
  for (const item of eventsRaw) {
    const event = sanitizeEvent(item, context, source);
    if (event) events.push(event);
  }
  const spans: PreparedBatch['spans'] = [];
  for (const item of spansRaw) {
    const span = sanitizeSpan(item, context, source);
    if (span) spans.push(span);
  }
  const metrics: PreparedBatch['metrics'] = [];
  for (const item of metricsRaw) {
    const metric = sanitizeMetric(item, context, source);
    if (metric) metrics.push(metric);
  }
  const artifacts: PreparedBatch['artifacts'] = [];
  for (const item of artifactsRaw) {
    const artifact = sanitizeArtifact(item, context, source);
    if (artifact) artifacts.push(artifact);
  }
  const accepted =
    events.length + spans.length + metrics.length + artifacts.length;
  return { ok: true, events, spans, metrics, artifacts, accepted };
}

export class TelemetryIngestionService {
  static async ingestBatch(
    body: unknown,
    source: TelemetrySource,
  ): Promise<RouteOutcome> {
    const prepared = buildBatch(body, source);
    if (!prepared.ok) {
      return {
        status: 400,
        body: { error: 'invalid_telemetry_payload' },
      };
    }
    for (const event of prepared.events) {
      await recordTelemetryEvent(event);
    }
    for (const span of prepared.spans) {
      await recordTelemetrySpan(span);
    }
    for (const metric of prepared.metrics) {
      await recordTelemetryMetric(metric);
    }
    for (const artifact of prepared.artifacts) {
      await indexTelemetryArtifactFile(artifact);
    }
    return { status: 200, body: { ok: true, accepted: prepared.accepted } };
  }
}

function sanitizeContext(value: unknown): TelemetryContextShape {
  const obj =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return {
    sessionId: cleanString(obj['sessionId'], 240),
    playerId: cleanInt(obj['playerId']),
    turnId: cleanString(obj['turnId'], 240),
    traceId: cleanString(obj['traceId'], 240),
    spanId: cleanString(obj['spanId'], 240),
    eventId: cleanInt(obj['eventId']),
    releaseSeq: cleanInt(obj['releaseSeq']),
    installId: cleanString(obj['installId'], 240),
    buildId: cleanString(obj['buildId'], 240),
    appVersion: cleanString(obj['appVersion'], 120),
  };
}

function sanitizeEvent(
  value: unknown,
  context: TelemetryContextShape,
  source: TelemetrySource,
) {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const eventName = cleanString(obj['eventName'], 160);
  if (!eventName) return null;
  return {
    ...context,
    traceId: cleanString(obj['traceId'], 240) ?? context.traceId,
    spanId: cleanString(obj['spanId'], 240) ?? context.spanId,
    turnId: cleanString(obj['turnId'], 240) ?? context.turnId,
    eventId: cleanInt(obj['eventId']) ?? context.eventId,
    releaseSeq: cleanInt(obj['releaseSeq']) ?? context.releaseSeq,
    schemaName: cleanString(obj['schemaName'], 160) ?? `${source}.${eventName}`,
    schemaVersion: cleanInt(obj['schemaVersion']) ?? 1,
    category: cleanString(obj['category'], 80) ?? source,
    eventName,
    severity: cleanSeverity(obj['severity']),
    occurredAt: cleanString(obj['occurredAt'], 80),
    properties: sanitizeJsonObject(obj['properties']),
    redactionTier:
      cleanRedactionTier(obj['redactionTier']) ?? 'tier1_local_debug',
    validationStatus: 'valid',
    source,
  };
}

function sanitizeSpan(
  value: unknown,
  context: TelemetryContextShape,
  source: TelemetrySource,
) {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const name = cleanString(obj['name'], 200);
  if (!name) return null;
  return {
    ...context,
    traceId: cleanString(obj['traceId'], 240) ?? context.traceId,
    spanId: cleanString(obj['spanId'], 240) ?? context.spanId,
    turnId: cleanString(obj['turnId'], 240) ?? context.turnId,
    eventId: cleanInt(obj['eventId']) ?? context.eventId,
    releaseSeq: cleanInt(obj['releaseSeq']) ?? context.releaseSeq,
    name,
    kind: cleanString(obj['kind'], 60) ?? 'internal',
    status: cleanString(obj['status'], 60) ?? 'ok',
    startedAt: cleanString(obj['startedAt'], 80),
    endedAt: cleanString(obj['endedAt'], 80),
    durationMs: cleanInt(obj['durationMs']),
    attributes: sanitizeJsonObject(obj['attributes']),
    error: cleanString(obj['error'], MAX_STRING),
    redactionTier:
      cleanRedactionTier(obj['redactionTier']) ?? 'tier1_local_debug',
    source,
  };
}

function sanitizeMetric(
  value: unknown,
  context: TelemetryContextShape,
  source: TelemetrySource,
) {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const name = cleanString(obj['name'], 200);
  if (!name) return null;
  return {
    ...context,
    traceId: cleanString(obj['traceId'], 240) ?? context.traceId,
    turnId: cleanString(obj['turnId'], 240) ?? context.turnId,
    name,
    unit: cleanString(obj['unit'], 40),
    aggregation: cleanString(obj['aggregation'], 40) ?? 'raw',
    bucketStart: cleanString(obj['bucketStart'], 80),
    count: cleanInt(obj['count']) ?? 1,
    sum: cleanNumber(obj['sum']),
    min: cleanNumber(obj['min']),
    max: cleanNumber(obj['max']),
    p50: cleanNumber(obj['p50']),
    p95: cleanNumber(obj['p95']),
    p99: cleanNumber(obj['p99']),
    attributes: sanitizeJsonObject(obj['attributes']),
    source,
  };
}

function sanitizeArtifact(
  value: unknown,
  context: TelemetryContextShape,
  source: TelemetrySource,
) {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const artifactType = cleanString(obj['artifactType'], 120);
  const artifactPath = cleanString(obj['path'], 2000);
  if (!artifactType || !artifactPath) return null;
  return {
    ...context,
    traceId: cleanString(obj['traceId'], 240) ?? context.traceId,
    spanId: cleanString(obj['spanId'], 240) ?? context.spanId,
    turnId: cleanString(obj['turnId'], 240) ?? context.turnId,
    artifactType,
    path: artifactPath,
    sizeBytes: cleanInt(obj['sizeBytes']),
    sha256: cleanString(obj['sha256'], 128),
    mimeType: cleanString(obj['mimeType'], 120),
    startedAt: cleanString(obj['startedAt'], 80),
    endedAt: cleanString(obj['endedAt'], 80),
    redactionTier:
      cleanRedactionTier(obj['redactionTier']) ?? 'tier1_local_debug',
    metadata: sanitizeJsonObject(obj['metadata']),
    source,
  };
}

function sanitizeJsonObject(value: unknown): Record<string, unknown> {
  const cleaned = sanitizeJson(value, 0);
  return cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)
    ? (cleaned as Record<string, unknown>)
    : {};
}

function sanitizeJson(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[max_depth]';
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitizeJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(
      0,
      MAX_OBJECT_KEYS,
    )) {
      out[key.slice(0, 160)] = sanitizeJson(nested, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, max)
    : null;
}

function cleanInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function cleanNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanSeverity(value: unknown): string {
  const severity = cleanString(value, 20);
  return severity === 'debug' ||
    severity === 'info' ||
    severity === 'warn' ||
    severity === 'error' ||
    severity === 'fatal'
    ? severity
    : 'info';
}

function cleanRedactionTier(value: unknown): TelemetryRedactionTier | null {
  return value === 'tier0_safe' ||
    value === 'tier1_local_debug' ||
    value === 'tier2_sensitive_local'
    ? value
    : null;
}

export const telemetryIngestionServiceInternals = {
  buildBatch,
  sanitizeContext,
  sanitizeEvent,
  sanitizeSpan,
  sanitizeMetric,
  sanitizeArtifact,
  sanitizeJson,
  sanitizeJsonObject,
  cleanString,
  cleanInt,
  cleanNumber,
  cleanSeverity,
  cleanRedactionTier,
  MAX_BATCH_ITEMS,
  MAX_STRING,
  MAX_ARRAY,
  MAX_OBJECT_KEYS,
  MAX_DEPTH,
};
