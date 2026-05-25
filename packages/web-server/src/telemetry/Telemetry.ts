/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-2 — Telemetry facade. `record()` is fire-and-forget from the
// caller's perspective; the facade tracks pending promises so tests
// (and shutdown paths) can await `flush()`. Sink failures are
// swallowed and logged to stderr — telemetry must never crash the turn
// loop.

import {appendGameplayLog} from '../gameplayLog.js';
import {recordPerformanceEvent} from '../performanceTelemetry.js';
import {recordTelemetryEvent, tryRecordTelemetryEvent} from '../telemetryLake.js';
import {recordTurnTelemetry} from '../turnTelemetry.js';
import {
  toTelemetryEventInput,
  type DesktopTelemetryEvent,
  type FrontendTelemetryEvent,
  type GameplayTelemetryEvent,
  type PerformanceTelemetryEvent,
  type TelemetryEvent,
  type TelemetrySinks,
  type TurnTelemetryEvent,
} from './channels.js';

// N-2 Phase 3 readiness gate — the gameplay channel writes JSONL by
// default, but the readiness report queries `telemetry_events`. To
// avoid a silent observability gap, mirror this narrowly-scoped
// whitelist of sanitizer gameplay events into the telemetry lake
// alongside the JSONL append. Other gameplay events keep their
// JSONL-only retention semantics.
const GAMEPLAY_LAKE_MIRROR_EVENTS: ReadonlySet<string> = new Set([
  'narrate.sanitiser.inspected',
  'narrate.sanitiser.fired',
]);

function mirroredGameplayEventName(event: GameplayTelemetryEvent): string {
  // `narrate.sanitiser.fired` → `gameplay.narrate_sanitiser_fired`
  return `gameplay.${event.name.replace(/\./g, '_')}`;
}

export interface TelemetryFacade {
  record(event: TelemetryEvent): void;
  flush(): Promise<void>;
  pendingCount(): number;
}

// N-2 Phase 3 mirror diagnostics — log per whitelisted-event progress
// through the gameplay sink with metadata only (event name, ids,
// schema, error message). Never log prose or `original_prefix`. Set
// `GREENHAVEN_GAMEPLAY_MIRROR_LOG=0` to silence these breadcrumbs;
// default is on so packaged desktop runs surface mirror behaviour to
// `desktop.log`.
function gameplayMirrorLogEnabled(): boolean {
  return process.env.GREENHAVEN_GAMEPLAY_MIRROR_LOG !== '0';
}

function mirrorLog(
  stage:
    | 'event_emitted'
    | 'jsonl_attempted'
    | 'jsonl_succeeded'
    | 'jsonl_failed'
    | 'lake_attempted'
    | 'lake_succeeded'
    | 'lake_failed',
  meta: Record<string, unknown>,
): void {
  if (!gameplayMirrorLogEnabled()) return;
  const isFailure = stage === 'jsonl_failed' || stage === 'lake_failed';
  const sink = isFailure ? console.warn : console.log;
  sink(`[telemetry-mirror] ${stage}`, meta);
}

