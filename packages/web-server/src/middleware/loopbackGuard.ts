/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-16 — Loopback Host/Origin guard.
//
// Greenhaven's backend always listens on `127.0.0.1` (the local dev
// process listens on `:7777`; the Electron desktop main process picks
// an ephemeral loopback port and forwards the renderer at the same
// origin). A request that arrives with a non-loopback `Host` or
// `Origin` header is therefore either a misrouted public-internet
// request or a DNS-rebinding attempt where a remote attacker tricked
// a browser into POSTing to `http://attacker.example/...` while the
// DNS resolver returned `127.0.0.1`. This middleware rejects both
// shapes before any route handler runs.
//
// Rules:
//   - `Host` must be a loopback authority (`localhost`, `127.0.0.1`,
//     or `[::1]`) optionally followed by a valid port. Userinfo,
//     paths, query strings, and confusable suffixes such as
//     `127.0.0.1.attacker.example` are rejected. Missing or
//     malformed Host returns `421 {error: 'invalid_host'}`.
//   - For mutating methods (POST/PUT/PATCH/DELETE) the `Origin`
//     header, when present, must parse as
//     `http://<loopback-host>[:port]`. The literal string `null` is
//     rejected. Missing Origin passes — that preserves native /
//     scripted local fetch (Node, Electron preload, curl). Anything
//     non-loopback returns `403 {error: 'invalid_origin'}`.
//   - Read-only methods (GET / HEAD / OPTIONS) are not Origin-gated;
//     they only get the Host check.
//
// The helpers below are exported alongside the middleware so unit
// tests can exercise the parser without booting Hono.

import type {MiddlewareHandler} from 'hono';

// Hostnames accepted in the `Host` header. RFC 7230 says HTTP Host
// uses the URL authority form, which for IPv6 is always
// `[::1]` (bracketed). We do not accept bare `::1` here because
// production traffic never sends it that way.
const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isValidPort(port: string): boolean {
  if (!/^[0-9]+$/.test(port)) return false;
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Strict loopback `Host` header validator. The standard `Host`
 * header is `<authority>` (no scheme, no path). We accept three
 * forms:
 *
 *   - `localhost` or `localhost:<port>`
 *   - `127.0.0.1` or `127.0.0.1:<port>`
 *   - `[::1]` or `[::1]:<port>` (Node's `req.headers.host` keeps
 *     the IPv6 brackets, matching the URL authority rule)
 *
 * Anything containing `@`, `/`, `?`, `#`, or whitespace, plus any
 * host whose hostname doesn't match the loopback allowlist
 * exactly, is rejected. The confusable
 * `127.0.0.1.attacker.example` case is filtered because
 * `127.0.0.1.attacker.example` is not in
 * `LOOPBACK_HOSTNAMES`.
 */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (typeof host !== 'string' || host.length === 0) return false;
  if (/[@/?#\s]/.test(host)) return false;
  let hostname: string;
  let port = '';
  if (host.startsWith('[')) {
    // IPv6 literal — must be `[<addr>]` or `[<addr>]:<port>`.
    const end = host.indexOf(']');
    if (end < 0) return false;
    hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(':')) return false;
      port = rest.slice(1);
    }
  } else {
    const colon = host.indexOf(':');
    if (colon < 0) {
      hostname = host;
    } else {
      hostname = host.slice(0, colon);
      port = host.slice(colon + 1);
      if (port.length === 0) return false;
      if (port.includes(':')) return false;
    }
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  if (port.length > 0 && !isValidPort(port)) return false;
  return true;
}

/**
 * Strict loopback `Origin` header validator. The Origin header is
 * `<scheme>://<host>[:port]`; per spec it never carries a path or
 * trailing slash, and browsers serialize the literal string `null`
 * for opaque origins (sandboxed iframes, `file://` documents,
 * cross-site referrers stripped under no-referrer policy). We
 * accept only:
 *
 *   - `http://` (loopback never speaks `https://` in this codebase)
 *   - hostname in the loopback allowlist
 *   - optional port (1-65535)
 *
 * `null` and any other value (including loopback IPs with a path,
 * fragment, userinfo, or trailing slash) return `false`.
 */
export function isLoopbackOrigin(origin: string | undefined | null): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (origin === 'null') return false;
  if (!origin.startsWith('http://')) return false;
  const rest = origin.slice('http://'.length);
  if (rest.length === 0) return false;
  if (/[/?#\s]/.test(rest)) return false;
  return isLoopbackHost(rest);
}

export interface LoopbackGuardOptions {
  /**
   * Override the default mutating-method set. Tests use this to
   * confirm that GET/HEAD never gate on Origin even when an
   * `Origin: null` header is present.
   */
  mutatingMethods?: ReadonlySet<string>;
}

/**
 * Hono middleware that enforces the loopback Host/Origin contract.
 * Mounted globally before any route handler in
 * `packages/web-server/src/index.ts`.
 */
export function createLoopbackGuardMiddleware(
  options: LoopbackGuardOptions = {},
): MiddlewareHandler {
  const mutatingMethods = options.mutatingMethods ?? MUTATING_METHODS;
  return async (c, next) => {
    const host = c.req.header('host');
    if (!isLoopbackHost(host)) {
      return c.json({error: 'invalid_host'}, 421);
    }
    if (mutatingMethods.has(c.req.method.toUpperCase())) {
      const origin = c.req.header('origin');
      if (typeof origin === 'string' && origin.length > 0) {
        if (!isLoopbackOrigin(origin)) {
          return c.json({error: 'invalid_origin'}, 403);
        }
      }
    }
    await next();
  };
}
