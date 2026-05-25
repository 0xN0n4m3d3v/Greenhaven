/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-4 — playthrough route contract.
//
// Mocks `CartridgePlaythroughService` (and the surrounding cartridge
// library services) so we can pin route validation, snake/camelCase
// body parity, status-code mapping, and the cookie issuance call on
// launch / new-game without booting the full PGlite + auth stack.

import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const preview = vi.fn();
const launch = vi.fn();
const newGame = vi.fn();
const authenticatedPlayerId = vi.fn();
const issueCookie = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authenticatedPlayerId,
  issueCookie,
}));

vi.mock('../../services/CartridgePlaythroughService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/CartridgePlaythroughService.js')
  >('../../services/CartridgePlaythroughService.js');
  return {
    ...actual,
    CartridgePlaythroughService: {
      preview,
      launch,
      newGame,
    },
  };
});

vi.mock('../../services/CartridgeImportPreviewService.js', () => ({
  CartridgeImportPreviewService: {
    createJob: vi.fn(),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
  },
}));

vi.mock('../../services/CartridgeImportApplyService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/CartridgeImportApplyService.js')
  >('../../services/CartridgeImportApplyService.js');
  return {
    ...actual,
    CartridgeImportApplyService: {apply: vi.fn()},
  };
});

vi.mock('../../services/CartridgeLibraryService.js', () => ({
  CartridgeLibraryService: {
    listCartridges: vi.fn(),
    getCartridge: vi.fn(),
    listHeroes: vi.fn(),
    listPlaythroughs: vi.fn(),
  },
}));

const {cartridgeLibraryRoutes} = await import('../../routes/cartridges.js');
const {PlaythroughServiceError} = await import(
  '../../services/CartridgePlaythroughService.js'
);

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', cartridgeLibraryRoutes);
  return app;
}

