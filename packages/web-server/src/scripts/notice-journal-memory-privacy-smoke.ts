/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference lib="dom" />

// FEAT-MEMORY-1 stable repository smoke.
//
// Promotes the two `.codex/run-logs/live-playtest/*-memory-journal-*`
// timestamped harnesses into a single repeatable command so future
// agents can verify the Notice Journal memory privacy contract
// without hunting buried run-log artifacts.
//
// Covers both halves of the FEAT-MEMORY-1 contract in one isolated
// run:
//
//   A. **Materialization path.** A live `memory:added` `gui_event`
//      with a maximally-revealing payload (text, summary,
//      draft_text, internal_reflection, link_reason, tags, kind,
//      category, sensitive) is fired through the debug live-ops
//      API. After materialization:
//      - `/api/player/:id/notices` returns the row with
//        `title='Memory recorded'` and `body=null`.
//      - The full API JSON contains zero hits for any secret or
//        category-revealing string.
//      - `player_journal_entries.body IS NULL` on disk.
//      - The persisted `payload` is the sanitized whitelist
//        (`memoryId`, `ownerId`, `ownerName`, `aboutId`,
//        `aboutName`, `importance`) — no raw secret on disk.
//      - `gui_events` STILL carries the original secret, proving
//        the audit/outbox source is untouched.
//
//   B. **Legacy-title read path.** Two pre-FEAT-MEMORY-1 journal
//      rows are SQL-INSERTed DIRECTLY into
//      `player_journal_entries` with leaky `title`, leaky `body`,
//      and full sensitive `payload` (one `memory:added` with
//      `title='betrayal'`, one `memory:enriched` with
//      `title='intimacy'`). After the read sanitizer runs:
//      - `/api/player/:id/notices` returns
//        `title='Memory recorded'` / `'Memory deepened'`,
//        `body=null`.
//      - The full API JSON contains zero hits for any secret or
//        category-revealing string (the original leaky titles
//        included).
//      - The on-disk rows are STILL the leaky originals —
//        read-time sanitization is intentionally read-only; we
//        do not mutate persisted rows.
//
// Then Chromium walks Title → Continue → game shell → J menu,
// asserts the three generic-title rows render, and runs a whole-
// document `innerText` leak guard over every secret string.
//
// CLI:
//   --out <dir>         Where to write `summary.json` and the
//                       `result.json` evidence. Default:
//                       `.codex/run-logs/live-playtest/notice-journal-memory-privacy-smoke`.
//   --port <n>          Backend port. Default 7801.
//   --keep-temp         Keep the PGlite temp dir + screenshots
//                       after the run. Default: cleaned.
//   --timeout-ms <n>    Hard ceiling. Default 240_000.
//
// Strict failure: exits 1 on any blocker (4xx/5xx from the API,
// missing generic row, leak string hit, unexpected exception).

import {chromium, type ConsoleMessage, type Request, type Response} from 'playwright';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
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
  'notice-journal-memory-privacy-smoke',
);
const DEFAULT_UI_DIST = path.join(
  REPO_ROOT,
  'packages',
  'web-ui',
  'dist',
);
const DEBUG_KEY = 'codex-notice-journal-privacy-smoke-debug-key';

// The secret strings we plant in every private memory field. None
// of these characters may appear in any player-facing surface.
const MEMORY_SECRET = 'she suspects the lord poisoned the cook';
const PRIVATE_REFLECTION = 'she is afraid to speak it aloud';
const LINK_REASON = 'cross-references the cook poisoning thread';
const ADDED_KIND = 'betrayal';
const ENRICHED_KIND = 'intimacy';
const SECRET_TAG = 'suspicion';

const ALL_SECRET_STRINGS = [
  MEMORY_SECRET,
  PRIVATE_REFLECTION,
  LINK_REASON,
  ADDED_KIND,
  ENRICHED_KIND,
  SECRET_TAG,
];
const API_LEAK_STRINGS = [
  ...ALL_SECRET_STRINGS,
  'internal_reflection',
  'link_reason',
  'draft_text',
];

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

