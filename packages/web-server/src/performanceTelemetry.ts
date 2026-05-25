/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {performance} from 'node:perf_hooks';
import {query} from './db.js';
import {recordTelemetrySpan} from './telemetryLake.js';

export type PerformanceEventKind =
  | 'turn'
  | 'llm'
  | 'tool'
  | 'agent'
  | 'queue'
  | 'gui'
  | 'http'
  | 'frontend'
  | 'db'
  | 'support';

export interface PerformanceEventInput {
  sessionId?: string | null;
  playerId?: number | null;
  turnId?: string | null;
  traceId?: string | null;
  kind: PerformanceEventKind | string;
  phase: string;
  status?: 'ok' | 'error' | 'timeout' | 'cancelled' | 'skipped' | string;
  durationMs?: number | null;
  cpuUserUs?: number | null;
  cpuSystemUs?: number | null;
  rssBytes?: number | null;
  heapUsedBytes?: number | null;
  externalBytes?: number | null;
  eventLoopUtilization?: number | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

interface PerfSample {
  startedAt: number;
  cpu: NodeJS.CpuUsage;
  memory: NodeJS.MemoryUsage;
  eventLoop: EventLoopUtilizationSnapshot | null;
}

interface EventLoopUtilizationSnapshot {
  idle: number;
  active: number;
  utilization: number;
}

export function startPerformanceSample(): PerfSample {
  return {
    startedAt: performance.now(),
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
    eventLoop: readEventLoopUtilization(),
  };
}

export async function recordPerformanceEvent(
  input: PerformanceEventInput,
): Promise<void> {
  const normalized = normalizePerformanceEventInput(input);
  try {
    await query(
      `INSERT INTO performance_events
         (session_id, player_id, turn_id, trace_id, kind, phase, status,
          duration_ms, cpu_user_us, cpu_system_us, rss_bytes, heap_used_bytes,
          external_bytes, event_loop_utilization, metadata, error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`,
      [
        normalized.sessionId,
        normalized.playerId,
        normalized.turnId,
        normalized.traceId,
        normalized.kind,
        normalized.phase,
        normalized.status,
        normalized.durationMs,
        normalized.cpuUserUs,
        normalized.cpuSystemUs,
        normalized.rssBytes,
        normalized.heapUsedBytes,
        normalized.externalBytes,
        normalized.eventLoopUtilization,
        JSON.stringify(normalized.metadata),
        normalized.error,
      ],
    );
    await recordTelemetrySpan({
      sessionId: normalized.sessionId,
      playerId: normalized.playerId,
      turnId: normalized.turnId,
      traceId: normalized.traceId,
      name: normalized.phase,
      kind: mapPerformanceKindToSpanKind(normalized.kind),
      status: normalized.status,
      endedAt: normalized.endedAt,
      durationMs: normalized.durationMs,
      attributes: {
        ...normalized.metadata,
        greenhaven_source_table: 'performance_events',
        greenhaven_performance_kind: normalized.kind,
        cpu_user_us: normalized.cpuUserUs,
        cpu_system_us: normalized.cpuSystemUs,
        rss_bytes: normalized.rssBytes,
        heap_used_bytes: normalized.heapUsedBytes,
        external_bytes: normalized.externalBytes,
        event_loop_utilization: normalized.eventLoopUtilization,
      },
      error: normalized.error,
      source: 'performance_events',
    });
  } catch (err) {
    // CATCH-WARN-OK: sink-internal write boundary. `recordPerformanceEvent` IS the performance-telemetry sink (it owns the `performance_events` INSERT + the `recordTelemetrySpan` mirror). Calling `telemetry.record({channel: 'performance', ...})` from this catch would re-enter `recordPerformanceEvent` via the ARCH-2 facade and either deadlock the sampler or recurse on the same SQL failure; the warn is the operator-visible escape hatch when the sink itself fails.
    console.warn(
      '[perf] performance_events insert failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

function normalizePerformanceEventInput(input: PerformanceEventInput): {
  sessionId: string | null;
  playerId: number | null;
  turnId: string | null;
  traceId: string | null;
  kind: string;
  phase: string;
  status: string;
  durationMs: number | null;
  cpuUserUs: number | null;
  cpuSystemUs: number | null;
  rssBytes: number | null;
  heapUsedBytes: number | null;
  externalBytes: number | null;
  eventLoopUtilization: number | null;
  metadata: Record<string, unknown>;
  error: string | null;
  endedAt: Date;
} {
  return {
    sessionId: input.sessionId ?? null,
    playerId: input.playerId ?? null,
    turnId: input.turnId ?? null,
    traceId: input.traceId ?? input.turnId ?? null,
    kind: input.kind,
    phase: input.phase,
    status: input.status ?? 'ok',
    durationMs: normalizePositiveInt(input.durationMs),
    cpuUserUs: normalizePositiveInt(input.cpuUserUs),
    cpuSystemUs: normalizePositiveInt(input.cpuSystemUs),
    rssBytes: normalizePositiveInt(input.rssBytes),
    heapUsedBytes: normalizePositiveInt(input.heapUsedBytes),
    externalBytes: normalizePositiveInt(input.externalBytes),
    eventLoopUtilization: input.eventLoopUtilization ?? null,
    metadata: input.metadata ?? {},
    error: input.error ?? null,
    endedAt: new Date(),
  };
}

function normalizePositiveInt(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function mapPerformanceKindToSpanKind(kind: string): string {
  if (kind === 'llm') return 'client';
  if (kind === 'http') return 'server';
  if (kind === 'db') return 'client';
  if (kind === 'frontend' || kind === 'gui') return 'internal';
  return 'internal';
}

export function eventFromSample(
  sample: PerfSample,
  input: Omit<
    PerformanceEventInput,
    | 'durationMs'
    | 'cpuUserUs'
    | 'cpuSystemUs'
    | 'rssBytes'
    | 'heapUsedBytes'
    | 'externalBytes'
    | 'eventLoopUtilization'
  >,
): PerformanceEventInput {
  const cpu = process.cpuUsage(sample.cpu);
  const memory = process.memoryUsage();
  const eventLoop = diffEventLoopUtilization(sample.eventLoop);
  return {
    ...input,
    durationMs: performance.now() - sample.startedAt,
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    eventLoopUtilization: eventLoop?.utilization ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      heap_delta_bytes: memory.heapUsed - sample.memory.heapUsed,
      rss_delta_bytes: memory.rss - sample.memory.rss,
    },
  };
}

export async function measurePhase<T>(
  input: Omit<
    PerformanceEventInput,
    | 'durationMs'
    | 'cpuUserUs'
    | 'cpuSystemUs'
    | 'rssBytes'
    | 'heapUsedBytes'
    | 'externalBytes'
    | 'eventLoopUtilization'
    | 'status'
    | 'error'
  >,
  fn: () => Promise<T> | T,
): Promise<T> {
  const sample = startPerformanceSample();
  try {
    const result = await fn();
    await recordPerformanceEvent(eventFromSample(sample, {...input, status: 'ok'}));
    return result;
  } catch (err) {
    await recordPerformanceEvent(
      eventFromSample(sample, {
        ...input,
        status: classifyErrorStatus(err),
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    throw err;
  }
}

function classifyErrorStatus(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // LANGUAGE-REGEX-OK: AbortSignal / AI-SDK / Node error-message wire tokens. `timeout` and `deadline` are the literal substrings Node, Vercel AI SDK, and most HTTP/DB drivers stamp into `Error.message` when a deadline elapses; matched here only to bucket the row's `status` column for span telemetry. Not natural-language player text. Same pattern as `tools/base.ts:errorStatus`.
  if (/timeout|deadline/i.test(message)) return 'timeout';
  // LANGUAGE-REGEX-OK: same AbortSignal / AI-SDK protocol-token family. `abort` is the literal substring Node's AbortController emits (`AbortError`, `The operation was aborted`); `cancel` covers cancelled-promise / fetch-cancel error shapes. Wire-format status bucketing only; not natural-language text.
  if (/abort|cancel/i.test(message)) return 'cancelled';
  return 'error';
}

function readEventLoopUtilization(): EventLoopUtilizationSnapshot | null {
  const maybePerf = performance as typeof performance & {
    eventLoopUtilization?: () => EventLoopUtilizationSnapshot;
  };
  try {
    return maybePerf.eventLoopUtilization?.() ?? null;
  } catch {
    return null;
  }
}

function diffEventLoopUtilization(
  start: EventLoopUtilizationSnapshot | null,
): EventLoopUtilizationSnapshot | null {
  if (!start) return null;
  const maybePerf = performance as typeof performance & {
    eventLoopUtilization?: (
      current?: EventLoopUtilizationSnapshot,
      previous?: EventLoopUtilizationSnapshot,
    ) => EventLoopUtilizationSnapshot;
  };
  try {
    const current = maybePerf.eventLoopUtilization?.();
    if (!current || !maybePerf.eventLoopUtilization) return null;
    return maybePerf.eventLoopUtilization(current, start);
  } catch {
    return null;
  }
}
