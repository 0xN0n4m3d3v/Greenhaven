/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — Turn lifecycle phase contract.
//
// A Phase is a named, runnable step of a turn. The full
// `turnRunnerV2.runTurn` body will move into Phases incrementally;
// this slice only introduces the contract so the lifecycle scaffold
// can take shape without rewriting the whole runner.
//
// Design constraints (per ARCH-1 spec):
//   - No EventEmitter, no hidden async bus.
//   - No phase-to-phase implicit dispatch — the lifecycle orchestrates
//     order explicitly.
//   - The TurnContext carries a typed mutable `state` bag so a phase
//     can hand data to a later phase without coupling.
//
// This file deliberately stays tiny.  Adding base-class machinery,
// hooks, or cancellation plumbing here would be premature: USER-1 /
// USER-2 close-out only needs the lifecycle scaffold to exist.

import type {TurnContext} from './TurnContext.js';

export interface Phase {
  /** Stable identifier used in logs/telemetry. */
  readonly name: string;
  /** Executes the phase against the shared mutable context. */
  run(context: TurnContext): Promise<void>;
}
