/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import {
  writeTelemetryJsonArtifact,
  writeTelemetryTextArtifact,
  type TelemetryArtifactFile,
} from '../telemetryArtifacts.js';
import { sinceIso } from './telemetryDiagnostics.js';

export type TelemetryDeveloperExportFormat = 'jsonl' | 'otlp';

export interface TelemetryDeveloperExportOptions {
  since?: string;
  minutes?: number;
  limit?: number;
  formats?: TelemetryDeveloperExportFormat[];
  write?: boolean;
  postOtlp?: boolean;
  otlpEndpoint?: string | null;
  allowRemote?: boolean;
}

export interface TelemetryDeveloperExportResult {
  ok: boolean;
  since: string;
  limits: { rows: number };
  formats: TelemetryDeveloperExportFormat[];
  counts: Record<string, number>;
  files: TelemetryArtifactFile[];
  otlp_post?: {
    skipped?: string;
    endpoint?: string;
    traces?: number;
    logs?: number;
    metrics?: number;
    errors?: Array<{ target: string; status?: number; error?: string }>;
  };
}

type SpanRow = {
  id: number | string;
  recorded_at: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  session_id: string | null;
  player_id: number | string | null;
  turn_id: string | null;
  event_id: number | string | null;
  release_seq: number | string | null;
  name: string;
  kind: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | string | null;
  attributes: Record<string, unknown> | null;
  events: unknown[] | null;
  links: unknown[] | null;
  error: string | null;
  redaction_tier: string;
  source: string;
};

type EventRow = {
  id: number | string;
  occurred_at: string;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
  player_id: number | string | null;
  turn_id: string | null;
  event_id: number | string | null;
  release_seq: number | string | null;
  schema_name: string;
  schema_version: number | string;
  category: string;
  event_name: string;
  severity: string;
  properties: Record<string, unknown> | null;
  redaction_tier: string;
  validation_status: string;
  source: string;
};

type MetricRow = {
  id: number | string;
  bucket_start: string;
  trace_id: string | null;
  session_id: string | null;
  player_id: number | string | null;
  turn_id: string | null;
  name: string;
  unit: string | null;
  aggregation: string;
  count: number | string;
  sum: number | string | null;
  min: number | string | null;
  max: number | string | null;
  p50: number | string | null;
  p95: number | string | null;
  p99: number | string | null;
  attributes: Record<string, unknown> | null;
  source: string;
};

type ArtifactRow = {
  id: number | string;
  recorded_at: string;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
  player_id: number | string | null;
  turn_id: string | null;
  artifact_type: string;
  path: string;
  size_bytes: number | string | null;
  sha256: string | null;
  mime_type: string | null;
  redaction_tier: string;
  metadata: Record<string, unknown> | null;
  source: string;
};

type EvalRow = {
  id: number | string;
  recorded_at: string;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
  player_id: number | string | null;
  turn_id: string | null;
  evaluator_id: string;
  evaluator_version: string | null;
  score: number | string | null;
  label: string | null;
  reason: string | null;
  reviewed: boolean;
  metadata: Record<string, unknown> | null;
  source: string;
};

interface ExportRows {
  spans: SpanRow[];
  events: EventRow[];
  metrics: MetricRow[];
  artifacts: ArtifactRow[];
  eval_scores: EvalRow[];
}

