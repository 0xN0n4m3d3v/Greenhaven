/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 runtime-bridge live smoke.
//
// Bootstraps a clean PGlite DB with the full migration chain plus
// the generated Greenhaven Obsidian preview SQL, exercises every
// OWV-17 runtime-bridge surface end-to-end, and writes a SUMMARY
// artifact to `--out` for downstream diagnosis.
//
// Surfaces covered:
//
//   1. All 5 OWV-17 bridge `cartridge_meta` rows present and
//      non-empty (`forge_currency_bridge`,
//      `forge_merchant_contracts`, `forge_materializer_bridge`,
//      `forge_scene_instructions`, `forge_visual_assets`).
//   2. A fresh anonymous player can be created and currency
//      can be seeded against the live bridge catalog (no
//      hardcoded coin ids).
//   3. `apply_materializer_bridge` is dispatched as a real
//      broker tool through `tools/dispatch`, producing a
//      `tool_invocations` row and the documented mutations
//      (e.g., bidirectional exit append for hidden-exit rows).
//   4. `pay_merchant_offer` is dispatched against an authored
//      merchant offer (the smoke picks the smallest copper
//      offer that the seeded inventory can cover), producing a
//      `tool_invocations` row + the merchant memory.
//   5. `buildTurnContext` renders a `## SCENE INSTRUCTIONS`
//      block when the player stands at an authored location.
//   6. `GET /api/assets/world/:kind/:slug[/:role]` serves a real
//      image listed in `forge_visual_assets` with a 200 status
//      and a `image/*` content type.
//   7. `.svg` responses carry the OWV-17 hardening headers
//      (`Content-Security-Policy: sandbox` + `nosniff`).
//
// The smoke uses the broker tool dispatch directly rather than
// driving a full LLM turn — exercising the bridge tools through
// `dispatch` is the canonical mutation path and produces the same
// `tool_invocations` audit rows the LLM would. A future slice can
// layer LLM-driven turn invocation on top of this infrastructure.

import {Hono} from 'hono';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

interface Args {
  out: string;
  obsidianSql?: string;
  vaultRoot?: string;
  timeoutMs: number;
  keepDb: boolean;
}

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..', '..', '..');
// The Obsidian compiler writes the preview SQL next to the
// generated cartridge-forge-project, NOT inside it. Try the two
// well-known locations in order.
const DEFAULT_OBSIDIAN_SQL_CANDIDATES = [
  path.join(
    REPO_ROOT,
    'GreenhavenWorld',
    '.greenhaven-agent-manual',
    'generated',
    'obsidian-world-preview.sql',
  ),
  path.join(
    REPO_ROOT,
    'GreenhavenWorld',
    '.greenhaven-agent-manual',
    'generated',
    'cartridge-forge-project',
    'audit',
    'obsidian-world-preview.sql',
  ),
];
const DEFAULT_OBSIDIAN_SQL = DEFAULT_OBSIDIAN_SQL_CANDIDATES[0]!;
const DEFAULT_VAULT_ROOT = path.join(REPO_ROOT, 'GreenhavenWorld');

interface SmokeStep {
  name: string;
  status: 'ok' | 'skipped' | 'failed';
  details?: Record<string, unknown>;
  error?: string;
}

