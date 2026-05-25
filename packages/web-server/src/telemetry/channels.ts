/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-2 — typed telemetry channels for the facade.
//
// The five-sink legacy split is preserved: each channel maps to one
// existing implementation module so this slice does not touch storage
// or retention behavior.  Channel matrix lives in
// docs/ops/telemetry-channels.md.

import type {Tier} from '../ai/classifier.js';
import type {
  PerformanceEventInput,
  PerformanceEventKind,
} from '../performanceTelemetry.js';
import type {
  TelemetryEventInput,
  TelemetryRedactionTier,
} from '../telemetryLake.js';
import type {TurnTelemetryRole} from '../turnTelemetry.js';

export type TelemetryChannel =
  | 'gameplay'
  | 'performance'
  | 'turn'
  | 'frontend'
  | 'desktop';

export interface TelemetryEventBase {
  channel: TelemetryChannel;
  name: string;
  sessionId?: string | null;
  playerId?: number | null;
  turnId?: string | null;
  traceId?: string | null;
}

export interface GameplayTelemetryEvent extends TelemetryEventBase {
  channel: 'gameplay';
  data?: Record<string, unknown>;
  error?: unknown;
}

export interface PerformanceTelemetryEvent extends TelemetryEventBase {
  channel: 'performance';
  kind: PerformanceEventKind | string;
  phase: string;
  status?: PerformanceEventInput['status'];
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

export interface TurnTelemetryEvent extends TelemetryEventBase {
  channel: 'turn';
  role: TurnTelemetryRole;
  modelId: string;
  thinking: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  durationMs: number;
  tier?: Tier;
}

export interface FrontendTelemetryEvent extends TelemetryEventBase {
  channel: 'frontend';
  schemaName?: string;
  schemaVersion?: number;
  category?: string;
  severity?: string;
  occurredAt?: string | null;
  properties?: Record<string, unknown>;
  redactionTier?: TelemetryRedactionTier;
}

export interface DesktopTelemetryEvent extends TelemetryEventBase {
  channel: 'desktop';
  schemaName?: string;
  schemaVersion?: number;
  category?: string;
  severity?: string;
  occurredAt?: string | null;
  properties?: Record<string, unknown>;
  redactionTier?: TelemetryRedactionTier;
}

export type TelemetryEvent =
  | GameplayTelemetryEvent
  | PerformanceTelemetryEvent
  | TurnTelemetryEvent
  | FrontendTelemetryEvent
  | DesktopTelemetryEvent;

/** Minimal sink contract — one async function per channel. The default
 *  implementation lives in `Telemetry.ts` and routes to the existing
 *  gameplayLog/performanceTelemetry/turnTelemetry/telemetryLake modules.
 *  Tests can pass fake sinks to `createTelemetry({sinks})`. */
export interface TelemetrySinks {
  gameplay: (event: GameplayTelemetryEvent) => Promise<void>;
  performance: (event: PerformanceTelemetryEvent) => Promise<void>;
  turn: (event: TurnTelemetryEvent) => Promise<void>;
  frontend: (event: FrontendTelemetryEvent) => Promise<void>;
  desktop: (event: DesktopTelemetryEvent) => Promise<void>;
}

export interface ToTelemetryEventInputArgs {
  source: 'frontend' | 'desktop';
  event: FrontendTelemetryEvent | DesktopTelemetryEvent;
}

/** Map a frontend/desktop facade event into the telemetryLake input. */
export function toTelemetryEventInput({
  source,
  event,
}: ToTelemetryEventInputArgs): TelemetryEventInput {
  return {
    sessionId: event.sessionId ?? null,
    playerId: event.playerId ?? null,
    turnId: event.turnId ?? null,
    traceId: event.traceId ?? null,
    schemaName: event.schemaName ?? `${source}.${event.name}`,
    schemaVersion: event.schemaVersion ?? 1,
    category: event.category ?? source,
    eventName: event.name,
    severity: event.severity ?? 'info',
    occurredAt: event.occurredAt ?? null,
    properties: event.properties ?? {},
    redactionTier: event.redactionTier ?? 'tier1_local_debug',
    validationStatus: 'valid',
    source,
  };
}
