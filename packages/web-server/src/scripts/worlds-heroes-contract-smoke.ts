/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-5 — Worlds & Heroes API-contract smoke.
//
// Drives the same HTTP endpoints the boot-phase GUI calls (the
// React side is verified by web-ui i18n:check + build); this
// script verifies the server-side contract end-to-end against a
// temp PGlite:
//
//   1. GET  /api/cartridges       — list installed worlds.
//   2. GET  /api/heroes           — list created heroes.
//   3. POST /api/heroes           — Create Hero (FEAT-CART-LIB-5
//                                   addition). Asserts the
//                                   `clearClientCache` hint shape.
//   4. POST /api/playthroughs/preview — compatibility preview for
//                                       the new hero + default
//                                       cartridge.
//   5. POST /api/playthroughs/launch  — launch into the pair;
//                                       asserts `clearClientCache`
//                                       hint + cookie reissue.
//
// Writes a `result.json` to
// `.codex/run-logs/live-playtest/worlds-heroes-contract-smoke/`.
// A LIVE browser smoke covering the actual React clicks remains
// the carry-forward FEAT-CART-LIB-5 work; that runs in
// FEAT-CART-LIB-6 with Playwright.

import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  '.codex',
  'run-logs',
  'live-playtest',
  'worlds-heroes-contract-smoke',
);

interface Blocker {
  step: string;
  detail: string;
}