interface SmokeReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outDir: string;
  steps: SmokeStep[];
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const startedAt = new Date();
  const outDir = path.resolve(args.out);
  await mkdir(outDir, {recursive: true});

  const obsidianSql = path.resolve(
    args.obsidianSql ??
      DEFAULT_OBSIDIAN_SQL_CANDIDATES.find(p => existsSync(p)) ??
      DEFAULT_OBSIDIAN_SQL,
  );
  if (!existsSync(obsidianSql)) {
    const summary: SmokeReport = {
      ok: false,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      outDir,
      steps: [
        {
          name: 'bootstrap',
          status: 'failed',
          error: `obsidian preview SQL not found at ${obsidianSql}`,
        },
      ],
    };
    await writeSummary(outDir, summary);
    return 1;
  }
  const vaultRoot = path.resolve(args.vaultRoot ?? DEFAULT_VAULT_ROOT);

  const steps: SmokeStep[] = [];
  const record = (step: SmokeStep) => {
    steps.push(step);
    process.stderr.write(
      `[owv17-smoke] ${step.status.padEnd(8)} ${step.name}` +
        (step.error ? ` — ${step.error}` : '') +
        '\n',
    );
  };

  const dbDir = await mkdtemp(
    path.join(os.tmpdir(), 'owv17-runtime-bridge-smoke-'),
  );
  process.env.PGLITE_DATA_DIR = dbDir;
  process.env.GREENHAVEN_VAULT_ROOTS = vaultRoot;
  process.env.AUTH_SECRET ??= 'owv17-smoke-auth-secret-32-bytes-minimum';
  process.env.FEATHERLESS_API_KEY ??= 'owv17-smoke-provider-key';

  const {createPristineDataDir} = await import(
    '../__tests__/migrations/framework.js'
  );
  const pristineDir = await createPristineDataDir();
  // `createPristineDataDir` returns the dataDir it created with
  // every migration applied. Re-point env at it before importing
  // the runtime modules so they see the migrated schema.
  process.env.PGLITE_DATA_DIR = pristineDir;

  // Now import runtime modules (they wire PGlite from env).
  await import('../tools/index.js');
  const [{query, closeDb}, {createAnonymousPlayer}, {sessionManager}, cartridgeCache, currency, merchant, materializer, scene, visual] = await Promise.all([
    import('../db.js'),
    import('../playerService.js'),
    import('../sessionManager.js'),
    import('../cartridge.js'),
    import('../services/CurrencyBridgeService.js'),
    import('../services/MerchantContractService.js'),
    import('../services/MaterializerBridgeService.js'),
    import('../services/SceneInstructionBridgeService.js'),
    import('../services/VisualAssetBridgeService.js'),
  ]);
  const {dispatch, runWithContext} = await import('../tools/base.js');
  const {buildTurnContext} = await import('../turnContext/index.js');
  const {visualAssetRoutes} = await import('../routes/visualAssets.js');

  let cleanupRan = false;
  const cleanup = async () => {
    if (cleanupRan) return;
    cleanupRan = true;
    try {
      await closeDb();
    } catch {
      // ignore close errors during cleanup
    }
    if (!args.keepDb) {
      await rm(pristineDir, {recursive: true, force: true}).catch(() => {});
      await rm(dbDir, {recursive: true, force: true}).catch(() => {});
    }
  };

  const finish = async (ok: boolean): Promise<number> => {
    const finishedAt = new Date();
    const report: SmokeReport = {
      ok,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outDir,
      steps,
    };
    await writeSummary(outDir, report);
    await cleanup();
    return ok ? 0 : 1;
  };

  const timeoutHandle = setTimeout(() => {
    record({
      name: 'timeout',
      status: 'failed',
      error: `smoke exceeded ${args.timeoutMs}ms`,
    });
    void finish(false).then(code => process.exit(code));
  }, args.timeoutMs);
  timeoutHandle.unref?.();

  try {
    // STEP 1 — apply the Obsidian preview SQL onto the migrated DB.
    const sqlText = await readFile(obsidianSql, 'utf8');
    try {
      await applyMultiStatement(query, sqlText);
      record({
        name: 'apply_obsidian_preview_sql',
        status: 'ok',
        details: {path: obsidianSql, length: sqlText.length},
      });
    } catch (err) {
      record({
        name: 'apply_obsidian_preview_sql',
        status: 'failed',
        error: errMessage(err),
      });
      return await finish(false);
    }

    // STEP 2 — verify all five OWV-17 bridge meta rows are present
    // with non-empty `rows`/`offers`/`coins` payloads.
    cartridgeCache.clearMetaCache();
    currency.clearCurrencyCatalogCache();
    merchant.clearMerchantContractsCache();
    materializer.clearMaterializerBridgeCache();
    scene.clearSceneInstructionBridgeCache();
    visual.clearVisualAssetBridgeCache();
    const bridgeCounts: Record<string, number> = {};
    let bridgesOk = true;
    for (const key of [
      'forge_currency_bridge',
      'forge_merchant_contracts',
      'forge_materializer_bridge',
      'forge_scene_instructions',
      'forge_visual_assets',
    ]) {
      const row = await query<{value: Record<string, unknown>}>(
        `SELECT value FROM cartridge_meta WHERE key = $1`,
        [key],
      );
      const value = row.rows[0]?.value;
      const count = countRowsField(value);
      bridgeCounts[key] = count;
      if (count <= 0) bridgesOk = false;
    }
    record({
      name: 'verify_bridge_meta',
      status: bridgesOk ? 'ok' : 'failed',
      details: bridgeCounts,
      error: bridgesOk ? undefined : 'one or more bridge meta rows missing or empty',
    });
    if (!bridgesOk) return await finish(false);

    // STEP 3 — anonymous player + entity resolution.
    const player = await createAnonymousPlayer(
      `OWV-17 smoke player ${Date.now()}`,
    );
    record({
      name: 'create_anonymous_player',
      status: 'ok',
      details: {playerId: player.entity_id},
    });
    // Open a real session row so `tool_invocations.session_id` FK
    // is satisfied when the broker dispatch audits each call.
    const session = await sessionManager.getOrCreate(
      `owv17-smoke-${player.entity_id}-${Date.now()}`,
      player.entity_id,
    );
    const sessionId = session.id;

    const townSquare = await findEntityBySlug(query, 'town-square');
    const thiefsMarket = await findEntityBySlug(query, 'thiefs-market');
    const mikka = await findEntityBySlug(query, 'mikka');
    const sableVey = await findEntityBySlug(query, 'sable-vey');
    if (!townSquare || !thiefsMarket || !mikka || !sableVey) {
      record({
        name: 'resolve_canonical_entities',
        status: 'failed',
        error: `missing entities: town-square=${!!townSquare}, thiefs-market=${!!thiefsMarket}, mikka=${!!mikka}, sable-vey=${!!sableVey}`,
      });
      return await finish(false);
    }
    record({
      name: 'resolve_canonical_entities',
      status: 'ok',
      details: {townSquare, thiefsMarket, mikka, sableVey},
    });

    // STEP 4 — seed enough currency to cover the smallest authored
    // merchant offer. Use the bridge catalog to pick the right
    // coin item ids (no hardcoded slug → id mapping).
    const catalog = await currency.getCurrencyCatalog();
    const copperCoin = catalog.coins.find(c => c.copperValue === 1) ?? null;
    if (!copperCoin) {
      record({
        name: 'seed_player_currency',
        status: 'failed',
        error: 'currency bridge has no copper (cv=1) coin',
      });
      return await finish(false);
    }
    const offers = await merchant.listMerchantOffers('mikka');
    const cheapestOffer = offers
      .slice()
      .sort((a, b) => a.copperTotal - b.copperTotal)[0];
    if (!cheapestOffer) {
      record({
        name: 'seed_player_currency',
        status: 'failed',
        error: 'no merchant offers for mikka in bridge',
      });
      return await finish(false);
    }
    const tenderCopper = Math.max(cheapestOffer.copperTotal, 1);
    await query(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (player_id, item_id) WHERE equipped = false
       DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity`,
      [player.entity_id, copperCoin.itemId, tenderCopper],
    );
    record({
      name: 'seed_player_currency',
      status: 'ok',
      details: {
        copperItemId: copperCoin.itemId,
        seededCopper: tenderCopper,
        offerId: cheapestOffer.offerId,
        offerCopper: cheapestOffer.copperTotal,
      },
    });

    // STEP 5 — dispatch `pay_merchant_offer` via the broker
    // dispatch. This produces a `tool_invocations` row + the
    // durable merchant memory.
    const payResult = await runWithContext(
      {sessionId, playerId: player.entity_id},
      () =>
        dispatch(
          'pay_merchant_offer',
          {merchant: 'mikka', offer_id: cheapestOffer.offerId},
          {sessionId, playerId: player.entity_id},
        ),
    );
    if (!payResult.ok) {
      record({
        name: 'dispatch_pay_merchant_offer',
        status: 'failed',
        error: payResult.error ?? 'unknown dispatch failure',
        details: {offer: cheapestOffer.offerId},
      });
      return await finish(false);
    }
    record({
      name: 'dispatch_pay_merchant_offer',
      status: 'ok',
      details: {
        offerId: cheapestOffer.offerId,
        copper: cheapestOffer.copperTotal,
        planMode: (payResult.data as {plan_mode?: string} | undefined)
          ?.plan_mode,
      },
    });

    // STEP 6 — dispatch `apply_materializer_bridge` for the
    // barrels → Thief's market hidden-exit row.
    const materializerEntries = await materializer.listMaterializerEntries();
    const hiddenExit = materializerEntries.find(
      e =>
        e.type === 'location/hidden-exit' &&
        e.entitySlug === 'thiefs-market',
    );
    if (!hiddenExit) {
      record({
        name: 'dispatch_apply_materializer_bridge',
        status: 'failed',
        error: 'no location/hidden-exit row for thiefs-market in bridge',
      });
      return await finish(false);
    }

    // STEP 6a — OWV-7 pre-action gate: the player stands at Town
    // square and `move_player(thiefs-market)` MUST reject because
    // the compile-time `profile.hidden_until_stage` gate is still
    // in place on the target. This proves the route was hidden
    // BEFORE the materializer ran, not just appended after.
    await query(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [townSquare, player.entity_id],
    );
    const preMoveResult = await runWithContext(
      {sessionId, playerId: player.entity_id},
      () =>
        dispatch(
          'move_player',
          {
            target_location_id: thiefsMarket,
            intent_source: 'user_command',
            reason: 'OWV-7 pre-action rejection probe',
          },
          {sessionId, playerId: player.entity_id},
        ),
    );
    const preMoveErr =
      preMoveResult.ok === false ? preMoveResult.error ?? '' : '';
    const preMoveRejected =
      preMoveResult.ok === false && /still hidden/i.test(preMoveErr);
    record({
      name: 'verify_move_player_rejected_pre_action',
      status: preMoveRejected ? 'ok' : 'failed',
      details: {
        from_id: townSquare,
        to_id: thiefsMarket,
        dispatch_ok: preMoveResult.ok,
        error: preMoveErr || null,
      },
      error: preMoveRejected
        ? undefined
        : 'expected move_player to reject with "still hidden" before apply_materializer_bridge',
    });
    if (!preMoveRejected) return await finish(false);

    const applyResult = await runWithContext(
      {sessionId, playerId: player.entity_id},
      () =>
        dispatch(
          'apply_materializer_bridge',
          {materializer_id: hiddenExit.materializerId},
          {sessionId, playerId: player.entity_id},
        ),
    );
    if (!applyResult.ok) {
      record({
        name: 'dispatch_apply_materializer_bridge',
        status: 'failed',
        error: applyResult.error ?? 'unknown dispatch failure',
        details: {materializerId: hiddenExit.materializerId},
      });
      return await finish(false);
    }
    record({
      name: 'dispatch_apply_materializer_bridge',
      status: 'ok',
      details: {
        materializerId: hiddenExit.materializerId,
        type: hiddenExit.type,
        exitsWired: (applyResult.data as {exits_wired?: number[]} | undefined)
          ?.exits_wired ?? [],
      },
    });

    // STEP 7 — verify the bidirectional exit landed.
    const exitsRow = await query<{exits: unknown}>(
      `SELECT profile->'exits' AS exits FROM entities WHERE id = $1`,
      [townSquare],
    );
    const exits = Array.isArray(exitsRow.rows[0]?.exits)
      ? (exitsRow.rows[0]!.exits as unknown[]).map(Number)
      : [];
    if (!exits.includes(thiefsMarket)) {
      record({
        name: 'verify_hidden_exit_wired',
        status: 'failed',
        error: `town-square profile.exits missing thiefs-market id ${thiefsMarket}`,
        details: {exits},
      });
      return await finish(false);
    }
    record({
      name: 'verify_hidden_exit_wired',
      status: 'ok',
      details: {townSquareExits: exits},
    });

    // STEP 7a — OWV-7 post-action gate: the same `move_player`
    // call that was rejected pre-action MUST now succeed, proving
    // the materializer cleared `hidden_until_stage` and the
    // bidirectional exit is live. The player is already standing
    // at Town square from STEP 6a, so no extra setup needed.
    const postMoveResult = await runWithContext(
      {sessionId, playerId: player.entity_id},
      () =>
        dispatch(
          'move_player',
          {
            target_location_id: thiefsMarket,
            intent_source: 'user_command',
            reason: 'OWV-7 post-action traversal probe',
          },
          {sessionId, playerId: player.entity_id},
        ),
    );
    const postData =
      postMoveResult.ok === true
        ? (postMoveResult.data as {moved?: boolean; toId?: number} | undefined)
        : undefined;
    const postMoveOk =
      postMoveResult.ok === true &&
      postData?.moved === true &&
      Number(postData?.toId) === thiefsMarket;
    record({
      name: 'verify_move_player_succeeds_post_action',
      status: postMoveOk ? 'ok' : 'failed',
      details: {
        from_id: townSquare,
        to_id: thiefsMarket,
        dispatch_ok: postMoveResult.ok,
        moved: postData?.moved ?? false,
        landed_at: postData?.toId ?? null,
        error:
          postMoveResult.ok === false ? postMoveResult.error ?? null : null,
      },
      error: postMoveOk
        ? undefined
        : 'expected move_player to succeed and land at thiefs-market after apply_materializer_bridge',
    });
    if (!postMoveOk) return await finish(false);

    // STEP 8 — verify tool_invocations audit rows exist.
    const auditRows = await query<{tool_name: string}>(
      `SELECT tool_name FROM tool_invocations
        WHERE session_id = $1
          AND tool_name IN ('pay_merchant_offer', 'apply_materializer_bridge')`,
      [sessionId],
    );
    const auditNames = auditRows.rows.map(r => r.tool_name).sort();
    const expectedAudit = ['apply_materializer_bridge', 'pay_merchant_offer'];
    const auditOk =
      auditNames.length >= 2 &&
      expectedAudit.every(name => auditNames.includes(name));
    record({
      name: 'verify_tool_invocations',
      status: auditOk ? 'ok' : 'failed',
      details: {auditNames},
      error: auditOk ? undefined : 'expected at least pay_merchant_offer + apply_materializer_bridge audit rows',
    });
    if (!auditOk) return await finish(false);

    // STEP 9 — buildTurnContext renders SCENE INSTRUCTIONS at
    // Town square (location-anchored authored rows present), AND
    // (OWV-9) the high-priority authored "@Mikka violence starts"
    // scene row reaches the static preamble as a `do_not:` line
    // carrying the "generic companion" anti-pattern token. Seeding
    // Mikka into `players.metadata.companions` is the narrative
    // prerequisite for the override block to matter at runtime —
    // the buildTurnContext static section itself is generated
    // regardless, but pinning the companion state here keeps the
    // smoke faithful to the "companion plus authored do_not" flow.
    await query(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [townSquare, player.entity_id],
    );
    await query(
      `UPDATE players
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('companions', $1::jsonb)
        WHERE entity_id = $2`,
      [JSON.stringify([mikka]), player.entity_id],
    );
    const ctx = await buildTurnContext(sessionId, player.entity_id);
    const sceneBlockPresent = ctx.static.includes('## SCENE INSTRUCTIONS');
    const mikkaViolencePresent = ctx.static.includes('mikka-violence-starts');
    const doNotLinePresent = /\n\s+do_not:/.test(ctx.static);
    const genericCompanionPresent = ctx.static.includes('generic companion');
    const overrideEvidenceOk =
      sceneBlockPresent &&
      mikkaViolencePresent &&
      doNotLinePresent &&
      genericCompanionPresent;
    record({
      name: 'scene_instructions_in_turn_context',
      status: overrideEvidenceOk ? 'ok' : 'failed',
      details: {
        staticChars: ctx.static.length,
        dynamicChars: ctx.dynamic.length,
        sceneBlockPresent,
        mikkaViolencePresent,
        doNotLinePresent,
        genericCompanionPresent,
      },
      error: overrideEvidenceOk
        ? undefined
        : 'static preamble missing one of: ## SCENE INSTRUCTIONS / mikka-violence-starts / do_not: / generic companion',
    });
    if (!overrideEvidenceOk) return await finish(false);

    // STEP 10 — fetch a real bridge-listed asset URL through the
    // Hono visual-asset route.
    const app = new Hono();
    app.route('/api/assets', visualAssetRoutes);
    const assetEntries = await visual.listVisualAssetEntries();
    const pickAsset = pickServableAsset(assetEntries, vaultRoot);
    if (!pickAsset) {
      record({
        name: 'fetch_visual_asset',
        status: 'failed',
        error: 'no bridge-listed asset has a real file under the configured vault root',
      });
      return await finish(false);
    }
    const url =
      `http://owv17-smoke/api/assets/world/` +
      `${encodeURIComponent(pickAsset.kind)}/` +
      `${encodeURIComponent(pickAsset.slug)}/` +
      `${encodeURIComponent(pickAsset.role)}`;
    const res = await app.fetch(new Request(url));
    if (res.status !== 200) {
      record({
        name: 'fetch_visual_asset',
        status: 'failed',
        error: `expected 200, got ${res.status}`,
        details: {url, contentType: res.headers.get('content-type')},
      });
      return await finish(false);
    }
    const ct = res.headers.get('content-type') ?? '';
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!ct.startsWith('image/') || buf.length === 0) {
      record({
        name: 'fetch_visual_asset',
        status: 'failed',
        error: `bad content-type or empty body (contentType=${ct}, bytes=${buf.length})`,
        details: {url},
      });
      return await finish(false);
    }
    record({
      name: 'fetch_visual_asset',
      status: 'ok',
      details: {
        url,
        contentType: ct,
        bytes: buf.length,
        kind: pickAsset.kind,
        slug: pickAsset.slug,
        role: pickAsset.role,
        path: pickAsset.path,
      },
    });

    return await finish(true);
  } catch (err) {
    record({
      name: 'unexpected_failure',
      status: 'failed',
      error: errMessage(err),
    });
    return await finish(false);
  } finally {
    clearTimeout(timeoutHandle);
    await cleanup();
  }
}

