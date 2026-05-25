/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-16 — loopback Host/Origin guard contract.
//
// The guard runs as the FIRST middleware in the web-server entry
// point. These tests drive it through a real Hono app so the
// 421 / 403 / pass-through paths exercise the same Hono request /
// response machinery production traffic touches; the rule helpers
// are also exercised directly so confusable hosts and edge cases
// (IPv6 brackets, `null` Origin, port validation) are pinned at the
// helper level.

import {Hono} from 'hono';
import {describe, expect, it} from 'vitest';
import {
  createLoopbackGuardMiddleware,
  isLoopbackHost,
  isLoopbackOrigin,
} from '../../middleware/loopbackGuard.js';

function makeApp(): Hono {
  const app = new Hono();
  app.use('*', createLoopbackGuardMiddleware());
  app.get('/api/health', (c) => c.json({ok: true}));
  app.post('/api/session', (c) => c.json({ok: true}));
  app.put('/api/session/:id', (c) => c.json({ok: true}));
  app.patch('/api/session/:id', (c) => c.json({ok: true}));
  app.delete('/api/session/:id', (c) => c.json({ok: true}));
  return app;
}

describe('isLoopbackHost', () => {
  it('accepts bare loopback hostnames without port', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('rejects bare IPv6 `::1` because Host uses bracketed authority', () => {
    // RFC 7230 + RFC 3986 — the HTTP Host header for an IPv6
    // address is always bracketed. We do not accept the bare form.
    expect(isLoopbackHost('::1')).toBe(false);
  });

  it('accepts loopback hostnames with valid ports', () => {
    expect(isLoopbackHost('localhost:5173')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:7777')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:65535')).toBe(true);
    expect(isLoopbackHost('[::1]:7777')).toBe(true);
  });

  it('rejects confusable hostnames that contain a loopback substring', () => {
    expect(isLoopbackHost('127.0.0.1.attacker.example')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
    expect(isLoopbackHost('attacker.example')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
  });

  it('rejects hosts with userinfo, paths, queries, or fragments', () => {
    expect(isLoopbackHost('user@127.0.0.1')).toBe(false);
    expect(isLoopbackHost('127.0.0.1/admin')).toBe(false);
    expect(isLoopbackHost('127.0.0.1?x=1')).toBe(false);
    expect(isLoopbackHost('127.0.0.1#frag')).toBe(false);
    expect(isLoopbackHost('127.0.0.1 ')).toBe(false);
  });

  it('rejects invalid or out-of-range ports', () => {
    expect(isLoopbackHost('127.0.0.1:0')).toBe(false);
    expect(isLoopbackHost('127.0.0.1:65536')).toBe(false);
    expect(isLoopbackHost('127.0.0.1:abc')).toBe(false);
    expect(isLoopbackHost('127.0.0.1:')).toBe(false);
    expect(isLoopbackHost('127.0.0.1:7777:8888')).toBe(false);
  });

  it('rejects empty / missing host', () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('isLoopbackOrigin', () => {
  it('accepts http loopback origins with arbitrary valid ports', () => {
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:7777')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:54321')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:7777')).toBe(true);
    expect(isLoopbackOrigin('http://localhost')).toBe(true);
  });

  it('rejects the literal `null` origin (opaque origins)', () => {
    expect(isLoopbackOrigin('null')).toBe(false);
  });

  it('rejects https loopback origins (we do not speak TLS locally)', () => {
    expect(isLoopbackOrigin('https://127.0.0.1:7777')).toBe(false);
    expect(isLoopbackOrigin('https://localhost:5173')).toBe(false);
  });

  it('rejects non-loopback origins', () => {
    expect(isLoopbackOrigin('http://attacker.example')).toBe(false);
    expect(isLoopbackOrigin('http://localhost.evil.com')).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1.attacker.example')).toBe(false);
  });

  it('rejects origins with a path, query, or trailing slash', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:7777/')).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1:7777/api')).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1:7777?x=1')).toBe(false);
  });

  it('rejects empty / missing origin', () => {
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
  });
});

// Hono's `app.request()` synthesizes a Fetch-style Request that
// does NOT auto-populate the `Host` header from the URL — production
// HTTP/1.1 always sends Host, so each test passes it explicitly to
// keep the contract honest. The first test below also exercises the
// missing-Host failure path by passing no `host` header at all.
const LOOPBACK_HOST = '127.0.0.1:7777';

describe('loopback guard middleware', () => {
  it('returns 421 invalid_host when Host header is missing', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/health', {
      method: 'GET',
    });
    expect(res.status).toBe(421);
    expect(await res.json()).toEqual({error: 'invalid_host'});
  });

  it('returns 421 invalid_host when Host is a non-loopback domain', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/health', {
      method: 'GET',
      headers: {host: 'attacker.example'},
    });
    expect(res.status).toBe(421);
    expect(await res.json()).toEqual({error: 'invalid_host'});
  });

  it('returns 421 invalid_host on a confusable suffix host', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/health', {
      method: 'GET',
      headers: {host: '127.0.0.1.attacker.example:7777'},
    });
    expect(res.status).toBe(421);
    expect(await res.json()).toEqual({error: 'invalid_host'});
  });

  it('passes GET through loopback Host without Origin gating', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/health', {
      method: 'GET',
      headers: {host: LOOPBACK_HOST},
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
  });

  it('returns 403 invalid_origin when POST carries a remote Origin', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/session', {
      method: 'POST',
      headers: {host: LOOPBACK_HOST, origin: 'http://attacker.example'},
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'invalid_origin'});
  });

  it('returns 403 invalid_origin when POST carries the literal null origin', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/session', {
      method: 'POST',
      headers: {host: LOOPBACK_HOST, origin: 'null'},
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'invalid_origin'});
  });

  it('passes mutating methods with absent Origin (native/local scripts)', async () => {
    const app = makeApp();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const url =
        method === 'POST'
          ? 'http://127.0.0.1:7777/api/session'
          : 'http://127.0.0.1:7777/api/session/abc';
      const res = await app.request(url, {
        method,
        headers: {host: LOOPBACK_HOST},
      });
      expect(res.status, `${method} should pass without Origin`).toBe(200);
      expect(await res.json()).toEqual({ok: true});
    }
  });

  it('accepts loopback Origin on mutating methods (Vite + Electron paths)', async () => {
    const app = makeApp();
    const cases = [
      'http://localhost:5173',
      'http://127.0.0.1:7777',
      'http://127.0.0.1:54321',
      'http://[::1]:7777',
    ];
    for (const origin of cases) {
      const res = await app.request('http://127.0.0.1:7777/api/session', {
        method: 'POST',
        headers: {host: LOOPBACK_HOST, origin},
      });
      expect(res.status, `${origin} should pass`).toBe(200);
      expect(await res.json()).toEqual({ok: true});
    }
  });

  it('still gates Host before evaluating Origin', async () => {
    const app = makeApp();
    const res = await app.request('http://127.0.0.1:7777/api/session', {
      method: 'POST',
      headers: {host: 'attacker.example', origin: 'http://127.0.0.1:7777'},
    });
    // Host fails before Origin is checked.
    expect(res.status).toBe(421);
    expect(await res.json()).toEqual({error: 'invalid_host'});
  });
});