interface SmokeResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outDir: string;
  steps: SmokeStep[];
  blockers: string[];
  steps_summary: Record<string, unknown>;
}

function parseArgs(argv: string[]): Args {
  let out = DEFAULT_OUT;
  let port = 7801;
  let keepTemp = false;
  let timeoutMs = 240_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[++i] ?? out;
    } else if (arg === '--port') {
      port = Number(argv[++i] ?? port) || port;
    } else if (arg === '--keep-temp') {
      keepTemp = true;
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number(argv[++i] ?? timeoutMs) || timeoutMs;
    }
  }
  return {out, port, keepTemp, timeoutMs};
}

async function postJson<T>(
  url: string,
  body: unknown,
  init: RequestInit = {},
): Promise<{status: number; body: T | null}> {
  const headers = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const {headers: _h, ...rest} = init;
  const r = await fetch(url, {
    method: 'POST',
    ...rest,
    body: JSON.stringify(body),
    headers,
  });
  let parsed: T | null = null;
  try {
    parsed = (await r.json()) as T;
  } catch {
    parsed = null;
  }
  return {status: r.status, body: parsed};
}

async function patchJson<T>(
  url: string,
  body: unknown,
): Promise<{status: number; body: T | null}> {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  let parsed: T | null = null;
  try {
    parsed = (await r.json()) as T;
  } catch {
    parsed = null;
  }
  return {status: r.status, body: parsed};
}

async function getJson<T>(
  url: string,
): Promise<{status: number; body: T | null; raw: string}> {
  const r = await fetch(url);
  const raw = await r.text();
  let parsed: T | null = null;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    parsed = null;
  }
  return {status: r.status, body: parsed, raw};
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

interface AnonymousPlayer {
  public_id: string;
  entity_id: number;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  const outDir = path.resolve(args.out);
  mkdirSync(outDir, {recursive: true});
  const screenshots = path.join(outDir, 'screenshots');
  mkdirSync(screenshots, {recursive: true});

  // Clean stale evidence before the run so a re-run never leaves
  // confusing artifacts from the previous attempt.
  for (const name of [
    'summary.json',
    'result.json',
    'notices-api-materialized.json',
    'notices-api-legacy.json',
    'persisted-journal-row-materialized.json',
    'gui-events-row-materialized.json',
    'persisted-journal-rows-legacy-before.json',
    'persisted-journal-rows-legacy-after.json',
    'console-log.jsonl',
    'network-log.jsonl',
  ]) {
    const p = path.join(outDir, name);
    if (existsSync(p)) rmSync(p);
  }

  const dbDir = await mkdtemp(
    path.join(os.tmpdir(), 'notice-journal-privacy-smoke-'),
  );
  process.env.PGLITE_DATA_DIR = dbDir;
  process.env.GEMINI_WEB_PORT = String(args.port);
  process.env.GREENHAVEN_WEB_UI_DIST = DEFAULT_UI_DIST;
  process.env.AUTH_DISABLED = '1';
  process.env.AUTH_SECRET = 'smoke-only-secret-not-real-32-bytes-or-more-XXXXX';
  process.env.GREENHAVEN_DEBUG_ROUTES = '1';
  process.env.GREENHAVEN_DEBUG_KEY = DEBUG_KEY;
  process.env.FEATHERLESS_API_KEY = 'smoke-provider-key-not-real';
  process.env.NODE_ENV = 'development';
  process.env.GREENHAVEN_GAMEPLAY_LOG_DIR = path.join(outDir, 'gameplay-logs');

