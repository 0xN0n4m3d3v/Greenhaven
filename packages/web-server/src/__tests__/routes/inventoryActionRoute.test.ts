/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-INV-1 — `POST /api/player/:id/inventory/action` contract.
//
// The route delegates into the existing `use_item` / `equip_item` /
// `give_to_npc` tools via `executeTool`. This test stubs
// `executeTool` and `SessionLifecycleService.getOwned` so we
// exercise the wiring, validation, action mapping, ownership
// protection, session ownership / liveness checks, and SEC-5
// rate limiting without booting PGlite. The real tools are
// covered by their own service tests; here we only guarantee
// that:
//
//   * unauthenticated callers cannot dispatch (`ownsPlayer` 401),
//   * a mismatched player cookie is rejected (`ownsPlayer` 403),
//   * a stale / unknown `sessionId` is rejected (404
//     `unknown_session`) BEFORE any tool runs,
//   * a session owned by a different player is rejected (403
//     `session_forbidden`) BEFORE any tool runs,
//   * invalid bodies return a structured 400 with zod issue paths,
//   * the four actions (`use` / `equip` / `unequip` / `give`) map
//     to the right tool name and arg shape,
//   * the route forwards the tool's `{ok, error}` shape verbatim,
//   * once an authed player exhausts the SEC-5 bucket, the next
//     POST returns 429 without dispatching the tool.

import {Hono} from 'hono';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const configMock = vi.hoisted(() => ({
  authDisabled: false as boolean,
  authSecret: 'a'.repeat(48),
  authCookieSecure: 'off' as 'auto' | 'on' | 'off',
  isDesktop: false as boolean,
  nodeEnv: 'test' as 'development' | 'production' | 'test',
}));

vi.mock('../../config.js', () => ({
  config: () => configMock,
}));

const tokenStoreMock = vi.hoisted(() => {
  const activeJtis = new Set<string>([
    '00000000-0000-4000-8000-000000000001',
  ]);
  return {
    activeJtis,
    isSessionTokenActive: async (jti: string, _playerId: number) =>
      activeJtis.has(jti),
    createSessionToken: async (playerId: number) => ({
      jti: '00000000-0000-4000-8000-000000000001',
      playerId,
      issuedAt: new Date(),
    }),
    revokeSessionToken: async (jti: string) => {
      activeJtis.delete(jti);
    },
  };
});

vi.mock('../../auth/sessionTokenStore.js', () => tokenStoreMock);

const executeToolMock = vi.hoisted(() =>
  vi.fn(async (toolName: string, _args: unknown, _ctx: unknown) => {
    if (toolName === 'give_to_npc' && (_args as {npc?: string}).npc === 'fail') {
      return {ok: false, error: 'unknown NPC: fail'};
    }
    return {
      ok: true,
      data: {tool: toolName, args: _args},
    };
  }),
);

vi.mock('../../tools/base.js', async () => {
  const real = await vi.importActual<typeof import('../../tools/base.js')>(
    '../../tools/base.js',
  );
  return {
    ...real,
    executeTool: executeToolMock,
  };
});

vi.mock('../../services/InventoryReadService.js', () => ({
  InventoryReadService: {
    snapshot: vi.fn(async () => ({
      playerId: 0,
      currency: {count: 0},
      equipment: [],
      items: [],
      totals: {itemCount: 0, uniqueItems: 0, weightKg: 0, equippedCount: 0},
    })),
  },
}));

