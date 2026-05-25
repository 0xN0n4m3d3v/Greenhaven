/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';

export interface TelemetrySpanRow {
  id: number;
  recorded_at: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  session_id: string | null;
  player_id: number | null;
  turn_id: string | null;
  event_id: number | null;
  release_seq: number | null;
  name: string;
  kind: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  attributes: Record<string, unknown>;
  events: unknown[];
  links: unknown[];
  error: string | null;
  redaction_tier: string;
  source: string;
}

export interface TelemetryEventRow {
  id: number;
  occurred_at: string;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
  player_id: number | null;
  turn_id: string | null;
  event_id: number | null;
  release_seq: number | null;
  schema_name: string;
  schema_version: number;
  category: string;
  event_name: string;
  severity: string;
  properties: Record<string, unknown>;
  redaction_tier: string;
  validation_status: string;
  source: string;
}

export interface TelemetrySummary {
  since: string;
  health: {
    spans: number;
    events: number;
    metrics: number;
    artifacts: number;
    eval_scores: number;
    failures: number;
  };
  hotspots: Array<{
    name: string;
    kind: string;
    status: string;
    count: number;
    avg_ms: number | null;
    max_ms: number | null;
    total_ms: number | null;
  }>;
  event_counts: Array<{
    schema_name: string;
    event_name: string;
    severity: string;
    count: number;
  }>;
  recent_traces: Array<{
    trace_id: string;
    session_id: string | null;
    player_id: number | null;
    turn_id: string | null;
    started_at: string;
    last_at: string;
    spans: number;
    total_ms: number | null;
    failures: number;
  }>;
}

export interface TelemetryBundle {
  schema: 'greenhaven.telemetry_bundle.v1';
  generated_at: string;
  since: string;
  redaction: {
    default_tier: 'tier1_local_debug';
    notes: string[];
  };
  summary: TelemetrySummary;
  errors: Awaited<ReturnType<typeof listTelemetryErrors>>;
  quality: Awaited<ReturnType<typeof listTelemetryQuality>>;
  canonical_counts: Array<{source: string; count: number}>;
  traces: Array<Awaited<ReturnType<typeof getTelemetryTrace>>>;
}

export function sinceIso(minutes: number | null | undefined): string {
  const safeMinutes =
    Number.isFinite(minutes ?? NaN) && Number(minutes) > 0
      ? Math.min(7 * 24 * 60, Number(minutes))
      : 60;
  return new Date(Date.now() - safeMinutes * 60_000).toISOString();
}

export async function buildTelemetrySummary(opts: {
  since?: string;
  limit?: number;
} = {}): Promise<TelemetrySummary> {
  const since = opts.since ?? sinceIso(60);
  const limit = clampLimit(opts.limit ?? 20);
  const [health, hotspots, eventCounts, recentTraces] = await Promise.all([
    telemetryHealth({since}),
    telemetryHotspots({since, limit}),
    telemetryEventCounts({since, limit}),
    telemetryRecentTraces({since, limit}),
  ]);
  return {
    since,
    health,
    hotspots,
    event_counts: eventCounts,
    recent_traces: recentTraces,
  };
}

export async function telemetryHealth(opts: {since: string}): Promise<
  TelemetrySummary['health']
> {
  const [spans, events, metrics, artifacts, evalScores, failures] =
    await Promise.all([
      countRows(
        `SELECT COUNT(*)::int AS count FROM telemetry_spans
          WHERE recorded_at >= $1::timestamptz`,
        [opts.since],
      ),
      countRows(
        `SELECT COUNT(*)::int AS count FROM telemetry_events
          WHERE occurred_at >= $1::timestamptz`,
        [opts.since],
      ),
      countRows(
        `SELECT COUNT(*)::int AS count FROM telemetry_metrics
          WHERE bucket_start >= $1::timestamptz`,
        [opts.since],
      ),
      countRows(
        `SELECT COUNT(*)::int AS count FROM telemetry_artifacts
          WHERE recorded_at >= $1::timestamptz`,
        [opts.since],
      ),
      countRows(
        `SELECT COUNT(*)::int AS count FROM telemetry_eval_scores
          WHERE recorded_at >= $1::timestamptz`,
        [opts.since],
      ),
      countRows(
        `SELECT COUNT(*)::int AS count FROM telemetry_spans
          WHERE recorded_at >= $1::timestamptz
            AND (status NOT IN ('ok', 'skipped') OR error IS NOT NULL)`,
        [opts.since],
      ),
    ]);
  return {spans, events, metrics, artifacts, eval_scores: evalScores, failures};
}

