/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// SEC-3 / DEEP-7 — generic HTTP error-response helpers.
//
// Before SEC-3, the global `app.onError` plus several non-debug 500
// catch handlers returned the raw `err.message` (or `String(err)`,
// or even the truncated model output) to the client. The same body
// shape was used by both the global handler and per-route catches,
// so any uncaught Postgres / provider / Node fs exception leaked
// straight to the wire — "ECONNREFUSED 127.0.0.1:54321", "duplicate
// key violates unique constraint sessions_player_id_uidx",
// "Cannot read properties of undefined (reading 'turn')", model
// stack traces, etc. — alongside operator-relevant strings like
// "DEEPSEEK_API_KEY not configured".
//
// The new contract:
//
//   * Public, non-debug 500 responses are
//     `{error: <stable-code>, correlation_id: <uuid>}`. No
//     `message` field, no `String(err)`, no raw model output, no
//     stack-derived text.
//   * Internal details (`err`, `method`, `path`, the chosen
//     `status` and `code`, any caller-supplied extras) are still
//     captured via the ARCH-2 telemetry facade and a
//     `console.error` line that includes the correlation id, so
//     operators can grep the logs for the id the client sees.
//   * 4xx validation / ownership / auth / rate-limit responses are
//     untouched: those bodies are client-actionable by design and
//     reusing this helper would just churn callers without
//     improving the leak surface.
//
// Two shapes are exported because the runtime has two response
// styles:
//
//   * `errorResponse(c, status, code, opts?)` — for direct Hono
//     handlers. Returns a `Response` produced by `c.json(...)`.
//   * `errorOutcome(status, code, opts?)` — for services that
//     return a `RouteOutcome` (`{status, body}`) which a thin
//     route adapter then forwards via `c.json(outcome.body,
//     outcome.status)`. Used by `SessionLifecycleService`,
//     `CharacterAssistService`, and `ExaminerSynthesisService`.
//
// Both helpers emit the same telemetry event and console line, so
// either response path is grep-equivalent during incident triage.

import type {Context} from 'hono';
import type {ContentfulStatusCode} from 'hono/utils/http-status';
import {randomUUID} from 'node:crypto';
import {telemetry} from './telemetry/index.js';

export interface ErrorResponseOptions {
  /**
   * The internal error or thrown value. Logged + recorded; never
   * placed in the response body. Pass `undefined` (the default) for
   * a code-only failure that has no captured exception.
   */
  internal?: unknown;
  /**
   * Optional extra structured data to attach to the telemetry
   * record (NOT the response body). Useful for hints like the
   * failing slot id, queue depth, etc., that ops needs to triage.
   */
  data?: Record<string, unknown>;
  /**
   * Optional method/path overrides — used by `errorOutcome` which
   * does not receive a Hono `Context`. When `errorResponse` is
   * called these default from `c.req.method` / `c.req.path`.
   */
  method?: string;
  path?: string;
}

export interface ErrorBody {
  error: string;
  correlation_id: string;
}

/**
 * Construct a fresh error body. Exposed so callers that need to
 * shape the body themselves (e.g. a wrapper that adds an extra
 * field while still committing to the no-message contract) can
 * still mint a correlation id from one place.
 */
export function buildErrorBody(code: string): ErrorBody {
  return {error: code, correlation_id: randomUUID()};
}

function recordErrorTelemetry(
  status: number,
  code: string,
  correlationId: string,
  method: string | null,
  path: string | null,
  internal: unknown,
  data: Record<string, unknown> | undefined,
): void {
  telemetry.record({
    channel: 'gameplay',
    name: 'http.error',
    error: internal,
    data: {
      status,
      code,
      correlation_id: correlationId,
      method,
      path,
      ...(data ?? {}),
    },
  });
}

function logErrorLine(
  status: number,
  code: string,
  correlationId: string,
  method: string | null,
  path: string | null,
  internal: unknown,
): void {
  const where =
    method && path ? `${method} ${path}` : method ? method : (path ?? '<svc>');
  const head = `[http] ${where} -> ${status} ${code} (${correlationId})`;
  if (internal === undefined) {
    console.error(head);
  } else {
    console.error(`${head}:`, internal);
  }
}

/**
 * Return a `Response` carrying the generic body. Used by Hono
 * routes and by the global `app.onError`. Records telemetry and
 * logs the correlation id so log triage matches what the client
 * sees.
 */
export function errorResponse(
  c: Context,
  status: number,
  code: string,
  opts: ErrorResponseOptions = {},
): Response {
  const body = buildErrorBody(code);
  const method = opts.method ?? c.req.method;
  const path = opts.path ?? c.req.path;
  recordErrorTelemetry(
    status,
    code,
    body.correlation_id,
    method,
    path,
    opts.internal,
    opts.data,
  );
  logErrorLine(status, code, body.correlation_id, method, path, opts.internal);
  return c.json(body, status as ContentfulStatusCode);
}

/**
 * The body type returned by `errorOutcome` is intentionally
 * structural-`Record<string, unknown>`-compatible so it slots into
 * existing `RouteOutcome { body: Record<string, unknown> }`
 * service interfaces without callers needing to cast. The two
 * mandatory fields (`error`, `correlation_id`) are still typed
 * explicitly via the intersection.
 */
export interface ErrorOutcome {
  status: number;
  body: ErrorBody & Record<string, unknown>;
}

/**
 * Return a `RouteOutcome`-shaped value (`{status, body}`) for
 * service-layer code that prefers to stay context-free and let a
 * thin route adapter forward to Hono. Telemetry + log line match
 * `errorResponse` so the two paths are grep-equivalent.
 */
export function errorOutcome(
  status: number,
  code: string,
  opts: ErrorResponseOptions = {},
): ErrorOutcome {
  const body = buildErrorBody(code) as ErrorBody & Record<string, unknown>;
  const method = opts.method ?? null;
  const path = opts.path ?? null;
  recordErrorTelemetry(
    status,
    code,
    body.correlation_id,
    method,
    path,
    opts.internal,
    opts.data,
  );
  logErrorLine(status, code, body.correlation_id, method, path, opts.internal);
  return {status, body};
}