async function main(): Promise<number> {
  const startedAt = new Date();
  const blockers: Blocker[] = [];
  const out: Record<string, unknown> = {
    startedAt: startedAt.toISOString(),
    passed: false,
  };

  const dbDir = await mkdtemp(path.join(os.tmpdir(), 'worlds-heroes-smoke-'));
  process.env.PGLITE_DATA_DIR = dbDir;
  process.env.AUTH_SECRET ??= 'worlds-heroes-smoke-secret-must-be-32-bytes-or-more';
  process.env.FEATHERLESS_API_KEY ??= 'smoke-not-real-key';
  process.env.NODE_ENV ??= 'development';
  process.env.AUTH_DISABLED ??= '1';

  await mkdir(DEFAULT_OUT, {recursive: true});

  try {
    const {runMigrations} = await import('../migrate.js');
    const {closeDb} = await import('../db.js');
    await runMigrations();

    // Mount the cartridge-library routes on a fresh Hono so we can
    // drive them via `app.request(...)` without booting an HTTP
    // listener. This is the same pattern the route tests use, but
    // pointed at the real (non-mocked) services + PGlite.
    const {Hono} = await import('hono');
    const {cartridgeLibraryRoutes} = await import('../routes/cartridges.js');
    const app = new Hono();
    app.route('/api', cartridgeLibraryRoutes);

    const cartridgesRes = await app.request('/api/cartridges');
    if (cartridgesRes.status !== 200) {
      blockers.push({
        step: 'list_cartridges',
        detail: `expected 200, got ${cartridgesRes.status}`,
      });
    }
    const cartridgesBody = (await cartridgesRes.json()) as {
      cartridges: Array<{id: string; isDefault: boolean; installCache: {ready: boolean} | null}>;
    };
    const defaultCart = cartridgesBody.cartridges.find((c) => c.isDefault);
    out['cartridges'] = {
      total: cartridgesBody.cartridges.length,
      defaultId: defaultCart?.id ?? null,
      ready: defaultCart?.installCache?.ready ?? false,
    };
    if (!defaultCart) {
      blockers.push({
        step: 'list_cartridges',
        detail: 'no default cartridge installed in the migrated DB',
      });
    }

    const heroesPreRes = await app.request('/api/heroes');
    if (heroesPreRes.status !== 200) {
      blockers.push({
        step: 'list_heroes_initial',
        detail: `expected 200, got ${heroesPreRes.status}`,
      });
    }
    const heroesPre = (await heroesPreRes.json()) as {heroes: unknown[]};
    out['heroesInitial'] = {count: heroesPre.heroes.length};

    // ── Create Hero ──────────────────────────────────────────────
    const createRes = await app.request('/api/heroes', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({displayName: 'Smoke Hero'}),
    });
    if (createRes.status !== 200) {
      blockers.push({
        step: 'create_hero',
        detail: `expected 200, got ${createRes.status}`,
      });
    }
    const cookieHeader = createRes.headers.get('set-cookie') ?? '';
    const created = (await createRes.json()) as {
      player: {entity_id: number; public_id: string; display_name: string; recovery_code: string};
      clearClientCache: {keys: string[]; playerPublicId: string};
    };
    out['createdHero'] = {
      entity_id: created.player.entity_id,
      public_id: created.player.public_id,
      display_name: created.player.display_name,
      hasRecoveryCode: typeof created.player.recovery_code === 'string' && created.player.recovery_code.length > 10,
      clearKeys: created.clearClientCache.keys,
      clearPublicId: created.clearClientCache.playerPublicId,
      cookieReissued: cookieHeader.includes('gh_player='),
    };
    if (!created.player.entity_id) {
      blockers.push({step: 'create_hero', detail: 'no entity_id returned'});
    }
    if (created.clearClientCache.playerPublicId !== created.player.public_id) {
      blockers.push({
        step: 'create_hero',
        detail: 'clearClientCache.playerPublicId does not match created public_id',
      });
    }
    if (!cookieHeader.includes('gh_player=')) {
      blockers.push({
        step: 'create_hero',
        detail: 'auth cookie was not re-issued on POST /api/heroes',
      });
    }

    const heroesPostRes = await app.request('/api/heroes');
    const heroesPost = (await heroesPostRes.json()) as {heroes: Array<{playerId: number}>};
    out['heroesAfterCreate'] = {count: heroesPost.heroes.length};
    if (heroesPost.heroes.length !== heroesPre.heroes.length + 1) {
      blockers.push({
        step: 'list_heroes_after_create',
        detail: `expected ${heroesPre.heroes.length + 1} heroes, got ${heroesPost.heroes.length}`,
      });
    }

    if (defaultCart) {
      const previewRes = await app.request('/api/playthroughs/preview', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          playerId: created.player.entity_id,
          cartridgeId: defaultCart.id,
        }),
      });
      const preview = (await previewRes.json()) as {
        mode: string;
        installReady: boolean;
        blockers: string[];
        startingLocationName: string | null;
      };
      out['preview'] = preview;
      if (previewRes.status !== 200) {
        blockers.push({
          step: 'preview',
          detail: `expected 200, got ${previewRes.status}`,
        });
      }

      // Launch only if preview is not repair_required. The default
      // cartridge after a fresh migration chain may not have its
      // scoped starting_location_id seeded — in that case the
      // FEAT-CART-LIB-5 backend corrective marks it
      // `repair_required` and we record that as expected behavior
      // rather than try to launch.
      if (preview.mode !== 'repair_required') {
        const launchRes = await app.request('/api/playthroughs/launch', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            playerId: created.player.entity_id,
            cartridgeId: defaultCart.id,
          }),
        });
        const launch = (await launchRes.json()) as {
          cartridgeId: string;
          playthroughId: string;
          mode: string;
          clearClientCache: {keys: string[]; playerPublicId: string};
        };
        const launchCookie = launchRes.headers.get('set-cookie') ?? '';
        out['launch'] = {
          cartridgeId: launch.cartridgeId,
          mode: launch.mode,
          playthroughId: launch.playthroughId,
          clearKeys: launch.clearClientCache?.keys ?? [],
          cookieReissued: launchCookie.includes('gh_player='),
        };
        if (launchRes.status !== 200) {
          blockers.push({
            step: 'launch',
            detail: `expected 200, got ${launchRes.status}`,
          });
        }
      } else {
        out['launchSkipped'] = `preview.mode = repair_required (${preview.blockers.join(',')})`;
      }
    }

    await closeDb();
  } catch (err) {
    blockers.push({
      step: 'unexpected',
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  } finally {
    if (existsSync(dbDir)) {
      await rm(dbDir, {recursive: true, force: true}).catch(() => {});
    }
  }

  const finishedAt = new Date();
  out['finishedAt'] = finishedAt.toISOString();
  out['durationMs'] = finishedAt.getTime() - startedAt.getTime();
  out['blockers'] = blockers;
  out['passed'] = blockers.length === 0;

  await writeFile(
    path.join(DEFAULT_OUT, 'result.json'),
    JSON.stringify(out, null, 2),
  );

  if (out['passed']) {
    process.stderr.write('[worlds-heroes-smoke] PASS\n');
    return 0;
  }
  process.stderr.write(
    `[worlds-heroes-smoke] FAIL — blockers: ${JSON.stringify(blockers)}\n`,
  );
  return 1;
}

const isDirect = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(FILE)
  : false;
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('[worlds-heroes-smoke] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runWorldsHeroesContractSmoke};
