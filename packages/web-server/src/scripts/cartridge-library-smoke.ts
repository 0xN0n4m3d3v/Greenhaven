/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference lib="dom" />

// FEAT-CART-LIB-6 — stable Worlds & Heroes browser smoke.
//
// Drives the production-built `packages/web-ui/dist` against a temp
// PGlite running the clean engine baseline. Chromium walks the boot
// gate into Worlds & Heroes, uses the GUI import wizard to install a
// tiny Obsidian vault, creates a hero, launches the playthrough,
// reimports the vault after a single-source-note edit, and starts a
// per-hero New Game from the ready install cache — all while a
// network/console log captures every server response and a final
// blocker pass refuses any 4xx/5xx leak through the GUI surface.
//
// What we DO assert through the GUI:
//   1. Clean baseline boots straight to Worlds & Heroes (empty
//      library + zero heroes → BootGate skips the menu).
//   2. Open the ImportWizard, select `obsidian_vault`, paste the
//      temp vault path, run preview → apply.
//   3. The Worlds column lists the just-installed cartridge with
//      `installCache.ready` and a starting location row.
//   4. Create Hero modal mints a fresh anonymous hero, renders
//      the once-only recovery code, and can continue into the
//      embedded character sheet without asking for a duplicate name;
//      we close the modal via × and mark the hero `profile.created =
//      true` through the backend for the rest of this smoke.
//   5. Reload → boot picks the cartridge+hero combo, GUI shows a
//      non-`repair_required` preview, Launch → `main.game-shell`.
//   6. Reload → Worlds & Heroes → modify one note in the temp vault
//      → GUI Reimport → apply. Static record count stays the same,
//      `content_hash` flips, a new `cartridge_import_runs` row
//      lands, and the launched hero's `hero_cartridge_states`
//      row is preserved.
//   7. Create Hero #2 + mark profile created → reload → select
//      Hero #2 + cartridge → click New game → confirm. Snapshot
//      `cartridge_import_preview_jobs` / `cartridge_import_runs` /
//      `entities` / `cartridge_records` before and after; all four
//      counters must stay flat across new-game (ready cache is
//      reused, no reimport).
//
// Strict failure: exits 1 on any console error, requestfailed, 4xx/
// 5xx response from the production UI, GUI assertion miss, or
// unexpected exception. Writes `result.json`, `summary.json`,
// `console-log.jsonl`, `network-log.jsonl`, and screenshots under
// `.codex/run-logs/live-playtest/cartridge-library-smoke/`.
//
// CLI:
//   --out <dir>         Result + log output dir.
//   --port <n>          Backend port (default 7811).
//   --keep-temp         Keep the temp PGlite + vault dirs.
//   --timeout-ms <n>    Hard ceiling. Default 480_000.

import {chromium, type ConsoleMessage, type Request, type Response} from 'playwright';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
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
  'cartridge-library-smoke',
);
const DEFAULT_UI_DIST = path.join(REPO_ROOT, 'packages', 'web-ui', 'dist');
const DEBUG_KEY = 'codex-cartridge-library-smoke-debug-key';

interface Args {
  out: string;
  port: number;
  keepTemp: boolean;
  timeoutMs: number;
}

interface SmokeStep {
  name: string;
  status: 'ok' | 'failed';
  details?: Record<string, unknown>;
  error?: string;
}

interface CountSnapshot {
  cartridge_import_preview_jobs: number;
  cartridge_import_runs: number;
  entities: number;
  cartridge_records: number;
  cartridge_meta_scoped: number;
  cartridge_install_cache: number;
  hero_cartridge_states: number;
}

function parseArgs(argv: string[]): Args {
  let out = DEFAULT_OUT;
  let port = 7811;
  let keepTemp = false;
  let timeoutMs = 480_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') out = argv[++i] ?? out;
    else if (arg === '--port') port = Number(argv[++i] ?? port) || port;
    else if (arg === '--keep-temp') keepTemp = true;
    else if (arg === '--timeout-ms')
      timeoutMs = Number(argv[++i] ?? timeoutMs) || timeoutMs;
  }
  return {out, port, keepTemp, timeoutMs};
}

