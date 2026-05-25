/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';

export interface PerformanceHotspotRow {
  kind: string;
  phase: string;
  status: string;
  count: number;
  avg_ms: number | null;
  max_ms: number | null;
  total_ms: number | null;
  avg_cpu_user_us: number | null;
  avg_cpu_system_us: number | null;
  max_heap_mb: number | null;
  max_rss_mb: number | null;
  errors: number;
}

export interface PerformanceEventRow {
  id: number;
  recorded_at: string;
  session_id: string | null;
  player_id: number | null;
  turn_id: string | null;
  trace_id: string | null;
  kind: string;
  phase: string;
  status: string;
  duration_ms: number | null;
  cpu_user_us: number | null;
  cpu_system_us: number | null;
  rss_mb: number | null;
  heap_used_mb: number | null;
  external_mb: number | null;
  event_loop_utilization: number | null;
  metadata: Record<string, unknown>;
  error: string | null;
}

export interface PerformanceDiagnosticsReport {
  since: string;
  hotspots: PerformanceHotspotRow[];
  failures: PerformanceEventRow[];
  recent_turns: Array<{
    turn_id: string;
    session_id: string | null;
    player_id: number | null;
    started_at: string;
    last_at: string;
    events: number;
    total_ms: number | null;
    failures: number;
  }>;
}

export function sinceIso(minutes: number | null | undefined): string {
  const safeMinutes =
    Number.isFinite(minutes ?? NaN) && Number(minutes) > 0
      ? Math.min(24 * 60, Number(minutes))
      : 60;
  return new Date(Date.now() - safeMinutes * 60_000).toISOString();
}

export async function buildPerformanceDiagnostics(opts: {
  since?: string;
  limit?: number;
} = {}): Promise<PerformanceDiagnosticsReport> {
  const since = opts.since ?? sinceIso(60);
  const limit = clampLimit(opts.limit ?? 20);
  const [hotspots, failures, recentTurns] = await Promise.all([
    listPerformanceHotspots({since, limit}),
    listPerformanceFailures({since, limit}),
    listRecentPerformanceTurns({since, limit}),
  ]);
  return {since, hotspots, failures, recent_turns: recentTurns};
}

export async function listPerformanceHotspots(opts: {
  since: string;
  limit?: number;
}): Promise<PerformanceHotspotRow[]> {
  const limit = clampLimit(opts.limit ?? 20);
  const rows = await query<PerformanceHotspotRow>(
    `SELECT kind,
            phase,
            status,
            COUNT(*)::int AS count,
            AVG(duration_ms)::int AS avg_ms,
            MAX(duration_ms)::int AS max_ms,
            SUM(duration_ms)::int AS total_ms,
            AVG(cpu_user_us)::int AS avg_cpu_user_us,
            AVG(cpu_system_us)::int AS avg_cpu_system_us,
            (MAX(heap_used_bytes) / 1024 / 1024)::int AS max_heap_mb,
            (MAX(rss_bytes) / 1024 / 1024)::int AS max_rss_mb,
            SUM(CASE WHEN status NOT IN ('ok', 'skipped') OR error IS NOT NULL THEN 1 ELSE 0 END)::int AS errors
       FROM performance_events
      WHERE recorded_at >= $1::timestamptz
      GROUP BY kind, phase, status
      ORDER BY COALESCE(AVG(duration_ms), 0) DESC, count DESC
      LIMIT $2`,
    [opts.since, limit],
  );
  return rows.rows.map(row => normalizeHotspot(row));
}

export async function listPerformanceFailures(opts: {
  since: string;
  limit?: number;
}): Promise<PerformanceEventRow[]> {
  const limit = clampLimit(opts.limit ?? 20);
  const rows = await query<PerformanceEventRow>(
    `SELECT id,
            recorded_at::text AS recorded_at,
            session_id,
            player_id,
            turn_id,
            trace_id,
            kind,
            phase,
            status,
            duration_ms,
            cpu_user_us,
            cpu_system_us,
            (rss_bytes / 1024 / 1024)::int AS rss_mb,
            (heap_used_bytes / 1024 / 1024)::int AS heap_used_mb,
            (external_bytes / 1024 / 1024)::int AS external_mb,
            event_loop_utilization,
            metadata,
            error
       FROM performance_events
      WHERE recorded_at >= $1::timestamptz
        AND (status NOT IN ('ok', 'skipped') OR error IS NOT NULL)
      ORDER BY recorded_at DESC, id DESC
      LIMIT $2`,
    [opts.since, limit],
  );
  return rows.rows.map(normalizeEvent);
}