export async function buildTelemetryDeveloperExport(
  opts: TelemetryDeveloperExportOptions = {},
): Promise<TelemetryDeveloperExportResult> {
  const since = opts.since ?? sinceIso(opts.minutes ?? 60);
  const limit = clampLimit(opts.limit ?? 1000);
  const formats = normalizeFormats(opts.formats);
  const rows = await loadExportRows({ since, limit });
  const files: TelemetryArtifactFile[] = [];

  if (opts.write === true) {
    if (formats.includes('jsonl')) {
      files.push(await writeJsonlExport(rows, since));
    }
    if (formats.includes('otlp')) {
      files.push(await writeOtlpExport(rows, since));
    }
  }

  const cfg = config();
  const otlp =
    opts.postOtlp === true
      ? await postOtlpExport(rows, {
          endpoint: opts.otlpEndpoint || cfg.telemetryOtlpEndpoint || null,
          allowRemote:
            opts.allowRemote === true || cfg.telemetryAllowRemoteExport,
        })
      : undefined;

  return {
    ok: true,
    since,
    limits: { rows: limit },
    formats,
    counts: {
      spans: rows.spans.length,
      events: rows.events.length,
      metrics: rows.metrics.length,
      artifacts: rows.artifacts.length,
      eval_scores: rows.eval_scores.length,
    },
    files,
    ...(otlp ? { otlp_post: otlp } : {}),
  };
}

async function loadExportRows(opts: {
  since: string;
  limit: number;
}): Promise<ExportRows> {
  const [spans, events, metrics, artifacts, evalRows] = await Promise.all([
    query<SpanRow>(
      `SELECT id,
              recorded_at::text AS recorded_at,
              trace_id,
              span_id,
              parent_span_id,
              session_id,
              player_id,
              turn_id,
              event_id,
              release_seq,
              name,
              kind,
              status,
              started_at::text AS started_at,
              ended_at::text AS ended_at,
              duration_ms,
              attributes,
              events,
              links,
              error,
              redaction_tier,
              source
         FROM telemetry_spans
        WHERE recorded_at >= $1::timestamptz
        ORDER BY recorded_at ASC, id ASC
        LIMIT $2`,
      [opts.since, opts.limit],
    ).then((result) => result.rows),
    query<EventRow>(
      `SELECT id,
              occurred_at::text AS occurred_at,
              trace_id,
              span_id,
              session_id,
              player_id,
              turn_id,
              event_id,
              release_seq,
              schema_name,
              schema_version,
              category,
              event_name,
              severity,
              properties,
              redaction_tier,
              validation_status,
              source
         FROM telemetry_events
        WHERE occurred_at >= $1::timestamptz
        ORDER BY occurred_at ASC, id ASC
        LIMIT $2`,
      [opts.since, opts.limit],
    ).then((result) => result.rows),
    query<MetricRow>(
      `SELECT id,
              bucket_start::text AS bucket_start,
              trace_id,
              session_id,
              player_id,
              turn_id,
              name,
              unit,
              aggregation,
              count,
              sum,
              min,
              max,
              p50,
              p95,
              p99,
              attributes,
              source
         FROM telemetry_metrics
        WHERE bucket_start >= $1::timestamptz
        ORDER BY bucket_start ASC, id ASC
        LIMIT $2`,
      [opts.since, opts.limit],
    ).then((result) => result.rows),
    query<ArtifactRow>(
      `SELECT id,
              recorded_at::text AS recorded_at,
              trace_id,
              span_id,
              session_id,
              player_id,
              turn_id,
              artifact_type,
              path,
              size_bytes,
              sha256,
              mime_type,
              redaction_tier,
              metadata,
              source
         FROM telemetry_artifacts
        WHERE recorded_at >= $1::timestamptz
        ORDER BY recorded_at ASC, id ASC
        LIMIT $2`,
      [opts.since, opts.limit],
    ).then((result) => result.rows),
    query<EvalRow>(
      `SELECT id,
              recorded_at::text AS recorded_at,
              trace_id,
              span_id,
              session_id,
              player_id,
              turn_id,
              evaluator_id,
              evaluator_version,
              score,
              label,
              reason,
              reviewed,
              metadata,
              source
         FROM telemetry_eval_scores
        WHERE recorded_at >= $1::timestamptz
        ORDER BY recorded_at ASC, id ASC
        LIMIT $2`,
      [opts.since, opts.limit],
    ).then((result) => result.rows),
  ]);
  return {
    spans: spans.map(normalizeSpan),
    events: events.map(normalizeEvent),
    metrics: metrics.map(normalizeMetric),
    artifacts: artifacts.map(normalizeArtifact),
    eval_scores: evalRows.map(normalizeEval),
  };
}