async function postJson(
  app: Hono,
  url: string,
  body: unknown,
): Promise<{status: number; body: Record<string, unknown>}> {
  const res = await app.request(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  return {status: res.status, body: (await res.json()) as Record<string, unknown>};
}

describe('cartridge playthrough routes (FEAT-CART-LIB-4)', () => {
  beforeEach(() => {
    preview.mockReset();
    launch.mockReset();
    newGame.mockReset();
    authenticatedPlayerId.mockReset();
    issueCookie.mockReset();
    authenticatedPlayerId.mockResolvedValue(null);
    issueCookie.mockResolvedValue(undefined);
  });

  describe('POST /api/playthroughs/preview', () => {
    it('returns 200 + view on the happy path (camelCase)', async () => {
      preview.mockResolvedValueOnce({
        playerId: 42,
        publicId: 'pub-42',
        cartridgeId: 'demo',
        mode: 'first_spawn',
        blockers: [],
        // FEAT-HERO-CONTINUITY-1 — preview now carries an additive
        // continuityPreview field; the route must pass it through
        // unchanged.
        continuityPreview: {
          schemaVersion: 'greenhaven.hero_continuity.preview.v1',
          targetCartridgeId: 'demo',
          hero: {
            playerId: 42,
            displayName: 'Hero',
            level: 1,
            xp: 0,
            statTotal: 0,
            proficientSkillCount: 0,
            rankedSkillCount: 0,
            equippedTitles: [],
            ownedTitleCount: 0,
            progressionTracks: [],
            wallet: {statPoints: 0, skillPoints: 0, titleSlots: 0},
          },
          policy: {
            schemaVersion: 'greenhaven.hero_continuity_policy.v1',
            isDefault: true,
            carry: {
              xpLevel: 'visible',
              titles: 'visible',
              inventory: 'local_only',
              quests: 'local_only',
              relationships: 'local_only',
              memories: 'summary_only',
              companions: 'local_only',
            },
            raw: null,
          },
          carriesWithHero: [],
          staysInSourceWorld: [],
          companions: [],
          // FEAT-HERO-CONTINUITY-3 — additive ledger fields.
          portableArtifacts: [],
          companionCandidates: [],
          warnings: [],
          audit: {readsFrom: [], mutatesRows: false},
        },
      });
      const r = await postJson(makeApp(), '/api/playthroughs/preview', {
        playerId: 42,
        cartridgeId: 'demo',
      });
      expect(r.status).toBe(200);
      expect(r.body.cartridgeId).toBe('demo');
      expect(r.body.continuityPreview).toBeTruthy();
      expect(
        (r.body.continuityPreview as Record<string, unknown>).targetCartridgeId,
      ).toBe('demo');
      expect(
        (
          (r.body.continuityPreview as Record<string, unknown>).audit as Record<
            string,
            unknown
          >
        ).mutatesRows,
      ).toBe(false);
      expect(preview).toHaveBeenCalledWith({
        playerId: 42,
        cartridgeId: 'demo',
      });
    });

    it('accepts snake_case body keys', async () => {
      preview.mockResolvedValueOnce({playerId: 7, cartridgeId: 'snake'});
      const r = await postJson(makeApp(), '/api/playthroughs/preview', {
        player_id: 7,
        cartridge_id: 'snake',
      });
      expect(r.status).toBe(200);
      expect(preview).toHaveBeenCalledWith({
        playerId: 7,
        cartridgeId: 'snake',
      });
    });

    it('translates unknown_player to 404', async () => {
      preview.mockRejectedValueOnce(
        new PlaythroughServiceError('unknown_player', 'nope'),
      );
      const r = await postJson(makeApp(), '/api/playthroughs/preview', {
        playerId: 99,
        cartridgeId: 'demo',
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('unknown_player');
    });

    it('translates unknown_cartridge to 404', async () => {
      preview.mockRejectedValueOnce(
        new PlaythroughServiceError('unknown_cartridge', 'nope'),
      );
      const r = await postJson(makeApp(), '/api/playthroughs/preview', {
        playerId: 1,
        cartridgeId: 'bogus',
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('unknown_cartridge');
    });

    it('400s on missing playerId', async () => {
      const r = await postJson(makeApp(), '/api/playthroughs/preview', {
        cartridgeId: 'demo',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_player_id');
      expect(preview).not.toHaveBeenCalled();
    });

    it('400s on missing cartridgeId', async () => {
      const r = await postJson(makeApp(), '/api/playthroughs/preview', {
        playerId: 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_cartridge_id');
      expect(preview).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/playthroughs/launch', () => {
    it('plumbs cookie player id as authenticatedPlayerId + issues cookie on success', async () => {
      authenticatedPlayerId.mockResolvedValueOnce(11);
      launch.mockResolvedValueOnce({
        playerId: 22,
        publicId: 'pub-22',
        cartridgeId: 'demo',
        playthroughId: 'pt-1',
        clearClientCache: {
          keys: ['greenhaven.sessionId', 'greenhaven.playerPublicId'],
          playerPublicId: 'pub-22',
        },
      });
      const r = await postJson(makeApp(), '/api/playthroughs/launch', {
        playerId: 22,
        cartridgeId: 'demo',
      });
      expect(r.status).toBe(200);
      expect(launch).toHaveBeenCalledWith({
        playerId: 22,
        cartridgeId: 'demo',
        authenticatedPlayerId: 11,
      });
      expect(issueCookie).toHaveBeenCalledTimes(1);
      const [, cookieArg] = issueCookie.mock.calls[0]!;
      expect(cookieArg).toBe(22);
    });

    it('does not issue cookie on service rejection', async () => {
      launch.mockRejectedValueOnce(
        new PlaythroughServiceError('repair_required', 'install_cache_not_ready'),
      );
      const r = await postJson(makeApp(), '/api/playthroughs/launch', {
        playerId: 1,
        cartridgeId: 'demo',
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('repair_required');
      expect(issueCookie).not.toHaveBeenCalled();
    });

    it('translates unknown_player to 404 + no cookie', async () => {
      launch.mockRejectedValueOnce(
        new PlaythroughServiceError('unknown_player', 'nope'),
      );
      const r = await postJson(makeApp(), '/api/playthroughs/launch', {
        playerId: 999,
        cartridgeId: 'demo',
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('unknown_player');
      expect(issueCookie).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/playthroughs/new-game', () => {
    it('plumbs cookie id + issues cookie on success', async () => {
      authenticatedPlayerId.mockResolvedValueOnce(33);
      newGame.mockResolvedValueOnce({
        playerId: 33,
        publicId: 'pub-33',
        cartridgeId: 'fresh',
        playthroughId: 'pt-new',
        clearClientCache: {
          keys: ['greenhaven.sessionId'],
          playerPublicId: 'pub-33',
        },
      });
      const r = await postJson(makeApp(), '/api/playthroughs/new-game', {
        playerId: 33,
        cartridgeId: 'fresh',
      });
      expect(r.status).toBe(200);
      expect(newGame).toHaveBeenCalledWith({
        playerId: 33,
        cartridgeId: 'fresh',
        authenticatedPlayerId: 33,
      });
      expect(issueCookie).toHaveBeenCalledTimes(1);
    });

    it('translates no_starting_location to 409', async () => {
      newGame.mockRejectedValueOnce(
        new PlaythroughServiceError('no_starting_location', 'nope'),
      );
      const r = await postJson(makeApp(), '/api/playthroughs/new-game', {
        playerId: 1,
        cartridgeId: 'demo',
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('no_starting_location');
      expect(issueCookie).not.toHaveBeenCalled();
    });

    it('translates other service errors to 400', async () => {
      newGame.mockRejectedValueOnce(
        new PlaythroughServiceError('invalid_player_id', 'bad'),
      );
      const r = await postJson(makeApp(), '/api/playthroughs/new-game', {
        playerId: 1,
        cartridgeId: 'demo',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_player_id');
    });
  });
});