  const steps: SmokeStep[] = [];
  const blockers: string[] = [];
  const stepsSummary: Record<string, unknown> = {};
  const record = (step: SmokeStep) => {
    steps.push(step);
    process.stderr.write(
      `[notice-journal-privacy-smoke] ${step.status.padEnd(6)} ${step.name}` +
        (step.error ? ` — ${step.error}` : '') +
        '\n',
    );
  };
  const logBlocker = (name: string, msg: string) => {
    record({name, status: 'failed', error: msg});
    blockers.push(`${name}: ${msg}`);
  };
  const writeJson = (name: string, data: unknown) => {
    writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2));
  };

  const {startGreenhavenServer, stopGreenhavenServer} = await import(
    '../index.js'
  );
  const dbModule = await import('../db.js');

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
        '[notice-journal-privacy-smoke] stopGreenhavenServer failed',
        err,
      );
    }
    if (!args.keepTemp) {
      await rm(dbDir, {recursive: true, force: true}).catch(() => {});
    }
  };

  const finish = async (): Promise<number> => {
    const finishedAt = new Date();
    const ok = blockers.length === 0;
    const summary: SmokeResult = {
      ok,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outDir,
      steps,
      blockers,
      steps_summary: stepsSummary,
    };
    writeJson('summary.json', summary);
    // `result.json` mirrors the older harness shape so anyone with
    // existing tooling/grep patterns finds the same evidence.
    writeJson('result.json', {
      passed: ok,
      blockers,
      steps: stepsSummary,
    });
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

    const anon = await postJson<AnonymousPlayer>(
      `${base}/api/player/anonymous`,
      {displayName: 'Codex Notice Journal Privacy Smoke'},
    );
    if (anon.status !== 200 || !anon.body?.entity_id || !anon.body.public_id) {
      logBlocker(
        'create_anonymous_player',
        `status=${anon.status} body=${JSON.stringify(anon.body)}`,
      );
      return await finish();
    }
    const playerId = anon.body.entity_id;
    const publicId = anon.body.public_id;
    stepsSummary.playerId = playerId;
    record({
      name: 'create_anonymous_player',
      status: 'ok',
      details: {playerId, publicId},
    });

    const sessionResp = await postJson<{sessionId: string}>(
      `${base}/api/session`,
      {playerId},
    );
    if (sessionResp.status !== 200 || !sessionResp.body?.sessionId) {
      logBlocker('create_session', `status=${sessionResp.status}`);
      return await finish();
    }
    const sessionId = sessionResp.body.sessionId;
    record({name: 'create_session', status: 'ok'});

    const profileResp = await patchJson<{ok: boolean}>(
      `${base}/api/player/${playerId}/profile`,
      {created: true},
    );
    if (profileResp.status !== 200) {
      logBlocker('patch_profile_created', `status=${profileResp.status}`);
      return await finish();
    }
    record({name: 'patch_profile_created', status: 'ok'});

    // ─────────────────────────────────────────────────────────────
    // PART A — materialization path.
    // ─────────────────────────────────────────────────────────────
    const fullMemoryPayload = {
      memoryId: 7,
      ownerId: 42,
      ownerName: 'Sable Vey',
      aboutId: 9,
      aboutName: 'The Lord',
      text: MEMORY_SECRET,
      summary: MEMORY_SECRET,
      draft_text: MEMORY_SECRET,
      internal_reflection: PRIVATE_REFLECTION,
      link_reason: LINK_REASON,
      tags: ['entity:9', 'sensitive', SECRET_TAG],
      kind: ADDED_KIND,
      category: ADDED_KIND,
      sensitive: true,
      importance: 0.9,
    };
    const emit = await postJson<{ok: boolean; operations?: unknown[]}>(
      `${base}/api/debug/live-ops`,
      {
        playerId,
        sessionId,
        ops: [
          {
            type: 'emit_gui_event',
            eventType: 'memory:added',
            payload: fullMemoryPayload,
          },
        ],
      },
      {headers: {'x-debug-key': DEBUG_KEY}},
    );
    if (emit.status !== 200) {
      logBlocker('emit_memory_added', `status=${emit.status}`);
      return await finish();
    }
    record({name: 'emit_memory_added', status: 'ok'});

    const noticesA = await getJson<{entries: Array<Record<string, unknown>>}>(
      `${base}/api/player/${playerId}/notices?limit=50`,
    );
    writeJson('notices-api-materialized.json', noticesA.body);
    if (noticesA.status !== 200 || !noticesA.body) {
      logBlocker(
        'fetch_notices_materialized',
        `status=${noticesA.status}`,
      );
      return await finish();
    }
    const materializedEntry = noticesA.body.entries.find(
      (e) => e['eventType'] === 'memory:added',
    );
    if (!materializedEntry) {
      logBlocker(
        'fetch_notices_materialized',
        'memory:added entry missing from notices',
      );
    } else {
      if (materializedEntry['title'] !== 'Memory recorded') {
        logBlocker(
          'fetch_notices_materialized',
          `expected title 'Memory recorded', got ${JSON.stringify(materializedEntry['title'])}`,
        );
      }
      if (materializedEntry['body'] !== null) {
        logBlocker(
          'fetch_notices_materialized',
          `expected body null, got ${JSON.stringify(materializedEntry['body'])}`,
        );
      }
      stepsSummary.materializedTitle = materializedEntry['title'];
      stepsSummary.materializedBody = materializedEntry['body'];
    }
    for (const s of API_LEAK_STRINGS) {
      if (noticesA.raw.toLowerCase().includes(s.toLowerCase())) {
        logBlocker('fetch_notices_materialized', `API JSON contains '${s}'`);
      }
    }
    if (
      noticesA.status === 200 &&
      materializedEntry &&
      materializedEntry['title'] === 'Memory recorded' &&
      materializedEntry['body'] === null
    ) {
      record({
        name: 'fetch_notices_materialized',
        status: 'ok',
        details: {title: 'Memory recorded', body: null},
      });
    }

    const persistedA = await dbModule.query<{
      title: string;
      body: string | null;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT title, body, payload
         FROM player_journal_entries
        WHERE player_id = $1 AND event_type = 'memory:added'
        ORDER BY id DESC
        LIMIT 1`,
      [playerId],
    );
    writeJson('persisted-journal-row-materialized.json', persistedA.rows[0] ?? null);
    if (!persistedA.rows[0]) {
      logBlocker(
        'inspect_persisted_materialized',
        'persisted memory journal row missing',
      );
    } else {
      const row = persistedA.rows[0];
      if (row.body !== null) {
        logBlocker(
          'inspect_persisted_materialized',
          `persisted body should be NULL, got ${JSON.stringify(row.body)}`,
        );
      }
      const payloadJson = JSON.stringify(row.payload ?? {});
      for (const s of API_LEAK_STRINGS) {
        if (payloadJson.toLowerCase().includes(s.toLowerCase())) {
          logBlocker(
            'inspect_persisted_materialized',
            `persisted payload contains '${s}'`,
          );
        }
      }
      if (row.body === null) {
        record({
          name: 'inspect_persisted_materialized',
          status: 'ok',
          details: {
            persistedKeys: Object.keys((row.payload ?? {}) as object).sort(),
          },
        });
      }
    }

    // gui_events outbox sanity — proves the pipeline is real.
    const guiEventA = await dbModule.query<{
      payload: Record<string, unknown>;
    }>(
      `SELECT payload FROM gui_events
        WHERE player_id = $1 AND event_type = 'memory:added'
        ORDER BY id DESC
        LIMIT 1`,
      [playerId],
    );
    writeJson('gui-events-row-materialized.json', guiEventA.rows[0] ?? null);
    if (
      !guiEventA.rows[0] ||
      !JSON.stringify(guiEventA.rows[0].payload).includes(MEMORY_SECRET)
    ) {
      logBlocker(
        'inspect_gui_events_outbox',
        'gui_events outbox is missing the original secret — pipeline likely disconnected',
      );
    } else {
      record({name: 'inspect_gui_events_outbox', status: 'ok'});
    }
    stepsSummary.guiEventsOutboxStillHasSecret =
      !!guiEventA.rows[0] &&
      JSON.stringify(guiEventA.rows[0].payload).includes(MEMORY_SECRET);

    // ─────────────────────────────────────────────────────────────
    // PART B — legacy-title read path. Seed two pre-FEAT-MEMORY-1
    // rows DIRECTLY via SQL INSERT (bypassing the materializer)
    // so the rows look exactly like what was on disk before the
    // privacy fix landed.
    // ─────────────────────────────────────────────────────────────
    await dbModule.query(
      `INSERT INTO player_journal_entries
         (player_id, session_id, source_event_id, entry_type,
          event_type, title, body, payload)
       VALUES ($1, $2, NULL, 'system',
               'memory:added', $3, $4, $5::jsonb)`,
      [playerId, sessionId, ADDED_KIND, MEMORY_SECRET, JSON.stringify(fullMemoryPayload)],
    );
    await dbModule.query(
      `INSERT INTO player_journal_entries
         (player_id, session_id, source_event_id, entry_type,
          event_type, title, body, payload)
       VALUES ($1, $2, NULL, 'system',
               'memory:enriched', $3, $4, $5::jsonb)`,
      [
        playerId,
        sessionId,
        ENRICHED_KIND,
        MEMORY_SECRET,
        JSON.stringify({
          ...fullMemoryPayload,
          kind: ENRICHED_KIND,
          category: ENRICHED_KIND,
        }),
      ],
    );
    record({name: 'seed_legacy_journal_rows', status: 'ok'});

    const beforeB = await dbModule.query<{
      id: number | string;
      event_type: string;
      title: string;
      body: string | null;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT id, event_type, title, body, payload
         FROM player_journal_entries
        WHERE player_id = $1
          AND event_type IN ('memory:added','memory:enriched')
          AND title IN ($2, $3)
        ORDER BY id ASC`,
      [playerId, ADDED_KIND, ENRICHED_KIND],
    );
    writeJson('persisted-journal-rows-legacy-before.json', beforeB.rows);
    const seededAdded = beforeB.rows.find(
      (r) => r.event_type === 'memory:added',
    )?.title;
    const seededEnriched = beforeB.rows.find(
      (r) => r.event_type === 'memory:enriched',
    )?.title;
    if (seededAdded !== ADDED_KIND || seededEnriched !== ENRICHED_KIND) {
      logBlocker(
        'inspect_legacy_seed_on_disk',
        `seeded leaky titles missing (added=${seededAdded}, enriched=${seededEnriched})`,
      );
    } else {
      record({
        name: 'inspect_legacy_seed_on_disk',
        status: 'ok',
        details: {added: seededAdded, enriched: seededEnriched},
      });
    }
    stepsSummary.seededTitles = {
      added: seededAdded,
      enriched: seededEnriched,
    };

    const noticesB = await getJson<{entries: Array<Record<string, unknown>>}>(
      `${base}/api/player/${playerId}/notices?limit=50`,
    );
    writeJson('notices-api-legacy.json', noticesB.body);
    if (noticesB.status !== 200 || !noticesB.body) {
      logBlocker('fetch_notices_legacy', `status=${noticesB.status}`);
      return await finish();
    }
    const legacyAdded = noticesB.body.entries.find(
      (e) =>
        e['eventType'] === 'memory:added' &&
        // distinguish the legacy-seeded one from the live-emitted one
        e['sourceEventId'] == null,
    );
    const legacyEnriched = noticesB.body.entries.find(
      (e) => e['eventType'] === 'memory:enriched',
    );
    if (legacyAdded && legacyAdded['title'] !== 'Memory recorded') {
      logBlocker(
        'fetch_notices_legacy',
        `legacy memory:added title not normalized: ${JSON.stringify(legacyAdded['title'])}`,
      );
    }
    if (legacyEnriched && legacyEnriched['title'] !== 'Memory deepened') {
      logBlocker(
        'fetch_notices_legacy',
        `legacy memory:enriched title not normalized: ${JSON.stringify(legacyEnriched['title'])}`,
      );
    }
    if (legacyAdded && legacyAdded['body'] !== null) {
      logBlocker(
        'fetch_notices_legacy',
        `legacy memory:added body should be null, got ${JSON.stringify(legacyAdded['body'])}`,
      );
    }
    if (legacyEnriched && legacyEnriched['body'] !== null) {
      logBlocker(
        'fetch_notices_legacy',
        `legacy memory:enriched body should be null, got ${JSON.stringify(legacyEnriched['body'])}`,
      );
    }
    stepsSummary.legacyApiTitles = {
      added: legacyAdded?.['title'] ?? null,
      enriched: legacyEnriched?.['title'] ?? null,
    };
    for (const s of API_LEAK_STRINGS) {
      if (noticesB.raw.toLowerCase().includes(s.toLowerCase())) {
        logBlocker('fetch_notices_legacy', `API JSON contains '${s}'`);
      }
    }
    if (
      noticesB.status === 200 &&
      legacyAdded?.['title'] === 'Memory recorded' &&
      legacyEnriched?.['title'] === 'Memory deepened'
    ) {
      record({
        name: 'fetch_notices_legacy',
        status: 'ok',
        details: {
          added: 'Memory recorded',
          enriched: 'Memory deepened',
        },
      });
    }

    const afterB = await dbModule.query<{
      id: number | string;
      event_type: string;
      title: string;
    }>(
      `SELECT id, event_type, title
         FROM player_journal_entries
        WHERE player_id = $1
          AND event_type IN ('memory:added','memory:enriched')
          AND title IN ($2, $3)
        ORDER BY id ASC`,
      [playerId, ADDED_KIND, ENRICHED_KIND],
    );
    writeJson('persisted-journal-rows-legacy-after.json', afterB.rows);
    const afterAdded = afterB.rows.find(
      (r) => r.event_type === 'memory:added',
    )?.title;
    if (afterAdded !== ADDED_KIND) {
      logBlocker(
        'inspect_legacy_disk_untouched',
        `on-disk legacy title was mutated by /notices read (was ${ADDED_KIND}, now ${afterAdded}) — read-only sanitization invariant broken`,
      );
    } else {
      record({
        name: 'inspect_legacy_disk_untouched',
        status: 'ok',
        details: {
          added: afterAdded,
          enriched: afterB.rows.find(
            (r) => r.event_type === 'memory:enriched',
          )?.title,
        },
      });
    }
    stepsSummary.diskTitlesStillLeakyAfterRead = {
      added: afterAdded,
      enriched: afterB.rows.find(
        (r) => r.event_type === 'memory:enriched',
      )?.title,
    };

    // ─────────────────────────────────────────────────────────────
    // PART C — DOM leak guard via Chromium.
    // ─────────────────────────────────────────────────────────────
    const browser = await chromium.launch({headless: true});
    const context = await browser.newContext({
      viewport: {width: 1280, height: 800},
    });
    const page = await context.newPage();

    const consoleLogPath = path.join(outDir, 'console-log.jsonl');
    const networkLogPath = path.join(outDir, 'network-log.jsonl');
    page.on('console', (msg: ConsoleMessage) => {
      appendFileSync(
        consoleLogPath,
        JSON.stringify({
          type: msg.type(),
          text: msg.text(),
          ts: Date.now(),
        }) + '\n',
      );
    });
    page.on('requestfailed', (req: Request) => {
      appendFileSync(
        networkLogPath,
        JSON.stringify({
          phase: 'requestfailed',
          url: req.url(),
          method: req.method(),
          failure: req.failure()?.errorText,
          ts: Date.now(),
        }) + '\n',
      );
    });
    page.on('response', (res: Response) => {
      const url = res.url();
      const status = res.status();
      if (status >= 400 || url.includes('/notices')) {
        appendFileSync(
          networkLogPath,
          JSON.stringify({
            phase: 'response',
            url,
            status,
            ts: Date.now(),
          }) + '\n',
        );
      }
    });

    await context.addInitScript(
      ({publicId, sessionId, language}) => {
        try {
          window.localStorage.setItem(
            'greenhaven.playerPublicId',
            publicId,
          );
          window.localStorage.setItem('greenhaven.sessionId', sessionId);
          window.localStorage.setItem('greenhaven.uiLanguage', language);
        } catch {
          // ignore
        }
      },
      {publicId, sessionId, language: 'en'},
    );

    try {
      await page.goto(base, {waitUntil: 'domcontentloaded', timeout: 20000});
      await page.waitForSelector('.title-screen', {timeout: 10000});
      await page.waitForTimeout(150);
      await page.keyboard.press('Space');
      await page.waitForSelector('.title-menu', {timeout: 5000});
      await page.waitForFunction(
        () => {
          const buttons = Array.from(
            document.querySelectorAll('.title-menu__btn'),
          ) as HTMLButtonElement[];
          const cont = buttons.find((b) =>
            b.textContent?.toLowerCase().includes('continue'),
          );
          return cont != null && !cont.disabled;
        },
        undefined,
        {timeout: 10000},
      );
      await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('.title-menu__btn'),
        ) as HTMLButtonElement[];
        const cont = buttons.find((b) =>
          b.textContent?.toLowerCase().includes('continue'),
        );
        cont?.click();
      });
      await page.waitForSelector('main.game-shell', {timeout: 20000});
      await page.waitForTimeout(800);

      await page.click('.chat-header-menu-trigger');
      await page.click('[role="menuitem"]:has(kbd:text("J"))');
      await page.waitForSelector('.notice-journal', {timeout: 10000});
      // The journal must show at least 3 rows now: 1 materialized
      // + 2 legacy-seeded.
      await page.waitForFunction(
        () => document.querySelectorAll('.notice-journal-row').length >= 3,
        undefined,
        {timeout: 8000},
      );
      await page.screenshot({
        path: path.join(screenshots, 'journal.png'),
        fullPage: true,
      });

      const journalSnapshot = await page.evaluate(() => {
        const root = document.querySelector('.notice-journal');
        const titles = Array.from(
          document.querySelectorAll('.notice-journal-title'),
        ).map((el) => el.textContent ?? '');
        return {
          rootText: root?.textContent ?? '',
          html: root?.outerHTML ?? '',
          titles,
        };
      });

      const recordedCount = journalSnapshot.titles.filter((t) =>
        t.includes('Memory recorded'),
      ).length;
      const deepenedCount = journalSnapshot.titles.filter((t) =>
        t.includes('Memory deepened'),
      ).length;
      if (recordedCount < 1) {
        logBlocker(
          'render_journal',
          'Notice Journal does not render a "Memory recorded" row',
        );
      }
      if (deepenedCount < 1) {
        logBlocker(
          'render_journal',
          'Notice Journal does not render a "Memory deepened" row',
        );
      }
      stepsSummary.journalTitles = journalSnapshot.titles;

      for (const s of ALL_SECRET_STRINGS) {
        if (journalSnapshot.rootText.toLowerCase().includes(s.toLowerCase())) {
          logBlocker(
            'render_journal',
            `Notice Journal DOM text contains '${s}'`,
          );
        }
      }

      const docLeak = await page.evaluate((secrets: string[]) => {
        const body = (document.body?.innerText ?? '').toLowerCase();
        const hits: Record<string, boolean> = {};
        for (const s of secrets) hits[s] = body.includes(s.toLowerCase());
        return hits;
      }, ALL_SECRET_STRINGS);
      stepsSummary.docLeak = docLeak;
      for (const [s, hit] of Object.entries(docLeak)) {
        if (hit) {
          logBlocker('render_journal', `document body contains '${s}'`);
        }
      }
      if (recordedCount >= 1 && deepenedCount >= 1) {
        record({
          name: 'render_journal',
          status: 'ok',
          details: {
            recordedRows: recordedCount,
            deepenedRows: deepenedCount,
          },
        });
      }
    } finally {
      await context.close();
      await browser.close();
    }

    clearTimeout(timeoutHandle);
    return await finish();
  } catch (err) {
    clearTimeout(timeoutHandle);
    logBlocker(
      'unexpected_exception',
      err instanceof Error ? err.message : String(err),
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
      console.error('[notice-journal-privacy-smoke] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runNoticeJournalMemoryPrivacySmoke};