async function writeJsonlExport(
  rows: ExportRows,
  since: string,
): Promise<TelemetryArtifactFile> {
  const lines = [
    ...rows.spans.map((row) => ({ type: 'span', row })),
    ...rows.events.map((row) => ({ type: 'event', row })),
    ...rows.metrics.map((row) => ({ type: 'metric', row })),
    ...rows.artifacts.map((row) => ({ type: 'artifact', row })),
    ...rows.eval_scores.map((row) => ({ type: 'eval_score', row })),
  ].map((line) => JSON.stringify(line));
  return await writeTelemetryTextArtifact({
    artifactType: 'developer_export_jsonl',
    filenamePrefix: 'telemetry-export-jsonl',
    extension: 'jsonl',
    mimeType: 'application/x-ndjson',
    content: `${lines.join('\n')}\n`,
    redactionTier: 'tier1_local_debug',
    metadata: {
      schema: 'greenhaven.telemetry_export_jsonl.v1',
      since,
      rows: lines.length,
    },
    source: 'developer.telemetry_export',
  });
}

async function writeOtlpExport(
  rows: ExportRows,
  since: string,
): Promise<TelemetryArtifactFile> {
  return await writeTelemetryJsonArtifact({
    artifactType: 'developer_export_otlp',
    filenamePrefix: 'telemetry-export-otlp',
    payload: buildOtlpPayload(rows),
    redactionTier: 'tier1_local_debug',
    metadata: {
      schema: 'greenhaven.telemetry_export_otlp.v1',
      since,
    },
    source: 'developer.telemetry_export',
  });
}

