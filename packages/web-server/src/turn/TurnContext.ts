/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — TurnContext.
//
// A TurnContext is the shared mutable state for a single turn.  It is
// created once when `startTurnV2` returns the turn handle and is
// passed by reference into each Phase.
//
// Why a single mutable bag instead of typed phase outputs?
// `runTurn` today threads ~30 locals through a deeply nested closure
// (broker prep, narrator output, dialogue mutations, etc.).  A typed
// per-phase contract would force a full rewrite right now; the
// `state` bag lets us migrate one phase at a time without breaking
// any caller.

import type {Session} from '../sessionManager.js';
import type {TurnInput} from '../turnRunnerV2.js';

export interface TurnContext {
  readonly session: Session;
  /**
   * Mutable, per-turn input snapshot.  `createTurnContext` shallow-
   * copies the caller's `TurnInput` so phase mutations (e.g. the
   * prompt-injection guard rewriting `input.text`) stay local to
   * the turn and never leak back to `startTurnV2`'s caller. The
   * `input` *reference* is fixed (readonly), but its fields may be
   * reassigned by phases.
   */
  readonly input: TurnInput;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  /**
   * Cross-phase scratch space.  Phases write here when they need to
   * hand data to a later phase.  Keys are owned by the writing phase;
   * readers should treat the value as opaque unless they own that key.
   */
  readonly state: Record<string, unknown>;
}

export interface CreateTurnContextOptions {
  session: Session;
  input: TurnInput;
  turnId: string;
  signal: AbortSignal;
}

export function createTurnContext(
  opts: CreateTurnContextOptions,
): TurnContext {
  return {
    session: opts.session,
    // Shallow-copy `input` so phases can rewrite per-turn fields
    // (e.g. `text` after the prompt-injection guard) without
    // mutating the caller-owned `TurnInput`.
    input: {...opts.input},
    turnId: opts.turnId,
    signal: opts.signal,
    startedAt: Date.now(),
    state: {},
  };
}