export function defaultTelemetrySinks(): TelemetrySinks {
  return {
    gameplay: async (event: GameplayTelemetryEvent) => {
      const whitelisted = GAMEPLAY_LAKE_MIRROR_EVENTS.has(event.name);
      const baseMeta = {
        name: event.name,
        sessionId: event.sessionId ?? null,
        playerId: event.playerId ?? null,
        turnId: event.turnId ?? null,
        traceId: event.traceId ?? null,
        whitelisted,
      };
      if (whitelisted) mirrorLog('event_emitted', baseMeta);

      if (whitelisted) mirrorLog('jsonl_attempted', baseMeta);
      try {
        await appendGameplayLog({
          type: event.name,
          sessionId: event.sessionId ?? null,
          playerId: event.playerId ?? null,
          turnId: event.turnId ?? null,
          traceId: event.traceId ?? null,
          data: event.data,
          error: event.error,
        });
        if (whitelisted) mirrorLog('jsonl_succeeded', baseMeta);
      } catch (err) {
        if (whitelisted) {
          mirrorLog('jsonl_failed', {
            ...baseMeta,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }

      if (whitelisted) {
        // N-2 Phase 3 — mirror narrate-sanitizer signals into the
        // telemetry lake so `narrateSanitiserReadinessReport()` can
        // count them. Redaction stays `tier1_local_debug` because the
        // payload may carry an `original_prefix` (capped at 200
        // chars) for changed-text rows. We use the resultful
        // `tryRecordTelemetryEvent` so a silently-failed INSERT
        // surfaces as a `lake_failed` breadcrumb in `desktop.log`
        // (or stderr in dev).
        const schemaName = mirroredGameplayEventName(event);
        mirrorLog('lake_attempted', {...baseMeta, schemaName});
        const result = await tryRecordTelemetryEvent({
          sessionId: event.sessionId ?? null,
          playerId: event.playerId ?? null,
          turnId: event.turnId ?? null,
          traceId: event.traceId ?? null,
          schemaName,
          schemaVersion: 1,
          category: 'gameplay',
          eventName: event.name,
          severity: 'info',
          properties: event.data ?? {},
          redactionTier: 'tier1_local_debug',
          validationStatus: 'valid',
          source: 'narrate_tool',
        });
        if (result.ok) {
          mirrorLog('lake_succeeded', {...baseMeta, schemaName});
        } else {
          mirrorLog('lake_failed', {
            ...baseMeta,
            schemaName,
            error: result.error,
          });
        }
      }
    },
    performance: async (event: PerformanceTelemetryEvent) => {
      await recordPerformanceEvent({
        sessionId: event.sessionId ?? null,
        playerId: event.playerId ?? null,
        turnId: event.turnId ?? null,
        traceId: event.traceId ?? null,
        kind: event.kind,
        phase: event.phase,
        status: event.status,
        durationMs: event.durationMs ?? null,
        cpuUserUs: event.cpuUserUs ?? null,
        cpuSystemUs: event.cpuSystemUs ?? null,
        rssBytes: event.rssBytes ?? null,
        heapUsedBytes: event.heapUsedBytes ?? null,
        externalBytes: event.externalBytes ?? null,
        eventLoopUtilization: event.eventLoopUtilization ?? null,
        metadata: event.metadata,
        error: event.error ?? null,
      });
    },
    turn: async (event: TurnTelemetryEvent) => {
      await recordTurnTelemetry({
        sessionId: event.sessionId ?? '',
        turnId: event.turnId ?? '',
        role: event.role,
        modelId: event.modelId,
        thinking: event.thinking,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheHitTokens: event.cacheHitTokens,
        cacheMissTokens: event.cacheMissTokens,
        durationMs: event.durationMs,
        tier: event.tier,
      });
    },
    frontend: async (event: FrontendTelemetryEvent) => {
      await recordTelemetryEvent(
        toTelemetryEventInput({source: 'frontend', event}),
      );
    },
    desktop: async (event: DesktopTelemetryEvent) => {
      await recordTelemetryEvent(
        toTelemetryEventInput({source: 'desktop', event}),
      );
    },
  };
}

export function createTelemetry(
  sinks: TelemetrySinks = defaultTelemetrySinks(),
): TelemetryFacade {
  const pending = new Set<Promise<void>>();

  function dispatch(event: TelemetryEvent): Promise<void> {
    switch (event.channel) {
      case 'gameplay':
        return sinks.gameplay(event);
      case 'performance':
        return sinks.performance(event);
      case 'turn':
        return sinks.turn(event);
      case 'frontend':
        return sinks.frontend(event);
      case 'desktop':
        return sinks.desktop(event);
    }
  }

  function record(event: TelemetryEvent): void {
    let p: Promise<void>;
    try {
      p = dispatch(event);
    } catch (err) {
      // CATCH-WARN-OK: the telemetry facade IS the sink; calling telemetry.record() here would re-enter the failing dispatcher.
      console.warn('[telemetry] sink threw synchronously', {
        channel: event.channel,
        name: event.name,
        err,
      });
      return;
    }
    const tracked = p.catch((err) => {
      // CATCH-WARN-OK: the telemetry facade IS the sink; calling telemetry.record() here would re-enter the failing dispatcher.
      console.warn('[telemetry] sink rejected', {
        channel: event.channel,
        name: event.name,
        err: err instanceof Error ? err.message : err,
      });
    });
    pending.add(tracked);
    // VOID-FF-OK: bookkeeping `.finally` handler that only cleans the `pending` set; the underlying rejection was already swallowed by the `.catch` above.
    void tracked.finally(() => {
      pending.delete(tracked);
    });
  }

  async function flush(): Promise<void> {
    while (pending.size > 0) {
      const snapshot = [...pending];
      await Promise.allSettled(snapshot);
    }
  }

  return {
    record,
    flush,
    pendingCount: () => pending.size,
  };
}

export const telemetry: TelemetryFacade = createTelemetry();
