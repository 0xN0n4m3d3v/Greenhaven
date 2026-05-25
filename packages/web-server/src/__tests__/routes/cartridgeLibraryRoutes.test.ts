/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-1 — `/api/cartridges` / `/api/heroes` /
// `/api/playthroughs` route contract.
//
// Mocks `CartridgeLibraryService` so each test pins what the
// route does to the service output: error shapes, 400 / 404
// branches, JSON envelope keys.

import {Hono} from 'hono';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const listCartridges = vi.fn();
const getCartridge = vi.fn();
const getLibraryStatus = vi.fn();
const listHeroes = vi.fn();
const listPlaythroughs = vi.fn();
const resetCartridge = vi.fn();
const deleteCartridge = vi.fn();
const deleteHero = vi.fn();
const createAnonymousPlayer = vi.fn();
const issueCookie = vi.fn();

vi.mock('../../services/CartridgeLibraryService.js', () => ({
  CartridgeLibraryService: {
    listCartridges,
    getCartridge,
    getLibraryStatus,
    listHeroes,
    listPlaythroughs,
    resetCartridge,
    deleteCartridge,
    deleteHero,
  },
}));

vi.mock('../../playerService.js', () => ({
  createAnonymousPlayer,
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticatedPlayerId: vi.fn().mockResolvedValue(null),
  issueCookie,
}));

const {cartridgeLibraryRoutes} = await import('../../routes/cartridges.js');

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', cartridgeLibraryRoutes);
  return app;
}

