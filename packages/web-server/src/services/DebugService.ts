/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-18 — service ownership for the /api/debug route. Owns
// reset-world, clear-dialogue-partner, synthetic event emit, all
// specialist smoke triggers, and the verify-specialists harness.
// Dynamic imports stay inside the service so provider-heavy modules
// (`agents/*`, `ai/providers`, `resetWorld`, tools) do not load at
// startup unless a debug endpoint is exercised.

import { randomUUID } from 'node:crypto';
import { getDebugAppGlobal } from '../debugAppGlobal.js';
import { listDebugSmokeSpecialists } from '../specialists/index.js';

export interface RouteOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface Verdict {
  spec: number;
  name: string;
  endpoint: string;
  status: 'pass' | 'fail' | 'skipped';
  durationMs: number;
  notes: string;
  rawSnippet?: string;
}

export interface VerifyTest {
  spec: number;
  name: string;
  endpoint: string;
  body: Record<string, unknown>;
  check: (parsed: Record<string, unknown>) => {
    status: 'pass' | 'fail' | 'skipped';
    notes: string;
  };
}

export interface VerifySummary {
  pass: number;
  skipped: number;
  fail: number;
  total: number;
}

type AppFetch = (req: Request) => Promise<Response>;

function ok(body: Record<string, unknown>): RouteOutcome {
  return { status: 200, body };
}

function bad(error: string, extra: Record<string, unknown> = {}): RouteOutcome {
  return { status: 400, body: { error, ...extra } };
}

function liveSessionIdOrSynthetic(entries: Iterable<[string, unknown]>): string {
  const first = [...entries][0];
  return first?.[0] ?? randomUUID();
}

function assertPositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export class DebugService {
  /** POST /api/debug/reset-world — nuke player-derived state. */
  static async resetWorld(): Promise<RouteOutcome> {
    const { resetWorldState } = await import('../resetWorld.js');
    const result = await resetWorldState();
    return ok({
      ok: true,
      counts: result.counts,
      dynamic_entities_removed: result.dynamicEntitiesRemoved,
    });
  }

  /** POST /api/debug/clear-dialogue-partner */
  static async clearDialoguePartner(
    playerIdRaw: string | null | undefined,
  ): Promise<RouteOutcome> {
    const playerId = assertPositiveInt(playerIdRaw);
    if (playerId === null) return bad('playerId required');
    const { query } = await import('../db.js');
    const r = await query(
      `UPDATE players SET dialogue_partner_id = NULL WHERE entity_id = $1`,
      [playerId],
    );
    return ok({ ok: true, playerId, updated: r.rowCount ?? 0 });
  }

  /** POST /api/debug/synth-event — broadcast to every live session. */
  static async emitSyntheticEvent(body: Record<string, unknown>): Promise<RouteOutcome> {
    const { sessionManager } = await import('../sessionManager.js');
    const type = (body['type'] as string) ?? 'memory:added';
    const payload = body['payload'] ?? {
      ownerName: 'Mikka Quickgrin',
      aboutName: 'active player',
      text: 'Тест карточки события — Микка запомнила что бридж работает.',
      importance: 0.9,
      tags: ['debug'],
    };
    let count = 0;
    for (const [, session] of sessionManager.entries()) {
      // SSE-OK: emit outside tx (reason: devtool echo for
      // /api/debug/sse; broadcasts an inert debug payload, no DB
      // row is written).
      session.sse.emit(type, payload);
      count++;
    }
    return ok({ ok: true, type, sessions: count, clients: count });
  }

  /** Spec 39 — Quest Watcher smoke trigger. */
  static async runQuestWatcher(body: Record<string, unknown>): Promise<RouteOutcome> {
    const playerId = assertPositiveInt(body['playerId']);
    if (playerId === null) return bad('playerId required');
    const turnId = String(body['turnId'] ?? `manual-${Date.now()}`);
    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());
    const ctrl = new AbortController();
    const ctx = { sessionId, playerId, turnId, signal: ctrl.signal };

    if (body['forceLLM'] === true) {
      const { runSpecialist } = await import('../agents/base.js');
      const { questWatcherPrompt } = await import(
        '../agents/questWatcherPrompt.js'
      );
      const { z } = await import('zod');
      const schema = z.object({
        decisions: z.array(
          z.object({
            quest_id: z.number().int(),
            action: z.enum(['advance', 'complete', 'no_change']),
            to_stage: z.string().optional(),
            outcome: z.enum(['completed', 'failed']).optional(),
            reason: z.string(),
          }),
        ),
      });
      const result = await runSpecialist(
        {
          name: 'quest_watcher',
          mode: 'async',
          outputSchema: schema,
          timeoutMs: 8000,
          buildPrompt: (i) => ({
            system: questWatcherPrompt.buildSystem(i),
            user: questWatcherPrompt.buildUser(i),
          }),
        },
        {
          player: { id: playerId, name: 'Test Player' },
          language: 'en',
          active_quests: [
            {
              id: 9999,
              title: 'Synthetic test quest',
              summary:
                'Used by /api/debug/run-quest-watcher forceLLM=true',
              current_stage_id: 'stage1',
              stages: [
                { id: 'stage1', title: 'Do the thing', next_stage: 'stage2' },
                { id: 'stage2', title: 'Done' },
              ],
              goal: 'Verify the agent pipeline writes telemetry',
            },
          ],
          turn: {
            user_text: 'I do the thing.',
            tool_calls: [
              { name: 'narrate', args: { text: 'You did the thing.' } },
            ],
            visible_narrative: 'The thing is done. The deed is canon.',
          },
        },
        ctx,
      );
      return ok({
        watcher_ran: true,
        specialist: 'quest_watcher',
        sessionId,
        playerId,
        turnId,
        forceLLM: true,
        result,
      });
    }

    const { questWatcherHook } = await import('../agents/questWatcher.js');
    await questWatcherHook.run(ctx, {
      text: '<manual trigger>',
      toolHistory: [],
      narrative: '<manual trigger — no narrative>',
    });
    return ok({
      watcher_ran: true,
      specialist: 'quest_watcher',
      sessionId,
      playerId,
      turnId,
    });
  }

  /** Spec 40 — Combat Director smoke trigger. */
  static async runCombatDirector(body: Record<string, unknown>): Promise<RouteOutcome> {
    const playerProse = String(body['playerProse'] ?? '');
    if (playerProse.length < 4) return bad('playerProse required (≥4 chars)');
    const playerId = assertPositiveInt(body['playerId']);
    if (playerId === null) return bad('playerId required');
    const targetName = String(body['targetName'] ?? 'Mikka Quickgrin');
    const languageHint =
      typeof body['language'] === 'string' ? body['language'] : null;

    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());

    const { runSpecialist } = await import('../agents/base.js');
    const { combatDirectorPrompt } = await import(
      '../agents/combatDirectorPrompt.js'
    );
    const { z } = await import('zod');
    const schema = z.object({
      roll_plan: z.object({
        skip_attack_roll: z.boolean(),
        reason: z.string(),
      }),
      damage_plan: z.object({
        target: z.string(),
        amount: z.number().int(),
        type: z.string().optional(),
        source: z.string().optional(),
      }),
      position: z.enum(['controlled', 'risky', 'desperate']),
      effect: z.enum(['limited', 'standard', 'great']),
      conditions: z
        .array(
          z.object({
            target: z.string(),
            tag: z.string(),
            duration_turns: z.number().int(),
            severity: z.number().int(),
          }),
        )
        .optional(),
      memory_canon: z.array(
        z.object({
          owner: z.union([z.string(), z.number()]),
          about: z.union([z.string(), z.number()]).nullable(),
          text: z.string(),
          importance: z.number(),
          tags: z.array(z.string()),
        }),
      ),
      language: z.string().optional(),
    });

    const result = await runSpecialist(
      {
        name: 'combat_director',
        mode: 'blocking',
        outputSchema: schema,
        timeoutMs: 7000,
        temperature: 0.2,
        buildPrompt: (i) => ({
          system: combatDirectorPrompt.buildSystem(i),
          user: combatDirectorPrompt.buildUser(i),
        }),
      },
      {
        player_prose: playerProse,
        player: { id: playerId, name: 'Debug Player', hp: 24, max_hp: 24 },
        target: {
          name: targetName,
          hp: 30,
          max_hp: 30,
          ac: 13,
          prof: 2,
          conditions: [],
        },
        recent_damage: [],
        inventory: {
          equipped_weapons: [],
          carried_weapons: [],
          carried_tools: [],
          unarmed_source: 'unarmed_strike' as const,
        },
        environment: {
          location_name: 'Debug Arena',
          location_summary: null,
          items_here: [],
          active_surfaces: [],
        },
        language_hint: languageHint,
      },
      {
        sessionId,
        playerId,
        turnId: `manual-cd-${Date.now()}`,
        signal: new AbortController().signal,
      },
    );
    return ok({
      director_ran: true,
      specialist: 'combat_director',
      sessionId,
      targetName,
      brief: result,
    });
  }

  /** Spec 41 — Intimacy Coordinator smoke trigger. */
  static async runIntimacyCoordinator(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const playerProse = String(body['playerProse'] ?? '');
    if (playerProse.length < 4) return bad('playerProse required (≥4 chars)');
    const playerId = assertPositiveInt(body['playerId']);
    if (playerId === null) return bad('playerId required');
    const partnerName = String(body['partnerName'] ?? 'Mikka Quickgrin');

    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());

    const { runSpecialist } = await import('../agents/base.js');
    const { intimacyCoordinatorPrompt } = await import(
      '../agents/intimacyCoordinatorPrompt.js'
    );
    const { CoordinatorOutput } = await import(
      '../agents/intimacyCoordinatorTypes.js'
    );
    const { normalizeCoordinatorBrief } = await import(
      '../agents/intimacyCoordinatorPolicy.js'
    );

    const input = {
      player: {
        id: playerId,
        name: String(body['playerName'] ?? playerId),
      },
      player_prose: playerProse,
      language: String(body['language'] ?? 'en'),
      partner: {
        name: partnerName,
        mood: null,
        strings: 0,
        intimacy_quest_active: null,
        sex_move: null,
      },
      participants: [],
      active_intimacy_quest_phase: null,
      recent_intimate_beats: [],
    };

    const result = await runSpecialist(
      {
        name: 'intimacy_coordinator',
        mode: 'blocking',
        outputSchema: CoordinatorOutput,
        timeoutMs: 7000,
        temperature: 0.3,
        buildPrompt: (i) => ({
          system: intimacyCoordinatorPrompt.buildSystem(i),
          user: intimacyCoordinatorPrompt.buildUser(i),
        }),
      },
      input,
      {
        sessionId,
        playerId,
        turnId: `manual-ic-${Date.now()}`,
        signal: new AbortController().signal,
      },
    );
    return ok({
      coordinator_ran: true,
      specialist: 'intimacy_coordinator',
      sessionId,
      partnerName,
      proposal: result,
      brief: result ? normalizeCoordinatorBrief(result, input) : null,
    });
  }

  /** Spec 42 — Catalogue Scout smoke trigger. */
  static async runCatalogueScout(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const newEntities = body['newEntities'] as
      | Array<{ id: number; kind: string; display_name: string }>
      | undefined;
    if (!Array.isArray(newEntities) || newEntities.length === 0) {
      return bad('newEntities array required');
    }

    const { similarityScore: scoreFn } = await import(
      '../agents/catalogueScout.js'
    );
    const { query: q } = await import('../db.js');
    const verdicts: Array<unknown> = [];

    for (const e of newEntities) {
      const r = await q(
        `SELECT id, display_name, summary FROM entities
          WHERE kind = $1 AND id <> $2`,
        [e.kind, e.id],
      );
      const scored = r.rows.map((row: Record<string, unknown>) => ({
        id: row.id as number,
        display_name: row.display_name as string,
        summary: row.summary,
        score: scoreFn(e.display_name, row.display_name as string),
      }));
      scored.sort(
        (a: { score: number }, b: { score: number }) => b.score - a.score,
      );
      const top = scored
        .filter((s: { score: number }) => s.score >= 0.5)
        .slice(0, 5);
      let band = 'unique';
      const topScore = top[0]?.score ?? 0;
      if (topScore >= 0.9) band = 'clear_dupe';
      else if (topScore >= 0.7) band = 'ambiguous';
      verdicts.push({ new_entity: e, candidates: top, band });
    }
    return ok({ scout_ran: true, specialist: 'catalogue_scout', verdicts });
  }

  /** Spec 43 — NPC Voice Engine smoke trigger. */
  static async runNpcVoice(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const memoryId = assertPositiveInt(body['memoryId']);
    if (memoryId === null) return bad('memoryId required');
    const force = Boolean(body['force'] ?? false);

    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());

    const { enrichOneMemory } = await import('../agents/npcVoice.js');
    const result = await enrichOneMemory(
      memoryId,
      {
        sessionId,
        playerId: 1000,
        turnId: `manual-vc-${Date.now()}`,
        signal: new AbortController().signal,
      },
      force,
    );

    const { selectDebugNpcVoiceMemory } = await import(
      '../domain/memory/index.js'
    );
    const memory = await selectDebugNpcVoiceMemory(memoryId);
    return ok({
      voiced: result?.voiced ?? false,
      reason: result?.reason,
      specialist: 'npc_voice',
      sessionId,
      memory,
    });
  }

  /** Spec 44 — Scene Painter smoke trigger. */
  static async runScenePainter(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const playerText = String(body['playerText'] ?? '');
    if (playerText.length < 2) return bad('playerText required');
    const sceneSummary = String(body['sceneSummary'] ?? '');
    const locationSummary = String(body['locationSummary'] ?? '');
    const language = String(body['language'] ?? 'en');

    const { runScenePainter } = await import('../agents/scenePainter.js');
    const { buildProviders } = await import('../ai/providers.js');
    const { getRegisteredTools } = await import('../tools/base.js');
    const providers = buildProviders();
    const tools = getRegisteredTools();
    const narrateDef = tools.get('narrate');
    if (!narrateDef) {
      return { status: 500, body: { error: 'narrate tool not registered' } };
    }
    const stubSystem = `You are narrating a Greenhaven turn.
Scene: ${sceneSummary}
Location: ${locationSummary}
Language: ${language}
Use narrate(author=<location>, tone="narrator", text=...) with the location voice.`;
    let buf = '';
    try {
      const out = await runScenePainter({
        providers,
        systemPrompt: stubSystem,
        userMessage: playerText,
        narrateTool: narrateDef,
        signal: new AbortController().signal,
        onText: (delta) => {
          buf += delta;
        },
      });
      return ok({
        painter: true,
        text: buf || out.contentBuffer,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        durationMs: undefined,
      });
    } catch (err) {
      return {
        status: 500,
        body: {
          painter: false,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** Spec 45 — Dialogue Anchor smoke trigger. */
  static async runDialogueAnchor(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const playerId = assertPositiveInt(body['playerId']);
    if (playerId === null) return bad('playerId required');

    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());

    const { forceRunForPlayer } = await import('../agents/dialogueAnchor.js');
    const result = await forceRunForPlayer(playerId, {
      sessionId,
      playerId,
      turnId: `manual-da-${Date.now()}`,
      signal: new AbortController().signal,
    });

    const { query: q } = await import('../db.js');
    const meta = await q(
      `SELECT (metadata->'dialogue_anchor') AS anchor FROM players WHERE entity_id = $1`,
      [playerId],
    );
    return ok({
      anchor_ran: result.anchor_ran,
      specialist: 'dialogue_anchor',
      sessionId,
      brief: result.brief,
      persisted_anchor: meta.rows[0]?.anchor ?? null,
    });
  }

  /** Spec 46 — Movement Warden smoke trigger. */
  static async runMovementWarden(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const playerId = assertPositiveInt(body['playerId']);
    if (playerId === null) return bad('playerId required');
    const narrateText = String(body['narrateText'] ?? '');
    if (narrateText.length < 4) return bad('narrateText required (≥4 chars)');

    const overrideLocationId = body['currentLocationId'];
    const { query: q } = await import('../db.js');
    let currentLocationId: number | null = null;
    if (typeof overrideLocationId === 'number') {
      currentLocationId = overrideLocationId;
    } else {
      const r = await q(
        `SELECT current_location_id FROM players WHERE entity_id = $1`,
        [playerId],
      );
      currentLocationId =
        ((r.rows[0] as Record<string, unknown> | undefined)
          ?.current_location_id as number | null) ?? null;
    }

    let currentLocationName: string | null = null;
    if (currentLocationId != null) {
      const cur = await q(
        `SELECT display_name FROM entities WHERE id = $1`,
        [currentLocationId],
      );
      currentLocationName =
        ((cur.rows[0] as Record<string, unknown> | undefined)
          ?.display_name as string | null) ?? null;
    }

    const { extractMentionsAnyScript } = await import(
      '../agents/movementWarden.js'
    );
    const { movementWardenPrompt } = await import(
      '../agents/movementWardenPrompt.js'
    );
    const { runSpecialist } = await import('../agents/base.js');
    const { z } = await import('zod');

    const mentions = extractMentionsAnyScript(narrateText);
    const names = [...mentions.keys()];
    const locRows =
      names.length === 0
        ? { rows: [] as Array<Record<string, unknown>> }
        : await q(
            `SELECT id, display_name FROM entities
              WHERE kind = 'location' AND display_name = ANY($1::text[])`,
            [names],
          );
    const candidates = locRows.rows
      .filter((r: Record<string, unknown>) => r['id'] !== currentLocationId)
      .map((r: Record<string, unknown>) => ({
        id: r['id'] as number,
        display_name: r['display_name'] as string,
      }));

    if (candidates.length === 0) {
      return ok({
        warning_emitted: false,
        teleport_detected: false,
        specialist: 'movement_warden',
        currentLocationId,
        currentLocationName,
        flagged: [],
        reason: 'no candidate locations in narrate text',
      });
    }

    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());

    const schema = z.object({
      flagged: z.array(
        z.object({
          location_id: z.number().int(),
          reason: z.string(),
        }),
      ),
    });

    const verdict = await runSpecialist(
      {
        name: 'movement_warden',
        mode: 'async',
        outputSchema: schema,
        timeoutMs: 6000,
        temperature: 0.2,
        maxOutputTokens: 500,
        buildPrompt: (i) => ({
          system: movementWardenPrompt.system,
          user: movementWardenPrompt.buildUser(i),
        }),
      },
      {
        narrate_text: narrateText,
        current_location_name: currentLocationName,
        candidate_locations: candidates,
      },
      {
        sessionId,
        playerId,
        turnId: `manual-mw-${Date.now()}`,
        signal: new AbortController().signal,
      },
    );

    const flagged: Array<{
      mentionedLocationId: number;
      mentionedLocationName: string;
      narrateExcerpt: string;
      reason: string;
    }> = [];
    if (verdict) {
      const candIds = new Set(candidates.map((x) => x.id));
      for (const f of verdict.flagged) {
        if (!candIds.has(f.location_id)) continue;
        const loc = candidates.find((x) => x.id === f.location_id);
        if (!loc) continue;
        flagged.push({
          mentionedLocationId: loc.id as number,
          mentionedLocationName: loc.display_name as string,
          narrateExcerpt: (
            mentions.get(loc.display_name as string) ?? ''
          ).slice(0, 280),
          reason: f.reason,
        });
      }
    }

    return ok({
      warning_emitted: flagged.length > 0,
      teleport_detected: flagged.length > 0,
      specialist: 'movement_warden',
      currentLocationId,
      currentLocationName,
      flagged,
    });
  }

  /** Spec 47 — Reward Calibrator smoke trigger. */
  static async runRewardCalibrator(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const playerId = assertPositiveInt(body['playerId']);
    if (playerId === null) return bad('playerId required');
    const text = String(body['playerText'] ?? '');
    if (text.length < 2) return bad('playerText required');
    const mode = String(body['mode'] ?? 'exploration');

    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());

    const { rewardCalibratorHook } = await import(
      '../agents/rewardCalibrator.js'
    );
    const briefing = await rewardCalibratorHook.run(
      {
        sessionId,
        playerId,
        turnId: `manual-rc-${Date.now()}`,
        signal: new AbortController().signal,
      },
      { text, mode },
    );

    return ok({
      calibrator_ran: briefing != null,
      specialist: 'reward_calibrator',
      sessionId,
      briefing: briefing ?? null,
    });
  }

  /** Spec 48 — Cartridge Steward smoke trigger. */
  static async runCartridgeSteward(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const tool = String(body['tool'] ?? 'create_entity');
    if (tool !== 'create_entity' && tool !== 'create_quest') {
      return bad('tool must be create_entity or create_quest');
    }
    const args = body['args'] ?? {};
    const playerId = Number(body['playerId'] ?? 0);

    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());

    const { dispatch } = await import('../tools/base.js');
    const result = await dispatch(tool, args, {
      sessionId,
      playerId: playerId || 1000,
      turnId: `manual-cs-${Date.now()}`,
    });

    return ok({
      steward_ran: true,
      specialist: 'cartridge_steward',
      tool,
      sessionId,
      result,
    });
  }

  /** Spec 49 — Quest Pacer smoke trigger. */
  static async runQuestPacer(
    body: Record<string, unknown>,
  ): Promise<RouteOutcome> {
    const playerId = assertPositiveInt(body['playerId']);
    if (playerId === null) return bad('playerId required');

    const { sessionManager } = await import('../sessionManager.js');
    const sessionId = liveSessionIdOrSynthetic(sessionManager.entries());

    const { questPacerHook } = await import('../agents/questPacer.js');
    await questPacerHook.run(
      {
        sessionId,
        playerId,
        turnId: `manual-qp-${Date.now()}`,
        signal: new AbortController().signal,
      },
      {
        text: '<manual trigger>',
        toolHistory: [],
        narrative: '',
      },
    );

    const { query: q } = await import('../db.js');
    const meta = await q(
      `SELECT (metadata->'quest_pacer') AS pacer FROM players WHERE entity_id = $1`,
      [playerId],
    );
    return ok({
      pacer_ran: true,
      specialist: 'quest_pacer',
      sessionId,
      playerId,
      persisted: meta.rows[0]?.pacer ?? null,
    });
  }

  /** Spec 50 — verify-specialists smoke matrix. ARCH-5 debug-smoke
   *  slice — descriptors live in the shared `SpecialistRegistry`
   *  (`specialists/debugSmoke.ts`); this method just materialises
   *  each registered descriptor's `buildBody(playerId)` into the
   *  `VerifyTest` shape `runOneVerifyTest` expects. Spec order,
   *  names, endpoints, request bodies, and per-specialist verdict
   *  checks are unchanged.
   */
  static buildVerifyTests(playerId: number): VerifyTest[] {
    return listDebugSmokeSpecialists().map((descriptor) => ({
      spec: descriptor.spec,
      name: descriptor.name,
      endpoint: descriptor.endpoint,
      body: descriptor.buildBody(playerId),
      check: descriptor.check,
    }));
  }

  static summarizeVerdicts(verdicts: Verdict[]): VerifySummary {
    return {
      pass: verdicts.filter((v) => v.status === 'pass').length,
      skipped: verdicts.filter((v) => v.status === 'skipped').length,
      fail: verdicts.filter((v) => v.status === 'fail').length,
      total: verdicts.length,
    };
  }

  /** Resolve the in-process app fetch handle (route-provided wins;
   *  falls back to the `SEC-8`-gated `globalThis.__greenhavenApp`
   *  slot through `getDebugAppGlobal()` so the read uses the
   *  exact key the installer wrote against). */
  static resolveAppFetch(routeApp?: { fetch?: AppFetch }): AppFetch | null {
    if (typeof routeApp?.fetch === 'function') return routeApp.fetch;
    const globalApp = getDebugAppGlobal() as
      | { fetch?: AppFetch }
      | undefined;
    if (typeof globalApp?.fetch === 'function') return globalApp.fetch;
    return null;
  }

  static async runOneVerifyTest(
    test: VerifyTest,
    fetchFn: AppFetch,
  ): Promise<Verdict> {
    const startedAt = Date.now();
    try {
      const fakeReq = new Request(`http://localhost${test.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(test.body),
      });
      const resp = await fetchFn(fakeReq);
      const text = await resp.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          spec: test.spec,
          name: test.name,
          endpoint: test.endpoint,
          status: 'fail',
          durationMs: Date.now() - startedAt,
          notes: `non-JSON response (status ${resp.status})`,
          rawSnippet: text.slice(0, 240),
        };
      }
      if (!resp.ok) {
        return {
          spec: test.spec,
          name: test.name,
          endpoint: test.endpoint,
          status: 'fail',
          durationMs: Date.now() - startedAt,
          notes: `HTTP ${resp.status}: ${parsed?.['error'] ?? '<no error>'}`,
          rawSnippet: text.slice(0, 240),
        };
      }
      const verdict = test.check(parsed!);
      return {
        spec: test.spec,
        name: test.name,
        endpoint: test.endpoint,
        status: verdict.status,
        durationMs: Date.now() - startedAt,
        notes: verdict.notes,
        rawSnippet: text.slice(0, 240),
      };
    } catch (err) {
      return {
        spec: test.spec,
        name: test.name,
        endpoint: test.endpoint,
        status: 'fail',
        durationMs: Date.now() - startedAt,
        notes: `threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** POST /api/debug/verify-specialists — runs all 11 specialist smokes. */
  static async verifySpecialists(opts: {
    playerId?: number;
    routeApp?: { fetch?: AppFetch };
  }): Promise<RouteOutcome> {
    const playerId = Number(opts.playerId ?? 1000);
    const fetchFn = this.resolveAppFetch(opts.routeApp);
    if (!fetchFn) {
      return {
        status: 500,
        body: {
          error:
            'verify-specialists requires app reference via globalThis.__greenhavenApp',
        },
      };
    }
    const tests = this.buildVerifyTests(playerId);
    const verdicts = await Promise.all(
      tests.map((t) => this.runOneVerifyTest(t, fetchFn)),
    );
    verdicts.sort((a, b) => a.spec - b.spec);
    const summary = this.summarizeVerdicts(verdicts);
    const allOk = summary.fail === 0;
    return {
      status: allOk ? 200 : 207,
      body: { ok: allOk, summary, verdicts },
    };
  }
}
