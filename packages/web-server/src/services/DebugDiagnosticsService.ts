/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 — service ownership for /api/debug diagnostics + /api/admin/usage.
// Dynamic imports stay inside the service so devtools, telemetry, DB, tool
// registry, and live-playtest modules still defer to first invocation.

import { config } from '../config.js';

export interface RouteOutcome {
  status: number;
  body: unknown;
}

export interface SinceOpts {
  minutes?: number | null;
  since?: string | null;
}

export interface LivePlaytestStateInput {
  playerId?: number | null;
  sessionId?: string | null;
  limit?: number | null;
}

export interface LivePlaytestOpsInput extends LivePlaytestStateInput {
  ops?: unknown[];
}

export interface LivePlaytestPresetInput extends LivePlaytestStateInput {
  preset?: string | null;
  options?: unknown;
}

export interface AdminUsageInput {
  adminKeyHeader: string | null;
  since?: string | null;
  playerId?: number | null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function coercePositiveInt(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function looksLikeIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function computeSince(
  opts: SinceOpts,
  sinceIso: (minutes: number) => string,
): string {
  const minutes =
    opts.minutes != null && Number.isFinite(opts.minutes)
      ? Number(opts.minutes)
      : 60;
  return looksLikeIsoTimestamp(opts.since) ? (opts.since as string) : sinceIso(minutes);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeSinceClauseAndParams(sinceParam: string | null | undefined): {
  clause: string;
  params: unknown[];
} {
  const useDefault =
    !sinceParam || !/^[\w\-:.\s'+]+$/.test(String(sinceParam));
  return useDefault
    ? { clause: `now() - interval '24 hours'`, params: [] }
    : { clause: `$1::timestamptz`, params: [String(sinceParam)] };
}

function ok(body: unknown): RouteOutcome {
  return { status: 200, body };
}

function bad(error: string): RouteOutcome {
  return { status: 400, body: { error } };
}

function forbidden(error: string): RouteOutcome {
  return { status: 403, body: { error } };
}

export class DebugDiagnosticsService {
  static async getPerf(
    opts: SinceOpts & { limit?: number | null },
  ): Promise<RouteOutcome> {
    const { buildPerformanceDiagnostics, sinceIso } = await import(
      '../devtools/performanceDiagnostics.js'
    );
    const since = computeSince(opts, sinceIso);
    const limit = Number(opts.limit ?? 20);
    return ok(await buildPerformanceDiagnostics({ since, limit }));
  }

  static async getPerfHotspots(
    opts: SinceOpts & { limit?: number | null },
  ): Promise<RouteOutcome> {
    const { listPerformanceHotspots, sinceIso } = await import(
      '../devtools/performanceDiagnostics.js'
    );
    const since = computeSince(opts, sinceIso);
    const limit = Number(opts.limit ?? 30);
    return ok({
      since,
      hotspots: await listPerformanceHotspots({ since, limit }),
    });
  }

  static async getPerfFailures(
    opts: SinceOpts & { limit?: number | null },
  ): Promise<RouteOutcome> {
    const { listPerformanceFailures, sinceIso } = await import(
      '../devtools/performanceDiagnostics.js'
    );
    const since = computeSince(opts, sinceIso);
    const limit = Number(opts.limit ?? 50);
    return ok({
      since,
      failures: await listPerformanceFailures({ since, limit }),
    });
  }

  static async getPerfTurn(turnId: string | undefined): Promise<RouteOutcome> {
    if (!turnId) return bad('turnId required');
    const { getPerformanceTurn } = await import(
      '../devtools/performanceDiagnostics.js'
    );
    return ok(await getPerformanceTurn(turnId));
  }

  static async getTelemetrySummary(
    opts: SinceOpts & { limit?: number | null },
  ): Promise<RouteOutcome> {
    const { buildTelemetrySummary, sinceIso } = await import(
      '../devtools/telemetryDiagnostics.js'
    );
    const since = computeSince(opts, sinceIso);
    const limit = Number(opts.limit ?? 30);
    return ok(await buildTelemetrySummary({ since, limit }));
  }

  static async getTelemetryHealth(opts: SinceOpts): Promise<RouteOutcome> {
    const { telemetryHealth, sinceIso } = await import(
      '../devtools/telemetryDiagnostics.js'
    );
    const since = computeSince(opts, sinceIso);
    return ok({ since, health: await telemetryHealth({ since }) });
  }

  static async getTelemetryErrors(
    opts: SinceOpts & { limit?: number | null },
  ): Promise<RouteOutcome> {
    const { listTelemetryErrors, sinceIso } = await import(
      '../devtools/telemetryDiagnostics.js'
    );
    const since = computeSince(opts, sinceIso);
    const limit = Number(opts.limit ?? 50);
    return ok({ since, ...(await listTelemetryErrors({ since, limit })) });
  }

  static async getTelemetryQuality(
    opts: SinceOpts & { limit?: number | null },
  ): Promise<RouteOutcome> {
    const { listTelemetryQuality, sinceIso } = await import(
      '../devtools/telemetryDiagnostics.js'
    );
    const since = computeSince(opts, sinceIso);
    const limit = Number(opts.limit ?? 50);
    return ok({ since, ...(await listTelemetryQuality({ since, limit })) });
  }

  static async getTelemetryTrace(
    traceId: string | undefined,
  ): Promise<RouteOutcome> {
    if (!traceId) return bad('traceId required');
    const { getTelemetryTrace } = await import(
      '../devtools/telemetryDiagnostics.js'
    );
    return ok(await getTelemetryTrace(traceId));
  }

  static async getTelemetryTurn(
    turnId: string | undefined,
  ): Promise<RouteOutcome> {
    if (!turnId) return bad('turnId required');
    const { getTelemetryTurn } = await import(
      '../devtools/telemetryDiagnostics.js'
    );
    return ok(await getTelemetryTurn(turnId));
  }

  static async postTelemetryBundle(opts: {
    since?: string | null;
    minutes?: number | null;
    limit?: number | null;
    traceLimit?: number | null;
    persist?: boolean;
  }): Promise<RouteOutcome> {
    const { buildTelemetryBundle, sinceIso } = await import(
      '../devtools/telemetryDiagnostics.js'
    );
    const { writeTelemetryJsonArtifact } = await import(
      '../telemetryArtifacts.js'
    );
    const minutes = Number(opts.minutes ?? 60);
    const sinceParam = String(opts.since ?? '');
    const since = looksLikeIsoTimestamp(sinceParam)
      ? sinceParam
      : sinceIso(minutes);
    const limit = Number(opts.limit ?? 50);
    const traceLimit = Number(opts.traceLimit ?? 5);
    const bundle = await buildTelemetryBundle({ since, limit, traceLimit });
    if (!opts.persist) return ok(bundle);
    const artifact = await writeTelemetryJsonArtifact({
      artifactType: 'diagnostic_bundle',
      filenamePrefix: 'telemetry-bundle',
      payload: bundle,
      context: {
        traceId: `telemetry-bundle-${Date.now()}`,
      },
      redactionTier: 'tier1_local_debug',
      metadata: {
        since,
        limit,
        trace_limit: traceLimit,
        schema: bundle.schema,
      },
      source: 'debug.telemetry_bundle',
    });
    return ok({ ...bundle, persisted_artifact: artifact });
  }

  static async postTelemetryRetention(opts: {
    safeDays?: number | null;
    debugDays?: number | null;
    sensitiveDays?: number | null;
    metricDays?: number | null;
    performanceDays?: number | null;
    artifactDays?: number | null;
    maxArtifactBytes?: number | null;
    dryRun?: boolean;
  }): Promise<RouteOutcome> {
    const { applyTelemetryRetention } = await import(
      '../telemetryArtifacts.js'
    );
    return ok(
      await applyTelemetryRetention({
        safeDays: opts.safeDays ?? undefined,
        debugDays: opts.debugDays ?? undefined,
        sensitiveDays: opts.sensitiveDays ?? undefined,
        metricDays: opts.metricDays ?? undefined,
        performanceDays: opts.performanceDays ?? undefined,
        artifactDays: opts.artifactDays ?? undefined,
        maxArtifactBytes: opts.maxArtifactBytes ?? undefined,
        dryRun: opts.dryRun ?? false,
      }),
    );
  }

  static async postTelemetryDeveloperExport(opts: {
    since?: string | null;
    minutes?: number | null;
    limit?: number | null;
    formats?: Array<'jsonl' | 'otlp'> | undefined;
    write?: boolean;
    postOtlp?: boolean;
    otlpEndpoint?: string | null;
    allowRemote?: boolean;
  }): Promise<RouteOutcome> {
    const { buildTelemetryDeveloperExport } = await import(
      '../devtools/telemetryDeveloperExport.js'
    );
    return ok(
      await buildTelemetryDeveloperExport({
        since: opts.since || undefined,
        minutes: opts.minutes ?? undefined,
        limit: opts.limit ?? undefined,
        formats: opts.formats,
        write: opts.write ?? false,
        postOtlp: opts.postOtlp ?? false,
        otlpEndpoint: opts.otlpEndpoint || undefined,
        allowRemote: opts.allowRemote ?? false,
      }),
    );
  }

  static async getSessionMessagesDiag(opts: {
    sessionId?: string | null;
    limit?: number | null;
  }): Promise<RouteOutcome> {
    const { query } = await import('../db.js');
    const { sessionManager } = await import('../sessionManager.js');
    const { buildSessionTranscriptDiagnostics } = await import(
      '../devtools/sessionTranscriptDiagnostics.js'
    );
    const r = await query<{
      session_id: string | null;
      n: number;
      last_at: string;
    }>(
      `SELECT session_id, COUNT(*)::int AS n, MAX(created_at)::text AS last_at
         FROM chat_messages
        GROUP BY session_id
        ORDER BY MAX(created_at) DESC
        LIMIT 10`,
    );
    const inMemory = [...sessionManager.entries()].map(([id]) => id);
    const requestedSessionId = opts.sessionId ?? null;
    const selectedSessionId =
      requestedSessionId ||
      r.rows.find((row) => row.session_id != null)?.session_id ||
      null;
    const limitRaw = Number(opts.limit ?? 80);
    const transcript = await buildSessionTranscriptDiagnostics({
      sessionId: selectedSessionId,
      limit: limitRaw,
    });
    return ok({
      chat_messages_by_session: r.rows,
      in_memory_sessions: inMemory,
      ...transcript,
    });
  }

  static async getRecentEntities(): Promise<RouteOutcome> {
    const { query } = await import('../db.js');
    const r = await query<{
      id: number;
      kind: string;
      display_name: string;
      summary: string | null;
      tags: string[] | null;
      profile: unknown;
    }>(
      `SELECT id, kind, display_name, summary, tags, profile
         FROM entities ORDER BY id DESC LIMIT 30`,
    );
    return ok({ entities: r.rows });
  }

  static async getTools(): Promise<RouteOutcome> {
    const { getRegisteredTools } = await import('../tools/index.js');
    const tools = Array.from(getRegisteredTools().values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
    return ok({ count: tools.length, tools });
  }

  static async getLiveState(
    opts: LivePlaytestStateInput,
  ): Promise<RouteOutcome> {
    const playerId = coercePositiveInt(opts.playerId);
    if (playerId === null) return bad('playerId_required');
    const { captureLivePlaytestState } = await import(
      '../devtools/livePlaytestControlPlane.js'
    );
    try {
      return ok(
        await captureLivePlaytestState({
          playerId,
          sessionId: opts.sessionId || undefined,
          limit: opts.limit ?? undefined,
        }),
      );
    } catch (err) {
      return {
        status: 400,
        body: { error: 'live_state_failed', message: errorMessage(err) },
      };
    }
  }

  static async postLiveOps(opts: LivePlaytestOpsInput): Promise<RouteOutcome> {
    const playerId = coercePositiveInt(opts.playerId);
    if (playerId === null) return bad('playerId_required');
    const { applyLivePlaytestOperations } = await import(
      '../devtools/livePlaytestControlPlane.js'
    );
    try {
      return ok(
        await applyLivePlaytestOperations({
          playerId,
          sessionId: opts.sessionId || undefined,
          limit: opts.limit ?? undefined,
          ops: Array.isArray(opts.ops) ? opts.ops : [],
        }),
      );
    } catch (err) {
      return {
        status: 400,
        body: { error: 'live_ops_failed', message: errorMessage(err) },
      };
    }
  }

  static async postLivePreset(
    opts: LivePlaytestPresetInput,
  ): Promise<RouteOutcome> {
    const playerId = coercePositiveInt(opts.playerId);
    if (playerId === null) return bad('playerId_required');
    const preset = String(opts.preset ?? '');
    if (!preset.trim()) return bad('preset_required');
    const { applyLivePlaytestPreset } = await import(
      '../devtools/livePlaytestControlPlane.js'
    );
    try {
      return ok(
        await applyLivePlaytestPreset({
          playerId,
          sessionId: opts.sessionId || undefined,
          limit: opts.limit ?? undefined,
          preset,
          options: opts.options,
        }),
      );
    } catch (err) {
      return {
        status: 400,
        body: { error: 'live_preset_failed', message: errorMessage(err) },
      };
    }
  }

  static async getSessionDiag(opts: { date?: string | null }): Promise<RouteOutcome> {
    const { query } = await import('../db.js');
    const dateRaw = opts.date;
    const date =
      dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
        ? dateRaw
        : new Date().toISOString().slice(0, 10);

    async function safe<T>(
      name: string,
      q: () => Promise<T>,
    ): Promise<T | { __error: string }> {
      try {
        return await q();
      } catch (err) {
        return {
          __error: `${name}: ${err instanceof Error ? err.message : String(err)}`,
        } as T | { __error: string };
      }
    }

    const sevenDaysAgo = new Date(date + 'T00:00:00Z');
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
    const since7d = sevenDaysAgo.toISOString().slice(0, 10);

    const toolsToday = await safe('toolsToday', () =>
      query<{ tool_name: string; n: number; errs: number }>(
        `SELECT tool_name,
                COUNT(*)::int AS n,
                SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)::int AS errs
           FROM tool_invocations
          WHERE invoked_at::date = $1::date
          GROUP BY tool_name ORDER BY n DESC`,
        [date],
      ),
    );
    const tools7d = await safe('tools7d', () =>
      query<{ tool_name: string; n: number }>(
        `SELECT tool_name, COUNT(*)::int AS n
           FROM tool_invocations
          WHERE invoked_at::date >= $1::date
          GROUP BY tool_name ORDER BY n DESC`,
        [since7d],
      ),
    );
    const memToday = await safe('memToday', async () => {
      const { selectDiagnosticsNpcMemoriesForDate } = await import(
        '../domain/memory/index.js'
      );
      const rows = await selectDiagnosticsNpcMemoriesForDate(date);
      return { rows };
    });
    const turns = await safe('turns', () =>
      query<{ role: string; n: number; cost: string }>(
        `SELECT role, COUNT(*)::int AS n, COALESCE(SUM(cost_usd),0)::text AS cost
           FROM turn_telemetry
          WHERE recorded_at::date = $1::date
          GROUP BY role ORDER BY n DESC`,
        [date],
      ),
    );
    const chats = await safe('chats', () =>
      query<{ n: number; players: number }>(
        `SELECT COUNT(*)::int AS n, COUNT(DISTINCT player_id)::int AS players
           FROM chat_messages WHERE created_at::date = $1::date`,
        [date],
      ),
    );
    const protagonistRenderer = await safe('protagonistRenderer', () =>
      query<{
        n: number;
        enabled: number;
        changed: number;
        skipped: number;
        timeouts: number;
      }>(
        `SELECT COUNT(*)::int AS n,
                SUM(CASE WHEN payload->'protagonist_renderer'->>'enabled' = 'true' THEN 1 ELSE 0 END)::int AS enabled,
                SUM(CASE WHEN payload->'protagonist_renderer'->>'changed' = 'true' THEN 1 ELSE 0 END)::int AS changed,
                SUM(CASE WHEN COALESCE(payload->'protagonist_renderer'->>'skipped_reason', '') <> '' THEN 1 ELSE 0 END)::int AS skipped,
                SUM(CASE WHEN COALESCE(payload->'protagonist_renderer'->>'skipped_reason', '') LIKE 'timeout_%' THEN 1 ELSE 0 END)::int AS timeouts
           FROM chat_messages
          WHERE created_at::date = $1::date
            AND tone = 'player'
            AND payload->'protagonist_renderer' IS NOT NULL`,
        [date],
      ),
    );
    const protagonistRendererSkipped = await safe(
      'protagonistRendererSkipped',
      () =>
        query<{
          skipped_reason: string;
          n: number;
        }>(
          `SELECT COALESCE(payload->'protagonist_renderer'->>'skipped_reason', 'changed') AS skipped_reason,
                  COUNT(*)::int AS n
             FROM chat_messages
            WHERE created_at::date = $1::date
              AND tone = 'player'
              AND payload->'protagonist_renderer' IS NOT NULL
            GROUP BY skipped_reason
            ORDER BY n DESC, skipped_reason`,
          [date],
        ),
    );
    const combatToday = await safe('combat', () =>
      query<{
        invoked_at: string;
        player_id: number | null;
        args: unknown;
      }>(
        `SELECT invoked_at::text AS invoked_at, player_id, args
           FROM tool_invocations
          WHERE invoked_at::date >= $1::date
            AND tool_name IN ('damage', 'heal', 'mark_downed', 'death_save')
          ORDER BY invoked_at DESC LIMIT 30`,
        [since7d],
      ),
    );
    const questsToday = await safe('quests', () =>
      query<{
        invoked_at: string;
        tool_name: string;
        player_id: number | null;
        args: unknown;
      }>(
        `SELECT invoked_at::text AS invoked_at, tool_name, player_id, args
           FROM tool_invocations
          WHERE invoked_at::date >= $1::date
            AND tool_name IN ('start_quest', 'advance_quest', 'complete_quest', 'create_quest')
          ORDER BY invoked_at DESC LIMIT 30`,
        [since7d],
      ),
    );
    const errsToday = await safe('errs', () =>
      query<{
        invoked_at: string;
        tool_name: string;
        args: unknown;
        error: string;
      }>(
        `SELECT invoked_at::text AS invoked_at, tool_name, args, error
           FROM tool_invocations
          WHERE invoked_at::date = $1::date AND error IS NOT NULL
          ORDER BY invoked_at DESC LIMIT 20`,
        [date],
      ),
    );
    const playerState = await safe('playerState', () =>
      query<{
        entity_id: number;
        display_name: string;
        dialogue_partner_id: number | null;
        current_location_id: number | null;
        current_scene_id: number | null;
        current_hp: number;
        max_hp: number;
        current_level: number;
        current_xp: number;
      }>(
        `SELECT p.entity_id, e.display_name, p.dialogue_partner_id,
                p.current_location_id, p.current_scene_id,
                p.current_hp, p.max_hp, p.current_level, p.current_xp
           FROM players p JOIN entities e ON e.id = p.entity_id
          ORDER BY p.entity_id DESC LIMIT 10`,
      ),
    );
    const recentChats = await safe('recentChats', () =>
      query<{
        created_at: string;
        author_entity_id: number | null;
        tone: string | null;
        text: string;
      }>(
        `SELECT created_at::text AS created_at, author_entity_id, tone, text
           FROM chat_messages
          WHERE created_at::date = $1::date
          ORDER BY created_at ASC
          LIMIT 30`,
        [date],
      ),
    );
    const dynamicQuests = await safe('dynamicQuests', () =>
      query<{
        id: number;
        display_name: string;
        summary: string | null;
        profile: unknown;
        tags: string[] | null;
      }>(
        `SELECT id, display_name, summary, profile, tags
           FROM entities
          WHERE kind = 'quest' AND dynamic_origin = true
          ORDER BY id DESC LIMIT 30`,
      ),
    );

    type Bag = { rows?: unknown[]; __error?: string };
    function rows(b: unknown): unknown[] | string {
      const x = b as Bag;
      if (x?.__error) return x.__error;
      return x?.rows ?? [];
    }
    return ok({
      date,
      tools_today: rows(toolsToday),
      tools_7d: rows(tools7d),
      memories_today: rows(memToday),
      turns_today: rows(turns),
      chats_today:
        ((chats as Bag).rows ?? [])[0] ?? (chats as Bag).__error ?? null,
      protagonist_renderer_today:
        ((protagonistRenderer as Bag).rows ?? [])[0] ??
        (protagonistRenderer as Bag).__error ??
        null,
      protagonist_renderer_skipped_today: rows(protagonistRendererSkipped),
      combat_invocations_7d: rows(combatToday),
      quest_invocations_7d: rows(questsToday),
      dynamic_quests: rows(dynamicQuests),
      recent_chats: rows(recentChats),
      errors_today: rows(errsToday),
      player_state: rows(playerState),
    });
  }

  static async getCost(opts: {
    since?: string | null;
  }): Promise<RouteOutcome> {
    const { query } = await import('../db.js');
    const { clause: sinceClause, params } = safeSinceClauseAndParams(
      opts.since,
    );
    const totals = await query<{ n: number; cost: string }>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(cost_usd),0)::text AS cost
         FROM turn_telemetry WHERE recorded_at >= ${sinceClause}`,
      params,
    );
    const byRole = await query<{
      role: string;
      n: number;
      avg_cost: string;
      avg_ms: number;
    }>(
      `SELECT role,
              COUNT(*)::int AS n,
              COALESCE(AVG(cost_usd),0)::text AS avg_cost,
              COALESCE(AVG(duration_ms),0)::int AS avg_ms
         FROM turn_telemetry WHERE recorded_at >= ${sinceClause}
         GROUP BY role ORDER BY role`,
      params,
    );
    const recent = await query<{
      turn_id: string;
      role: string;
      model_id: string;
      cost_usd: string;
      duration_ms: number;
    }>(
      `SELECT turn_id, role, model_id, cost_usd::text, duration_ms
         FROM turn_telemetry ORDER BY recorded_at DESC LIMIT 50`,
    );
    return ok({
      totals: totals.rows[0] ?? { n: 0, cost: '0' },
      byRole: byRole.rows,
      recent: recent.rows,
    });
  }

  /** Pure gating helper — separated from config reads so tests can
   *  exercise admin_key_required / forbidden branches deterministically. */
  static checkAdminAccess(opts: {
    nodeEnv: string;
    adminKey: string | null | undefined;
    adminKeyHeader: string | null | undefined;
  }): RouteOutcome | null {
    if (opts.nodeEnv === 'production' && !opts.adminKey) {
      return forbidden('admin_key_required');
    }
    if (opts.adminKey && opts.adminKeyHeader !== opts.adminKey) {
      return forbidden('forbidden');
    }
    return null;
  }

  /** GET /admin/usage — gated by config().nodeEnv + config().adminKey. */
  static async getAdminUsage(opts: AdminUsageInput): Promise<RouteOutcome> {
    const cfg = config();
    const denied = this.checkAdminAccess({
      nodeEnv: cfg.nodeEnv,
      adminKey: cfg.adminKey,
      adminKeyHeader: opts.adminKeyHeader,
    });
    if (denied) return denied;
    const { query } = await import('../db.js');
    const { clause: sinceClause, params: baseParams } =
      safeSinceClauseAndParams(opts.since);
    const playerId = coercePositiveInt(opts.playerId);
    const playerWhere = isPositiveInt(playerId)
      ? ` AND player_id = $${baseParams.length + 1}`
      : '';
    const params = isPositiveInt(playerId)
      ? [...baseParams, playerId]
      : baseParams;
    const totals = await query<{ n: number; cost: string }>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(cost_usd),0)::text AS cost
         FROM turn_telemetry
        WHERE recorded_at >= ${sinceClause}${playerWhere}`,
      params,
    );
    const byPlayer = await query<{
      player_id: number | null;
      turns: number;
      cost: string;
      avg_ms: number;
    }>(
      `SELECT player_id,
              COUNT(*)::int AS turns,
              COALESCE(SUM(cost_usd),0)::text AS cost,
              COALESCE(AVG(duration_ms),0)::int AS avg_ms
         FROM turn_telemetry
        WHERE recorded_at >= ${sinceClause}${playerWhere}
        GROUP BY player_id
        ORDER BY cost DESC NULLS LAST
        LIMIT 100`,
      params,
    );
    return ok({
      totals: totals.rows[0] ?? { n: 0, cost: '0' },
      byPlayer: byPlayer.rows,
    });
  }
}

export const debugDiagnosticsServiceInternals = {
  computeSince,
  safeSinceClauseAndParams,
  coercePositiveInt,
  looksLikeIsoTimestamp,
};