// The session lookup is the new hardening gate. We mock the
// service interface (not `sessionManager` directly) because the
// route imports `SessionLifecycleService` and `SessionOwnershipError`
// from the service module. Each test sets the desired return /
// throw shape before invoking the request.
const sessionLifecycleMock = vi.hoisted(() => {
  class FakeSessionOwnershipError extends Error {
    constructor(sessionId: string) {
      super(`session ${sessionId} owned by another player`);
      this.name = 'SessionOwnershipError';
    }
  }
  const liveSessions = new Map<string, {playerId: number}>();
  // Default seeded session — playerId 42 owns 's-1'.
  liveSessions.set('s-1', {playerId: 42});
  return {
    liveSessions,
    SessionOwnershipError: FakeSessionOwnershipError,
    SessionLifecycleService: {
      getOwned: vi.fn(async (sessionId: string, playerId: number) => {
        const row = liveSessions.get(sessionId);
        if (!row) return null;
        if (row.playerId !== playerId) {
          throw new FakeSessionOwnershipError(sessionId);
        }
        // The real return is a `Session` instance; the route only
        // checks for truthiness, so a stub object is enough here.
        return {id: sessionId, playerId: row.playerId} as unknown as never;
      }),
    },
  };
});

vi.mock('../../services/SessionLifecycleService.js', () => ({
  SessionLifecycleService: sessionLifecycleMock.SessionLifecycleService,
  SessionOwnershipError: sessionLifecycleMock.SessionOwnershipError,
}));

let signCookie: typeof import('../../middleware/auth.js').signCookie;
let ownsPlayer: typeof import('../../middleware/ownsPlayer.js').ownsPlayer;
let rateLimitStateChanges: typeof import('../../middleware/rateLimit.js').rateLimitStateChanges;
let rateLimitTestHooks: typeof import('../../middleware/rateLimit.js').rateLimitTestHooks;
let inventoryRoutes: typeof import('../../routes/inventory.js').inventoryRoutes;

beforeAll(async () => {
  ({signCookie} = await import('../../middleware/auth.js'));
  ({ownsPlayer} = await import('../../middleware/ownsPlayer.js'));
  ({rateLimitStateChanges, rateLimitTestHooks} = await import(
    '../../middleware/rateLimit.js'
  ));
  ({inventoryRoutes} = await import('../../routes/inventory.js'));
});

function authCookieHeader(playerId: number): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jti = '00000000-0000-4000-8000-000000000001';
  return `gh_player=${signCookie({playerId, exp, jti})}`;
}

// Mirrors production wiring from `src/index.ts`: ownership guard,
// then SEC-5 rate-limit, then the inventory router.
function makeApp(): Hono {
  const app = new Hono();
  app.use('/api/player/:id/inventory', ownsPlayer());
  app.use('/api/player/:id/inventory/*', ownsPlayer());
  app.use('/api/player/:id/inventory/*', rateLimitStateChanges());
  app.route('/api/player', inventoryRoutes);
  return app;
}