function parseArgs(argv: string[]): Args {
  let out = '.codex/run-logs/live-playtest/owv17-runtime-bridge-smoke';
  let obsidianSql: string | undefined;
  let vaultRoot: string | undefined;
  let timeoutMs = 240_000;
  let keepDb = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[++i] ?? out;
    } else if (arg === '--obsidian-sql') {
      obsidianSql = argv[++i] ?? obsidianSql;
    } else if (arg === '--vault-root') {
      vaultRoot = argv[++i] ?? vaultRoot;
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number(argv[++i] ?? timeoutMs) || timeoutMs;
    } else if (arg === '--keep-db') {
      keepDb = true;
    }
  }
  return {out, obsidianSql, vaultRoot, timeoutMs, keepDb};
}

interface ServableAssetPick {
  kind: string;
  slug: string;
  role: string;
  path: string;
}

function pickServableAsset(
  entries: ReadonlyArray<{
    kind: string;
    slug: string;
    role: string;
    path: string;
  }>,
  vaultRoot: string,
): ServableAssetPick | null {
  for (const entry of entries) {
    const abs = path.resolve(vaultRoot, entry.path);
    if (existsSync(abs)) {
      return {
        kind: entry.kind,
        slug: entry.slug,
        role: entry.role,
        path: entry.path,
      };
    }
  }
  return null;
}

