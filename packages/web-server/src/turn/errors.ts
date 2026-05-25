/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-13 — turn-domain error classes.
//
// The pre-S-13 turn pipeline carried error categories as raw strings:
// `BrokerEmptyOutputError` lived in `ai/handoff.ts`, the watchdog
// class was private to `turnRunnerV2.ts`, and every other failure
// path threw a generic `Error`. This file centralises the shared
// vocabulary so call sites can use `instanceof` checks and telemetry
// can carry a stable `error_code` instead of fragile `raw_message`
// substring matching.
//
// Codes are stable strings shaped `<DOMAIN>_<KIND>`. They appear in
// rotated gameplay JSONL alongside the canonical `name` field and are
// safe to dashboard on.

export type TurnErrorCode =
  | 'BROKER_EMPTY_OUTPUT'
  | 'BROKER_MUTATION_LIMIT'
  | 'NARRATOR_NO_CONTENT'
  | 'TURN_WATCHDOG_TIMEOUT'
  | 'TURN_CANCELLED'
  | 'SESSION_RESET_DURING_TURN';

export abstract class TurnDomainError extends Error {
  abstract readonly code: TurnErrorCode;
}

export class BrokerEmptyOutputError extends TurnDomainError {
  readonly code = 'BROKER_EMPTY_OUTPUT' as const;

  constructor(
    message = 'broker produced no tool calls, no narrate handoff, and no prose',
  ) {
    super(message);
    this.name = 'BrokerEmptyOutputError';
  }
}

export class BrokerMutationLimitError extends TurnDomainError {
  readonly code = 'BROKER_MUTATION_LIMIT' as const;

  constructor(message = 'broker exceeded the per-turn mutation tool limit') {
    super(message);
    this.name = 'BrokerMutationLimitError';
  }
}

export class NarratorNoContentError extends TurnDomainError {
  readonly code = 'NARRATOR_NO_CONTENT' as const;

  constructor(message = 'narrator produced no visible content') {
    super(message);
    this.name = 'NarratorNoContentError';
  }
}

export class TurnWatchdogTimeoutError extends TurnDomainError {
  readonly code = 'TURN_WATCHDOG_TIMEOUT' as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`turn timed out after ${timeoutMs}ms`);
    this.name = 'TurnWatchdogTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class TurnCancelledError extends TurnDomainError {
  readonly code = 'TURN_CANCELLED' as const;

  constructor(message = 'turn cancelled') {
    super(message);
    this.name = 'TurnCancelledError';
  }
}

export class SessionResetDuringTurnError extends TurnDomainError {
  readonly code = 'SESSION_RESET_DURING_TURN' as const;

  constructor(message = 'session reset while a turn was in flight') {
    super(message);
    this.name = 'SessionResetDuringTurnError';
  }
}

/**
 * Narrow predicate used by the broker stage to distinguish the
 * empty-output case from any other broker failure. Accepts both real
 * instances and structurally-tagged plain objects: external SDK
 * adapters sometimes rebuild the error across worker boundaries, so
 * the `code === 'BROKER_EMPTY_OUTPUT'` shape is the canonical match.
 */
export function isBrokerEmptyOutputError(
  error: unknown,
): error is BrokerEmptyOutputError {
  if (error instanceof BrokerEmptyOutputError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return (error as {code?: unknown}).code === 'BROKER_EMPTY_OUTPUT';
}

/**
 * Pull a stable domain code off an unknown error for telemetry.
 * Returns `null` for non-domain errors so callers can decide whether
 * to omit the field or fall through to generic `raw_message` paths.
 */
export function getTurnErrorCode(error: unknown): TurnErrorCode | null {
  if (error instanceof TurnDomainError) return error.code;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as {code?: unknown}).code;
  if (typeof code !== 'string') return null;
  switch (code) {
    case 'BROKER_EMPTY_OUTPUT':
    case 'BROKER_MUTATION_LIMIT':
    case 'NARRATOR_NO_CONTENT':
    case 'TURN_WATCHDOG_TIMEOUT':
    case 'TURN_CANCELLED':
    case 'SESSION_RESET_DURING_TURN':
      return code;
    default:
      return null;
  }
}