async function postOtlpExport(
  rows: ExportRows,
  opts: { endpoint: string | null; allowRemote: boolean },
): Promise<NonNullable<TelemetryDeveloperExportResult['otlp_post']>> {
  if (!opts.endpoint) return { skipped: 'missing_otlp_endpoint' };
  const base = normalizeOtlpBase(opts.endpoint);
  if (!opts.allowRemote && !isLocalEndpoint(base)) {
    return { skipped: 'remote_endpoint_blocked', endpoint: base };
  }
  const payload = buildOtlpPayload(rows);
  const targets = [
    { name: 'traces', path: '/v1/traces', payload: payload.traces },
    { name: 'logs', path: '/v1/logs', payload: payload.logs },
    { name: 'metrics', path: '/v1/metrics', payload: payload.metrics },
  ];
  const errors: Array<{ target: string; status?: number; error?: string }> = [];
  for (const target of targets) {
    try {
      const response = await fetch(`${base}${target.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target.payload),
      });
      if (!response.ok) {
        errors.push({ target: target.name, status: response.status });
      }
    } catch (err) {
      errors.push({
        target: target.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    endpoint: base,
    traces: rows.spans.length,
    logs: rows.events.length + rows.artifacts.length + rows.eval_scores.length,
    metrics: rows.metrics.length,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function buildOtlpPayload(rows: ExportRows): {
  traces: Record<string, unknown>;
  logs: Record<string, unknown>;
  metrics: Record<string, unknown>;
} {
  const resource = {
    attributes: [
      otlpAttr('service.name', 'greenhaven'),
      otlpAttr('service.namespace', 'greenhaven.local'),
      otlpAttr('telemetry.sdk.language', 'javascript'),
      otlpAttr('greenhaven.exporter', 'developer_mode'),
    ],
  };
  return {
    traces: {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope: { name: 'greenhaven.telemetry', version: '1' },
              spans: rows.spans.map((span) => ({
                traceId: otlpTraceId(span.trace_id),
                spanId: otlpSpanId(span.span_id),
                ...(span.parent_span_id
                  ? { parentSpanId: otlpSpanId(span.parent_span_id) }
                  : {}),
                name: span.name,
                kind: otlpSpanKind(span.kind),
                startTimeUnixNano: unixNano(span.started_at),
                endTimeUnixNano: unixNano(span.ended_at ?? span.started_at),
                attributes: objectAttrs({
                  ...span.attributes,
                  greenhaven_trace_id: span.trace_id,
                  greenhaven_span_id: span.span_id,
                  session_id: span.session_id,
                  player_id: span.player_id,
                  turn_id: span.turn_id,
                  event_id: span.event_id,
                  release_seq: span.release_seq,
                  source: span.source,
                  redaction_tier: span.redaction_tier,
                  duration_ms: span.duration_ms,
                }),
                status: {
                  code:
                    span.status === 'ok' || span.status === 'skipped' ? 1 : 2,
                  ...(span.error ? { message: span.error } : {}),
                },
              })),
            },
          ],
        },
      ],
    },
    logs: {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope: { name: 'greenhaven.telemetry', version: '1' },
              logRecords: [
                ...rows.events.map((event) => ({
                  timeUnixNano: unixNano(event.occurred_at),
                  severityText: event.severity,
                  body: {
                    stringValue: `${event.schema_name}.${event.event_name}`,
                  },
                  attributes: objectAttrs({
                    ...event.properties,
                    type: 'event',
                    schema_name: event.schema_name,
                    schema_version: event.schema_version,
                    category: event.category,
                    validation_status: event.validation_status,
                    trace_id: event.trace_id,
                    span_id: event.span_id,
                    session_id: event.session_id,
                    player_id: event.player_id,
                    turn_id: event.turn_id,
                    event_id: event.event_id,
                    release_seq: event.release_seq,
                    source: event.source,
                    redaction_tier: event.redaction_tier,
                  }),
                })),
                ...rows.artifacts.map((artifact) => ({
                  timeUnixNano: unixNano(artifact.recorded_at),
                  severityText: 'info',
                  body: { stringValue: `artifact.${artifact.artifact_type}` },
                  attributes: objectAttrs({
                    type: 'artifact',
                    artifact_type: artifact.artifact_type,
                    path: artifact.path,
                    size_bytes: artifact.size_bytes,
                    sha256: artifact.sha256,
                    mime_type: artifact.mime_type,
                    trace_id: artifact.trace_id,
                    span_id: artifact.span_id,
                    session_id: artifact.session_id,
                    player_id: artifact.player_id,
                    turn_id: artifact.turn_id,
                    source: artifact.source,
                    redaction_tier: artifact.redaction_tier,
                  }),
                })),
                ...rows.eval_scores.map((score) => ({
                  timeUnixNano: unixNano(score.recorded_at),
                  severityText: 'info',
                  body: { stringValue: `eval.${score.evaluator_id}` },
                  attributes: objectAttrs({
                    type: 'eval_score',
                    evaluator_id: score.evaluator_id,
                    evaluator_version: score.evaluator_version,
                    score: score.score,
                    label: score.label,
                    reviewed: score.reviewed,
                    trace_id: score.trace_id,
                    span_id: score.span_id,
                    session_id: score.session_id,
                    player_id: score.player_id,
                    turn_id: score.turn_id,
                    source: score.source,
                  }),
                })),
              ],
            },
          ],
        },
      ],
    },
    metrics: {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope: { name: 'greenhaven.telemetry', version: '1' },
              metrics: rows.metrics.map((metric) => ({
                name: metric.name,
                unit: metric.unit ?? '1',
                gauge: {
                  dataPoints: [
                    {
                      timeUnixNano: unixNano(metric.bucket_start),
                      asDouble:
                        metric.sum ??
                        metric.max ??
                        metric.min ??
                        metric.p95 ??
                        metric.p50 ??
                        metric.count,
                      attributes: objectAttrs({
                        ...metric.attributes,
                        aggregation: metric.aggregation,
                        count: metric.count,
                        min: metric.min,
                        max: metric.max,
                        p50: metric.p50,
                        p95: metric.p95,
                        p99: metric.p99,
                        trace_id: metric.trace_id,
                        session_id: metric.session_id,
                        player_id: metric.player_id,
                        turn_id: metric.turn_id,
                        source: metric.source,
                      }),
                    },
                  ],
                },
              })),
            },
          ],
        },
      ],
    },
  };
}

function normalizeFormats(
  formats: TelemetryDeveloperExportFormat[] | undefined,
): TelemetryDeveloperExportFormat[] {
  const set = new Set<TelemetryDeveloperExportFormat>();
  for (const format of formats ?? ['jsonl', 'otlp']) {
    if (format === 'jsonl' || format === 'otlp') set.add(format);
  }
  return set.size > 0 ? [...set] : ['jsonl', 'otlp'];
}

function normalizeOtlpBase(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1\/(traces|logs|metrics)$/i, '');
}

function isLocalEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return (
      u.hostname === '127.0.0.1' ||
      u.hostname === 'localhost' ||
      u.hostname === '::1'
    );
  } catch {
    return false;
  }
}

function normalizeSpan(row: SpanRow): SpanRow {
  return {
    ...row,
    id: Number(row.id),
    player_id: nullableNumber(row.player_id),
    event_id: nullableNumber(row.event_id),
    release_seq: nullableNumber(row.release_seq),
    duration_ms: nullableNumber(row.duration_ms),
    attributes: row.attributes ?? {},
    events: Array.isArray(row.events) ? row.events : [],
    links: Array.isArray(row.links) ? row.links : [],
  };
}

function normalizeEvent(row: EventRow): EventRow {
  return {
    ...row,
    id: Number(row.id),
    player_id: nullableNumber(row.player_id),
    event_id: nullableNumber(row.event_id),
    release_seq: nullableNumber(row.release_seq),
    schema_version: Number(row.schema_version ?? 1),
    properties: row.properties ?? {},
  };
}

function normalizeMetric(row: MetricRow): MetricRow {
  return {
    ...row,
    id: Number(row.id),
    player_id: nullableNumber(row.player_id),
    count: Number(row.count ?? 0),
    sum: nullableNumber(row.sum),
    min: nullableNumber(row.min),
    max: nullableNumber(row.max),
    p50: nullableNumber(row.p50),
    p95: nullableNumber(row.p95),
    p99: nullableNumber(row.p99),
    attributes: row.attributes ?? {},
  };
}

function normalizeArtifact(row: ArtifactRow): ArtifactRow {
  return {
    ...row,
    id: Number(row.id),
    player_id: nullableNumber(row.player_id),
    size_bytes: nullableNumber(row.size_bytes),
    metadata: row.metadata ?? {},
  };
}

function normalizeEval(row: EvalRow): EvalRow {
  return {
    ...row,
    id: Number(row.id),
    player_id: nullableNumber(row.player_id),
    score: nullableNumber(row.score),
    metadata: row.metadata ?? {},
  };
}

function otlpTraceId(value: string | null | undefined): string {
  return hashHex(value ?? 'trace', 32);
}

function otlpSpanId(value: string | null | undefined): string {
  return hashHex(value ?? 'span', 16);
}

function hashHex(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function otlpSpanKind(kind: string): number {
  if (kind === 'server') return 2;
  if (kind === 'client') return 3;
  if (kind === 'producer') return 4;
  if (kind === 'consumer') return 5;
  return 1;
}

function unixNano(value: string): string {
  const ms = new Date(value).getTime();
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return `${BigInt(safe) * 1_000_000n}`;
}

function objectAttrs(obj: Record<string, unknown>): Array<{
  key: string;
  value: Record<string, unknown>;
}> {
  const attrs: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(obj)) {
    const attr = otlpAttr(key, value);
    if (attr) attrs.push(attr);
  }
  return attrs;
}

function otlpAttr(
  key: string,
  value: unknown,
): { key: string; value: Record<string, unknown> } | null {
  if (value == null) return null;
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { key, value: { intValue: value } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: JSON.stringify(value) } };
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), 20_000));
}