export async function telemetryHotspots(opts: {
  since: string;
  limit?: number;
}): Promise<TelemetrySummary['hotspots']> {
  const limit = clampLimit(opts.limit ?? 20);
  const rows = await query<{
    name: string;
    kind: string;
    status: string;
    count: number;
    avg_ms: number | null;
    max_ms: number | null;
    total_ms: number | null;
  }>(
    `SELECT name,
            kind,
            status,
            COUNT(*)::int AS count,
            AVG(duration_ms)::int AS avg_ms,
            MAX(duration_ms)::int AS max_ms,
            SUM(duration_ms)::int AS total_ms
       FROM telemetry_spans
      WHERE recorded_at >= $1::timestamptz
      GROUP BY name, kind, status
      ORDER BY COALESCE(AVG(duration_ms), 0) DESC, count DESC
      LIMIT $2`,
    [opts.since, limit],
  );
  return rows.rows.map(row => ({
    name: row.name,
    kind: row.kind,
    status: row.status,
    count: Number(row.count ?? 0),
    avg_ms: nullableNumber(row.avg_ms),
    max_ms: nullableNumber(row.max_ms),
    total_ms: nullableNumber(row.total_ms),
  }));
}

export async function telemetryEventCounts(opts: {
  since: string;
  limit?: number;
}): Promise<TelemetrySummary['event_counts']> {
  const limit = clampLimit(opts.limit ?? 20);
  const rows = await query<{
    schema_name: string;
    event_name: string;
    severity: string;
    count: number;
  }>(
    `SELECT schema_name,
            event_name,
            severity,
            COUNT(*)::int AS count
       FROM telemetry_events
      WHERE occurred_at >= $1::timestamptz
      GROUP BY schema_name, event_name, severity
      ORDER BY count DESC, schema_name, event_name
      LIMIT $2`,
    [opts.since, limit],
  );
  return rows.rows.map(row => ({
    schema_name: row.schema_name,
    event_name: row.event_name,
    severity: row.severity,
    count: Number(row.count ?? 0),
  }));
}

export async function telemetryRecentTraces(opts: {
  since: string;
  limit?: number;
}): Promise<TelemetrySummary['recent_traces']> {
  const limit = clampLimit(opts.limit ?? 20);
  const rows = await query<{
    trace_id: string;
    session_id: string | null;
    player_id: number | null;
    turn_id: string | null;
    started_at: string;
    last_at: string;
    spans: number;
    total_ms: number | null;
    failures: number;
  }>(
    `SELECT trace_id,
            MAX(session_id) AS session_id,
            MAX(player_id)::bigint AS player_id,
            MAX(turn_id) AS turn_id,
            MIN(started_at)::text AS started_at,
            MAX(COALESCE(ended_at, started_at))::text AS last_at,
            COUNT(*)::int AS spans,
            SUM(duration_ms)::int AS total_ms,
            SUM(CASE WHEN status NOT IN ('ok', 'skipped') OR error IS NOT NULL THEN 1 ELSE 0 END)::int AS failures
       FROM telemetry_spans
      WHERE recorded_at >= $1::timestamptz
      GROUP BY trace_id
      ORDER BY MAX(recorded_at) DESC
      LIMIT $2`,
    [opts.since, limit],
  );
  return rows.rows.map(row => ({
    trace_id: row.trace_id,
    session_id: row.session_id,
    player_id: row.player_id == null ? null : Number(row.player_id),
    turn_id: row.turn_id,
    started_at: row.started_at,
    last_at: row.last_at,
    spans: Number(row.spans ?? 0),
    total_ms: nullableNumber(row.total_ms),
    failures: Number(row.failures ?? 0),
  }));
}