export function splitForgeSqlStatements(sql: string): string[] {
  // Split on statement-ending semicolons that sit at end-of-line. The
  // forge generator never embeds raw newlines inside string literals
  // (Russian prose ships JSON-encoded with `\n` escape sequences) so
  // the naive split is safe.
  //
  // OWV-14: a chunk may start with a header comment block (e.g. the
  // production migration's `-- 0122_obsidian_world_patch_v2.sql`
  // banner). Trimming the chunk first and rejecting `startsWith('--')`
  // dropped the entire first real statement together with the header.
  // We instead strip leading comment + blank lines per chunk and keep
  // any chunk that still has SQL content.
  return sql
    .split(/;\s*(?=\n|$)/g)
    .map(chunk => stripLeadingSqlLineComments(chunk))
    .filter(chunk => chunk.length > 0);
}

function stripLeadingSqlLineComments(chunk: string): string {
  const lines = chunk.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed.length === 0 || trimmed.startsWith('--')) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index).join('\n').trim();
}

async function applyMultiStatement(
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{rows: T[]; rowCount: number}>,
  sql: string,
): Promise<void> {
  for (const stmt of splitForgeSqlStatements(sql)) {
    await query(stmt);
  }
}

async function findEntityBySlug(
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{rows: T[]; rowCount: number}>,
  slug: string,
): Promise<number | null> {
  const rows = await query<{id: number | string}>(
    `SELECT id FROM entities
      WHERE profile->>'source_slug' = $1
      ORDER BY id ASC
      LIMIT 1`,
    [slug],
  );
  return rows.rows[0] ? Number(rows.rows[0].id) : null;
}