describe('inventory action route (FEAT-INV-1)', () => {
  beforeEach(() => {
    executeToolMock.mockClear();
    sessionLifecycleMock.SessionLifecycleService.getOwned.mockClear();
    sessionLifecycleMock.liveSessions.clear();
    sessionLifecycleMock.liveSessions.set('s-1', {playerId: 42});
    rateLimitTestHooks.clear();
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          action: 'equip',
          sessionId: 's-1',
          itemSlug: 'shortsword',
        }),
      },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({error: 'unauthenticated'});
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(
      sessionLifecycleMock.SessionLifecycleService.getOwned,
    ).not.toHaveBeenCalled();
  });

  it('rejects mismatched player cookies with 403', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(7),
        },
        body: JSON.stringify({
          action: 'equip',
          sessionId: 's-1',
          itemSlug: 'shortsword',
        }),
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'player_mismatch'});
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(
      sessionLifecycleMock.SessionLifecycleService.getOwned,
    ).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON bodies with invalid_json 400', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: 'not json',
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({error: 'invalid_json'});
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it('rejects unknown action discriminators with structured 400', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'set_on_fire',
          sessionId: 's-1',
          itemSlug: 'torch',
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {error: string};
    expect(body.error).toBe('invalid_body');
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it('rejects give without npc target with structured 400', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'give',
          sessionId: 's-1',
          itemSlug: 'apple',
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues: Array<{path: string}>;
    };
    expect(body.error).toBe('invalid_body');
    expect(body.issues.some((i) => i.path === 'npc')).toBe(true);
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it('rejects stale / unknown sessionId with 404 unknown_session', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip',
          sessionId: 's-does-not-exist',
          itemSlug: 'shortsword',
        }),
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      action: 'equip',
      error: 'unknown_session',
    });
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(
      sessionLifecycleMock.SessionLifecycleService.getOwned,
    ).toHaveBeenCalledWith('s-does-not-exist', 42);
  });

  it('rejects a sessionId owned by another player with 403 session_forbidden', async () => {
    sessionLifecycleMock.liveSessions.set('s-other', {playerId: 999});
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip',
          sessionId: 's-other',
          itemSlug: 'shortsword',
        }),
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      action: 'equip',
      error: 'session_forbidden',
    });
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it('dispatches `equip` to the `equip_item` tool with equipped=true', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip',
          sessionId: 's-1',
          itemSlug: 'shortsword',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      action: string;
      result: {tool: string; args: Record<string, unknown>};
    };
    expect(body.ok).toBe(true);
    expect(body.action).toBe('equip');
    expect(body.result.tool).toBe('equip_item');
    expect(body.result.args).toEqual({
      item_slug: 'shortsword',
      equipped: true,
    });
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    const ctx = executeToolMock.mock.calls[0]![2] as {
      sessionId: string;
      playerId: number;
      turnInputKind: string;
      toolHistorySource: string;
    };
    expect(ctx.sessionId).toBe('s-1');
    expect(ctx.playerId).toBe(42);
    expect(ctx.turnInputKind).toBe('player_action');
    expect(ctx.toolHistorySource).toBe('direct');
    expect(
      sessionLifecycleMock.SessionLifecycleService.getOwned,
    ).toHaveBeenCalledWith('s-1', 42);
  });

  it('dispatches `unequip` to the `equip_item` tool with equipped=false', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'unequip',
          sessionId: 's-1',
          itemSlug: 'shortsword',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {tool: string; args: Record<string, unknown>};
    };
    expect(body.result.tool).toBe('equip_item');
    expect(body.result.args).toEqual({
      item_slug: 'shortsword',
      equipped: false,
    });
  });

  it('dispatches `use` with optional target_location forwarded', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'use',
          sessionId: 's-1',
          itemSlug: 'oil_flask',
          targetLocation: 'tavern_floor',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {tool: string; args: Record<string, unknown>};
    };
    expect(body.result.tool).toBe('use_item');
    expect(body.result.args).toEqual({
      item_slug: 'oil_flask',
      target_location: 'tavern_floor',
    });
  });

  it('dispatches `give` to the `give_to_npc` tool with quantity defaulted', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'give',
          sessionId: 's-1',
          itemSlug: 'apple',
          npc: 'innkeeper',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {tool: string; args: Record<string, unknown>};
    };
    expect(body.result.tool).toBe('give_to_npc');
    expect(body.result.args).toEqual({
      item_slug: 'apple',
      npc: 'innkeeper',
      quantity: 1,
    });
  });

  it('forwards a tool-level failure as ok=false 400', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'give',
          sessionId: 's-1',
          itemSlug: 'apple',
          npc: 'fail',
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      action: string;
      error: string;
    };
    expect(body.ok).toBe(false);
    expect(body.action).toBe('give');
    expect(body.error).toBe('unknown NPC: fail');
  });

  it('returns 429 once the per-player SEC-5 bucket is exhausted', async () => {
    // The state-change limiter is 30 tokens with a 30/min refill;
    // seed the bucket at zero and verify the very next POST trips
    // the limiter without ever consulting the session lookup or
    // dispatching the tool.
    rateLimitTestHooks.seed('state:player:42', {
      tokens: 0,
      capacity: 30,
      refillPerMs: 30 / 60_000,
      updatedAt: Date.now(),
    });
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/inventory/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip',
          sessionId: 's-1',
          itemSlug: 'shortsword',
        }),
      },
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({error: 'rate_limited'});
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(
      sessionLifecycleMock.SessionLifecycleService.getOwned,
    ).not.toHaveBeenCalled();
  });
});
