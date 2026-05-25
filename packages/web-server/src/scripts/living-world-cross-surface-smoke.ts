/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference lib="dom" />

// FEAT-PRESENCE-3 stable repository smoke.
//
// Promotes the timestamped donor harness at
// `.codex/run-logs/live-playtest/2026-05-17T09-25-34Z-living-world-cross-surface-smoke/`
// into a single repeatable command so future agents can verify the
// living-world × Tier-8 cross-surface contract without hunting
// buried run-log artifacts.
//
// In one isolated run (own port + temp PGlite + production
// `web-ui/dist`) the smoke proves:
//
//   1. The four Tier-8 surfaces (Inventory I, Quest Dashboard Q,
//      Notice Journal J, Character State P) render, refresh live,
//      and persist across a hard `page.reload()`.
//   2. The living-world presence chips (rail, city-map "Here now"
//      row, NPC profile modal) render the seeded friendly bond and
//      the seeded PUBLIC actor status (`tired` / `long-shift`).
//   3. The seeded PRIVATE actor status (`emotion` / `jealous`)
//      never leaks through `/api/session/:id/locations?playerId=…`,
//      the rendered DOM of any surface, OR the whole-document
//      `document.body.innerText`.
//   4. Item C also survives the hard reload — both the bond chip
//      and the public status pip re-render with no leak.
//
// Strict failure semantics: every assertion is a blocker, not a
// warning. The script exits 1 on the first reproducible blocker.
//
// CLI:
//   --out <dir>         Where to write `summary.json`,
//                       `result.json`, snapshots, screenshots,
//                       logs. Default:
//                       `.codex/run-logs/live-playtest/living-world-cross-surface-smoke`.
//   --port <n>          Backend port. Default 7802.
//   --keep-temp         Keep the PGlite temp dir + screenshots
//                       after the run. Default: cleaned.
//   --timeout-ms <n>    Hard ceiling. Default 360_000.
//
// Run from repo root:
//
//   npm --prefix packages/web-server run live:living-world-surfaces

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
  'living-world-cross-surface-smoke',
);
const DEFAULT_UI_DIST = path.join(
  REPO_ROOT,
  'packages',
  'web-ui',
  'dist',
);
const DEBUG_KEY = 'codex-living-world-smoke-debug-key';

// Live-ops `grant_item` normalises display names through the player
// inventory writer; the canonical row keeps the slugified spacing
// (no dash). Use a name that survives that normalization so the
// initial-snapshot find matches the canonical row.
const ITEM_NAME = 'Codex Living World Smoke Sword';
const QUEST_TITLE = 'Codex Living-World Smoke Quest';
const TRACK_KEY = 'survival_living_world';
const TRACK_NAME = 'Survival (Living-World Smoke)';
const SKILL_NAME = 'tracking_living_world';
const STAT_KEY = 'strength';
const TITLE_KEY = 'forgewarden_living_world';
const TITLE_DISPLAY = 'Forgewarden of the Living-World Smoke';

const NPC_DISPLAY_NAME = 'Mira the Living-World Smith (Living-World Smoke)';
const LOCATION_DISPLAY_NAME = 'Smoke Forge (Living-World Smoke)';
const PUBLIC_STATUS_KIND = 'tired';
const PUBLIC_STATUS_VALUE = 'long-shift';
const PRIVATE_STATUS_KIND = 'emotion';
const PRIVATE_STATUS_VALUE = 'jealous';
const STRINGS_COUNT = 3; // → friendly per stringBandForCount

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
  let port = 7802;
  let keepTemp = false;
  let timeoutMs = 360_000;
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
  display_name: string;
}
interface InventoryMinSnapshot {
  items: Array<{name: string; slug: string | null; equipped: boolean}>;
}
interface QuestSnapshot {
  active: Array<{id: number; name: string}>;
  recentEvents: Array<{type: string; questEntityId?: number | null}>;
}
interface NoticeSnapshot {
  entries: Array<{id: number; eventType: string; title: string}>;
}
interface CharacterSnapshot {
  vitals: {xp: {level: number; total: number}};
  stats: Array<{key: string; current: number}>;
  titles: Array<{titleKey: string; isEquipped: boolean}>;
  progression: {
    tracks: Array<{trackKey: string; level: number}>;
    wallet: {statPoints: number; skillPoints: number};
  };
  rankedSkills: Array<{name: string; rank: number}>;
}
interface LocationsView {
  current: {id: number; name: string} | null;
  exits: unknown[];
  nearby: Array<{
    id: number;
    name: string;
    relationship: {band: string | null; count: number | null} | null;
    statuses: Array<{kind: string; value: string; intensity: number}>;
  }>;
  map: unknown;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  const outDir = path.resolve(args.out);
  mkdirSync(outDir, {recursive: true});
  const screenshots = path.join(outDir, 'screenshots');
  mkdirSync(screenshots, {recursive: true});

  // Clean stale evidence before the run so a re-run never leaves
  // confusing artifacts.
  for (const name of [
    'summary.json',
    'result.json',
    'health-api.json',
    'health-db.json',
    'locations-api-seed.json',
    'locations-api-reload.json',
    'inventory-seed.json',
    'inventory-equip.json',
    'inventory-reload.json',
    'quest-dashboard-seed.json',
    'quest-dashboard-emit.json',
    'quest-dashboard-reload.json',
    'notices-seed.json',
    'notices-emit.json',
    'notices-reload.json',
    'character-state-seed.json',
    'character-state-actions.json',
    'character-state-reload.json',
    'rail-snapshot-seed.json',
    'rail-snapshot-reload.json',
    'city-map-snapshot-seed.json',
    'city-map-snapshot-reload.json',
    'npc-profile-snapshot-seed.json',
    'npc-profile-snapshot-reload.json',
    'seed-results.json',
    'emit-responses.jsonl',
    'sse-events.jsonl',
    'console-log.jsonl',
    'network-log.jsonl',
  ]) {
    const p = path.join(outDir, name);
    if (existsSync(p)) rmSync(p);
  }

