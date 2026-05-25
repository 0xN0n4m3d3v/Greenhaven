/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-13 unit tests — the turn-domain error vocabulary in
// `src/turn/errors.ts`.

import {describe, expect, it} from 'vitest';
import {
  BrokerEmptyOutputError,
  BrokerMutationLimitError,
  NarratorNoContentError,
  SessionResetDuringTurnError,
  TurnCancelledError,
  TurnDomainError,
  TurnWatchdogTimeoutError,
  getTurnErrorCode,
  isBrokerEmptyOutputError,
} from '../../turn/errors.js';

describe('TurnDomainError vocabulary', () => {
  it('every domain class carries a stable, unique code', () => {
    const cases: Array<{instance: TurnDomainError; code: string; name: string}> = [
      {
        instance: new BrokerEmptyOutputError(),
        code: 'BROKER_EMPTY_OUTPUT',
        name: 'BrokerEmptyOutputError',
      },
      {
        instance: new BrokerMutationLimitError(),
        code: 'BROKER_MUTATION_LIMIT',
        name: 'BrokerMutationLimitError',
      },
      {
        instance: new NarratorNoContentError(),
        code: 'NARRATOR_NO_CONTENT',
        name: 'NarratorNoContentError',
      },
      {
        instance: new TurnWatchdogTimeoutError(120_000),
        code: 'TURN_WATCHDOG_TIMEOUT',
        name: 'TurnWatchdogTimeoutError',
      },
      {
        instance: new TurnCancelledError(),
        code: 'TURN_CANCELLED',
        name: 'TurnCancelledError',
      },
      {
        instance: new SessionResetDuringTurnError(),
        code: 'SESSION_RESET_DURING_TURN',
        name: 'SessionResetDuringTurnError',
      },
    ];
    const codes = new Set<string>();
    for (const {instance, code, name} of cases) {
      expect(instance).toBeInstanceOf(Error);
      expect(instance).toBeInstanceOf(TurnDomainError);
      expect(instance.code).toBe(code);
      expect(instance.name).toBe(name);
      codes.add(code);
    }
    expect(codes.size).toBe(cases.length);
  });

  it('TurnWatchdogTimeoutError carries the timeoutMs field', () => {
    const err = new TurnWatchdogTimeoutError(45_000);
    expect(err.timeoutMs).toBe(45_000);
    expect(err.message).toContain('45000');
  });

  it('isBrokerEmptyOutputError accepts real instances and tagged plain objects', () => {
    expect(isBrokerEmptyOutputError(new BrokerEmptyOutputError())).toBe(true);
    expect(
      isBrokerEmptyOutputError({code: 'BROKER_EMPTY_OUTPUT', message: 'x'}),
    ).toBe(true);
    expect(isBrokerEmptyOutputError(new Error('not empty'))).toBe(false);
    expect(isBrokerEmptyOutputError(null)).toBe(false);
    expect(isBrokerEmptyOutputError('boom')).toBe(false);
    expect(
      isBrokerEmptyOutputError(new BrokerMutationLimitError()),
    ).toBe(false);
  });

  it('getTurnErrorCode returns the canonical code for known errors', () => {
    expect(getTurnErrorCode(new BrokerEmptyOutputError())).toBe(
      'BROKER_EMPTY_OUTPUT',
    );
    expect(getTurnErrorCode(new TurnWatchdogTimeoutError(1))).toBe(
      'TURN_WATCHDOG_TIMEOUT',
    );
    expect(getTurnErrorCode(new TurnCancelledError())).toBe('TURN_CANCELLED');
  });

  it('getTurnErrorCode accepts tagged plain objects', () => {
    expect(getTurnErrorCode({code: 'BROKER_MUTATION_LIMIT'})).toBe(
      'BROKER_MUTATION_LIMIT',
    );
    expect(getTurnErrorCode({code: 'SESSION_RESET_DURING_TURN'})).toBe(
      'SESSION_RESET_DURING_TURN',
    );
  });

  it('getTurnErrorCode returns null for unknown or generic errors', () => {
    expect(getTurnErrorCode(new Error('boom'))).toBe(null);
    expect(getTurnErrorCode({code: 'UNRELATED_CODE'})).toBe(null);
    expect(getTurnErrorCode({code: 42})).toBe(null);
    expect(getTurnErrorCode(null)).toBe(null);
    expect(getTurnErrorCode('whatever')).toBe(null);
  });
});
