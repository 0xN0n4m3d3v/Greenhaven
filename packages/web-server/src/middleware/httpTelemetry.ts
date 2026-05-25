/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-15 — HTTP telemetry middleware that splits SSE long-poll
// connections from normal HTTP requests.
//
// Pre-ARCH-15 every request, including the EventSource `GET
// /api/session/:id/stream` connections, recorded `http.request` after
// `await next()`. SSE connections live for minutes-to-hours, so the
// `duration_ms` field dominated normal-request latency dashboards and
// turned average-request-duration into a useless signal.
//
// Split rule:
//   - SSE-shaped requests (path ends in `/stream` or `Accept` contains
//     `text/event-stream`) record `sse.opened` on entry and
//     `sse.closed` in a `finally` so close-on-throw still lands.
//   - Every other request keeps the existing pair:
//     `http.request` on success, `http.request.error` on throw.
//
// The middleware is exposed as a factory so tests can pass a
// captured-events stub instead of the real ARCH-2 facade.

import type {Context, MiddlewareHandler} from 'hono';
import {telemetry as defaultTelemetry} from '../telemetry/index.js';
import type {TelemetryEvent} from '../telemetry/channels.js';

export interface TelemetryRecorder {
  record(event: TelemetryEvent): void;
}

/**
 * Classify a request as an SSE long-poll. Hono's `c.req.path`
 * returns the URL path with no query string. `Accept` may arrive
 * as a comma-separated list (browsers may include a trailing
 * `text/event-stream` mixed with other media types), so we use
 * substring containment rather than equality.
 */
export function isSseRequest(c: Context): boolean {
  if (c.req.path.endsWith('/stream')) return true;
  const accept = c.req.header('accept');
  if (typeof accept === 'string' && accept.includes('text/event-stream')) {
    return true;
  }
  return false;
}

export function createHttpTelemetryMiddleware(
  recorder: TelemetryRecorder = defaultTelemetry,
): MiddlewareHandler {
  return async (c, next) => {
    if (isSseRequest(c)) {
      const startedAt = Date.now();
      recorder.record({
        channel: 'gameplay',
        name: 'sse.opened',
        data: {
          method: c.req.method,
          path: c.req.path,
        },
      });
      try {
        await next();
        recorder.record({
          channel: 'gameplay',
          name: 'sse.closed',
          data: {
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            duration_ms: Date.now() - startedAt,
          },
        });
      } catch (err) {
        recorder.record({
          channel: 'gameplay',
          name: 'sse.closed',
          error: err,
          data: {
            method: c.req.method,
            path: c.req.path,
            duration_ms: Date.now() - startedAt,
            errored: true,
          },
        });
        throw err;
      }
      return;
    }
    const startedAt = Date.now();
    try {
      await next();
      recorder.record({
        channel: 'gameplay',
        name: 'http.request',
        data: {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          duration_ms: Date.now() - startedAt,
        },
      });
    } catch (err) {
      recorder.record({
        channel: 'gameplay',
        name: 'http.request.error',
        error: err,
        data: {
          method: c.req.method,
          path: c.req.path,
          duration_ms: Date.now() - startedAt,
        },
      });
      throw err;
    }
  };
}