  const dbDir = await mkdtemp(
    path.join(os.tmpdir(), 'living-world-smoke-'),
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
      `[living-world-smoke] ${step.status.padEnd(6)} ${step.name}` +
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
  const toolBase = await import('../tools/base.js');
  const cartridgeScope = await import('../cartridgeScope.js');
  // Side-effect import — registers tools into the central registry.
  await import('../tools/index.js');

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
        '[living-world-smoke] stopGreenhavenServer failed',
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
    // `result.json` mirrors the donor harness shape so existing
    // grep tooling keeps working.
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

  const emitEvidencePath = path.join(outDir, 'emit-responses.jsonl');
  async function liveOps(
    playerId: number,
    sessionId: string,
    ops: Array<Record<string, unknown>>,
    label: string,
  ): Promise<{status: number; body: unknown}> {
    const r = await postJson<{ok: boolean; operations?: unknown[]}>(
      `${base}/api/debug/live-ops`,
      {playerId, sessionId, ops},
      {headers: {'x-debug-key': DEBUG_KEY}},
    );
    appendFileSync(
      emitEvidencePath,
      JSON.stringify({label, status: r.status, body: r.body}) + '\n',
    );
    return {status: r.status, body: r.body};
  }

  try {
    if (!(await waitForHealthy(base))) {
      logBlocker('bootstrap', '/api/health never returned ok=true');
      return await finish();
    }
    const healthBody = await getJson<unknown>(`${base}/api/health`);
    writeJson('health-api.json', healthBody.body);
    const dbHealth = await getJson<unknown>(`${base}/api/db/health`);
    writeJson('health-db.json', dbHealth.body);
    record({name: 'bootstrap_backend', status: 'ok'});

    // 1. Player.
    const anon = await postJson<AnonymousPlayer>(
      `${base}/api/player/anonymous`,
      {displayName: 'Codex Living-World Smoke Player'},
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
    stepsSummary.publicId = publicId;
    record({name: 'create_anonymous_player', status: 'ok'});

    // 2. WizardGate bypass.
    const profileResp = await patchJson<{ok: boolean}>(
      `${base}/api/player/${playerId}/profile`,
      {created: true},
    );
    if (profileResp.status !== 200) {
      logBlocker('patch_profile_created', `status=${profileResp.status}`);
      return await finish();
    }
    record({name: 'patch_profile_created', status: 'ok'});

    const {query} = dbModule;
    const cartridgeId = await cartridgeScope.activeCartridgeId();
    stepsSummary.cartridgeId = cartridgeId;
    if (!cartridgeId) {
      logBlocker('resolve_cartridge', 'no active cartridge id available');
      return await finish();
    }

    // 3. Living-world presence fixture.
    const locationRow = await query<{id: number}>(
      `INSERT INTO entities (kind, display_name, profile, tags,
                              cartridge_id, dynamic_origin)
       VALUES ('location', $1, $2::jsonb, ARRAY['location']::text[],
               $3, false)
       RETURNING id`,
      [
        LOCATION_DISPLAY_NAME,
        JSON.stringify({
          location_kind: 'workshop',
          summary: 'Smoke fixture forge.',
        }),
        cartridgeId,
      ],
    );
    const locationId = Number(locationRow.rows[0]!.id);
    stepsSummary.locationId = locationId;

    const npcRow = await query<{id: number}>(
      `INSERT INTO entities (kind, display_name, profile, tags,
                              cartridge_id, dynamic_origin)
       VALUES ('person', $1, $2::jsonb, ARRAY['person']::text[],
               $3, false)
       RETURNING id`,
      [
        NPC_DISPLAY_NAME,
        JSON.stringify({
          location_id: String(locationId),
          role: 'smith',
          summary: 'Living-world fixture NPC for the stable smoke.',
        }),
        cartridgeId,
      ],
    );
    const npcId = Number(npcRow.rows[0]!.id);
    stepsSummary.npcId = npcId;

    await query(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locationId, playerId],
    );

    const fieldRow = await query<{id: number}>(
      `INSERT INTO runtime_fields (owner_entity_id, field_key, value_type,
                                    default_value)
       VALUES ($1, 'strings', 'json', '{}'::jsonb)
       RETURNING id`,
      [npcId],
    );
    const fieldId = Number(fieldRow.rows[0]!.id);
    await query(
      `INSERT INTO runtime_values (field_id, value, source)
       VALUES ($1, $2::jsonb, 'smoke')`,
      [fieldId, JSON.stringify({[String(playerId)]: STRINGS_COUNT})],
    );

    await query(
      `INSERT INTO actor_statuses (player_id, actor_entity_id, status_kind,
                                    status_value, intensity, source)
       VALUES ($1, $2, $3, $4, $5, 'smoke')
       ON CONFLICT (player_id, actor_entity_id, status_kind)
       DO UPDATE SET status_value = EXCLUDED.status_value,
                     intensity = EXCLUDED.intensity`,
      [playerId, npcId, PUBLIC_STATUS_KIND, PUBLIC_STATUS_VALUE, 0.6],
    );
    await query(
      `INSERT INTO actor_statuses (player_id, actor_entity_id, status_kind,
                                    status_value, intensity, source)
       VALUES ($1, $2, $3, $4, $5, 'smoke')
       ON CONFLICT (player_id, actor_entity_id, status_kind)
       DO UPDATE SET status_value = EXCLUDED.status_value,
                     intensity = EXCLUDED.intensity`,
      [playerId, npcId, PRIVATE_STATUS_KIND, PRIVATE_STATUS_VALUE, 0.9],
    );
    record({name: 'seed_living_world_fixtures', status: 'ok'});

    // 4. Session.
    const sessionResp = await postJson<{sessionId: string}>(
      `${base}/api/session`,
      {playerId},
    );
    if (sessionResp.status !== 200 || !sessionResp.body?.sessionId) {
      logBlocker('create_session', `status=${sessionResp.status}`);
      return await finish();
    }
    const sessionId = sessionResp.body.sessionId;
    stepsSummary.sessionId = sessionId;
    record({name: 'create_session', status: 'ok'});

    // 5. Presence API contract proof.
    const locSeed = await getJson<LocationsView>(
      `${base}/api/session/${encodeURIComponent(sessionId)}/locations?playerId=${playerId}`,
    );
    writeJson('locations-api-seed.json', locSeed.body);
    if (locSeed.status !== 200 || !locSeed.body) {
      logBlocker(
        'locations_api_seed',
        `status=${locSeed.status}`,
      );
      return await finish();
    }
    const seededNearby = locSeed.body.nearby.find((n) => n.id === npcId);
    if (!seededNearby) {
      logBlocker(
        'locations_api_seed',
        `seeded NPC ${npcId} not in nearby[]`,
      );
      return await finish();
    }
    if (seededNearby.relationship?.band !== 'friendly') {
      logBlocker(
        'locations_api_seed',
        `expected friendly band; got ${JSON.stringify(seededNearby.relationship)}`,
      );
    }
    const apiStatusKinds = seededNearby.statuses.map((s) => s.kind);
    if (!apiStatusKinds.includes(PUBLIC_STATUS_KIND)) {
      logBlocker(
        'locations_api_seed',
        `public status '${PUBLIC_STATUS_KIND}' missing from API`,
      );
    }
    if (apiStatusKinds.includes(PRIVATE_STATUS_KIND)) {
      logBlocker(
        'locations_api_seed',
        `private status '${PRIVATE_STATUS_KIND}' LEAKED through API`,
      );
    }
    if (locSeed.raw.includes(PRIVATE_STATUS_VALUE)) {
      logBlocker(
        'locations_api_seed',
        `private status value '${PRIVATE_STATUS_VALUE}' LEAKED through API`,
      );
    }
    stepsSummary.apiBandSeed = seededNearby.relationship?.band;
    if (!blockers.some((b) => b.startsWith('locations_api_seed:'))) {
      record({
        name: 'locations_api_seed',
        status: 'ok',
        details: {band: seededNearby.relationship?.band},
      });
    }

    // 6. Tier-8 fixtures via live-ops + in-process tools.
    const grant = await liveOps(
      playerId,
      sessionId,
      [
        {
          type: 'grant_item',
          displayName: ITEM_NAME,
          category: 'weapon',
          quantity: 1,
        },
      ],
      'grant_item',
    );
    if (grant.status !== 200) {
      logBlocker('grant_item', `status=${grant.status}`);
      return await finish();
    }
    const createQuest = await liveOps(
      playerId,
      sessionId,
      [
        {
          type: 'create_debug_quest',
          title: QUEST_TITLE,
          summary: 'Living-World smoke quest.',
          goalText: 'Walk all four surfaces with presence rendered.',
        },
      ],
      'create_debug_quest',
    );
    const createBody = createQuest.body as {
      ok?: boolean;
      operations?: Array<{type: string; questEntityId?: number}>;
    };
    const questEntityId = createBody.operations?.find(
      (op) => op.type === 'create_debug_quest',
    )?.questEntityId;
    if (createQuest.status !== 200 || typeof questEntityId !== 'number') {
      logBlocker(
        'create_debug_quest',
        `status=${createQuest.status} body=${JSON.stringify(createBody)}`,
      );
      return await finish();
    }
    stepsSummary.questEntityId = questEntityId;

    await liveOps(
      playerId,
      sessionId,
      [
        {
          type: 'emit_gui_event',
          eventType: 'quest:created',
          payload: {
            questId: questEntityId,
            title: QUEST_TITLE,
            summary: 'Living-World smoke seed.',
          },
        },
        {
          type: 'emit_gui_event',
          eventType: 'companion:added',
          payload: {
            npcId: 1,
            npcName: 'Living-World Smoke Companion',
            reason: 'Joined for the smoke.',
          },
        },
      ],
      'notice_seed_batch',
    );

    // Character fixtures + in-process tool dispatch.
    await query(
      `INSERT INTO progression_tracks
         (track_key, display_name, description, xp_curve, max_level, sort_order)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (track_key) DO NOTHING`,
      [
        TRACK_KEY,
        TRACK_NAME,
        'Living-World smoke side track.',
        JSON.stringify({kind: 'linear', step: 100}),
        20,
        10,
      ],
    );
    await query(
      `INSERT INTO entities (kind, display_name, profile, dynamic_origin)
       VALUES ('skill', $1, $2::jsonb, TRUE)
       RETURNING id`,
      [SKILL_NAME, JSON.stringify({source: 'living-world-smoke'})],
    );
    await query(
      `INSERT INTO player_progression_wallets
         (player_id, stat_points, skill_points, title_slots)
       VALUES ($1, 1, 1, 1)
       ON CONFLICT (player_id) DO UPDATE
         SET stat_points = 1, skill_points = 1, title_slots = 1`,
      [playerId],
    );
    await query(
      `INSERT INTO player_stats (player_id, stat_key, base, current)
       VALUES ($1, $2, 10, 10)
       ON CONFLICT (player_id, stat_key) DO NOTHING`,
      [playerId, STAT_KEY],
    );
    await query(
      `INSERT INTO player_proficient_skills
         (player_id, skill_name, proficiency_level)
       VALUES ($1, 'investigation_living_world', 1)
       ON CONFLICT DO NOTHING`,
      [playerId],
    );

    const ctx: import('../tools/base.js').ToolContext = {
      sessionId,
      playerId,
      toolHistorySource: 'direct',
      turnInputKind: 'player_action',
    };
    const seedResults: Record<string, unknown> = {};
    const dispatch = async (
      name: string,
      payload: Record<string, unknown>,
    ): Promise<void> => {
      const r = await toolBase.runWithContext(ctx, () =>
        toolBase.executeTool(name, payload, ctx),
      );
      if (!r.ok) {
        throw new Error(`tool ${name} failed: ${r.error ?? 'unknown error'}`);
      }
      seedResults[name] = r.data ?? null;
    };
    await dispatch('award_xp', {
      player_id: playerId,
      amount: 500,
      reason: 'Living-World smoke seed',
    });
    await dispatch('award_progression_xp', {
      player_id: playerId,
      track_key: TRACK_KEY,
      amount: 250,
      reason: 'Living-World smoke seed',
    });
    await dispatch('award_title', {
      player_id: playerId,
      title_key: TITLE_KEY,
      display_name: TITLE_DISPLAY,
      description: 'Earned in the Living-World smoke.',
      source: 'living-world-smoke',
    });
    await dispatch('spend_skill_point', {
      player_id: playerId,
      skill: SKILL_NAME,
    });
    writeJson('seed-results.json', seedResults);

    await query(
      `UPDATE player_progression_wallets
          SET stat_points = 1, skill_points = 1
        WHERE player_id = $1`,
      [playerId],
    );
    record({name: 'seed_tier8_fixtures', status: 'ok'});

    // 7. API-level seed proofs.
    const invSeed = await getJson<InventoryMinSnapshot>(
      `${base}/api/player/${playerId}/inventory`,
    );
    writeJson('inventory-seed.json', invSeed.body);
    const grantedItem = invSeed.body?.items.find((i) => i.name === ITEM_NAME);
    if (!grantedItem?.slug) {
      logBlocker(
        'inventory_seed',
        `granted item not in seed snapshot: ${JSON.stringify(invSeed.body?.items)}`,
      );
      return await finish();
    }

    const questSeed = await getJson<QuestSnapshot>(
      `${base}/api/player/${playerId}/quest-dashboard?language=en`,
    );
    writeJson('quest-dashboard-seed.json', questSeed.body);
    if (!questSeed.body?.active.find((q) => q.id === questEntityId)) {
      logBlocker('quest_dashboard_seed', 'seeded quest not in active bucket');
    }
    const noticeSeed = await getJson<NoticeSnapshot>(
      `${base}/api/player/${playerId}/notices?limit=50`,
    );
    writeJson('notices-seed.json', noticeSeed.body);
    if (!noticeSeed.body?.entries.find((e) => e.eventType === 'quest:created')) {
      logBlocker('notices_seed', 'quest:created journal entry missing');
    }
    const charSeed = await getJson<CharacterSnapshot>(
      `${base}/api/player/${playerId}/character-state`,
    );
    writeJson('character-state-seed.json', charSeed.body);
    const seededLevel = charSeed.body?.vitals.xp.level ?? 0;
    if (seededLevel < 2) {
      logBlocker('character_state_seed', `character seed level ${seededLevel} < 2`);
    }
    const baselineStat =
      charSeed.body?.stats.find((s) => s.key === STAT_KEY)?.current ?? 10;
    stepsSummary.baselineStat = baselineStat;
    record({name: 'api_seed_proofs', status: 'ok'});

    // 8. SSE capture.
    const sseEventsPath = path.join(outDir, 'sse-events.jsonl');
    let sseClient: AbortController | null = null;
    const sseDone = (async () => {
      sseClient = new AbortController();
      try {
        const sseUrl = `${base}/api/session/${encodeURIComponent(sessionId)}/stream?playerId=${playerId}`;
        const r = await fetch(sseUrl, {signal: sseClient.signal});
        if (!r.body) return;
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventName = '';
        while (true) {
          const {value, done} = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, {stream: true});
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trimEnd();
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('event:')) {
              eventName = line.slice('event:'.length).trim();
            } else if (line.startsWith('data:')) {
              const data = line.slice('data:'.length).trim();
              appendFileSync(
                sseEventsPath,
                JSON.stringify({event: eventName, data, ts: Date.now()}) + '\n',
              );
            }
          }
        }
      } catch {
        // expected on abort
      }
    })();
    await new Promise((r) => setTimeout(r, 250));

    // 9. UI.
    const consoleLogPath = path.join(outDir, 'console-log.jsonl');
    const networkLogPath = path.join(outDir, 'network-log.jsonl');
    const browser = await chromium.launch({headless: true});
    const context = await browser.newContext({
      viewport: {width: 1280, height: 800},
    });
    const page = await context.newPage();

    const consoleErrors: Array<{text: string; ts: number}> = [];
    page.on('console', (msg: ConsoleMessage) => {
      const text = msg.text();
      appendFileSync(
        consoleLogPath,
        JSON.stringify({type: msg.type(), text, ts: Date.now()}) + '\n',
      );
      if (msg.type() === 'error') consoleErrors.push({text, ts: Date.now()});
    });
    const failedRequests: Array<{url: string; failure: string | undefined}> = [];
    let teardownStarted = false;
    page.on('requestfailed', (req: Request) => {
      const failure = req.failure()?.errorText;
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
      if (!teardownStarted) failedRequests.push({url: req.url(), failure});
    });
    const serverErrors: Array<{url: string; status: number}> = [];
    page.on('response', (res: Response) => {
      const url = res.url();
      const status = res.status();
      if (status >= 400) {
        appendFileSync(
          networkLogPath,
          JSON.stringify({
            phase: 'response',
            url,
            status,
            ts: Date.now(),
          }) + '\n',
        );
        serverErrors.push({url, status});
      }
    });

    await context.addInitScript(
      ({publicId, sessionId, language}) => {
        try {
          window.localStorage.setItem('greenhaven.playerPublicId', publicId);
          window.localStorage.setItem('greenhaven.sessionId', sessionId);
          window.localStorage.setItem('greenhaven.uiLanguage', language);
        } catch {
          // ignore
        }
      },
      {publicId, sessionId, language: 'en'},
    );

    async function bootIntoApp(): Promise<void> {
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
    }

    async function openSurfaceViaMenu(kbdLabel: string): Promise<void> {
      await page.click('.chat-header-menu-trigger');
      await page.click(`[role="menuitem"]:has(kbd:text("${kbdLabel}"))`);
    }

    async function closeActiveSurface(): Promise<void> {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }

    async function capturePresence(label: string): Promise<void> {
      // Rail.
      await page.waitForSelector('.chatlist .contact-row', {timeout: 10000});
      await page.screenshot({
        path: path.join(screenshots, `rail-${label}.png`),
        fullPage: true,
      });
      const railSnapshot = await page.evaluate((name) => {
        const rows = Array.from(
          document.querySelectorAll('.chatlist .contact-row'),
        );
        const match = rows.find((r) => r.textContent?.includes(name));
        if (!match) return {found: false, html: ''};
        const chip = match.querySelector('.chatlist-band-chip');
        const pip = match.querySelector('.chatlist-status-pip');
        return {
          found: true,
          chipClasses: chip ? chip.className : null,
          chipText: chip ? chip.textContent?.trim() ?? null : null,
          pipText: pip ? pip.textContent?.trim() ?? null : null,
          html: match.outerHTML,
        };
      }, NPC_DISPLAY_NAME);
      writeJson(`rail-snapshot-${label}.json`, railSnapshot);
      if (!railSnapshot.found) {
        logBlocker(`rail_${label}`, 'rail row for seeded NPC not found');
      } else {
        if (
          !railSnapshot.chipClasses ||
          !railSnapshot.chipClasses.includes('chatlist-band-friendly')
        ) {
          logBlocker(
            `rail_${label}`,
            `rail chip missing friendly variant: ${railSnapshot.chipClasses}`,
          );
        }
        if (railSnapshot.chipText !== 'Friendly') {
          logBlocker(
            `rail_${label}`,
            `rail chip text expected "Friendly", got ${JSON.stringify(railSnapshot.chipText)}`,
          );
        }
        if (railSnapshot.html.toLowerCase().includes(PRIVATE_STATUS_KIND)) {
          logBlocker(
            `rail_${label}`,
            `rail HTML contains private status kind '${PRIVATE_STATUS_KIND}'`,
          );
        }
        if (railSnapshot.html.toLowerCase().includes(PRIVATE_STATUS_VALUE)) {
          logBlocker(
            `rail_${label}`,
            `rail HTML contains private status value '${PRIVATE_STATUS_VALUE}'`,
          );
        }
      }

      // City map.
      await page.evaluate(() => {
        const channels = Array.from(
          document.querySelectorAll('.chatlist .channel-row'),
        );
        (channels[0] as HTMLButtonElement | undefined)?.click();
      });
      await page.waitForSelector('.city-map-modal', {timeout: 8000});
      await page.waitForTimeout(200);
      await page.screenshot({
        path: path.join(screenshots, `city-map-${label}.png`),
        fullPage: true,
      });
      const mapSnapshot = await page.evaluate((name) => {
        const rows = Array.from(document.querySelectorAll('.city-map-npc-row'));
        const match = rows.find((r) => r.textContent?.includes(name));
        if (!match) return {found: false, html: ''};
        const band = match.querySelector('.city-map-npc-band');
        return {
          found: true,
          bandClasses: band ? band.className : null,
          bandText: band ? band.textContent?.trim() ?? null : null,
          html: match.outerHTML,
        };
      }, NPC_DISPLAY_NAME);
      writeJson(`city-map-snapshot-${label}.json`, mapSnapshot);
      if (!mapSnapshot.found) {
        logBlocker(`city_map_${label}`, 'city-map "Here now" row not found');
      } else {
        if (mapSnapshot.bandText !== 'Friendly') {
          logBlocker(
            `city_map_${label}`,
            `city-map band text expected "Friendly", got ${JSON.stringify(mapSnapshot.bandText)}`,
          );
        }
        if (
          !mapSnapshot.bandClasses ||
          !mapSnapshot.bandClasses.includes('city-map-band-friendly')
        ) {
          logBlocker(
            `city_map_${label}`,
            `city-map chip missing friendly variant: ${mapSnapshot.bandClasses}`,
          );
        }
        if (mapSnapshot.html.toLowerCase().includes(PRIVATE_STATUS_KIND)) {
          logBlocker(
            `city_map_${label}`,
            `city-map HTML contains private status kind '${PRIVATE_STATUS_KIND}'`,
          );
        }
        if (mapSnapshot.html.toLowerCase().includes(PRIVATE_STATUS_VALUE)) {
          logBlocker(
            `city_map_${label}`,
            `city-map HTML contains private status value '${PRIVATE_STATUS_VALUE}'`,
          );
        }
      }
      await page.evaluate(() => {
        const close = document.querySelector(
          '.city-map-close',
        ) as HTMLButtonElement | null;
        close?.click();
      });
      await page.waitForTimeout(200);

      // NPC profile.
      await page.evaluate((name) => {
        const rows = Array.from(
          document.querySelectorAll('.chatlist .contact-row'),
        );
        const match = rows.find((r) => r.textContent?.includes(name));
        (match as HTMLButtonElement | undefined)?.click();
      }, NPC_DISPLAY_NAME);
      await page.waitForSelector('.npc-profile-modal', {timeout: 8000});
      await page.waitForTimeout(150);
      await page.screenshot({
        path: path.join(screenshots, `npc-profile-${label}.png`),
        fullPage: true,
      });
      const profileSnapshot = await page.evaluate(() => {
        const modal = document.querySelector('.npc-profile-modal');
        if (!modal) {
          return {
            found: false,
            bandClasses: null as string | null,
            bandText: null as string | null,
            badges: [] as Array<{kind: string | null; value: string | null}>,
            html: '',
          };
        }
        const presence = modal.querySelector('.npc-profile-presence');
        const band = modal.querySelector('.npc-profile-band');
        const badges = Array.from(
          modal.querySelectorAll('.npc-profile-status-badge'),
        ).map((b) => ({
          kind:
            b.querySelector('.npc-profile-status-kind')?.textContent?.trim() ??
            null,
          value:
            b.querySelector('.npc-profile-status-value')?.textContent?.trim() ??
            null,
        }));
        return {
          found: presence != null,
          bandClasses: band ? band.className : null,
          bandText: band ? band.textContent?.trim() ?? null : null,
          badges,
          html: modal.outerHTML,
        };
      });
      writeJson(`npc-profile-snapshot-${label}.json`, profileSnapshot);
      if (!profileSnapshot.found) {
        logBlocker(
          `npc_profile_${label}`,
          'npc-profile-presence block did not render',
        );
      } else {
        if (profileSnapshot.bandText !== 'Friendly') {
          logBlocker(
            `npc_profile_${label}`,
            `npc-profile band expected "Friendly", got ${JSON.stringify(profileSnapshot.bandText)}`,
          );
        }
        const profileKinds = profileSnapshot.badges.map((b) => b.kind);
        if (!profileKinds.includes(PUBLIC_STATUS_KIND)) {
          logBlocker(
            `npc_profile_${label}`,
            `npc-profile missing public status badge '${PUBLIC_STATUS_KIND}'`,
          );
        }
        if (profileKinds.includes(PRIVATE_STATUS_KIND)) {
          logBlocker(
            `npc_profile_${label}`,
            `npc-profile LEAKED private status kind '${PRIVATE_STATUS_KIND}'`,
          );
        }
        if (profileSnapshot.html.toLowerCase().includes(PRIVATE_STATUS_VALUE)) {
          logBlocker(
            `npc_profile_${label}`,
            `npc-profile HTML contains private status value '${PRIVATE_STATUS_VALUE}'`,
          );
        }
      }
      await page.evaluate(() => {
        const close = document.querySelector(
          '.npc-profile-modal .modal-close',
        ) as HTMLButtonElement | null;
        close?.click();
      });
      await page.waitForTimeout(150);
    }

    try {
      await page.goto(base, {waitUntil: 'domcontentloaded', timeout: 20000});
      await bootIntoApp();
      await page.screenshot({
        path: path.join(screenshots, 'ui-loaded.png'),
        fullPage: true,
      });

      // Living-world presence proof (seed).
      await capturePresence('seed');

      // ── Inventory (I) ───────────────────────────────────────
      await openSurfaceViaMenu('I');
      await page.waitForSelector('.inventory-surface', {timeout: 10000});
      await page.evaluate((targetName: string) => {
        const rows = Array.from(
          document.querySelectorAll('.inventory-bag-row'),
        ) as HTMLButtonElement[];
        const row = rows.find((r) => r.textContent?.includes(targetName));
        row?.click();
      }, ITEM_NAME);
      await page.waitForSelector('.inventory-detail-action-btn.action-equip', {
        timeout: 8000,
      });
      await page.screenshot({
        path: path.join(screenshots, 'inventory.png'),
        fullPage: true,
      });
      await page.evaluate(() => {
        const btn = document.querySelector(
          '.inventory-detail-action-btn.action-equip',
        ) as HTMLButtonElement | null;
        btn?.click();
      });
      await page.waitForFunction(
        (targetName: string) => {
          const rows = Array.from(
            document.querySelectorAll('.inventory-bag-row.equipped'),
          );
          for (const r of rows) {
            if (r.textContent?.includes(targetName)) return true;
          }
          return false;
        },
        ITEM_NAME,
        {timeout: 8000},
      );
      const invEquipped = await getJson<InventoryMinSnapshot>(
        `${base}/api/player/${playerId}/inventory`,
      );
      writeJson('inventory-equip.json', invEquipped.body);
      if (!invEquipped.body?.items.find((i) => i.name === ITEM_NAME)?.equipped) {
        logBlocker(
          'inventory_equip',
          'inventory item not equipped on backend after click',
        );
      }
      await page.screenshot({
        path: path.join(screenshots, 'inventory-equipped.png'),
        fullPage: true,
      });
      await closeActiveSurface();

      // ── Quest Dashboard (Q) ─────────────────────────────────
      await openSurfaceViaMenu('Q');
      await page.waitForSelector('.quest-dashboard', {timeout: 10000});
      const questText = await page.evaluate((title: string) => {
        const root = document.querySelector('.quest-dashboard');
        return root ? root.textContent?.includes(title) === true : false;
      }, QUEST_TITLE);
      if (!questText) {
        logBlocker(
          'quest_dashboard_render',
          'Quest Dashboard rendered but seeded quest title missing',
        );
      }
      await page.screenshot({
        path: path.join(screenshots, 'quest.png'),
        fullPage: true,
      });
      await liveOps(
        playerId,
        sessionId,
        [
          {
            type: 'emit_gui_event',
            eventType: 'quest:auto_advanced',
            payload: {
              questEntityId,
              questId: questEntityId,
              questName: QUEST_TITLE,
              reason: 'Living-World smoke refresh proof',
            },
          },
        ],
        'quest_auto_advanced',
      );
      await page.waitForFunction(
        (questName: string) => {
          const root = document.querySelector('.quest-dashboard');
          if (!root) return false;
          return (root.textContent ?? '').includes(questName);
        },
        QUEST_TITLE,
        {timeout: 5000},
      );
      const questAfterEmit = await getJson<QuestSnapshot>(
        `${base}/api/player/${playerId}/quest-dashboard?language=en`,
      );
      writeJson('quest-dashboard-emit.json', questAfterEmit.body);
      if (
        !questAfterEmit.body?.recentEvents.find(
          (e) => e.type === 'quest:auto_advanced',
        )
      ) {
        logBlocker(
          'quest_auto_advanced',
          'quest:auto_advanced not visible in quest-dashboard recentEvents',
        );
      }
      await page.screenshot({
        path: path.join(screenshots, 'quest-refreshed.png'),
        fullPage: true,
      });
      await closeActiveSurface();

      // ── Notice Journal (J) ──────────────────────────────────
      await openSurfaceViaMenu('J');
      await page.waitForSelector('.notice-journal', {timeout: 10000});
      const journalSeeded = await page.evaluate(() => {
        return document.querySelectorAll('.notice-journal-row').length > 0;
      });
      if (!journalSeeded) {
        logBlocker(
          'notice_journal_render',
          'notice journal rendered with zero rows after seed',
        );
      }
      await page.screenshot({
        path: path.join(screenshots, 'journal.png'),
        fullPage: true,
      });
      const journalEmitTitle = 'Living-World live refresh proof';
      await liveOps(
        playerId,
        sessionId,
        [
          {
            type: 'emit_gui_event',
            eventType: 'quest:auto_advanced',
            payload: {
              questId: 99003,
              title: journalEmitTitle,
              summary: 'Fired with journal open.',
            },
          },
        ],
        'notice_live_emit',
      );
      await page.waitForFunction(
        (title: string) => {
          const titles = Array.from(
            document.querySelectorAll('.notice-journal-title'),
          ).map((el) => el.textContent ?? '');
          return titles.some((t) => t.includes(title));
        },
        journalEmitTitle,
        {timeout: 8000},
      );
      const noticeAfterEmit = await getJson<NoticeSnapshot>(
        `${base}/api/player/${playerId}/notices?limit=10`,
      );
      writeJson('notices-emit.json', noticeAfterEmit.body);
      await page.screenshot({
        path: path.join(screenshots, 'journal-refreshed.png'),
        fullPage: true,
      });
      await closeActiveSurface();

      // ── Character State (P) ─────────────────────────────────
      await openSurfaceViaMenu('P');
      await page.waitForSelector('.character-state', {timeout: 10000});
      await page.screenshot({
        path: path.join(screenshots, 'character.png'),
        fullPage: true,
      });
      await page.evaluate(() => {
        const tabs = Array.from(
          document.querySelectorAll('.character-state-tab'),
        ) as HTMLButtonElement[];
        const t = tabs.find((b) => b.textContent?.trim() === 'Attributes');
        t?.click();
      });
      await page.waitForSelector('.character-state-attribute', {timeout: 5000});
      await page.evaluate((statKey: string) => {
        const rows = Array.from(
          document.querySelectorAll('.character-state-attribute'),
        );
        for (const row of rows) {
          const keyEl = row.querySelector(
            '.character-state-attribute-key',
          ) as HTMLElement | null;
          if (keyEl?.textContent?.trim() === statKey) {
            const btn = row.querySelector(
              '.action-spend-stat',
            ) as HTMLButtonElement | null;
            btn?.click();
            return;
          }
        }
      }, STAT_KEY);
      await page.waitForFunction(
        (params: {statKey: string; before: number}) => {
          const rows = Array.from(
            document.querySelectorAll('.character-state-attribute'),
          );
          for (const row of rows) {
            const keyEl = row.querySelector(
              '.character-state-attribute-key',
            ) as HTMLElement | null;
            if (keyEl?.textContent?.trim() === params.statKey) {
              const currentEl = row.querySelector(
                '.character-state-attribute-current',
              ) as HTMLElement | null;
              return (
                Number(currentEl?.textContent?.trim() ?? '0') > params.before
              );
            }
          }
          return false;
        },
        {statKey: STAT_KEY, before: baselineStat},
        {timeout: 8000},
      );
      const charActions = await getJson<CharacterSnapshot>(
        `${base}/api/player/${playerId}/character-state`,
      );
      writeJson('character-state-actions.json', charActions.body);
      const statRow = charActions.body?.stats.find((s) => s.key === STAT_KEY);
      if (!statRow || statRow.current <= baselineStat) {
        logBlocker(
          'character_spend_stat',
          `STR did not increase: before=${baselineStat} after=${statRow?.current}`,
        );
      }
      stepsSummary.statAfter = statRow?.current;
      await page.screenshot({
        path: path.join(screenshots, 'character-after-spend.png'),
        fullPage: true,
      });
      await closeActiveSurface();

      // ── Hard reload ─────────────────────────────────────────
      await page.reload({waitUntil: 'domcontentloaded'});
      await bootIntoApp();

      // Presence after reload (HARD).
      await capturePresence('reload');

      const locReload = await getJson<LocationsView>(
        `${base}/api/session/${encodeURIComponent(sessionId)}/locations?playerId=${playerId}`,
      );
      writeJson('locations-api-reload.json', locReload.body);
      const reloadedNearby = locReload.body?.nearby.find((n) => n.id === npcId);
      if (reloadedNearby?.relationship?.band !== 'friendly') {
        logBlocker(
          'locations_api_reload',
          `expected friendly band; got ${JSON.stringify(reloadedNearby?.relationship)}`,
        );
      }
      if (locReload.raw.includes(PRIVATE_STATUS_VALUE)) {
        logBlocker(
          'locations_api_reload',
          `private status value '${PRIVATE_STATUS_VALUE}' LEAKED through API`,
        );
      }

      // Inventory persists.
      await openSurfaceViaMenu('I');
      await page.waitForSelector('.inventory-surface', {timeout: 10000});
      await page.waitForFunction(
        (targetName: string) => {
          const rows = Array.from(
            document.querySelectorAll('.inventory-bag-row.equipped'),
          );
          for (const r of rows) {
            if (r.textContent?.includes(targetName)) return true;
          }
          return false;
        },
        ITEM_NAME,
        {timeout: 8000},
      );
      const invReload = await getJson<InventoryMinSnapshot>(
        `${base}/api/player/${playerId}/inventory`,
      );
      writeJson('inventory-reload.json', invReload.body);
      await page.screenshot({
        path: path.join(screenshots, 'inventory-reload.png'),
        fullPage: true,
      });
      await closeActiveSurface();

      // Quest persists.
      await openSurfaceViaMenu('Q');
      await page.waitForSelector('.quest-dashboard', {timeout: 10000});
      const reloadQuestText = await page.evaluate((title: string) => {
        const root = document.querySelector('.quest-dashboard');
        return root ? root.textContent?.includes(title) === true : false;
      }, QUEST_TITLE);
      if (!reloadQuestText) {
        logBlocker('quest_reload', 'Quest title missing after reload');
      }
      const questReload = await getJson<QuestSnapshot>(
        `${base}/api/player/${playerId}/quest-dashboard?language=en`,
      );
      writeJson('quest-dashboard-reload.json', questReload.body);
      await page.screenshot({
        path: path.join(screenshots, 'quest-reload.png'),
        fullPage: true,
      });
      await closeActiveSurface();

      // Notices persist.
      await openSurfaceViaMenu('J');
      await page.waitForSelector('.notice-journal', {timeout: 10000});
      await page.waitForFunction(
        () => document.querySelectorAll('.notice-journal-row').length > 0,
        undefined,
        {timeout: 8000},
      );
      const noticeReload = await getJson<NoticeSnapshot>(
        `${base}/api/player/${playerId}/notices?limit=10`,
      );
      writeJson('notices-reload.json', noticeReload.body);
      await page.screenshot({
        path: path.join(screenshots, 'journal-reload.png'),
        fullPage: true,
      });
      await closeActiveSurface();

      // Character persists.
      await openSurfaceViaMenu('P');
      await page.waitForSelector('.character-state', {timeout: 10000});
      const charReload = await getJson<CharacterSnapshot>(
        `${base}/api/player/${playerId}/character-state`,
      );
      writeJson('character-state-reload.json', charReload.body);
      const reloadStat = charReload.body?.stats.find((s) => s.key === STAT_KEY);
      if (!reloadStat || reloadStat.current <= baselineStat) {
        logBlocker(
          'character_reload',
          'STR bump did not persist across reload',
        );
      }
      await page.screenshot({
        path: path.join(screenshots, 'character-reload.png'),
        fullPage: true,
      });
      await closeActiveSurface();

      // ── Whole-document leak guard ───────────────────────────
      const docLeak = await page.evaluate(
        ({privateKind, privateValue}) => {
          const body = document.body?.innerText ?? '';
          return {
            hasKind: body.toLowerCase().includes(privateKind),
            hasValue: body.toLowerCase().includes(privateValue),
          };
        },
        {privateKind: PRIVATE_STATUS_KIND, privateValue: PRIVATE_STATUS_VALUE},
      );
      stepsSummary.docLeak = docLeak;
      if (docLeak.hasKind) {
        logBlocker(
          'doc_leak',
          `document body contains private status kind '${PRIVATE_STATUS_KIND}'`,
        );
      }
      if (docLeak.hasValue) {
        logBlocker(
          'doc_leak',
          `document body contains private status value '${PRIVATE_STATUS_VALUE}'`,
        );
      }

      teardownStarted = true;
      const unexpectedConsoleErrors = consoleErrors.filter((e) => {
        const t = e.text.toLowerCase();
        return !(
          t.includes('failed to load resource') ||
          t.includes('the server responded with a status of 404') ||
          t.includes('eventsource') ||
          t.includes('failed to fetch')
        );
      });
      const unexpectedServerErrors = serverErrors.filter((e) => {
        if (e.status === 404 && /\.(mp3|png|svg|ico)(\?|$)/.test(e.url)) {
          return false;
        }
        return true;
      });
      const unexpectedFailedRequests = failedRequests.filter((r) => {
        if (/\.(mp3|png|svg|ico)(\?|$)/.test(r.url)) return false;
        if (
          r.failure === 'net::ERR_ABORTED' &&
          /\/api\/session\/[^/]+\/stream/.test(r.url)
        ) {
          return false;
        }
        return true;
      });
      stepsSummary.consoleErrors = consoleErrors.length;
      stepsSummary.serverErrors = serverErrors.length;
      stepsSummary.failedRequests = failedRequests.length;
      stepsSummary.unexpectedConsoleErrors = unexpectedConsoleErrors.length;
      stepsSummary.unexpectedServerErrors = unexpectedServerErrors.length;
      stepsSummary.unexpectedFailedRequests = unexpectedFailedRequests.length;
      if (unexpectedConsoleErrors.length > 0) {
        logBlocker(
          'browser_health',
          `unexpected browser console errors: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 5))}`,
        );
      }
      if (unexpectedServerErrors.length > 0) {
        logBlocker(
          'browser_health',
          `unexpected 4xx/5xx responses: ${JSON.stringify(unexpectedServerErrors.slice(0, 5))}`,
        );
      }
      if (unexpectedFailedRequests.length > 0) {
        logBlocker(
          'browser_health',
          `unexpected failed requests: ${JSON.stringify(unexpectedFailedRequests.slice(0, 5))}`,
        );
      }
    } catch (err) {
      logBlocker(
        'playwright_flow',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      await context.close();
      await browser.close();
    }

    if (sseClient) {
      try {
        (sseClient as AbortController).abort();
      } catch {
        // ignore
      }
    }
    await Promise.race([sseDone, new Promise((r) => setTimeout(r, 300))]);

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
      console.error('[living-world-smoke] FATAL', err);
      process.exit(1);
    },
  );
}

export {main as runLivingWorldCrossSurfaceSmoke};