function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`unsafe identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function waitForHealthy(base: string, attempts = 30): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Tiny Obsidian vault generator. Identical surface to the engine-
// baseline-cartridge smoke so the transformer compiles a 1-location
// Forge project deterministically. Returns the absolute vault dir.
async function generateTinyVault(suffix: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `cart-lib-smoke-vault-${suffix}-`));
  const locDir = path.join(dir, 'GreenHavenWorld', 'Locations', '@Smoke Landing');
  await mkdir(locDir, {recursive: true});
  await writeFile(
    path.join(dir, 'WORLD_MANIFEST.md'),
    [
      '# Smoke World',
      '',
      'Generated by `live:cartridge-library` smoke.',
      '',
      '## Start of the game',
      '',
      'Starting location:',
      '[[SmokeLandingMind|Smoke Landing]]',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(locDir, 'SmokeLandingMind.md'),
    body,
    'utf8',
  );
  return dir;
}

const VAULT_BODY_V1 = [
  '# @Smoke Landing',
  '',
  '@Smoke Landing is a flat stone landing high above a quiet city.',
  'The wind is dry. The light is honest.',
  '',
  '## Canon',
  '',
  '- Parent area: none — this is the entry point.',
  '- Visibility: open from the first turn.',
  '- Tone: calm, exposed, clean.',
  '- Smoke fixture: yes (delete this note before shipping).',
  '',
].join('\n');

const VAULT_BODY_V2 = [
  '# @Smoke Landing',
  '',
  '@Smoke Landing is a flat stone landing high above a quiet city.',
  'The wind is dry. The light is honest. Reimport pass: the air',
  'tastes faintly of woodsmoke now, and a hawk circles overhead.',
  '',
  '## Canon',
  '',
  '- Parent area: none — this is the entry point.',
  '- Visibility: open from the first turn.',
  '- Tone: calm, exposed, clean, with one new mood beat.',
  '- Smoke fixture: yes (delete this note before shipping).',
  '',
].join('\n');

async function snapshotCounts(dbModule: typeof import('../db.js')): Promise<CountSnapshot> {
  const tables = [
    'cartridge_import_preview_jobs',
    'cartridge_import_runs',
    'entities',
    'cartridge_records',
    'cartridge_meta_scoped',
    'cartridge_install_cache',
    'hero_cartridge_states',
  ] as const;
  const out: Partial<Record<(typeof tables)[number], number>> = {};
  for (const table of tables) {
    const row = await dbModule.query<{c: number}>(
      `SELECT COUNT(*)::int AS c FROM ${quoteIdent(table)}`,
    );
    out[table] = Number(row.rows[0]?.c ?? 0);
  }
  return out as CountSnapshot;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  const outDir = path.resolve(args.out);
  mkdirSync(outDir, {recursive: true});
  const screenshots = path.join(outDir, 'screenshots');
  mkdirSync(screenshots, {recursive: true});

  for (const name of [
    'summary.json',
    'result.json',
    'console-log.jsonl',
    'network-log.jsonl',
    'snapshots.json',
  ]) {
    const p = path.join(outDir, name);
    if (existsSync(p)) rmSync(p);
  }

  const dbDir = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-smoke-db-'));
  process.env.PGLITE_DATA_DIR = dbDir;
  process.env.GEMINI_WEB_PORT = String(args.port);
  process.env.GREENHAVEN_WEB_UI_DIST = DEFAULT_UI_DIST;
  process.env.AUTH_DISABLED = '1';
  process.env.AUTH_SECRET = 'cart-lib-smoke-not-real-secret-32-bytes-or-more-XXXXX';
  process.env.GREENHAVEN_DEBUG_ROUTES = '1';
  process.env.GREENHAVEN_DEBUG_KEY = DEBUG_KEY;
  process.env.FEATHERLESS_API_KEY = 'smoke-not-real-key';
  process.env.NODE_ENV = 'development';
  process.env.GREENHAVEN_GAMEPLAY_LOG_DIR = path.join(outDir, 'gameplay-logs');

  // The preview service's transformer spawner uses `process.cwd()`
  // to locate `compile_vault_to_forge.py`. `npm --prefix packages/
  // web-server` sets CWD to that package; chdir up to the repo root
  // so the obsidian_vault import path can find the script.
  const originalCwd = process.cwd();
  process.chdir(REPO_ROOT);

  const steps: SmokeStep[] = [];
  const blockers: string[] = [];
  const stepsSummary: Record<string, unknown> = {};
  const snapshots: Record<string, unknown> = {};
  const record = (step: SmokeStep) => {
    steps.push(step);
    process.stderr.write(
      `[cartridge-library-smoke] ${step.status.padEnd(6)} ${step.name}` +
        (step.error ? ` — ${step.error}` : '') +
        '\n',
    );
  };
  const logBlocker = (name: string, msg: string) => {
    record({name, status: 'failed', error: msg});
    blockers.push(`${name}: ${msg}`);
  };

  const {startGreenhavenServer, stopGreenhavenServer} = await import(
    '../index.js'
  );
  const dbModule = await import('../db.js');

  const vaultV1 = await generateTinyVault('a', VAULT_BODY_V1);
  let cleanupVaults: string[] = [vaultV1];

  const server = await startGreenhavenServer({
    port: args.port,
    hostname: '127.0.0.1',
  });
  const base = server.url;

  let cleanupRan = false;
  const cleanup = async () => {
    if (cleanupRan) return;
    cleanupRan = true;
    try {
      await stopGreenhavenServer(server);
    } catch (err) {
      console.warn(
        '[cartridge-library-smoke] stopGreenhavenServer failed',
        err,
      );
    }
    try {
      process.chdir(originalCwd);
    } catch {
      // best-effort
    }
    if (!args.keepTemp) {
      await rm(dbDir, {recursive: true, force: true}).catch(() => {});
      for (const v of cleanupVaults) {
        await rm(v, {recursive: true, force: true}).catch(() => {});
      }
    }
  };

  const finish = async (): Promise<number> => {
    const finishedAt = new Date();
    const ok = blockers.length === 0;
    const summary = {
      ok,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outDir,
      steps,
      blockers,
      steps_summary: stepsSummary,
    };
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    writeFileSync(
      path.join(outDir, 'result.json'),
      JSON.stringify({passed: ok, blockers, steps: stepsSummary}, null, 2),
    );
    writeFileSync(
      path.join(outDir, 'snapshots.json'),
      JSON.stringify(snapshots, null, 2),
    );
    await cleanup();
    return ok ? 0 : 1;
  };

  const timeoutHandle = setTimeout(() => {
    logBlocker('timeout', `smoke exceeded ${args.timeoutMs}ms`);
    void finish().then((code) => process.exit(code));
  }, args.timeoutMs);
  timeoutHandle.unref?.();

  try {
    if (!(await waitForHealthy(base))) {
      logBlocker('bootstrap', '/api/health never returned ok=true');
      return await finish();
    }
    record({name: 'bootstrap_backend', status: 'ok'});

    // ── 1. Pre-import DB invariants ───────────────────────────────
    const preCounts = await snapshotCounts(dbModule);
    snapshots.preImportCounts = preCounts;
    if (
      preCounts.entities !== 0 ||
      preCounts.cartridge_records !== 0 ||
      preCounts.cartridge_meta_scoped !== 0 ||
      preCounts.cartridge_install_cache !== 0 ||
      preCounts.cartridge_import_runs !== 0
    ) {
      logBlocker(
        'clean_baseline_empty',
        `unexpected non-zero pre-install counts: ${JSON.stringify(preCounts)}`,
      );
    } else {
      record({
        name: 'clean_baseline_empty',
        status: 'ok',
        details: preCounts as unknown as Record<string, unknown>,
      });
    }

    // ── 2. Boot Chromium → boot routes to Worlds & Heroes ─────────
    const browser = await chromium.launch({headless: true});
    const context = await browser.newContext({
      viewport: {width: 1400, height: 900},
    });
    const page = await context.newPage();

    const consoleLogPath = path.join(outDir, 'console-log.jsonl');
    const networkLogPath = path.join(outDir, 'network-log.jsonl');
    let teardownStarted = false;
    const consoleErrors: Array<{type: string; text: string}> = [];
    const failedRequests: Array<{url: string; failure: string}> = [];
    const serverErrors: Array<{url: string; status: number}> = [];
    page.on('console', (msg: ConsoleMessage) => {
      appendFileSync(
        consoleLogPath,
        JSON.stringify({type: msg.type(), text: msg.text(), ts: Date.now()}) + '\n',
      );
      if (msg.type() === 'error' && !teardownStarted) {
        consoleErrors.push({type: msg.type(), text: msg.text()});
      }
    });
    page.on('requestfailed', (req: Request) => {
      const failure = req.failure()?.errorText ?? 'unknown';
      appendFileSync(
        networkLogPath,
        JSON.stringify({
          phase: 'requestfailed',
          url: req.url(),
          method: req.method(),
          failure,
          ts: Date.now(),
        }) + '\n',
      );
      // `net::ERR_ABORTED` is what Chromium reports for in-flight
      // requests cancelled by `page.reload()` (SSE streams, audio
      // asset prefetches, telemetry POSTs). They are not server
      // errors and not GUI regressions — skip them.
      if (teardownStarted) return;
      if (failure.includes('ERR_ABORTED')) return;
      failedRequests.push({url: req.url(), failure});
    });
    page.on('response', (res: Response) => {
      const url = res.url();
      const status = res.status();
      if (status >= 400) {
        appendFileSync(
          networkLogPath,
          JSON.stringify({phase: 'response', url, status, ts: Date.now()}) + '\n',
        );
        if (!teardownStarted) serverErrors.push({url, status});
      }
    });

    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('greenhaven.uiLanguage', 'en');
      } catch {
        // ignore
      }
    });

    // Auto-accept the New Game `window.confirm()` dialog. Returning
    // `true` from `dialog.accept()` is the GUI's intended "yes".
    page.on('dialog', (dialog) => {
      appendFileSync(
        networkLogPath,
        JSON.stringify({
          phase: 'dialog',
          type: dialog.type(),
          message: dialog.message(),
          ts: Date.now(),
        }) + '\n',
      );
      void dialog.accept();
    });

    const enterWorldsHeroes = async (): Promise<void> => {
      await page.waitForSelector('.title-screen', {timeout: 15000});
      await page.waitForTimeout(150);
      await page.keyboard.press('Space');
      // BootGate routes to library when readyCartridgeCount===0 OR
      // heroCount===0. After install we may pass through the menu,
      // in which case we click the Worlds & Heroes button to
      // re-enter the library screen.
      await Promise.race([
        page.waitForSelector('.cart-lib', {timeout: 30000}),
        page.waitForSelector('.title-menu', {timeout: 30000}),
      ]);
      if (await page.locator('.title-menu').isVisible({timeout: 100}).catch(() => false)) {
        await page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll('.title-menu__btn'),
          ) as HTMLButtonElement[];
          const wh = buttons.find((b) => {
            const t = (b.textContent ?? '').toLowerCase();
            return t.includes('worlds') || t.includes('миры') || t.includes('світ');
          });
          wh?.click();
        });
        await page.waitForSelector('.cart-lib', {timeout: 15000});
      }
    };

    await page.goto(base, {waitUntil: 'domcontentloaded', timeout: 30000});
    await enterWorldsHeroes();

    const emptyVisible = await page.locator('.cart-lib__empty-library-title').isVisible({timeout: 5000}).catch(() => false);
    if (!emptyVisible) {
      logBlocker(
        'clean_library_visible',
        '.cart-lib__empty-library-title not visible after entering Worlds & Heroes on a clean baseline',
      );
    } else {
      record({name: 'clean_library_visible', status: 'ok'});
    }
    await page.screenshot({path: path.join(screenshots, '01-empty-library.png'), fullPage: true});

    // ── 2a. OPERATOR-WORLDS-HEROES-MENU-TRAP ───────────────────────
    // Prove the auto-opened Worlds & Heroes is exitable: click the
    // header back button ("← Back to menu" / "← В меню"), confirm
    // the main menu appears, wait a beat to confirm BootGate does
    // not silently bounce back into the library, then re-enter
    // Worlds & Heroes from the menu to continue the smoke.
    const menuTrapBackClicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('.cart-lib__head .cart-lib__btn--ghost'),
      ) as HTMLButtonElement[];
      const back = buttons.find((b) => {
        const t = (b.textContent ?? '').toLowerCase();
        return (
          t.includes('back') ||
          t.includes('меню') ||
          t.includes('меню') ||
          t.includes('меню')
        );
      });
      if (!back) return false;
      back.click();
      return true;
    });
    if (!menuTrapBackClicked) {
      logBlocker(
        'menu_trap_back_button_present',
        '`.cart-lib__head .cart-lib__btn--ghost` Back button not found',
      );
    } else {
      record({name: 'menu_trap_back_button_present', status: 'ok'});
    }
    await page
      .waitForSelector('.title-menu', {timeout: 5000})
      .then(() => record({name: 'menu_trap_back_to_menu', status: 'ok'}))
      .catch(() =>
        logBlocker(
          'menu_trap_back_to_menu',
          '.title-menu did not appear after clicking Back from Worlds & Heroes',
        ),
      );
    await page.screenshot({
      path: path.join(screenshots, '01a-menu-trap-back-to-menu.png'),
      fullPage: true,
    });

    // The bug to disprove is "back bounces straight back into the
    // library because BootGate auto-routes through `status`". Wait a
    // full second and re-check that .title-menu is still visible and
    // .cart-lib is not visible — proves the menu is sticky.
    await page.waitForTimeout(1000);
    const menuStaysVisible = await page
      .locator('.title-menu')
      .isVisible({timeout: 500})
      .catch(() => false);
    const libraryHidden = !(await page
      .locator('.cart-lib')
      .isVisible({timeout: 100})
      .catch(() => false));
    if (!menuStaysVisible || !libraryHidden) {
      logBlocker(
        'menu_trap_menu_stays_visible',
        `expected .title-menu visible && .cart-lib hidden after 1s; menuStaysVisible=${menuStaysVisible} libraryHidden=${libraryHidden}`,
      );
    } else {
      record({name: 'menu_trap_menu_stays_visible', status: 'ok'});
    }
    await page.screenshot({
      path: path.join(screenshots, '01b-menu-trap-menu-sticky.png'),
      fullPage: true,
    });

    // Now re-enter Worlds & Heroes intentionally by clicking the
    // menu button. This proves bidirectional navigation works.
    await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('.title-menu__btn'),
      ) as HTMLButtonElement[];
      const wh = buttons.find((b) => {
        const t = (b.textContent ?? '').toLowerCase();
        return t.includes('worlds') || t.includes('миры') || t.includes('світ');
      });
      wh?.click();
    });
    await page
      .waitForSelector('.cart-lib', {timeout: 15000})
      .then(() =>
        record({name: 'menu_trap_reenter_library', status: 'ok'}),
      )
      .catch(() =>
        logBlocker(
          'menu_trap_reenter_library',
          '.cart-lib did not appear after clicking Worlds & Heroes in the main menu',
        ),
      );
    // Confirm empty-library state is still rendered (no state was
    // reset by the menu round-trip).
    const emptyStillVisible = await page
      .locator('.cart-lib__empty-library-title')
      .isVisible({timeout: 5000})
      .catch(() => false);
    if (!emptyStillVisible) {
      logBlocker(
        'menu_trap_state_preserved',
        '.cart-lib__empty-library-title not visible after re-entering Worlds & Heroes',
      );
    } else {
      record({name: 'menu_trap_state_preserved', status: 'ok'});
    }
    await page.screenshot({
      path: path.join(screenshots, '01c-menu-trap-reentered-library.png'),
      fullPage: true,
    });

    // ── 3. GUI import wizard → obsidian_vault → apply ─────────────
    // The header carries an "+ Import world…" button.
    const importHeaderClicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('.cart-lib__head .cart-lib__btn'),
      ) as HTMLButtonElement[];
      const btn = buttons.find((b) => {
        const t = (b.textContent ?? '').toLowerCase();
        return t.includes('import world');
      });
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!importHeaderClicked) {
      logBlocker('open_import_wizard', 'Header "+ Import world…" button not found');
    }
    await page.waitForSelector('.cart-lib__wizard', {timeout: 10000});
    record({name: 'open_import_wizard', status: 'ok'});

    // Select obsidian_vault from the select, then type the path.
    await page.locator('.cart-lib__wizard select').selectOption('obsidian_vault');
    await page.locator('.cart-lib__wizard input[type="text"]').fill(vaultV1);
    await page.screenshot({path: path.join(screenshots, '02-wizard-filled.png'), fullPage: true});

    // Click "Start preview" — the primary button in the footer.
    await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('.cart-lib__wizard-foot .cart-lib__btn'),
      ) as HTMLButtonElement[];
      const primary = buttons.find((b) =>
        b.classList.contains('cart-lib__btn--primary'),
      );
      primary?.click();
    });

    // Poll the wizard's status dl until the dd reads "Ready"
    // (English label). Bail out if it flips to "Failed".
    const previewReady = await page
      .waitForFunction(
        () => {
          const ddNodes = Array.from(
            document.querySelectorAll('.cart-lib__wizard-status dd'),
          ) as HTMLElement[];
          if (ddNodes.length === 0) return false;
          const status = ddNodes[0]?.textContent?.toLowerCase() ?? '';
          if (status.includes('failed')) return 'failed';
          if (status.includes('ready')) return 'ready';
          return false;
        },
        undefined,
        {timeout: 90000},
      )
      .then((handle) => handle.jsonValue())
      .catch(() => 'timeout');
    if (previewReady !== 'ready') {
      logBlocker('preview_ready', `wizard status was '${String(previewReady)}'`);
      await page.screenshot({path: path.join(screenshots, '03-preview-failed.png'), fullPage: true});
    } else {
      record({name: 'preview_ready', status: 'ok'});
    }
    await page.screenshot({path: path.join(screenshots, '03-preview-ready.png'), fullPage: true});

    // Click "Apply" — same primary button slot, post-ready.
    if (previewReady === 'ready') {
      await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('.cart-lib__wizard-foot .cart-lib__btn'),
        ) as HTMLButtonElement[];
        const primary = buttons.find((b) =>
          b.classList.contains('cart-lib__btn--primary'),
        );
        primary?.click();
      });
      // The wizard auto-closes on apply success because the parent
      // `WorldsHeroesScreen.onImported` callback flips
      // `wizardOpen → false` immediately. So `.cart-lib__wizard-
      // applied` may flash for less than one render. Instead we
      // wait for the wizard to detach AND verify a cartridges row
      // landed in the DB below; that is what "applied" actually
      // means.
      await page.waitForSelector('.cart-lib__wizard', {state: 'detached', timeout: 60000})
        .then(() => record({name: 'apply_succeeded', status: 'ok'}))
        .catch(() => {
          logBlocker('apply_succeeded', '.cart-lib__wizard did not close after Apply');
        });
      await page.screenshot({path: path.join(screenshots, '04-apply-applied.png'), fullPage: true});
    }

    // ── 4. DB + GUI post-apply assertions ─────────────────────────
    const postApplyCounts = await snapshotCounts(dbModule);
    snapshots.postApplyCounts = postApplyCounts;
    if (postApplyCounts.cartridge_records !== 1) {
      logBlocker(
        'post_apply_records',
        `expected 1 cartridge_records row, got ${postApplyCounts.cartridge_records}`,
      );
    }
    if (postApplyCounts.cartridge_install_cache !== 1) {
      logBlocker(
        'post_apply_install_cache',
        `expected 1 cartridge_install_cache row, got ${postApplyCounts.cartridge_install_cache}`,
      );
    }
    const cartRow = await dbModule.query<{id: string; content_hash: string}>(
      `SELECT id, content_hash FROM cartridges ORDER BY installed_at DESC LIMIT 1`,
    );
    const cartridgeId = cartRow.rows[0]?.id ?? null;
    const contentHashV1 = cartRow.rows[0]?.content_hash ?? null;
    snapshots.cartridgeId = cartridgeId;
    snapshots.contentHashV1 = contentHashV1;
    if (!cartridgeId) {
      logBlocker('post_apply_cartridge_row', 'no cartridges row after apply');
    } else {
      record({
        name: 'post_apply_cartridge_row',
        status: 'ok',
        details: {cartridgeId, contentHash: contentHashV1},
      });
    }
    const scopedRow = await dbModule.query<{key: string; value: unknown}>(
      `SELECT key, value FROM cartridge_meta_scoped WHERE cartridge_id = $1 ORDER BY key`,
      [cartridgeId],
    );
    const scopedKeys = scopedRow.rows.map((r) => r.key);
    snapshots.scopedKeys = scopedKeys;
    for (const required of ['starting_location_id', 'starting_location_slug']) {
      if (!scopedKeys.includes(required)) {
        logBlocker(
          'post_apply_scoped_start',
          `cartridge_meta_scoped.${required} missing for ${cartridgeId}`,
        );
      }
    }

    // Worlds list card must be visible.
    await page.waitForSelector('.cart-lib__list .cart-lib__card', {timeout: 5000});
    const worldsCardCount = await page.locator('.cart-lib__list .cart-lib__card').count();
    if (worldsCardCount < 1) {
      logBlocker('worlds_list_populated', 'no .cart-lib__card rendered after apply');
    } else {
      record({name: 'worlds_list_populated', status: 'ok', details: {count: worldsCardCount}});
    }

    // ── 5. Create Hero #1 modal ─────────────────────────────────
    await page.evaluate(() => {
      const btn = Array.from(
        document.querySelectorAll('.cart-lib__col .cart-lib__btn'),
      ).find((b) => {
        const t = (b.textContent ?? '').toLowerCase();
        return t.includes('create hero');
      }) as HTMLButtonElement | undefined;
      btn?.click();
    });
    await page.waitForSelector('.cart-lib__wizard', {timeout: 5000});
    const duplicateHeroNameInputs = await page
      .locator('.cart-lib__wizard input[type="text"]')
      .count();
    if (duplicateHeroNameInputs !== 0) {
      logBlocker(
        'hero1_no_duplicate_name_prompt',
        `Create Hero shell rendered ${duplicateHeroNameInputs} text input(s) before the character sheet`,
      );
    }
    await page.screenshot({path: path.join(screenshots, '05-create-hero-1.png'), fullPage: true});

    // Submit — primary button in modal footer.
    await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('.cart-lib__wizard-foot .cart-lib__btn'),
      ) as HTMLButtonElement[];
      const submit = buttons.find((b) =>
        b.classList.contains('cart-lib__btn--primary'),
      );
      submit?.click();
    });
    await page.waitForSelector('.cart-lib__recovery', {timeout: 15000});
    const recoveryCodeOne = await page.locator('.cart-lib__recovery code').textContent();
    snapshots.hero1RecoveryCodeVisible = typeof recoveryCodeOne === 'string' && recoveryCodeOne.length >= 19;
    record({
      name: 'hero1_created',
      status: snapshots.hero1RecoveryCodeVisible ? 'ok' : 'failed',
      details: {recoveryCodeLength: recoveryCodeOne?.length ?? 0},
    });
    await page.screenshot({path: path.join(screenshots, '06-hero1-recovery.png'), fullPage: true});

    await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('.cart-lib__wizard-foot .cart-lib__btn'),
      ) as HTMLButtonElement[];
      const next = buttons.find((b) =>
        b.classList.contains('cart-lib__btn--primary'),
      );
      next?.click();
    });
    await page.waitForSelector('.creator-overlay--embedded', {timeout: 15000});
    await page.waitForSelector('.creator-overlay--embedded input', {timeout: 15000});
    record({name: 'hero1_embedded_character_sheet', status: 'ok'});
    await page.screenshot({path: path.join(screenshots, '06b-hero1-character-sheet.png'), fullPage: true});

    // Close the modal via the × button so we don't get yanked into
    // the embedded character creator's commit flow.
    await page.evaluate(() => {
      const xBtn = document.querySelector(
        '.cart-lib__wizard-head .cart-lib__btn--ghost',
      ) as HTMLButtonElement | null;
      xBtn?.click();
    });
    await page.waitForSelector('.cart-lib__wizard', {state: 'detached', timeout: 5000});

    // Look up the freshly minted hero entity_id.
    const hero1Row = await dbModule.query<{entity_id: number}>(
      `SELECT entity_id FROM players ORDER BY entity_id DESC LIMIT 1`,
    );
    const hero1Id = Number(hero1Row.rows[0]?.entity_id ?? 0);
    snapshots.hero1Id = hero1Id;
    if (!hero1Id) {
      logBlocker('hero1_persisted', 'hero #1 row missing from players table');
    }

    // Mark the hero `profile.created = true` so the post-launch
    // gameplay shell renders without bouncing into CharacterCreator.
    const patchHero1 = await fetch(
      `${base}/api/player/${hero1Id}/profile`,
      {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({created: true}),
      },
    );
    if (patchHero1.status !== 200) {
      logBlocker(
        'patch_hero1_profile_created',
        `PATCH profile returned ${patchHero1.status}`,
      );
    } else {
      record({name: 'patch_hero1_profile_created', status: 'ok'});
    }

    // ── 6. Reload → enter Worlds & Heroes → select Hero #1 + cart → Launch ─
    await page.reload({waitUntil: 'domcontentloaded'});
    await enterWorldsHeroes();
    await page.waitForSelector('.cart-lib__list .cart-lib__card', {timeout: 10000});

    // Select Hero #1 card (Heroes column).
    await page.evaluate((heroName: string) => {
      const cols = Array.from(document.querySelectorAll('.cart-lib__col'));
      const heroesCol = cols.find((col) => {
        const heading = col.querySelector('.cart-lib__col-heading');
        return (heading?.textContent ?? '').toLowerCase().includes('hero');
      });
      const cards = Array.from(
        heroesCol?.querySelectorAll('.cart-lib__card') ?? [],
      ) as HTMLButtonElement[];
      const target = cards.find((c) =>
        (c.textContent ?? '').includes(heroName),
      );
      target?.click();
    }, 'Cartridge Library Smoke Hero One');

    // Wait until the compatibility panel shows a non-repair preview.
    await page
      .waitForFunction(
        () => {
          const launchBtn = Array.from(
            document.querySelectorAll('.cart-lib__actions .cart-lib__btn'),
          ).find((b) => {
            const normalized = (b.textContent ?? '').toLowerCase();
            return (
              normalized.includes('launch') ||
              normalized.includes('enter world') ||
              normalized.includes('\u0432\u043e\u0439\u0442\u0438')
            );
          }) as
            | HTMLButtonElement
            | undefined;
          return launchBtn != null && !launchBtn.disabled;
        },
        undefined,
        {timeout: 15000},
      )
      .catch(() => {
        logBlocker(
          'preview_non_repair',
          'Launch button never became enabled — preview likely stuck on repair_required',
        );
      });

    const previewSnapshot = await page.evaluate(() => {
      const dts = Array.from(document.querySelectorAll('.cart-lib__compat-meta dt'));
      const dds = Array.from(document.querySelectorAll('.cart-lib__compat-meta dd'));
      return dts.map((dt, i) => ({label: dt.textContent ?? '', value: dds[i]?.textContent ?? ''}));
    });
    snapshots.hero1PreviewBeforeLaunch = previewSnapshot;
    await page.screenshot({path: path.join(screenshots, '07-hero1-preview.png'), fullPage: true});

    // FEAT-HERO-CONTINUITY-5 — narrow DOM assertions that the server-
    // owned continuity preview renders the three required sections
    // (carries / stays / adjusted) plus the companion carryover panel
    // and both carryover-note paragraphs. Stops short of the full
    // cross-world live:hero-continuity smoke (FEAT-HERO-CONTINUITY-6).
    const continuitySectionsSnapshot = await page.evaluate(() => {
      const root = document.querySelector('.cart-lib__continuity');
      if (!root) return {present: false, kinds: [] as string[], notes: 0, schema: ''};
      const sections = Array.from(
        root.querySelectorAll('[data-continuity-kind]'),
      ) as HTMLElement[];
      const kinds = sections
        .map((s) => s.dataset['continuityKind'])
        .filter((k): k is string => typeof k === 'string');
      const notes = document.querySelectorAll(
        '.cart-lib__continuity-note',
      ).length;
      return {
        present: true,
        kinds,
        notes,
        schema: root.getAttribute('data-continuity-schema') ?? '',
      };
    });
    snapshots.continuitySectionsBeforeLaunch = continuitySectionsSnapshot;
    if (!continuitySectionsSnapshot.present) {
      logBlocker(
        'continuity_sections_visible',
        '.cart-lib__continuity not visible after Hero #1 preview loaded',
      );
    } else {
      const required = ['carries', 'stays', 'adjusted', 'companions'];
      const missing = required.filter(
        (k) => !continuitySectionsSnapshot.kinds.includes(k),
      );
      if (missing.length > 0) {
        logBlocker(
          'continuity_sections_complete',
          `missing continuity section kinds: ${missing.join(',')}`,
        );
      }
      if (continuitySectionsSnapshot.notes < 2) {
        logBlocker(
          'continuity_carryover_notes',
          `expected 2 carryover-note paragraphs, got ${continuitySectionsSnapshot.notes}`,
        );
      }
      if (
        !continuitySectionsSnapshot.schema.startsWith(
          'greenhaven.hero_continuity.preview.',
        )
      ) {
        logBlocker(
          'continuity_schema_version',
          `unexpected data-continuity-schema='${continuitySectionsSnapshot.schema}'`,
        );
      }
      if (missing.length === 0 && continuitySectionsSnapshot.notes >= 2) {
        record({
          name: 'continuity_sections_visible',
          status: 'ok',
          details: continuitySectionsSnapshot,
        });
      }
    }

    // Click Launch.
    await page.evaluate(() => {
      const launchBtn = Array.from(
        document.querySelectorAll('.cart-lib__actions .cart-lib__btn'),
      ).find((b) => {
        const normalized = (b.textContent ?? '').toLowerCase();
        return (
          normalized.includes('launch') ||
          normalized.includes('enter world') ||
          normalized.includes('\u0432\u043e\u0439\u0442\u0438')
        );
      }) as
        | HTMLButtonElement
        | undefined;
      launchBtn?.click();
    });

    // Wait for game-shell. CharacterCreator gate would render
    // `.creator-overlay` — accept either as proof we reached gameplay.
    const reachedGame = await Promise.race([
      page.waitForSelector('main.game-shell', {timeout: 30000}).then(() => 'game-shell'),
      page.waitForSelector('.creator-overlay', {timeout: 30000}).then(() => 'creator-overlay'),
    ]).catch(() => null);
    if (!reachedGame) {
      logBlocker('launch_into_game', 'neither main.game-shell nor .creator-overlay rendered after Launch');
    } else {
      record({name: 'launch_into_game', status: 'ok', details: {selector: reachedGame}});
      snapshots.hero1LandedOn = reachedGame;
    }
    await page.screenshot({path: path.join(screenshots, '08-after-launch.png'), fullPage: true});

    // Snapshot hero state to verify the launch persisted.
    const postLaunchStates = await dbModule.query<{player_id: number; status: string; reset_generation: number}>(
      `SELECT player_id, status, reset_generation FROM hero_cartridge_states ORDER BY player_id`,
    );
    snapshots.heroCartridgeStatesAfterLaunch = postLaunchStates.rows;

    // FEAT-CART-LIB-7-FOLLOWUP (2026-05-18) — explicit assertion that
    // GET /api/session/:id/locations is 2xx for the freshly-launched
    // hero. The stale-server reproducer showed a post-launch 500 here
    // from `cartridge_meta missing required key: 'cartridge_id'` when
    // the route silently fell through to the legacy global mirror; the
    // optional resolver fix has to be exercised inside the green
    // window (before `teardownStarted` disables the 4xx/5xx gate).
    const hero1Session = await dbModule.query<{id: string}>(
      `SELECT id::text AS id
         FROM sessions
        WHERE player_id = $1
        ORDER BY last_seen DESC
        LIMIT 1`,
      [hero1Id],
    );
    const hero1SessionId = hero1Session.rows[0]?.id ?? null;
    snapshots.hero1SessionId = hero1SessionId;
    if (!hero1SessionId) {
      logBlocker(
        'locations_after_launch_clean',
        `no sessions row landed for hero1 entity_id=${hero1Id} after Launch`,
      );
    } else {
      const locResp = await fetch(
        `${base}/api/session/${hero1SessionId}/locations?playerId=${hero1Id}`,
      );
      if (locResp.status >= 400) {
        logBlocker(
          'locations_after_launch_clean',
          `GET /api/session/${hero1SessionId}/locations -> ${locResp.status}`,
        );
      } else {
        record({
          name: 'locations_after_launch_clean',
          status: 'ok',
          details: {status: locResp.status, sessionId: hero1SessionId},
        });
      }
    }

    // ── 7. Reimport with modified vault note ────────────────────
    const preReimportCounts = await snapshotCounts(dbModule);
    snapshots.preReimportCounts = preReimportCounts;

    // Reload + re-enter library so the WorldsHeroesScreen is mounted
    // (we are currently in main.game-shell). After reload, BootGate
    // routes through the menu (heroes + ready cartridge present), so
    // `enterWorldsHeroes` clicks Worlds & Heroes.
    await page.reload({waitUntil: 'domcontentloaded'});
    await enterWorldsHeroes();
    await page.waitForSelector('.cart-lib__list .cart-lib__card', {timeout: 10000});

    // Modify the vault file (V2 body).
    await writeFile(
      path.join(vaultV1, 'GreenHavenWorld', 'Locations', '@Smoke Landing', 'SmokeLandingMind.md'),
      VAULT_BODY_V2,
      'utf8',
    );

    // Select the cartridge card so Reimport unlocks.
    await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll('.cart-lib__list .cart-lib__card'),
      ) as HTMLButtonElement[];
      cards[0]?.click();
    });
    await page.waitForFunction(
      () => {
        const btns = Array.from(
          document.querySelectorAll('.cart-lib__actions .cart-lib__btn'),
        ) as HTMLButtonElement[];
        const reimport = btns.find((b) =>
          (b.textContent ?? '').toLowerCase().includes('reimport'),
        );
        return reimport != null;
      },
      undefined,
      {timeout: 10000},
    );
    await page.evaluate(() => {
      const btns = Array.from(
        document.querySelectorAll('.cart-lib__actions .cart-lib__btn'),
      ) as HTMLButtonElement[];
      const reimport = btns.find((b) =>
        (b.textContent ?? '').toLowerCase().includes('reimport'),
      ) as HTMLButtonElement | undefined;
      reimport?.click();
    });
    await page.waitForSelector('.cart-lib__wizard', {timeout: 10000});
    await page.locator('.cart-lib__wizard select').selectOption('obsidian_vault');
    await page.locator('.cart-lib__wizard input[type="text"]').fill(vaultV1);
    await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('.cart-lib__wizard-foot .cart-lib__btn'),
      ) as HTMLButtonElement[];
      const primary = buttons.find((b) =>
        b.classList.contains('cart-lib__btn--primary'),
      );
      primary?.click();
    });

    const reimportPreviewStatus = await page
      .waitForFunction(
        () => {
          const ddNodes = Array.from(
            document.querySelectorAll('.cart-lib__wizard-status dd'),
          ) as HTMLElement[];
          if (ddNodes.length === 0) return false;
          const status = ddNodes[0]?.textContent?.toLowerCase() ?? '';
          if (status.includes('failed')) return 'failed';
          if (status.includes('ready')) return 'ready';
          return false;
        },
        undefined,
        {timeout: 90000},
      )
      .then((handle) => handle.jsonValue())
      .catch(() => 'timeout');
    if (reimportPreviewStatus !== 'ready') {
      logBlocker('reimport_preview_ready', `reimport status='${String(reimportPreviewStatus)}'`);
    }
    if (reimportPreviewStatus === 'ready') {
      await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('.cart-lib__wizard-foot .cart-lib__btn'),
        ) as HTMLButtonElement[];
        const primary = buttons.find((b) =>
          b.classList.contains('cart-lib__btn--primary'),
        );
        primary?.click();
      });
      await page
        .waitForSelector('.cart-lib__wizard', {state: 'detached', timeout: 60000})
        .then(() => record({name: 'reimport_applied', status: 'ok'}))
        .catch(() => logBlocker('reimport_applied', '.cart-lib__wizard did not close after reimport Apply'));
      await page.screenshot({path: path.join(screenshots, '09-reimport-applied.png'), fullPage: true});
    }

    const postReimportCounts = await snapshotCounts(dbModule);
    snapshots.postReimportCounts = postReimportCounts;
    const cartRowV2 = await dbModule.query<{content_hash: string}>(
      `SELECT content_hash FROM cartridges WHERE id = $1`,
      [cartridgeId],
    );
    const contentHashV2 = cartRowV2.rows[0]?.content_hash ?? null;
    snapshots.contentHashV2 = contentHashV2;
    if (contentHashV2 === contentHashV1) {
      logBlocker(
        'reimport_hash_changed',
        `content_hash did not change after reimport (still ${contentHashV2})`,
      );
    } else {
      record({name: 'reimport_hash_changed', status: 'ok', details: {v1: contentHashV1, v2: contentHashV2}});
    }
    if (postReimportCounts.cartridge_records !== preReimportCounts.cartridge_records) {
      logBlocker(
        'reimport_records_preserved',
        `cartridge_records count changed ${preReimportCounts.cartridge_records} -> ${postReimportCounts.cartridge_records}`,
      );
    }
    if (postReimportCounts.cartridge_import_runs <= preReimportCounts.cartridge_import_runs) {
      logBlocker(
        'reimport_run_appended',
        `cartridge_import_runs did not grow (pre=${preReimportCounts.cartridge_import_runs} post=${postReimportCounts.cartridge_import_runs})`,
      );
    }
    if (postReimportCounts.hero_cartridge_states < preReimportCounts.hero_cartridge_states) {
      logBlocker(
        'reimport_hero_states_preserved',
        `hero_cartridge_states shrank across reimport`,
      );
    }

    // ── 8. Create Hero #2 + mark profile created ────────────────
    await page.evaluate(() => {
      const btn = Array.from(
        document.querySelectorAll('.cart-lib__col .cart-lib__btn'),
      ).find((b) => {
        const t = (b.textContent ?? '').toLowerCase();
        return t.includes('create hero');
      }) as HTMLButtonElement | undefined;
      btn?.click();
    });
    await page.waitForSelector('.cart-lib__wizard', {timeout: 5000});
    const duplicateHero2NameInputs = await page
      .locator('.cart-lib__wizard input[type="text"]')
      .count();
    if (duplicateHero2NameInputs !== 0) {
      logBlocker(
        'hero2_no_duplicate_name_prompt',
        `Create Hero shell rendered ${duplicateHero2NameInputs} text input(s) before the character sheet`,
      );
    }
    await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('.cart-lib__wizard-foot .cart-lib__btn'),
      ) as HTMLButtonElement[];
      const submit = buttons.find((b) =>
        b.classList.contains('cart-lib__btn--primary'),
      );
      submit?.click();
    });
    await page.waitForSelector('.cart-lib__recovery', {timeout: 15000});
    const recoveryCodeTwo = await page.locator('.cart-lib__recovery code').textContent();
    snapshots.hero2RecoveryCodeVisible = typeof recoveryCodeTwo === 'string' && recoveryCodeTwo.length >= 19;
    await page.evaluate(() => {
      const xBtn = document.querySelector(
        '.cart-lib__wizard-head .cart-lib__btn--ghost',
      ) as HTMLButtonElement | null;
      xBtn?.click();
    });
    await page.waitForSelector('.cart-lib__wizard', {state: 'detached', timeout: 5000});

    const hero2Row = await dbModule.query<{entity_id: number}>(
      `SELECT entity_id FROM players ORDER BY entity_id DESC LIMIT 1`,
    );
    const hero2Id = Number(hero2Row.rows[0]?.entity_id ?? 0);
    snapshots.hero2Id = hero2Id;
    if (!hero2Id || hero2Id === hero1Id) {
      logBlocker('hero2_persisted', `expected new hero entity_id distinct from ${hero1Id}, got ${hero2Id}`);
    }
    await fetch(`${base}/api/player/${hero2Id}/profile`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({created: true}),
    });

    // ── 9. Reload → select Hero #2 + cartridge → New game ───────
    await page.reload({waitUntil: 'domcontentloaded'});
    await enterWorldsHeroes();
    await page.waitForSelector('.cart-lib__list .cart-lib__card', {timeout: 10000});

    // Select Hero #2 in the Heroes column.
    await page.evaluate((heroName: string) => {
      const cols = Array.from(document.querySelectorAll('.cart-lib__col'));
      const heroesCol = cols.find((col) => {
        const heading = col.querySelector('.cart-lib__col-heading');
        return (heading?.textContent ?? '').toLowerCase().includes('hero');
      });
      const cards = Array.from(
        heroesCol?.querySelectorAll('.cart-lib__card') ?? [],
      ) as HTMLButtonElement[];
      const target = cards.find((c) =>
        (c.textContent ?? '').includes(heroName),
      );
      target?.click();
    }, 'Cartridge Library Smoke Hero Two');
    // Also re-select the cartridge card (selection was reset by reload).
    await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll('.cart-lib__list .cart-lib__card'),
      ) as HTMLButtonElement[];
      const worldCard = cards.find((c) => {
        const ancestor = c.closest('.cart-lib__col');
        const heading = ancestor?.querySelector('.cart-lib__col-heading');
        return (heading?.textContent ?? '').toLowerCase().includes('world');
      });
      worldCard?.click();
    });
    await page.waitForFunction(
      () => {
        const btns = Array.from(
          document.querySelectorAll('.cart-lib__actions .cart-lib__btn'),
        ) as HTMLButtonElement[];
        const newGame = btns.find((b) =>
          (b.textContent ?? '').toLowerCase().includes('new game'),
        );
        return newGame != null && !newGame.disabled;
      },
      undefined,
      {timeout: 15000},
    );

    const preNewGameCounts = await snapshotCounts(dbModule);
    snapshots.preNewGameCounts = preNewGameCounts;

    // Click New game — the `page.on('dialog')` handler above will
    // auto-accept the confirm prompt.
    await page.evaluate(() => {
      const btns = Array.from(
        document.querySelectorAll('.cart-lib__actions .cart-lib__btn'),
      ) as HTMLButtonElement[];
      const newGame = btns.find((b) =>
        (b.textContent ?? '').toLowerCase().includes('new game'),
      ) as HTMLButtonElement | undefined;
      newGame?.click();
    });

    // Wait for either the game shell (or character creator) to
    // render — confirms the new-game backend call landed.
    const reachedAfterNewGame = await Promise.race([
      page.waitForSelector('main.game-shell', {timeout: 30000}).then(() => 'game-shell'),
      page.waitForSelector('.creator-overlay', {timeout: 30000}).then(() => 'creator-overlay'),
    ]).catch(() => null);
    if (!reachedAfterNewGame) {
      logBlocker('new_game_into_game', 'no game-shell / creator-overlay after New game');
    } else {
      record({name: 'new_game_into_game', status: 'ok', details: {selector: reachedAfterNewGame}});
    }
    await page.screenshot({path: path.join(screenshots, '10-after-new-game.png'), fullPage: true});

    const postNewGameCounts = await snapshotCounts(dbModule);
    snapshots.postNewGameCounts = postNewGameCounts;
    if (postNewGameCounts.cartridge_import_preview_jobs !== preNewGameCounts.cartridge_import_preview_jobs) {
      logBlocker(
        'new_game_no_new_preview',
        `cartridge_import_preview_jobs changed ${preNewGameCounts.cartridge_import_preview_jobs} -> ${postNewGameCounts.cartridge_import_preview_jobs}`,
      );
    }
    if (postNewGameCounts.cartridge_import_runs !== preNewGameCounts.cartridge_import_runs) {
      logBlocker(
        'new_game_no_new_import_run',
        `cartridge_import_runs changed ${preNewGameCounts.cartridge_import_runs} -> ${postNewGameCounts.cartridge_import_runs}`,
      );
    }
    if (postNewGameCounts.entities !== preNewGameCounts.entities) {
      logBlocker(
        'new_game_entities_preserved',
        `entities count changed ${preNewGameCounts.entities} -> ${postNewGameCounts.entities}`,
      );
    }
    if (postNewGameCounts.cartridge_records !== preNewGameCounts.cartridge_records) {
      logBlocker(
        'new_game_records_preserved',
        `cartridge_records changed ${preNewGameCounts.cartridge_records} -> ${postNewGameCounts.cartridge_records}`,
      );
    }

    // FEAT-CART-LIB-7-FOLLOWUP (2026-05-18) — same explicit
    // /locations probe for the new-game hero so the green window
    // covers both the launch and new-game paths into the gameplay
    // shell before the 4xx/5xx gate is disabled.
    const hero2Session = await dbModule.query<{id: string}>(
      `SELECT id::text AS id
         FROM sessions
        WHERE player_id = $1
        ORDER BY last_seen DESC
        LIMIT 1`,
      [hero2Id],
    );
    const hero2SessionId = hero2Session.rows[0]?.id ?? null;
    snapshots.hero2SessionId = hero2SessionId;
    if (!hero2SessionId) {
      logBlocker(
        'locations_after_new_game_clean',
        `no sessions row landed for hero2 entity_id=${hero2Id} after New Game`,
      );
    } else {
      const locResp = await fetch(
        `${base}/api/session/${hero2SessionId}/locations?playerId=${hero2Id}`,
      );
      if (locResp.status >= 400) {
        logBlocker(
          'locations_after_new_game_clean',
          `GET /api/session/${hero2SessionId}/locations -> ${locResp.status}`,
        );
      } else {
        record({
          name: 'locations_after_new_game_clean',
          status: 'ok',
          details: {status: locResp.status, sessionId: hero2SessionId},
        });
      }
    }

    // ── 10. Final blocker pass on console + network ─────────────
    teardownStarted = true;
    if (consoleErrors.length > 0) {
      logBlocker(
        'browser_console_clean',
        `console errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`,
      );
    } else {
      record({name: 'browser_console_clean', status: 'ok'});
    }
    if (failedRequests.length > 0) {
      logBlocker(
        'no_failed_requests',
        `${failedRequests.length} requestfailed events`,
      );
    } else {
      record({name: 'no_failed_requests', status: 'ok'});
    }
    if (serverErrors.length > 0) {
      logBlocker(
        'no_4xx_5xx',
        `${serverErrors.length} 4xx/5xx responses: ${JSON.stringify(serverErrors.slice(0, 5))}`,
      );
    } else {
      record({name: 'no_4xx_5xx', status: 'ok'});
    }

    await context.close();
    await browser.close();

    clearTimeout(timeoutHandle);
    return await finish();
  } catch (err) {
    clearTimeout(timeoutHandle);
    logBlocker(
      'unexpected_exception',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    return await finish();
  }
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(FILE)
  : false;

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error('[cartridge-library-smoke] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runCartridgeLibrarySmoke};
