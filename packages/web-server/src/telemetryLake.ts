/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {query} from './db.js';

export type TelemetryRedactionTier =
  | 'tier0_safe'
  | 'tier1_local_debug'
  | 'tier2_sensitive_local';

export interface TelemetryContext {
  installId?: string | null;
  buildId?: string | null;
  appVersion?: string | null;
  cartridgeId?: string | null;
  cartridgeVersion?: string | null;
  saveId?: string | null;
  playerId?: number | null;
  sessionId?: string | null;
  turnId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  eventId?: number | null;
  releaseSeq?: number | null;
}

export interface TelemetrySpanInput extends TelemetryContext {
  name: string;
  kind?: string;
  status?: string;
  startedAt?: Date | string | null;
  endedAt?: Date | string | null;
  durationMs?: number | null;
  attributes?: Record<string, unknown>;
  events?: unknown[];
  links?: unknown[];
  error?: string | null;
  redactionTier?: TelemetryRedactionTier;
  source?: string;
}

export interface TelemetryEventInput extends TelemetryContext {
  schemaName: string;
  schemaVersion?: number;
  category?: string;
  eventName: string;
  severity?: string;
  occurredAt?: Date | string | null;
  properties?: Record<string, unknown>;
  redactionTier?: TelemetryRedactionTier;
  validationStatus?: string;
  source?: string;
}

export interface TelemetryMetricInput extends TelemetryContext {
  name: string;
  unit?: string | null;
  aggregation?: string;
  bucketStart?: Date | string | null;
  count?: number;
  sum?: number | null;
  min?: number | null;
  max?: number | null;
  p50?: number | null;
  p95?: number | null;
  p99?: number | null;
  attributes?: Record<string, unknown>;
  source?: string;
}

export interface TelemetryArtifactInput extends TelemetryContext {
  artifactType: string;
  path: string;
  sizeBytes?: number | null;
  sha256?: string | null;
  mimeType?: string | null;
  startedAt?: Date | string | null;
  endedAt?: Date | string | null;
  redactionTier?: TelemetryRedactionTier;
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface TelemetryEvalScoreInput extends TelemetryContext {
  evaluatorId: string;
  evaluatorVersion?: string | null;
  score?: number | null;
  label?: string | null;
  reason?: string | null;
  reviewed?: boolean;
  metadata?: Record<string, unknown>;
  source?: string;
}

const contextStore = new AsyncLocalStorage<TelemetryContext>();

export function withTelemetryContext<T>(
  context: TelemetryContext,
  fn: () => T,
): T {
  const parent = contextStore.getStore() ?? {};
  return contextStore.run({...parent, ...context}, fn);
}

export function currentTelemetryContext(): TelemetryContext {
  return contextStore.getStore() ?? {};
}

export function makeTraceId(seed?: string | null): string {
  return seed && seed.trim().length > 0 ? seed : randomUUID();
}

export function makeSpanId(): string {
  return randomUUID();
}

export async function recordTelemetrySpan(
  input: TelemetrySpanInput,
): Promise<{traceId: string; spanId: string} | null> {
  const merged = mergeContext(input);
  const traceId = makeTraceId(merged.traceId ?? merged.turnId ?? null);
  const spanId = merged.spanId ?? makeSpanId();
  const now = new Date();
  const endedAt = asDate(input.endedAt) ?? now;
  const durationMs = normalizeInt(input.durationMs);
  const startedAt =
    asDate(input.startedAt) ??
    (durationMs == null
      ? endedAt
      : new Date(endedAt.getTime() - Math.max(0, durationMs)));
  try {
    await query(
      `INSERT INTO telemetry_spans
         (trace_id, span_id, parent_span_id, session_id, player_id, turn_id,
          event_id, release_seq, name, kind, status, started_at, ended_at,
          duration_ms, attributes, events, links, error, redaction_tier, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,
               $16::jsonb,$17::jsonb,$18,$19,$20)
       ON CONFLICT (trace_id, span_id) DO UPDATE
         SET ended_at = EXCLUDED.ended_at,
             duration_ms = EXCLUDED.duration_ms,
             status = EXCLUDED.status,
             attributes = telemetry_spans.attributes || EXCLUDED.attributes,
             error = COALESCE(EXCLUDED.error, telemetry_spans.error)`,
      [
        traceId,
        spanId,
        merged.parentSpanId ?? null,
        merged.sessionId ?? null,
        merged.playerId ?? null,
        merged.turnId ?? null,
        merged.eventId ?? null,
        merged.releaseSeq ?? null,
        input.name,
        input.kind ?? 'internal',
        input.status ?? 'ok',
        startedAt.toISOString(),
        endedAt.toISOString(),
        durationMs,
        JSON.stringify(input.attributes ?? {}),
        JSON.stringify(input.events ?? []),
        JSON.stringify(input.links ?? []),
        input.error ?? null,
        input.redactionTier ?? 'tier0_safe',
        input.source ?? 'greenhaven',
      ],
    );
    return {traceId, spanId};
  } catch (err) {
    warnTelemetryFailure('span', err);
    return null;
  }
}

export type TelemetryEventInsertResult =
  | {ok: true}
  | {ok: false; error: string};

// N-2 Phase 3 observability — resultful sibling of `recordTelemetryEvent`.
// Returns `{ok:true}` on a successful INSERT and `{ok:false, error}` on
// failure so callers (notably the gameplay-mirror branch in
// `Telemetry.ts`) can record per-event success/failure diagnostics.
// `recordTelemetryEvent` keeps its swallowing/void semantics for the
// existing fire-and-forget callers (frontend/desktop sinks, inbound
// batch ingestion).
export async function tryRecordTelemetryEvent(
  input: TelemetryEventInput,
): Promise<TelemetryEventInsertResult> {
  const merged = mergeContext(input);
  try {
    await query(
      `INSERT INTO telemetry_events
         (occurred_at, trace_id, span_id, session_id, player_id, turn_id,
          event_id, release_seq, schema_name, schema_version, category,
          event_name, severity, properties, redaction_tier,
          validation_status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
               $15,$16,$17)`,
      [
        (asDate(input.occurredAt) ?? new Date()).toISOString(),
        merged.traceId ?? merged.turnId ?? null,
        merged.spanId ?? null,
        merged.sessionId ?? null,
        merged.playerId ?? null,
        merged.turnId ?? null,
        merged.eventId ?? null,
        merged.releaseSeq ?? null,
        input.schemaName,
        normalizeInt(input.schemaVersion) ?? 1,
        input.category ?? 'system',
        input.eventName,
        input.severity ?? 'info',
        JSON.stringify(input.properties ?? {}),
        input.redactionTier ?? 'tier0_safe',
        input.validationStatus ?? 'valid',
        input.source ?? 'greenhaven',
      ],
    );
    return {ok: true};
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : String(err)};
  }
}