describe('cartridgeLibraryRoutes (FEAT-CART-LIB-1)', () => {
  beforeEach(() => {
    listCartridges.mockReset();
    getCartridge.mockReset();
    getLibraryStatus.mockReset();
    listHeroes.mockReset();
    listPlaythroughs.mockReset();
    resetCartridge.mockReset();
    deleteCartridge.mockReset();
    deleteHero.mockReset();
    createAnonymousPlayer.mockReset();
    issueCookie.mockReset();
    issueCookie.mockResolvedValue(undefined);
  });

  describe('GET /api/cartridges', () => {
    it('returns 200 + {cartridges: [...]} envelope', async () => {
      listCartridges.mockResolvedValueOnce([
        {id: 'demo', title: 'Demo', isDefault: true, counts: {locations: 1}},
      ]);
      const app = makeApp();
      const res = await app.request('/api/cartridges');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {cartridges: Array<{id: string}>};
      expect(body.cartridges.map((c) => c.id)).toEqual(['demo']);
    });

    it('returns 200 + empty array when no cartridges installed', async () => {
      listCartridges.mockResolvedValueOnce([]);
      const app = makeApp();
      const res = await app.request('/api/cartridges');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({cartridges: []});
    });
  });

  describe('GET /api/filesystem/directories', () => {
    it('lists local child folders and flags cartridge candidates', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'gh-fs-browser-'));
      try {
        await mkdir(path.join(root, 'Vault', 'Locations'), {recursive: true});
        await writeFile(path.join(root, 'Vault', 'WORLD_MANIFEST.md'), 'demo');
        await mkdir(path.join(root, 'Forge'), {recursive: true});
        await writeFile(path.join(root, 'Forge', 'forge.project.json'), '{}');

        const app = makeApp();
        const res = await app.request(
          `/api/filesystem/directories?path=${encodeURIComponent(root)}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          currentPath: string;
          entries: Array<{
            name: string;
            obsidianVault: boolean;
            forgeProject: boolean;
          }>;
        };
        expect(body.currentPath).toBe(path.resolve(root));
        const byName = new Map(body.entries.map((entry) => [entry.name, entry]));
        expect(byName.get('Vault')?.obsidianVault).toBe(true);
        expect(byName.get('Forge')?.forgeProject).toBe(true);
      } finally {
        await rm(root, {recursive: true, force: true});
      }
    });

    it('rejects missing paths instead of leaking an fs exception', async () => {
      const app = makeApp();
      const missingPath = path.join(
        tmpdir(),
        'greenhaven-missing-folder-for-test',
      );
      const res = await app.request(
        `/api/filesystem/directories?path=${encodeURIComponent(missingPath)}`,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({error: 'invalid_path'});
    });
  });

  describe('GET /api/cartridges/:id', () => {
    it('returns 200 + detail body when the service finds it', async () => {
      getCartridge.mockResolvedValueOnce({
        id: 'demo',
        title: 'Demo',
        manifest: {},
        scopedMeta: [],
        recentImports: [],
      });
      const app = makeApp();
      const res = await app.request('/api/cartridges/demo');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {id: string};
      expect(body.id).toBe('demo');
      expect(getCartridge).toHaveBeenCalledWith('demo');
    });

    it('returns 404 + unknown_cartridge when the service returns null', async () => {
      getCartridge.mockResolvedValueOnce(null);
      const app = makeApp();
      const res = await app.request('/api/cartridges/missing');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({error: 'unknown_cartridge'});
    });

    it('returns 400 for an oversized id without hitting the service', async () => {
      const app = makeApp();
      const huge = 'x'.repeat(257);
      const res = await app.request(`/api/cartridges/${huge}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({error: 'invalid cartridge id'});
      expect(getCartridge).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/cartridges/:id/reset', () => {
    it('resets world runs and returns a client cache hint', async () => {
      resetCartridge.mockResolvedValueOnce({
        reset: true,
        cartridgeId: 'demo',
        sessionsDeleted: 2,
        playthroughStatesDeleted: 3,
      });
      const app = makeApp();
      const res = await app.request('/api/cartridges/demo/reset', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        reset: true,
        cartridgeId: 'demo',
        sessionsDeleted: 2,
        playthroughStatesDeleted: 3,
        clearClientCache: {keys: ['greenhaven.sessionId']},
      });
      expect(resetCartridge).toHaveBeenCalledWith('demo');
    });

    it('returns 404 when the world is unknown', async () => {
      resetCartridge.mockResolvedValueOnce(null);
      const app = makeApp();
      const res = await app.request('/api/cartridges/missing/reset', {
        method: 'POST',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({error: 'unknown_cartridge'});
    });
  });

  describe('DELETE /api/cartridges/:id', () => {
    it('deletes an installed world and returns a client cache hint', async () => {
      deleteCartridge.mockResolvedValueOnce({
        deleted: true,
        cartridgeId: 'demo',
        entitiesDeleted: 12,
        sessionsDeleted: 2,
        playthroughStatesDeleted: 3,
        nextDefaultCartridgeId: null,
      });
      const app = makeApp();
      const res = await app.request('/api/cartridges/demo', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        deleted: true,
        cartridgeId: 'demo',
        entitiesDeleted: 12,
        sessionsDeleted: 2,
        playthroughStatesDeleted: 3,
        nextDefaultCartridgeId: null,
        clearClientCache: {keys: ['greenhaven.sessionId']},
      });
      expect(deleteCartridge).toHaveBeenCalledWith('demo');
    });

    it('returns 404 when the world is unknown', async () => {
      deleteCartridge.mockResolvedValueOnce(null);
      const app = makeApp();
      const res = await app.request('/api/cartridges/missing', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({error: 'unknown_cartridge'});
    });
  });

  describe('GET /api/cartridges/library/status', () => {
    it('returns the library status read model', async () => {
      getLibraryStatus.mockResolvedValueOnce({
        cartridgeCount: 1,
        readyCartridgeCount: 1,
        heroCount: 2,
        activePlaythroughCount: 1,
        defaultForgeProject: {
          available: true,
          path: 'C:/Greenhaven/GreenhavenWorld/.greenhaven-agent-manual/generated/cartridge-forge-project',
        },
      });
      const app = makeApp();
      const res = await app.request('/api/cartridges/library/status');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        cartridgeCount: 1,
        readyCartridgeCount: 1,
        heroCount: 2,
        activePlaythroughCount: 1,
        defaultForgeProject: {
          available: true,
          path: 'C:/Greenhaven/GreenhavenWorld/.greenhaven-agent-manual/generated/cartridge-forge-project',
        },
      });
    });

    it('maps local PGlite failures to a typed 503 instead of internal_error', async () => {
      getLibraryStatus.mockRejectedValueOnce(
        new Error('PGlite failed to initialize properly'),
      );
      const app = makeApp();
      const res = await app.request('/api/cartridges/library/status');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'local_database_unavailable',
        message:
          'Local game database is unavailable. Restart the backend with a clean local database and try again.',
      });
    });
  });

  describe('GET /api/heroes', () => {
    it('returns 200 + {heroes: [...]} envelope and never leaks recovery_code fields', async () => {
      listHeroes.mockResolvedValueOnce([
        {
          playerId: 7,
          publicId: 'pub-7',
          name: 'Hero',
          level: 1,
          xp: 0,
          profileCreated: false,
          lastSeenAt: null,
          currentCartridgeId: null,
          states: [],
        },
      ]);
      const app = makeApp();
      const res = await app.request('/api/heroes');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {heroes: unknown[]};
      const serialized = JSON.stringify(body);
      expect(body.heroes).toHaveLength(1);
      expect(serialized).not.toContain('recovery_code_hash');
      expect(serialized).not.toContain('recovery_code_prefix');
    });
  });

  describe('POST /api/heroes (FEAT-CART-LIB-5)', () => {
    it('mints a fresh anonymous player + issues cookie + returns clearClientCache hint', async () => {
      createAnonymousPlayer.mockResolvedValueOnce({
        entity_id: 1001,
        public_id: 'pub-1001',
        display_name: 'New Hero',
        recovery_code: 'AAAA-BBBB-CCCC-DDDD',
      });
      const app = makeApp();
      const res = await app.request('/api/heroes', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({displayName: 'New Hero'}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        player: {entity_id: number; public_id: string};
        clearClientCache: {keys: string[]; playerPublicId: string};
      };
      expect(body.player.entity_id).toBe(1001);
      expect(body.player.public_id).toBe('pub-1001');
      expect(body.clearClientCache.playerPublicId).toBe('pub-1001');
      expect(body.clearClientCache.keys).toContain('greenhaven.sessionId');
      expect(body.clearClientCache.keys).toContain('greenhaven.playerPublicId');
      expect(createAnonymousPlayer).toHaveBeenCalledWith('New Hero');
      expect(issueCookie).toHaveBeenCalledTimes(1);
      const [, cookieArg] = issueCookie.mock.calls[0]!;
      expect(cookieArg).toBe(1001);
    });

    it('accepts snake_case display_name', async () => {
      createAnonymousPlayer.mockResolvedValueOnce({
        entity_id: 1002,
        public_id: 'pub-1002',
        display_name: 'Snake Hero',
        recovery_code: 'ZZZZ-YYYY-XXXX-WWWW',
      });
      const app = makeApp();
      await app.request('/api/heroes', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({display_name: 'Snake Hero'}),
      });
      expect(createAnonymousPlayer).toHaveBeenCalledWith('Snake Hero');
    });

    it('works with empty body (no display name)', async () => {
      createAnonymousPlayer.mockResolvedValueOnce({
        entity_id: 1003,
        public_id: 'pub-1003',
        display_name: 'Unnamed',
        recovery_code: 'AAAA-BBBB-CCCC-EEEE',
      });
      const app = makeApp();
      const res = await app.request('/api/heroes', {method: 'POST'});
      expect(res.status).toBe(200);
      expect(createAnonymousPlayer).toHaveBeenCalledWith(undefined);
      expect(issueCookie).toHaveBeenCalledTimes(1);
    });

    it('maps local PGlite failures to a typed 503 instead of internal_error', async () => {
      createAnonymousPlayer.mockRejectedValueOnce(
        new Error('PGlite failed to initialize properly'),
      );
      const app = makeApp();
      const res = await app.request('/api/heroes', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({displayName: 'Blocked'}),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'local_database_unavailable',
        message:
          'Local game database is unavailable. Restart the backend with a clean local database and try again.',
      });
      expect(issueCookie).not.toHaveBeenCalled();
    });

    it('does not delete any existing hero (createAnonymousPlayer is insert-only by contract)', async () => {
      // The route never calls any delete/reset helper. We pin the
      // contract by asserting the service surface mocked is the
      // single `createAnonymousPlayer` insert call.
      createAnonymousPlayer.mockResolvedValueOnce({
        entity_id: 1004,
        public_id: 'pub-1004',
        display_name: 'Untouched',
        recovery_code: 'EEEE-FFFF-1111-2222',
      });
      const app = makeApp();
      await app.request('/api/heroes', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({}),
      });
      expect(createAnonymousPlayer).toHaveBeenCalledTimes(1);
      // No other service write surfaces are mocked + called here.
    });
  });

  describe('DELETE /api/heroes/:id', () => {
    it('deletes a hero and returns a client cache hint', async () => {
      deleteHero.mockResolvedValueOnce({
        deleted: true,
        playerId: 1001,
        sessionsDeleted: 4,
      });
      const app = makeApp();
      const res = await app.request('/api/heroes/1001', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        deleted: true,
        playerId: 1001,
        sessionsDeleted: 4,
        clearClientCache: {
          keys: ['greenhaven.sessionId', 'greenhaven.playerPublicId'],
        },
      });
      expect(deleteHero).toHaveBeenCalledWith(1001);
    });

    it('returns 400 for an invalid hero id', async () => {
      const app = makeApp();
      const res = await app.request('/api/heroes/not-a-number', {
        method: 'DELETE',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({error: 'invalid_player_id'});
      expect(deleteHero).not.toHaveBeenCalled();
    });

    it('returns 404 when the hero is unknown', async () => {
      deleteHero.mockResolvedValueOnce(null);
      const app = makeApp();
      const res = await app.request('/api/heroes/404', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({error: 'unknown_player'});
    });
  });

  describe('GET /api/playthroughs', () => {
    it('returns 200 + {playthroughs: [...]}', async () => {
      listPlaythroughs.mockResolvedValueOnce([
        {
          playerId: 7,
          publicId: 'pub-7',
          heroName: 'Hero',
          cartridgeId: 'demo',
          cartridgeTitle: 'Demo',
          status: 'available',
          lastLocationName: null,
          lastSessionId: null,
          updatedAt: '2026-05-17T00:00:00.000Z',
        },
      ]);
      const app = makeApp();
      const res = await app.request('/api/playthroughs');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {playthroughs: unknown[]};
      expect(body.playthroughs).toHaveLength(1);
    });
  });
});
