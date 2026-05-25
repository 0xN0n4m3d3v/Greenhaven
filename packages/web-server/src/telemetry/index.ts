/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-2 — Public surface for the telemetry facade. Hot-path callers
// should import from here instead of the per-sink modules.
//
// `measure` is a passthrough to `measurePhase` so wrapped-phase semantics
// (sample start, status/error classification, durationMs/cpu/rss/etc.
// auto-attached) stay identical. Callers don't need to import
// `performanceTelemetry.js` directly. `startPerformanceSample` +
// `eventFromSample` are re-exported for the tool layer so it can build
// a sampled `PerformanceEventInput`-shaped payload and feed it into
// `telemetry.record({channel: 'performance', name, ...sampled})`.

import {
  eventFromSample,
  measurePhase,
  startPerformanceSample,
} from '../performanceTelemetry.js';

export {
  createTelemetry,
  defaultTelemetrySinks,
  telemetry,
  type TelemetryFacade,
} from './Telemetry.js';
export {
  toTelemetryEventInput,
  type DesktopTelemetryEvent,
  type FrontendTelemetryEvent,
  type GameplayTelemetryEvent,
  type PerformanceTelemetryEvent,
  type TelemetryChannel,
  type TelemetryEvent,
  type TelemetryEventBase,
  type TelemetrySinks,
  type TurnTelemetryEvent,
} from './channels.js';
export type {TurnTelemetryRole} from '../turnTelemetry.js';

export const measure = measurePhase;
export {eventFromSample, startPerformanceSample};