export async function listRecentPerformanceTurns(opts: {
  since: string;
  limit?: number;
}): Promise<PerformanceDiagnosticsReport['recent_turns']> {
  const limit = clampLimit(opts.limit ?? 20);
  const rows = await query<{
    turn_id: string;
    session_id: string | null;
    player_id: number | null;
    started_at: string;
    last_at: string;
    events: number;
    total_ms: number | null;
    failures: number;
  }>(
    `SELECT turn_id,
            MAX(session_id) AS session_id,
            MAX(player_id)::bigint AS player_id,
            MIN(recorded_at)::text AS started_at,
            MAX(recorded_at)::text AS last_at,
            COUNT(*)::int AS events,
            SUM(duration_ms)::int AS total_ms,
            SUM(CASE WHEN status NOT IN ('ok', 'skipped') OR error IS NOT NULL THEN 1 ELSE 0 END)::int AS failures
       FROM performance_events
      WHERE recorded_at >= $1::timestamptz
        AND turn_id IS NOT NULL
      GROUP BY turn_id
      ORDER BY MAX(recorded_at) DESC
      LIMIT $2`,
    [opts.since, limit],
  );
  return rows.rows.map(row => ({
    turn_id: row.turn_id,
    session_id: row.session_id,
    player_id: row.player_id == null ? null : Number(row.player_id),
    started_at: row.started_at,
    last_at: row.last_at,
    events: Number(row.events ?? 0),
    total_ms: row.total_ms == null ? null : Number(row.total_ms),
    failures: Number(row.failures ?? 0),
  }));
}

export async function getPerformanceTurn(turnId: string): Promise<{
  turn_id: string;
  events: PerformanceEventRow[];
  summary: {
    events: number;
    total_ms: number;
    failures: number;
    slowest: PerformanceEventRow | null;
  };
}> {
  const rows = await query<PerformanceEventRow>(
    `SELECT id,
            recorded_at::text AS recorded_at,
            session_id,
            player_id,
            turn_id,
            trace_id,
            kind,
            phase,
            status,
            duration_ms,
            cpu_user_us,
            cpu_system_us,
            (rss_bytes / 1024 / 1024)::int AS rss_mb,
            (heap_used_bytes / 1024 / 1024)::int AS heap_used_mb,
            (external_bytes / 1024 / 1024)::int AS external_mb,
            event_loop_utilization,
            metadata,
            error
       FROM performance_events
      WHERE turn_id = $1
      ORDER BY recorded_at ASC, id ASC`,
    [turnId],
  );
  const events = rows.rows.map(normalizeEvent);
  const slowest = [...events]
    .filter(event => event.duration_ms != null)
    .sort((a, b) => Number(b.duration_ms ?? 0) - Number(a.duration_ms ?? 0))[0] ?? null;
  return {
    turn_id: turnId,
    events,
    summary: {
      events: events.length,
      total_ms: events.reduce((sum, event) => sum + Number(event.duration_ms ?? 0), 0),
      failures: events.filter(event => event.status !== 'ok' && event.status !== 'skipped').length,
      slowest,
    },
  };
}

function normalizeHotspot(row: PerformanceHotspotRow): PerformanceHotspotRow {
  return {
    ...row,
    count: Number(row.count ?? 0),
    avg_ms: nullableNumber(row.avg_ms),
    max_ms: nullableNumber(row.max_ms),
    total_ms: nullableNumber(row.total_ms),
    avg_cpu_user_us: nullableNumber(row.avg_cpu_user_us),
    avg_cpu_system_us: nullableNumber(row.avg_cpu_system_us),
    max_heap_mb: nullableNumber(row.max_heap_mb),
    max_rss_mb: nullableNumber(row.max_rss_mb),
    errors: Number(row.errors ?? 0),
  };
}

function normalizeEvent(row: PerformanceEventRow): PerformanceEventRow {
  return {
    ...row,
    id: Number(row.id),
    player_id: row.player_id == null ? null : Number(row.player_id),
    duration_ms: nullableNumber(row.duration_ms),
    cpu_user_us: nullableNumber(row.cpu_user_us),
    cpu_system_us: nullableNumber(row.cpu_system_us),
    rss_mb: nullableNumber(row.rss_mb),
    heap_used_mb: nullableNumber(row.heap_used_mb),
    external_mb: nullableNumber(row.external_mb),
    event_loop_utilization: nullableNumber(row.event_loop_utilization),
    metadata: row.metadata ?? {},
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), 200));
}