export async function listTelemetryErrors(opts: {
  since: string;
  limit?: number;
}): Promise<{spans: TelemetrySpanRow[]; events: TelemetryEventRow[]}> {
  const limit = clampLimit(opts.limit ?? 50);
  const [spans, events] = await Promise.all([
    queryTelemetrySpans(
      `WHERE recorded_at >= $1::timestamptz
         AND (status NOT IN ('ok', 'skipped') OR error IS NOT NULL)
       ORDER BY recorded_at DESC, id DESC
       LIMIT $2`,
      [opts.since, limit],
    ),
    queryTelemetryEvents(
      `WHERE occurred_at >= $1::timestamptz
         AND (severity IN ('warn', 'error', 'fatal')
              OR validation_status <> 'valid')
       ORDER BY occurred_at DESC, id DESC
       LIMIT $2`,
      [opts.since, limit],
    ),
  ]);
  return {spans, events};
}

export async function buildTelemetryBundle(opts: {
  since?: string;
  limit?: number;
  traceLimit?: number;
} = {}): Promise<TelemetryBundle> {
  const since = opts.since ?? sinceIso(60);
  const limit = clampLimit(opts.limit ?? 50);
  const traceLimit = Math.max(
    0,
    Math.min(Math.trunc(opts.traceLimit ?? 5), 20),
  );
  const [summary, errors, quality, canonicalCounts] = await Promise.all([
    buildTelemetrySummary({since, limit}),
    listTelemetryErrors({since, limit}),
    listTelemetryQuality({since, limit}),
    telemetryCanonicalCounts({since}),
  ]);
  const traceIds = summary.recent_traces
    .slice(0, traceLimit)
    .map(trace => trace.trace_id);
  const traces = await Promise.all(traceIds.map(traceId => getTelemetryTrace(traceId)));
  return {
    schema: 'greenhaven.telemetry_bundle.v1',
    generated_at: new Date().toISOString(),
    since,
    redaction: {
      default_tier: 'tier1_local_debug',
      notes: [
        'Bundle contains structured local telemetry and sanitized attributes.',
        'It does not include raw chat text, full prompts, provider keys, cookies, or headers.',
        'Artifact rows contain local paths only; artifact file export is a later phase.',
      ],
    },
    summary,
    errors,
    quality,
    canonical_counts: canonicalCounts,
    traces,
  };
}