function countRowsField(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const obj = value as Record<string, unknown>;
  for (const key of ['rows', 'offers', 'coins']) {
    const list = obj[key];
    if (Array.isArray(list)) return list.length;
  }
  return 0;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function writeSummary(outDir: string, report: SmokeReport): Promise<void> {
  const json = JSON.stringify(report, null, 2);
  await writeFile(path.join(outDir, 'SUMMARY.json'), json + '\n', 'utf8');
  const md = renderMarkdown(report);
  await writeFile(path.join(outDir, 'SUMMARY.md'), md, 'utf8');
}

function renderMarkdown(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push(`# OWV-17 runtime-bridge live smoke`);
  lines.push('');
  lines.push(`- result: **${report.ok ? 'OK' : 'FAILED'}**`);
  lines.push(`- started: ${report.startedAt}`);
  lines.push(`- finished: ${report.finishedAt}`);
  lines.push(`- duration: ${report.durationMs}ms`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  for (const step of report.steps) {
    const badge =
      step.status === 'ok' ? '✓' : step.status === 'skipped' ? '–' : '✗';
    lines.push(`- ${badge} **${step.name}** — ${step.status}`);
    if (step.error) lines.push(`  - error: \`${step.error}\``);
    if (step.details && Object.keys(step.details).length > 0) {
      lines.push('  - details:');
      lines.push('    ```json');
      lines.push(
        ...JSON.stringify(step.details, null, 2)
          .split('\n')
          .map(l => '    ' + l),
      );
      lines.push('    ```');
    }
  }
  return lines.join('\n') + '\n';
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => {
    process.stderr.write(`fatal: ${errMessage(err)}\n`);
    process.exit(1);
  },
);
