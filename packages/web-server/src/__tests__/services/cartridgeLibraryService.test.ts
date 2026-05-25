/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-1 — `CartridgeLibraryService` contract.
//
// Mocks `query()` so each test plants the rows it cares about and
// asserts the DTO surface the GUI consumes. Migration shape, FKs,
// indexes, and the default-cartridge backfill are covered by the
// PGlite-backed `cartridgeLibrary.test.ts` companion.

import {beforeEach, describe, expect, it, vi} from 'vitest';

interface QueryRow {
  [key: string]: unknown;
}
interface QueryResult {
  rows: QueryRow[];
  rowCount?: number;
}

const queryMock =
  vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const withTransactionMock = vi.fn(
  async <T>(fn: (client: {query: typeof queryMock}) => Promise<T>) =>
    await fn({query: queryMock}),
);

vi.mock('../../db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
}));

const {CartridgeLibraryService} = await import(
  '../../services/CartridgeLibraryService.js'
);
const cartridgeCache = await import('../../cartridge.js');

function matchSql(sql: string, fragment: string): boolean {
  return sql.includes(fragment);
}

interface CartridgeRowMock extends QueryRow {
  id: string;
  title: string;
  version: string;
  schema_version: string;
  status: string;
  content_hash: string;
  source_kind: string;
  source_path: string | null;
  manifest: Record<string, unknown> | null;
  validation_report: Record<string, unknown> | null;
  installed_at: string;
  updated_at: string;
}