export async function recordTelemetryEvent(
  input: TelemetryEventInput,
): Promise<void> {
  const result = await tryRecordTelemetryEvent(input);
  if (!result.ok) warnTelemetryFailure('event', result.error);
}

export async function recordTelemetryMetric(
  input: TelemetryMetricInput,
): Promise<void> {
  const merged = mergeContext(input);
  try {
    await query(
      `INSERT INTO telemetry_metrics
         (bucket_start, trace_id, session_id, player_id, turn_id, name, unit,
          aggregation, count, sum, min, max, p50, p95, p99, attributes, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
      [
        (asDate(input.bucketStart) ?? new Date()).toISOString(),
        merged.traceId ?? merged.turnId ?? null,
        merged.sessionId ?? null,
        merged.playerId ?? null,
        merged.turnId ?? null,
        input.name,
        input.unit ?? null,
        input.aggregation ?? 'raw',
        normalizeInt(input.count) ?? 1,
        nullableNumber(input.sum),
        nullableNumber(input.min),
        nullableNumber(input.max),
        nullableNumber(input.p50),
        nullableNumber(input.p95),
        nullableNumber(input.p99),
        JSON.stringify(input.attributes ?? {}),
        input.source ?? 'greenhaven',
      ],
    );
  } catch (err) {
    warnTelemetryFailure('metric', err);
  }
}

export async function recordTelemetryArtifact(
  input: TelemetryArtifactInput,
): Promise<void> {
  const merged = mergeContext(input);
  try {
    await query(
      `INSERT INTO telemetry_artifacts
         (trace_id, span_id, session_id, player_id, turn_id, artifact_type,
          path, size_bytes, sha256, mime_type, started_at, ended_at,
          redaction_tier, metadata, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
      [
        merged.traceId ?? merged.turnId ?? null,
        merged.spanId ?? null,
        merged.sessionId ?? null,
        merged.playerId ?? null,
        merged.turnId ?? null,
        input.artifactType,
        input.path,
        input.sizeBytes == null ? null : Math.max(0, Math.trunc(input.sizeBytes)),
        input.sha256 ?? null,
        input.mimeType ?? null,
        asDate(input.startedAt)?.toISOString() ?? null,
        asDate(input.endedAt)?.toISOString() ?? null,
        input.redactionTier ?? 'tier1_local_debug',
        JSON.stringify(input.metadata ?? {}),
        input.source ?? 'greenhaven',
      ],
    );
  } catch (err) {
    warnTelemetryFailure('artifact', err);
  }
}

export async function recordTelemetryEvalScore(
  input: TelemetryEvalScoreInput,
): Promise<void> {
  const merged = mergeContext(input);
  try {
    await query(
      `INSERT INTO telemetry_eval_scores
         (trace_id, span_id, session_id, player_id, turn_id, evaluator_id,
          evaluator_version, score, label, reason, reviewed, metadata, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [
        merged.traceId ?? merged.turnId ?? null,
        merged.spanId ?? null,
        merged.sessionId ?? null,
        merged.playerId ?? null,
        merged.turnId ?? null,
        input.evaluatorId,
        input.evaluatorVersion ?? null,
        nullableNumber(input.score),
        input.label ?? null,
        input.reason ?? null,
        input.reviewed === true,
        JSON.stringify(input.metadata ?? {}),
        input.source ?? 'greenhaven',
      ],
    );
  } catch (err) {
    warnTelemetryFailure('eval_score', err);
  }
}

function mergeContext<T extends TelemetryContext>(input: T): TelemetryContext & T {
  return {...currentTelemetryContext(), ...input};
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeInt(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function warnTelemetryFailure(kind: string, err: unknown): void {
  console.warn(
    `[telemetry] ${kind} insert failed:`,
    err instanceof Error ? err.message : err,
  );
}
