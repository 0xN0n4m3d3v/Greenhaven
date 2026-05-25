/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — `POST /api/player/:id/character-state/action`
// contract. Mirrors `inventoryActionRoute.test.ts`: stubs the
// session ownership lookup and `executeTool`, then exercises the
// wiring, validation, action mapping, ownership protection, and
// SEC-5 rate limiting without booting PGlite. The real progression
// tools are covered by their own service tests; here we only
// guarantee:
//
//   * unauthenticated callers cannot dispatch (`ownsPlayer` 401),
//   * a mismatched player cookie is rejected (`ownsPlayer` 403),
//   * malformed JSON / unknown actions are rejected with structured 400,
//   * `equip_title` / `unequip_title` / `spend_stat_point` /
//     `spend_skill_point` each map to the right tool with the
//     right arg shape (no `award_progression_xp` or `award_title`
//     exposed),
//   * stale / unknown session ids are rejected with 404 BEFORE any
//     tool runs,
//   * sessions owned by another player are rejected with 403
//     `session_forbidden` BEFORE any tool runs,
//   * a tool-level `{ok: false, error}` shape is forwarded as 400,
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
    const args = _args as {title_key?: string; stat_key?: string; skill?: string};
    if (toolName === 'spend_skill_point' && args.skill === 'fail') {
      return {ok: false, error: 'unknown skill: fail'};
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

vi.mock('../../services/CharacterStateService.js', () => ({
  CharacterStateService: {
    snapshot: vi.fn(async () => null),
  },
}));

const sessionLifecycleMock = vi.hoisted(() => {
  class FakeSessionOwnershipError extends Error {
    constructor(sessionId: string) {
      super(`session ${sessionId} owned by another player`);
      this.name = 'SessionOwnershipError';
    }
  }
  const liveSessions = new Map<string, {playerId: number}>();
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
let characterStateRoutes: typeof import('../../routes/characterState.js').characterStateRoutes;

beforeAll(async () => {
  ({signCookie} = await import('../../middleware/auth.js'));
  ({ownsPlayer} = await import('../../middleware/ownsPlayer.js'));
  ({rateLimitStateChanges, rateLimitTestHooks} = await import(
    '../../middleware/rateLimit.js'
  ));
  ({characterStateRoutes} = await import('../../routes/characterState.js'));
});

function authCookieHeader(playerId: number): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jti = '00000000-0000-4000-8000-000000000001';
  return `gh_player=${signCookie({playerId, exp, jti})}`;
}

function makeApp(): Hono {
  const app = new Hono();
  app.use('/api/player/:id/character-state', ownsPlayer());
  app.use('/api/player/:id/character-state/*', ownsPlayer());
  app.use('/api/player/:id/character-state/*', rateLimitStateChanges());
  app.route('/api/player', characterStateRoutes);
  return app;
}

describe('character-state action route (FEAT-STATE-1)', () => {
  beforeEach(() => {
    executeToolMock.mockClear();
    sessionLifecycleMock.SessionLifecycleService.getOwned.mockClear();
    sessionLifecycleMock.liveSessions.clear();
    sessionLifecycleMock.liveSessions.set('s-1', {playerId: 42});
    rateLimitTestHooks.clear();
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          action: 'equip_title',
          sessionId: 's-1',
          titleKey: 'ironforged',
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
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(7),
        },
        body: JSON.stringify({
          action: 'equip_title',
          sessionId: 's-1',
          titleKey: 'ironforged',
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
      'http://127.0.0.1:7777/api/player/42/character-state/action',
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
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'award_progression_xp',
          sessionId: 's-1',
          amount: 100,
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {error: string};
    expect(body.error).toBe('invalid_body');
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it('rejects equip_title without titleKey with structured 400', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip_title',
          sessionId: 's-1',
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues: Array<{path: string}>;
    };
    expect(body.error).toBe('invalid_body');
    expect(body.issues.some((i) => i.path === 'titleKey')).toBe(true);
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it('rejects stale / unknown sessionId with 404 unknown_session', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip_title',
          sessionId: 's-does-not-exist',
          titleKey: 'ironforged',
        }),
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      action: 'equip_title',
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
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip_title',
          sessionId: 's-other',
          titleKey: 'ironforged',
        }),
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      action: 'equip_title',
      error: 'session_forbidden',
    });
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it('dispatches equip_title to the equip_title tool with equip=true', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip_title',
          sessionId: 's-1',
          titleKey: 'ironforged',
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
    expect(body.action).toBe('equip_title');
    expect(body.result.tool).toBe('equip_title');
    expect(body.result.args).toEqual({
      title_key: 'ironforged',
      equip: true,
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

  it('dispatches unequip_title to the equip_title tool with equip=false', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'unequip_title',
          sessionId: 's-1',
          titleKey: 'ironforged',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {tool: string; args: Record<string, unknown>};
    };
    expect(body.result.tool).toBe('equip_title');
    expect(body.result.args).toEqual({
      title_key: 'ironforged',
      equip: false,
    });
  });

  it('dispatches spend_stat_point with optional reason forwarded', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'spend_stat_point',
          sessionId: 's-1',
          statKey: 'strength',
          reason: 'forge_training',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {tool: string; args: Record<string, unknown>};
    };
    expect(body.result.tool).toBe('spend_stat_point');
    expect(body.result.args).toEqual({
      stat_key: 'strength',
      reason: 'forge_training',
    });
  });

  it('dispatches spend_stat_point without reason when omitted', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'spend_stat_point',
          sessionId: 's-1',
          statKey: 'dexterity',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {tool: string; args: Record<string, unknown>};
    };
    expect(body.result.args).toEqual({stat_key: 'dexterity'});
  });

  it('dispatches spend_skill_point to the spend_skill_point tool', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'spend_skill_point',
          sessionId: 's-1',
          skill: 'investigation',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {tool: string; args: Record<string, unknown>};
    };
    expect(body.result.tool).toBe('spend_skill_point');
    expect(body.result.args).toEqual({skill: 'investigation'});
  });

  it('forwards a tool-level failure as ok=false 400', async () => {
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'spend_skill_point',
          sessionId: 's-1',
          skill: 'fail',
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
    expect(body.action).toBe('spend_skill_point');
    expect(body.error).toBe('unknown skill: fail');
  });

  it('returns 429 once the per-player SEC-5 bucket is exhausted', async () => {
    rateLimitTestHooks.seed('state:player:42', {
      tokens: 0,
      capacity: 30,
      refillPerMs: 30 / 60_000,
      updatedAt: Date.now(),
    });
    const res = await makeApp().request(
      'http://127.0.0.1:7777/api/player/42/character-state/action',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: authCookieHeader(42),
        },
        body: JSON.stringify({
          action: 'equip_title',
          sessionId: 's-1',
          titleKey: 'ironforged',
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
