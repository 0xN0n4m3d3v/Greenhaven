/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — `friendlyTurnErrorMessage` translates noisy underlying-
// stream errors into a one-line player-facing hint. The
// classification table moved from `turnRunnerV2.ts` to
// `turn/friendlyTurnError.ts`; the tests below pin every detection
// branch and the language fallback contract.

import {describe, expect, it} from 'vitest';
import {friendlyTurnErrorMessage} from '../../turn/friendlyTurnError.js';

describe('friendlyTurnErrorMessage (ARCH-1)', () => {
  it('classifies undici "terminated" + ECONNRESET as stream_reset', () => {
    const enText = friendlyTurnErrorMessage(
      new Error('terminated'),
      'terminated',
      'en',
    );
    expect(enText).toContain('model TLS stream reset');

    const causeErr = new Error('socket failure');
    (causeErr as {cause?: unknown}).cause = {code: 'ECONNRESET'};
    expect(
      friendlyTurnErrorMessage(causeErr, 'socket failure', 'en'),
    ).toContain('model TLS stream reset');

    const undiciErr = new Error('undici socket closed');
    (undiciErr as {cause?: unknown}).cause = {code: 'UND_ERR_SOCKET'};
    expect(
      friendlyTurnErrorMessage(undiciErr, 'undici socket closed', 'en'),
    ).toContain('model TLS stream reset');
  });

  it('classifies abort messages and ABORT_ERR cause as aborted', () => {
    expect(
      friendlyTurnErrorMessage(new Error('aborted'), 'aborted', 'en'),
    ).toBe('Request cancelled.');
    expect(
      friendlyTurnErrorMessage(new Error('canceled'), 'canceled', 'en'),
    ).toBe('Request cancelled.');
    const abortErr = new Error('whatever');
    (abortErr as {cause?: unknown}).cause = {code: 'ABORT_ERR'};
    expect(
      friendlyTurnErrorMessage(abortErr, 'whatever', 'en'),
    ).toBe('Request cancelled.');
  });

  it('classifies timeout messages and ETIMEDOUT-family causes as timeout', () => {
    expect(
      friendlyTurnErrorMessage(new Error('timeout'), 'timeout', 'en'),
    ).toBe('The model did not answer in time. Repeat the turn.');
    expect(
      friendlyTurnErrorMessage(new Error('timed out'), 'timed out', 'en'),
    ).toBe('The model did not answer in time. Repeat the turn.');
    for (const code of [
      'ETIMEDOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ]) {
      const err = new Error('upstream took too long');
      (err as {cause?: unknown}).cause = {code};
      expect(
        friendlyTurnErrorMessage(err, 'upstream took too long', 'en'),
      ).toBe('The model did not answer in time. Repeat the turn.');
    }
  });

  it('classifies 429 / rate-limit messages as rate_limit', () => {
    expect(
      friendlyTurnErrorMessage(
        new Error('HTTP 429'),
        'HTTP 429',
        'en',
      ),
    ).toContain('rate-limited');
    expect(
      friendlyTurnErrorMessage(
        new Error('rate limit reached'),
        'rate limit reached',
        'en',
      ),
    ).toContain('rate-limited');
  });

  it('classifies 503 / upstream wording as upstream_unavailable', () => {
    expect(
      friendlyTurnErrorMessage(
        new Error('HTTP 503'),
        'HTTP 503',
        'en',
      ),
    ).toContain('unavailable');
    expect(
      friendlyTurnErrorMessage(
        new Error('upstream broken'),
        'upstream broken',
        'en',
      ),
    ).toContain('unavailable');
  });

  it('passes unknown error text through unchanged', () => {
    expect(
      friendlyTurnErrorMessage(
        new Error('weird new failure'),
        'weird new failure',
        'en',
      ),
    ).toBe('weird new failure');
  });

  it('falls back to English when the language is unknown', () => {
    const enText = friendlyTurnErrorMessage(
      new Error('aborted'),
      'aborted',
      'klingon',
    );
    expect(enText).toBe('Request cancelled.');
  });

  it('returns localized text for a supported non-en language', () => {
    const ruText = friendlyTurnErrorMessage(
      new Error('aborted'),
      'aborted',
      'ru',
    );
    expect(ruText).toBe('Запрос отменён.');
  });

  it('handles language tags like ru-RU via the base language helper', () => {
    const ruText = friendlyTurnErrorMessage(
      new Error('aborted'),
      'aborted',
      'ru-RU',
    );
    expect(ruText).toBe('Запрос отменён.');
  });

  it('still classifies via `text` when err is not an Error', () => {
    expect(
      friendlyTurnErrorMessage(null, 'timeout from socket', 'en'),
    ).toBe('The model did not answer in time. Repeat the turn.');
  });
});

describe('friendlyTurnErrorMessage re-exported from turnRunnerV2', () => {
  it('is still importable from turnRunnerV2 for back-compat', async () => {
    const runner = await import('../../turnRunnerV2.js');
    expect(typeof runner.friendlyTurnErrorMessage).toBe('function');
    expect(
      runner.friendlyTurnErrorMessage(
        new Error('aborted'),
        'aborted',
        'en',
      ),
    ).toBe('Request cancelled.');
  });
});