function cartridgeRow(overrides: Partial<CartridgeRowMock> = {}): CartridgeRowMock {
  return {
    id: 'demo',
    title: 'Demo',
    version: '0.1.0',
    schema_version: '1',
    status: 'installed',
    content_hash: 'legacy:demo',
    source_kind: 'builtin',
    source_path: null,
    manifest: {},
    validation_report: {},
    installed_at: '2026-05-17T00:00:00.000Z',
    updated_at: '2026-05-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('CartridgeLibraryService (FEAT-CART-LIB-1)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withTransactionMock.mockClear();
    cartridgeCache.clearMetaCache();
  });

  describe('listCartridges()', () => {
    it('returns DTOs with counts, validation summary, and default flag', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'FROM cartridges') && matchSql(sql, 'ORDER BY installed_at')) {
          return {
            rows: [
              cartridgeRow({
                id: 'quickgrin-lane',
                title: 'Quickgrin Lane',
                validation_report: {errors: 0, warnings: 2},
              }),
              cartridgeRow({
                id: 'second-world',
                title: 'Second World',
                installed_at: '2026-05-18T00:00:00.000Z',
                updated_at: '2026-05-18T00:00:00.000Z',
                manifest: {generatedFrom: 'obsidian'},
                source_kind: 'obsidian_vault',
                source_path: '/tmp/vault',
              }),
            ],
          };
        }
        if (
          matchSql(sql, 'SELECT value FROM cartridge_meta WHERE key') &&
          (params?.[0] === 'cartridge_id')
        ) {
          // activeCartridgeId → getMetaRequired
          return {rows: [{value: 'quickgrin-lane'}]};
        }
        if (matchSql(sql, 'cartridge_records')) {
          // No records yet on the default backfill; rely on
          // entities fallback below.
          return {rows: []};
        }
        if (matchSql(sql, 'FROM entities') && matchSql(sql, 'cartridge_id')) {
          // Direct entities count fallback for the default
          // cartridge.
          return {
            rows: [
              {kind: 'location', count: '4'},
              {kind: 'person', count: '3'},
              {kind: 'quest', count: '2'},
              {kind: 'scene', count: '1'},
              {kind: 'item', count: '5'},
            ],
          };
        }
        if (matchSql(sql, 'cartridge_meta_scoped') && matchSql(sql, 'starting_location_id')) {
          return {rows: [{display_name: 'Quickgrin Lane Plaza'}]};
        }
        if (matchSql(sql, 'FROM cartridge_meta') && matchSql(sql, 'starting_location_id')) {
          return {rows: [{display_name: 'Quickgrin Lane Plaza'}]};
        }
        if (matchSql(sql, 'cartridge_import_runs')) {
          return {rows: [{applied_at: '2026-05-15T12:00:00.000Z'}]};
        }
        return {rows: []};
      });
      const list = await CartridgeLibraryService.listCartridges();
      expect(list).toHaveLength(2);
      const def = list[0]!;
      expect(def.id).toBe('quickgrin-lane');
      expect(def.title).toBe('Quickgrin Lane');
      expect(def.isDefault).toBe(true);
      expect(def.validation).toEqual({errors: 0, warnings: 2});
      expect(def.counts).toEqual({
        locations: 4,
        people: 3,
        quests: 2,
        scenes: 1,
        items: 5,
      });
      expect(def.startingLocationName).toBe('Quickgrin Lane Plaza');
      expect(def.lastImportAt).toBe('2026-05-15T12:00:00.000Z');
      expect(def.source).toEqual({kind: 'builtin', path: null, generatedFrom: null});
      const other = list[1]!;
      expect(other.id).toBe('second-world');
      expect(other.isDefault).toBe(false);
      expect(other.source).toEqual({
        kind: 'obsidian_vault',
        path: '/tmp/vault',
        generatedFrom: 'obsidian',
      });
    });

    it('uses cartridge_records counts when present (ignores entities fallback)', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'FROM cartridges')) {
          return {rows: [cartridgeRow({id: 'demo'})]};
        }
        if (
          matchSql(sql, 'SELECT value FROM cartridge_meta WHERE key') &&
          (params?.[0] === 'cartridge_id')
        ) {
          return {rows: [{value: 'demo'}]};
        }
        if (
          matchSql(sql, 'FROM entities') &&
          matchSql(sql, 'cartridge_records')
        ) {
          return {
            rows: [
              {kind: 'location', count: '7'},
              {kind: 'person', count: '11'},
            ],
          };
        }
        return {rows: []};
      });
      const list = await CartridgeLibraryService.listCartridges();
      expect(list[0]?.counts.locations).toBe(7);
      expect(list[0]?.counts.people).toBe(11);
      expect(list[0]?.counts.items).toBe(0);
    });

    it('never exposes raw recovery hashes or hidden profile blobs (DTO shape lock)', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'FROM cartridges')) {
          return {
            rows: [
              cartridgeRow({
                id: 'demo',
                manifest: {leakRiskInternal: 'should-not-surface'},
              }),
            ],
          };
        }
        if (
          matchSql(sql, 'SELECT value FROM cartridge_meta WHERE key') &&
          (params?.[0] === 'cartridge_id')
        ) {
          return {rows: [{value: 'demo'}]};
        }
        return {rows: []};
      });
      const list = await CartridgeLibraryService.listCartridges();
      const serialized = JSON.stringify(list[0]);
      expect(serialized).not.toContain('recovery_code_hash');
      expect(serialized).not.toContain('recovery_code_prefix');
      // The summary DTO must not echo internal manifest keys
      // verbatim — only the explicit fields the GUI consumes.
      expect(serialized).not.toContain('leakRiskInternal');
    });
  });

  describe('getCartridge()', () => {
    it('returns null for an unknown id', async () => {
      queryMock.mockImplementation(async () => ({rows: []}));
      const out = await CartridgeLibraryService.getCartridge('missing');
      expect(out).toBeNull();
    });

    it('returns full details with scoped-meta keys + recent imports', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'FROM cartridges') && matchSql(sql, 'WHERE id = $1')) {
          return {rows: [cartridgeRow({id: params?.[0] as string, title: 'Demo'})]};
        }
        if (
          matchSql(sql, 'SELECT value FROM cartridge_meta WHERE key') &&
          (params?.[0] === 'cartridge_id')
        ) {
          return {rows: [{value: 'demo'}]};
        }
        if (
          matchSql(sql, 'FROM cartridge_meta_scoped') &&
          matchSql(sql, 'ORDER BY key')
        ) {
          return {
            rows: [
              {key: 'cartridge_id', description: 'Identifier of the active cartridge.'},
              {key: 'starting_location_id', description: 'entity_id where new players spawn.'},
            ],
          };
        }
        if (matchSql(sql, 'cartridge_import_runs') && matchSql(sql, 'mode')) {
          return {
            rows: [
              {
                id: 42,
                mode: 'install',
                status: 'applied',
                created_at: '2026-05-15T11:00:00.000Z',
                applied_at: '2026-05-15T12:00:00.000Z',
              },
            ],
          };
        }
        return {rows: []};
      });
      const out = await CartridgeLibraryService.getCartridge('demo');
      expect(out?.id).toBe('demo');
      expect(out?.scopedMeta).toHaveLength(2);
      expect(out?.scopedMeta[0]).toEqual({
        key: 'cartridge_id',
        description: 'Identifier of the active cartridge.',
      });
      expect(out?.recentImports).toHaveLength(1);
      expect(out?.recentImports[0]).toMatchObject({
        id: 42,
        mode: 'install',
        status: 'applied',
      });
    });
  });

  describe('listHeroes()', () => {
    it('returns hero summaries with per-cartridge state ordering (active first)', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM players p') && matchSql(sql, 'JOIN entities e')) {
          return {
            rows: [
              {
                entity_id: 999_001,
                public_id: 'pub-abc',
                display_name: 'Hero Anya',
                profile_created: true,
                current_xp: 1200,
                current_level: 5,
                current_location_id: 100,
                last_seen: '2026-05-17T10:00:00.000Z',
              },
            ],
          };
        }
        if (matchSql(sql, 'FROM hero_cartridge_states h')) {
          return {
            rows: [
              {
                player_id: 999_001,
                cartridge_id: 'second-world',
                status: 'available',
                last_session_id: null,
                current_location_id: null,
                last_location_name: null,
                updated_at: '2026-05-15T00:00:00.000Z',
              },
              {
                player_id: 999_001,
                cartridge_id: 'quickgrin-lane',
                status: 'active',
                last_session_id: 'sess-xyz',
                current_location_id: 100,
                last_location_name: 'Quickgrin Lane Plaza',
                updated_at: '2026-05-17T09:00:00.000Z',
              },
            ],
          };
        }
        return {rows: []};
      });
      const heroes = await CartridgeLibraryService.listHeroes();
      expect(heroes).toHaveLength(1);
      const h = heroes[0]!;
      expect(h.name).toBe('Hero Anya');
      expect(h.level).toBe(5);
      expect(h.xp).toBe(1200);
      expect(h.profileCreated).toBe(true);
      expect(h.lastSeenAt).toBe('2026-05-17T10:00:00.000Z');
      // The `active` state wins for currentCartridgeId
      expect(h.currentCartridgeId).toBe('quickgrin-lane');
      expect(h.states.map((s) => s.cartridgeId)).toEqual([
        'second-world',
        'quickgrin-lane',
      ]);
      // Privacy: no hash/recovery field leakage
      const serialized = JSON.stringify(h);
      expect(serialized).not.toContain('recovery');
      expect(serialized).not.toContain('hash');
    });

    it('returns [] when no players exist', async () => {
      queryMock.mockImplementation(async () => ({rows: []}));
      expect(await CartridgeLibraryService.listHeroes()).toEqual([]);
    });
  });

  describe('listPlaythroughs()', () => {
    it('flattens hero_cartridge_states with hero name + cartridge title', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (
          matchSql(sql, 'FROM hero_cartridge_states h') &&
          matchSql(sql, 'JOIN cartridges c')
        ) {
          return {
            rows: [
              {
                player_id: 999_001,
                public_id: 'pub-abc',
                hero_name: 'Hero Anya',
                cartridge_id: 'quickgrin-lane',
                cartridge_title: 'Quickgrin Lane',
                status: 'active',
                last_session_id: 'sess-xyz',
                last_location_name: 'Quickgrin Lane Plaza',
                updated_at: '2026-05-17T09:00:00.000Z',
              },
            ],
          };
        }
        return {rows: []};
      });
      const list = await CartridgeLibraryService.listPlaythroughs();
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        playerId: 999_001,
        publicId: 'pub-abc',
        heroName: 'Hero Anya',
        cartridgeId: 'quickgrin-lane',
        cartridgeTitle: 'Quickgrin Lane',
        status: 'active',
        lastLocationName: 'Quickgrin Lane Plaza',
        lastSessionId: 'sess-xyz',
        updatedAt: '2026-05-17T09:00:00.000Z',
      });
    });
  });

  describe('library mutations', () => {
    it('deleteHero removes matching sessions then the player entity', async () => {
      const calls: string[] = [];
      queryMock.mockImplementation(async (sql: string) => {
        calls.push(sql);
        if (matchSql(sql, 'FROM entities e') && matchSql(sql, "e.kind = 'player'")) {
          return {rows: [{id: 77}]};
        }
        if (matchSql(sql, 'FROM sessions') && matchSql(sql, 'player_id = $1')) {
          return {rows: [{id: 'sess-a'}, {id: 'sess-b'}]};
        }
        if (matchSql(sql, 'DELETE FROM sessions')) return {rows: [], rowCount: 2};
        if (matchSql(sql, 'DELETE FROM entities')) return {rows: [], rowCount: 1};
        return {rows: []};
      });
      const out = await CartridgeLibraryService.deleteHero(77);
      expect(out).toEqual({deleted: true, playerId: 77, sessionsDeleted: 2});
      expect(withTransactionMock).toHaveBeenCalledTimes(1);
      expect(calls.some((sql) => matchSql(sql, 'DELETE FROM entities'))).toBe(true);
    });

    it('deleteHero returns null for an unknown player', async () => {
      queryMock.mockResolvedValue({rows: []});
      await expect(CartridgeLibraryService.deleteHero(404)).resolves.toBeNull();
    });

    it('resetCartridge clears playthrough states and sessions but keeps cartridge content', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'SELECT id FROM cartridges')) {
          return {rows: [{id: 'demo'}]};
        }
        if (matchSql(sql, 'DELETE FROM sessions')) return {rows: [], rowCount: 1};
        if (matchSql(sql, 'DELETE FROM hero_cartridge_states')) {
          return {rows: [], rowCount: 2};
        }
        if (matchSql(sql, 'FROM hero_cartridge_states')) {
          return {
            rows: [
              {player_id: 10, last_session_id: 'sess-10'},
              {player_id: 11, last_session_id: null},
            ],
          };
        }
        return {rows: []};
      });
      const out = await CartridgeLibraryService.resetCartridge('demo');
      expect(out).toEqual({
        reset: true,
        cartridgeId: 'demo',
        sessionsDeleted: 1,
        playthroughStatesDeleted: 2,
      });
    });

    it('deleteCartridge removes static imported entities and promotes the next default cartridge', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'SELECT id FROM cartridges WHERE id = $1')) {
          return {rows: [{id: 'old-world'}]};
        }
        if (
          matchSql(sql, 'SELECT last_session_id') &&
          matchSql(sql, 'FROM hero_cartridge_states')
        ) {
          return {rows: [{last_session_id: 'sess-old'}]};
        }
        if (matchSql(sql, 'DELETE FROM sessions')) return {rows: [], rowCount: 1};
        if (matchSql(sql, 'DELETE FROM hero_cartridge_states')) {
          return {rows: [], rowCount: 3};
        }
        if (matchSql(sql, 'FROM entities') && matchSql(sql, 'cartridge_id = $1')) {
          return {rows: [{id: 100}, {id: 200}]};
        }
        if (matchSql(sql, 'UPDATE players')) return {rows: [], rowCount: 1};
        if (matchSql(sql, 'DELETE FROM entities')) return {rows: [], rowCount: 2};
        if (matchSql(sql, 'DELETE FROM cartridges')) return {rows: [], rowCount: 1};
        if (matchSql(sql, 'ORDER BY installed_at')) {
          return {rows: [{id: 'next-world'}]};
        }
        if (matchSql(sql, 'INSERT INTO cartridge_meta')) {
          return {rows: [], rowCount: 1};
        }
        return {rows: []};
      });
      const out = await CartridgeLibraryService.deleteCartridge('old-world');
      expect(out).toEqual({
        deleted: true,
        cartridgeId: 'old-world',
        entitiesDeleted: 2,
        sessionsDeleted: 1,
        playthroughStatesDeleted: 3,
        nextDefaultCartridgeId: 'next-world',
      });
    });
  });

  // FEAT-ENGINE-BASELINE-6 corrective: `getLibraryStatus()` is the GUI
  // boot gate; it MUST return a stable LibraryStatus DTO for every
  // documented degraded state (clean worldless engine DB, no
  // cartridges installed, ready install cache present, missing/stale
  // scoped metadata, partially generated Obsidian vault, install
  // cache row missing or table absent, PGlite WASM-abort on the
  // cartridges or players query) so BootGate + WorldsHeroesScreen
  // route the operator into Worlds & Heroes / Import instead of
  // crashing on a 500. The dev pgdata corruption that surfaced
  // `RuntimeError: Aborted()` on every cartridges SELECT is the
  // concrete trigger documented in
  // `.greenhaven-agent-manual/cartridgebuilder-work/handoffs/`.
  describe('getLibraryStatus()', () => {
    it('clean baseline (no cartridges, no heroes) returns deterministic zeros', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM cartridges')) return {rows: []};
        if (
          matchSql(sql, 'FROM players p') &&
          matchSql(sql, 'JOIN entities e')
        ) {
          return {rows: [{c: 0}]};
        }
        return {rows: []};
      });
      const status = await CartridgeLibraryService.getLibraryStatus();
      expect(status.cartridgeCount).toBe(0);
      expect(status.readyCartridgeCount).toBe(0);
      expect(status.heroCount).toBe(0);
      expect(status.activePlaythroughCount).toBe(0);
      expect(typeof status.defaultForgeProject.path).toBe('string');
      expect(status.defaultForgeProject.path.length).toBeGreaterThan(0);
      expect(typeof status.defaultForgeProject.available).toBe('boolean');
    });

    it('ready install cache + zero validation errors counts as ready', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'FROM cartridges')) {
          return {
            rows: [
              {
                cartridge_id: 'quickgrin-lane',
                content_hash: 'hash-1',
                validation_report: {errors: 0, warnings: 0},
              },
            ],
          };
        }
        if (matchSql(sql, 'FROM cartridge_install_cache')) {
          return {
            rows: [
              {
                cartridge_id: params?.[0],
                state: 'ready',
                content_hash: 'hash-1',
                record_count: 12,
                last_verified_at: '2026-05-17T00:00:00.000Z',
                notes: {},
              },
            ],
          };
        }
        if (
          matchSql(sql, 'FROM players p') &&
          matchSql(sql, 'JOIN entities e')
        ) {
          return {rows: [{c: 2}]};
        }
        return {rows: []};
      });
      const status = await CartridgeLibraryService.getLibraryStatus();
      expect(status.cartridgeCount).toBe(1);
      expect(status.readyCartridgeCount).toBe(1);
      expect(status.heroCount).toBe(2);
      expect(status.activePlaythroughCount).toBe(0);
    });

    it('includes cartridge boot media from the scoped asset manifest', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'SELECT id AS cartridge_id')) {
          return {
            rows: [
              {
                cartridge_id: 'boot-world',
                content_hash: 'hash-boot',
                validation_report: {errors: 0, warnings: 0},
              },
            ],
          };
        }
        if (matchSql(sql, 'FROM cartridge_install_cache')) {
          return {
            rows: [
              {
                cartridge_id: params?.[0],
                state: 'ready',
                content_hash: 'hash-boot',
                record_count: 3,
                last_verified_at: '2026-05-17T00:00:00.000Z',
                notes: {},
              },
            ],
          };
        }
        if (
          matchSql(sql, 'SELECT value FROM cartridge_meta WHERE key') &&
          params?.[0] === 'cartridge_id'
        ) {
          return {rows: [{value: 'boot-world'}]};
        }
        if (matchSql(sql, 'FROM cartridge_meta_scoped')) {
          return {
            rows: [
              {
                value: {
                  schema_version: 'greenhaven.cartridge_assets.v1',
                  cartridge_id: 'boot-world',
                  cache_root: 'cartridges/boot-world/assets',
                  source_path: '',
                  generated_at: '',
                  counts: {
                    total: 3,
                    available: 3,
                    missing: 0,
                    unsupported_extension: 0,
                  },
                  rows: [
                    {
                      asset_id: 'poster',
                      kind: 'cartridge',
                      slug: 'boot',
                      role: 'boot_poster_01',
                      mention: '@Boot 01',
                      source_path: 'GreenHavenWorld/media/boot/01.png',
                      content_hash: 'poster-hash',
                      cache_path: 'poster.png',
                      content_type: 'image/png',
                      extension: '.png',
                      status: 'available',
                    },
                    {
                      asset_id: 'video',
                      kind: 'cartridge',
                      slug: 'boot',
                      role: 'boot_video_01',
                      mention: '@Boot 01',
                      source_path: 'GreenHavenWorld/media/boot/01.mp4',
                      content_hash: 'video-hash',
                      cache_path: 'video.mp4',
                      content_type: 'video/mp4',
                      extension: '.mp4',
                      status: 'available',
                    },
                    {
                      asset_id: 'music',
                      kind: 'cartridge',
                      slug: 'boot',
                      role: 'boot_music_01',
                      mention: '@Boot 01',
                      source_path: 'GreenHavenWorld/media/boot/01.mp3',
                      content_hash: 'music-hash',
                      cache_path: 'music.mp3',
                      content_type: 'audio/mpeg',
                      extension: '.mp3',
                      status: 'available',
                    },
                  ],
                },
              },
            ],
          };
        }
        if (
          matchSql(sql, 'FROM players p') &&
          matchSql(sql, 'JOIN entities e')
        ) {
          return {rows: [{c: 0}]};
        }
        return {rows: []};
      });

      const status = await CartridgeLibraryService.getLibraryStatus();
      expect(status.bootMedia).toEqual({
        cartridgeId: 'boot-world',
        bundles: [
          {
            id: '01',
            posterUrl:
              '/api/assets/cartridges/boot-world/world/cartridge/boot/boot_poster_01',
            videoUrl:
              '/api/assets/cartridges/boot-world/world/cartridge/boot/boot_video_01',
            musicUrl:
              '/api/assets/cartridges/boot-world/world/cartridge/boot/boot_music_01',
          },
        ],
      });
    });

    it('counts only active launched playthroughs for the boot continue gate', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'SELECT id AS cartridge_id')) {
          return {
            rows: [
              {
                cartridge_id: 'quickgrin-lane',
                content_hash: 'hash-1',
                validation_report: {errors: 0, warnings: 0},
              },
            ],
          };
        }
        if (matchSql(sql, 'FROM cartridge_install_cache')) {
          return {
            rows: [
              {
                cartridge_id: params?.[0],
                state: 'ready',
                content_hash: 'hash-1',
                record_count: 12,
                last_verified_at: '2026-05-17T00:00:00.000Z',
                notes: {},
              },
            ],
          };
        }
        if (
          matchSql(sql, 'FROM players p') &&
          matchSql(sql, 'JOIN entities e')
        ) {
          return {rows: [{c: 2}]};
        }
        if (matchSql(sql, 'FROM hero_cartridge_states h')) {
          return {rows: [{c: 1}]};
        }
        return {rows: []};
      });
      const status = await CartridgeLibraryService.getLibraryStatus();
      expect(status.readyCartridgeCount).toBe(1);
      expect(status.heroCount).toBe(2);
      expect(status.activePlaythroughCount).toBe(1);
    });

    it('validation errors > 0 prevents ready count even when install cache says ready', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'FROM cartridges')) {
          return {
            rows: [
              {
                cartridge_id: 'broken-world',
                content_hash: 'hash-2',
                validation_report: {errors: 3, warnings: 0},
              },
            ],
          };
        }
        if (matchSql(sql, 'FROM cartridge_install_cache')) {
          return {
            rows: [
              {
                cartridge_id: params?.[0],
                state: 'ready',
                content_hash: 'hash-2',
                record_count: 7,
                last_verified_at: '2026-05-17T00:00:00.000Z',
                notes: {},
              },
            ],
          };
        }
        return {rows: []};
      });
      const status = await CartridgeLibraryService.getLibraryStatus();
      expect(status.cartridgeCount).toBe(1);
      expect(status.readyCartridgeCount).toBe(0);
      expect(status.activePlaythroughCount).toBe(0);
    });

    it('cartridges SELECT throw (corrupt pgdata / missing table) degrades to zero, not 500', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM cartridges')) {
          throw new Error(
            'RuntimeError: Aborted(). Build with -sASSERTIONS for more info.',
          );
        }
        if (
          matchSql(sql, 'FROM players p') &&
          matchSql(sql, 'JOIN entities e')
        ) {
          return {rows: [{c: 1}]};
        }
        return {rows: []};
      });
      const status = await CartridgeLibraryService.getLibraryStatus();
      expect(status.cartridgeCount).toBe(0);
      expect(status.readyCartridgeCount).toBe(0);
      expect(status.heroCount).toBe(1);
      expect(status.activePlaythroughCount).toBe(0);
      expect(typeof status.defaultForgeProject.available).toBe('boolean');
    });

    it('readInstallCache throw on one cartridge leaves count at 0 for that row but does not crash', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM cartridges')) {
          return {
            rows: [
              {
                cartridge_id: 'cart-a',
                content_hash: 'h-a',
                validation_report: {errors: 0, warnings: 0},
              },
            ],
          };
        }
        if (matchSql(sql, 'FROM cartridge_install_cache')) {
          throw new Error('relation "cartridge_install_cache" does not exist');
        }
        if (
          matchSql(sql, 'FROM players p') &&
          matchSql(sql, 'JOIN entities e')
        ) {
          return {rows: [{c: 0}]};
        }
        return {rows: []};
      });
      const status = await CartridgeLibraryService.getLibraryStatus();
      expect(status.cartridgeCount).toBe(1);
      // Install cache read failed, so ready count cannot increment.
      expect(status.readyCartridgeCount).toBe(0);
      expect(status.heroCount).toBe(0);
      expect(status.activePlaythroughCount).toBe(0);
    });

    it('players JOIN entities throw degrades heroCount to 0, not 500', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM cartridges')) return {rows: []};
        if (
          matchSql(sql, 'FROM players p') &&
          matchSql(sql, 'JOIN entities e')
        ) {
          throw new Error(
            'RuntimeError: Aborted(). Build with -sASSERTIONS for more info.',
          );
        }
        return {rows: []};
      });
      const status = await CartridgeLibraryService.getLibraryStatus();
      expect(status.cartridgeCount).toBe(0);
      expect(status.heroCount).toBe(0);
      expect(status.activePlaythroughCount).toBe(0);
    });
  });

  // 2026-05-18 follow-up corrective: the four read-only methods that
  // back `GET /api/cartridges`, `GET /api/cartridges/:id`,
  // `GET /api/heroes`, `GET /api/playthroughs` must survive the same
  // degraded local-DB state that `getLibraryStatus()` already
  // tolerated (PGlite WASM abort, missing table, dropped column).
  // Worlds & Heroes loads all four in parallel; a 500 on any one of
  // them blocks the entire library view.
  describe('listCartridges() degraded-state guards', () => {
    it('returns [] when the base cartridges SELECT throws', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM cartridges')) {
          throw new Error(
            'RuntimeError: Aborted(). Build with -sASSERTIONS for more info.',
          );
        }
        return {rows: []};
      });
      const list = await CartridgeLibraryService.listCartridges();
      expect(list).toEqual([]);
    });

    it('per-cartridge auxiliary failures degrade to safe defaults but list still renders', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM cartridges') && matchSql(sql, 'ORDER BY installed_at')) {
          return {rows: [cartridgeRow({id: 'broken-aux'})]};
        }
        if (
          matchSql(sql, 'SELECT value FROM cartridge_meta WHERE key')
        ) {
          // activeCartridgeId lookup — let it succeed so isDefault
          // gates on the cartridge id alone.
          return {rows: [{value: 'broken-aux'}]};
        }
        // Every other auxiliary read fails (counts, starting location,
        // last import, install cache).
        throw new Error('relation does not exist');
      });
      const list = await CartridgeLibraryService.listCartridges();
      expect(list).toHaveLength(1);
      const row = list[0]!;
      expect(row.id).toBe('broken-aux');
      expect(row.counts).toEqual({
        locations: 0,
        people: 0,
        quests: 0,
        scenes: 0,
        items: 0,
      });
      expect(row.startingLocationName).toBeNull();
      expect(row.lastImportAt).toBeNull();
      expect(row.installCache).toBeNull();
    });
  });

  describe('getCartridge() degraded-state guards', () => {
    it('returns null (route → 404) when the base cartridges SELECT throws', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM cartridges')) {
          throw new Error(
            'RuntimeError: Aborted(). Build with -sASSERTIONS for more info.',
          );
        }
        return {rows: []};
      });
      const out = await CartridgeLibraryService.getCartridge('demo');
      expect(out).toBeNull();
    });

    it('scoped-meta + recent-imports failures degrade to empty arrays', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (matchSql(sql, 'FROM cartridges') && matchSql(sql, 'WHERE id = $1')) {
          return {rows: [cartridgeRow({id: params?.[0] as string})]};
        }
        if (matchSql(sql, 'cartridge_meta_scoped') && matchSql(sql, 'ORDER BY key')) {
          throw new Error('relation "cartridge_meta_scoped" does not exist');
        }
        if (matchSql(sql, 'cartridge_import_runs') && matchSql(sql, 'mode')) {
          throw new Error('relation "cartridge_import_runs" does not exist');
        }
        return {rows: []};
      });
      const out = await CartridgeLibraryService.getCartridge('demo');
      expect(out).not.toBeNull();
      expect(out!.id).toBe('demo');
      expect(out!.scopedMeta).toEqual([]);
      expect(out!.recentImports).toEqual([]);
    });
  });

  describe('listHeroes() degraded-state guards', () => {
    it('returns [] when the base players JOIN entities throws', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM players p') && matchSql(sql, 'JOIN entities e')) {
          throw new Error(
            'RuntimeError: Aborted(). Build with -sASSERTIONS for more info.',
          );
        }
        return {rows: []};
      });
      const heroes = await CartridgeLibraryService.listHeroes();
      expect(heroes).toEqual([]);
    });

    it('hero_cartridge_states failure leaves heroes intact with empty states', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (matchSql(sql, 'FROM players p') && matchSql(sql, 'JOIN entities e')) {
          return {
            rows: [
              {
                entity_id: 999_002,
                public_id: 'pub-degraded',
                display_name: 'Hero Survivor',
                profile_created: true,
                current_xp: 0,
                current_level: 1,
                current_location_id: null,
                last_seen: null,
              },
            ],
          };
        }
        if (matchSql(sql, 'FROM hero_cartridge_states h')) {
          throw new Error(
            'RuntimeError: Aborted(). Build with -sASSERTIONS for more info.',
          );
        }
        return {rows: []};
      });
      const heroes = await CartridgeLibraryService.listHeroes();
      expect(heroes).toHaveLength(1);
      expect(heroes[0]!.publicId).toBe('pub-degraded');
      expect(heroes[0]!.states).toEqual([]);
      expect(heroes[0]!.currentCartridgeId).toBeNull();
    });
  });

  describe('listPlaythroughs() degraded-state guards', () => {
    it('returns [] when the playthrough JOIN throws', async () => {
      queryMock.mockImplementation(async () => {
        throw new Error(
          'RuntimeError: Aborted(). Build with -sASSERTIONS for more info.',
        );
      });
      const playthroughs = await CartridgeLibraryService.listPlaythroughs();
      expect(playthroughs).toEqual([]);
    });
  });
});