export async function listTelemetryQuality(opts: {
  since: string;
  limit?: number;
}): Promise<{events: TelemetryEventRow[]; eval_scores: unknown[]}> {
  const limit = clampLimit(opts.limit ?? 50);
  const [events, evalRows] = await Promise.all([
    queryTelemetryEvents(
      `WHERE occurred_at >= $1::timestamptz
         AND (category = 'quality' OR schema_name LIKE 'quality.%')
       ORDER BY occurred_at DESC, id DESC
       LIMIT $2`,
      [opts.since, limit],
    ),
    query<Record<string, unknown>>(
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
        ORDER BY recorded_at DESC, id DESC
        LIMIT $2`,
      [opts.since, limit],
    ).then(result => result.rows),
  ]);
  return {events, eval_scores: evalRows};
}

// N-2 Phase 3 readiness gate. Counts two narrate-sanitizer signals
// over a window:
//
//   * `narrate.sanitiser.inspected` — every runtime narrate call.
//     The liveness precondition: `inspected_events > 0` proves the
//     sanitiser code path is reachable in the queried pgdata.
//   * `narrate.sanitiser.fired` — only when sanitization actually
//     changed the text. `patterns_fired` per row drives the
//     `phase3_blockers` tally; the four Phase 3 patterns
//     (`analysis_heading`, `stanislavski_label_bold`,
//     `stanislavski_label_plain`, `bracket_meta`) must report zero
//     for the gate to open.
//
// `ready_for_phase3` is `inspected_events > 0 && phase3_total === 0`.
// `total_events` (fired count) and the sample list are retained for
// dashboarding; the sample carries the existing 200-char
// `original_prefix` cap verbatim and no additional prose.
export interface NarrateSanitiserReadinessSample {
  occurred_at: string;
  patterns_fired: string[];
  original_length: number | null;
  sanitised_length: number | null;
  original_prefix: string;
}

export interface NarrateSanitiserReadinessReport {
  since: string;
  /** Per-call `narrate.sanitiser.fired` count — only the
   *  changed-text turns. Kept for backward compatibility with the
   *  CLI consumer payload shape. */
  total_events: number;
  /** N-2 Phase 3 readiness — per-call `narrate.sanitiser.inspected`
   *  count. This is the liveness precondition: a window with
   *  `inspected_events > 0` proves the runtime sanitizer code path is
   *  reachable even when the model never emitted anything the
   *  regexes needed to touch. `total_events` (the fired count) only
   *  covers changed-text turns, so it can be zero even on a healthy
   *  sanitizer; the gate uses `inspected_events` to avoid that
   *  ambiguity. */
  inspected_events: number;
  patterns_fired: Record<string, number>;
  phase3_blockers: {
    analysis_heading: number;
    stanislavski_label_bold: number;
    stanislavski_label_plain: number;
    bracket_meta: number;
  };
  phase3_total: number;
  ready_for_phase3: boolean;
  sample: NarrateSanitiserReadinessSample[];
  error?: string;
}

const PHASE3_PATTERN_IDS = [
  'analysis_heading',
  'stanislavski_label_bold',
  'stanislavski_label_plain',
  'bracket_meta',
] as const;

export async function narrateSanitiserReadinessReport(opts: {
  since: string;
  limit?: number;
}): Promise<NarrateSanitiserReadinessReport> {
  const limit = clampLimit(opts.limit ?? 20);
  const blockers = {
    analysis_heading: 0,
    stanislavski_label_bold: 0,
    stanislavski_label_plain: 0,
    bracket_meta: 0,
  };
  try {
    const rows = await queryTelemetryEvents(
      `WHERE event_name = $1 AND occurred_at >= $2::timestamptz
       ORDER BY occurred_at DESC, id DESC
       LIMIT $3`,
      ['narrate.sanitiser.fired', opts.since, limit],
    );
    const countRow = await query<{count: number}>(
      `SELECT COUNT(*)::int AS count
         FROM telemetry_events
        WHERE event_name = $1
          AND occurred_at >= $2::timestamptz`,
      ['narrate.sanitiser.fired', opts.since],
    );
    const totalEvents = Number(countRow.rows[0]?.count ?? rows.length);

    // N-2 Phase 3 readiness — per-call inspected count is the
    // liveness signal. It runs on every narrate (clean or changed)
    // so a zero-event window means the sanitizer code path is not
    // observably reachable in the queried pgdata, not "model output
    // was always clean".
    const inspectedCountRow = await query<{count: number}>(
      `SELECT COUNT(*)::int AS count
         FROM telemetry_events
        WHERE event_name = $1
          AND occurred_at >= $2::timestamptz`,
      ['narrate.sanitiser.inspected', opts.since],
    );
    const inspectedEvents = Number(inspectedCountRow.rows[0]?.count ?? 0);

    const patternCountsRow = await query<{patterns_fired: unknown}>(
      `SELECT properties->'patterns_fired' AS patterns_fired
         FROM telemetry_events
        WHERE event_name = $1
          AND occurred_at >= $2::timestamptz`,
      ['narrate.sanitiser.fired', opts.since],
    );
    const tally: Record<string, number> = {};
    for (const row of patternCountsRow.rows) {
      const ids = Array.isArray(row.patterns_fired) ? row.patterns_fired : [];
      for (const id of ids) {
        if (typeof id !== 'string') continue;
        tally[id] = (tally[id] ?? 0) + 1;
      }
    }
    for (const id of PHASE3_PATTERN_IDS) {
      blockers[id] = tally[id] ?? 0;
    }
    const phase3Total =
      blockers.analysis_heading
      + blockers.stanislavski_label_bold
      + blockers.stanislavski_label_plain
      + blockers.bracket_meta;

    const sample: NarrateSanitiserReadinessSample[] = rows.map(row => {
      const props = row.properties ?? {};
      const patternsRaw = (props as {patterns_fired?: unknown}).patterns_fired;
      const patterns = Array.isArray(patternsRaw)
        ? patternsRaw.filter((p): p is string => typeof p === 'string')
        : [];
      const originalLength = nullableNumber(
        (props as {original_length?: unknown}).original_length,
      );
      const sanitisedLength = nullableNumber(
        (props as {sanitised_length?: unknown}).sanitised_length,
      );
      const originalPrefix =
        typeof (props as {original_prefix?: unknown}).original_prefix === 'string'
          ? ((props as {original_prefix: string}).original_prefix)
          : '';
      return {
        occurred_at: row.occurred_at,
        patterns_fired: patterns,
        original_length: originalLength,
        sanitised_length: sanitisedLength,
        original_prefix: originalPrefix,
      };
    });

    return {
      since: opts.since,
      total_events: totalEvents,
      inspected_events: inspectedEvents,
      patterns_fired: tally,
      phase3_blockers: blockers,
      phase3_total: phase3Total,
      // N-2 Phase 3 gate — use the inspected count as the liveness
      // precondition; any Phase 3 firing in `narrate.sanitiser.fired`
      // remains a hard blocker.
      ready_for_phase3: inspectedEvents > 0 && phase3Total === 0,
      sample,
    };
  } catch (err) {
    return {
      since: opts.since,
      total_events: 0,
      inspected_events: 0,
      patterns_fired: {},
      phase3_blockers: blockers,
      phase3_total: 0,
      ready_for_phase3: false,
      sample: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function telemetryCanonicalCounts(opts: {
  since: string;
}): Promise<Array<{source: string; count: number}>> {
  const rows = await query<{source: string; count: number}>(
    `SELECT 'sessions' AS source, COUNT(*)::int AS count
       FROM sessions
      WHERE started_at >= $1::timestamptz
     UNION ALL
     SELECT 'chat_messages' AS source, COUNT(*)::int AS count
       FROM chat_messages
      WHERE created_at >= $1::timestamptz
     UNION ALL
     SELECT 'gui_events' AS source, COUNT(*)::int AS count
       FROM gui_events
      WHERE created_at >= $1::timestamptz
     UNION ALL
     SELECT 'tool_invocations' AS source, COUNT(*)::int AS count
       FROM tool_invocations
      WHERE invoked_at >= $1::timestamptz
     UNION ALL
     SELECT 'turn_telemetry' AS source, COUNT(*)::int AS count
       FROM turn_telemetry
      WHERE recorded_at >= $1::timestamptz
     UNION ALL
     SELECT 'performance_events' AS source, COUNT(*)::int AS count
       FROM performance_events
      WHERE recorded_at >= $1::timestamptz
     ORDER BY source`,
    [opts.since],
  );
  return rows.rows.map(row => ({
    source: row.source,
    count: Number(row.count ?? 0),
  }));
}

export async function getTelemetryTrace(traceId: string): Promise<{
  trace_id: string;
  spans: TelemetrySpanRow[];
  events: TelemetryEventRow[];
  artifacts: unknown[];
  eval_scores: unknown[];
  summary: {spans: number; events: number; failures: number; total_ms: number};
}> {
  const [spans, events, artifacts, evalRows] = await Promise.all([
    queryTelemetrySpans(
      `WHERE trace_id = $1 ORDER BY started_at ASC, id ASC`,
      [traceId],
    ),
    queryTelemetryEvents(
      `WHERE trace_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [traceId],
    ),
    query<Record<string, unknown>>(
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
              started_at::text AS started_at,
              ended_at::text AS ended_at,
              redaction_tier,
              metadata,
              source
         FROM telemetry_artifacts
        WHERE trace_id = $1
        ORDER BY recorded_at ASC, id ASC`,
      [traceId],
    ).then(result => result.rows),
    query<Record<string, unknown>>(
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
        WHERE trace_id = $1
        ORDER BY recorded_at ASC, id ASC`,
      [traceId],
    ).then(result => result.rows),
  ]);
  return {
    trace_id: traceId,
    spans,
    events,
    artifacts,
    eval_scores: evalRows,
    summary: {
      spans: spans.length,
      events: events.length,
      failures: spans.filter(span => isFailure(span.status, span.error)).length,
      total_ms: spans.reduce((sum, span) => sum + Number(span.duration_ms ?? 0), 0),
    },
  };
}

export async function getTelemetryTurn(turnId: string): Promise<{
  turn_id: string;
  traces: string[];
  spans: TelemetrySpanRow[];
  events: TelemetryEventRow[];
  summary: {spans: number; events: number; failures: number; total_ms: number};
}> {
  const [spans, events] = await Promise.all([
    queryTelemetrySpans(
      `WHERE turn_id = $1 ORDER BY started_at ASC, id ASC`,
      [turnId],
    ),
    queryTelemetryEvents(
      `WHERE turn_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [turnId],
    ),
  ]);
  const traces = [...new Set(spans.map(span => span.trace_id))];
  return {
    turn_id: turnId,
    traces,
    spans,
    events,
    summary: {
      spans: spans.length,
      events: events.length,
      failures: spans.filter(span => isFailure(span.status, span.error)).length,
      total_ms: spans.reduce((sum, span) => sum + Number(span.duration_ms ?? 0), 0),
    },
  };
}

async function queryTelemetrySpans(
  whereSql: string,
  params: unknown[],
): Promise<TelemetrySpanRow[]> {
  const rows = await query<TelemetrySpanRow>(
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
       ${whereSql}`,
    params,
  );
  return rows.rows.map(normalizeSpan);
}

async function queryTelemetryEvents(
  whereSql: string,
  params: unknown[],
): Promise<TelemetryEventRow[]> {
  const rows = await query<TelemetryEventRow>(
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
       ${whereSql}`,
    params,
  );
  return rows.rows.map(normalizeEvent);
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{count: number}>(sql, params);
  return Number(rows.rows[0]?.count ?? 0);
}

function normalizeSpan(row: TelemetrySpanRow): TelemetrySpanRow {
  return {
    ...row,
    id: Number(row.id),
    player_id: row.player_id == null ? null : Number(row.player_id),
    event_id: row.event_id == null ? null : Number(row.event_id),
    release_seq: row.release_seq == null ? null : Number(row.release_seq),
    duration_ms: nullableNumber(row.duration_ms),
    attributes: row.attributes ?? {},
    events: Array.isArray(row.events) ? row.events : [],
    links: Array.isArray(row.links) ? row.links : [],
  };
}

function normalizeEvent(row: TelemetryEventRow): TelemetryEventRow {
  return {
    ...row,
    id: Number(row.id),
    player_id: row.player_id == null ? null : Number(row.player_id),
    event_id: row.event_id == null ? null : Number(row.event_id),
    release_seq: row.release_seq == null ? null : Number(row.release_seq),
    schema_version: Number(row.schema_version ?? 1),
    properties: row.properties ?? {},
  };
}

function isFailure(status: string, error: string | null): boolean {
  return (status !== 'ok' && status !== 'skipped') || error != null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), 500));
}
