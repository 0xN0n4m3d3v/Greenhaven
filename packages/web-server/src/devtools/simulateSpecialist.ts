/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../tools/index.js';
import { runMigrations } from '../migrate.js';
import { query } from '../db.js';
import {
  projectEntityNormalizedColumns,
  stripRetiredProfileKeysForPersist,
  stripRetiredTagsForPersist,
} from '../entities/profileProjection.js';
import { clearConfigEnv, rawConfigEnv, setConfigEnv } from '../config.js';
import {
  executeTool,
  type ToolContext,
  type ToolResult,
} from '../tools/base.js';
import { questPacerHook } from '../agents/questPacer.js';
import { questWatcherHook } from '../agents/questWatcher.js';
import { adventureMaterializerHook } from '../domain/adventure/materializer/index.js';
import {
  listAdventureQueue,
  maybeEnqueueAdventureOpportunity,
  rollAdventureOracle,
  type AdventureKind,
  type AdventureTableContext,
} from '../domain/adventure/index.js';
import {
  validateProtagonistRenderCandidate,
  type ProtagonistActionRendererOutput,
} from '../agents/protagonistActionRenderer.js';
import {
  fixtureById,
  fixturesFor,
  HARNESS_NAMES,
  hasProviderKeys,
  type HarnessExpectation,
  type SpecialistFixture,
  type SpecialistHarnessName,
} from './specialistFixtures.js';

export type FixtureMode = 'temp' | 'existing' | 'none';
export type HarnessStatus = 'passed' | 'failed' | 'skipped';

export interface SimulateSpecialistOptions {
  specialist: SpecialistHarnessName;
  input?: unknown;
  fixtureId?: string;
  fixtureMode?: FixtureMode;
  sessionId?: string;
  playerId?: number;
  turnId?: string;
}

export interface SimulateSpecialistResult {
  ok: boolean;
  status: HarnessStatus;
  specialist: SpecialistHarnessName;
  fixtureId?: string;
  fixtureMode: FixtureMode;
  providerAvailable: boolean;
  skippedReason?: string;
  expected?: HarnessExpectation;
  toolResult?: ToolResult;
  questSignals?: unknown[];
  protagonistResult?: ProtagonistHarnessResult;
  context?: {
    sessionId: string;
    playerId: number;
    turnId: string;
    pgliteDataDir?: string;
  };
  notes: string[];
}

interface ProtagonistHarnessResult {
  rawText: string;
  visibleText: string;
  changed: boolean;
  skippedReason: string | null;
}

interface HarnessWorld {
  sessionId: string;
  playerId: number;
  turnId: string;
  pgliteDataDir?: string;
  laneId?: number;
  basementId?: number;
  mikkaId?: number;
}

export async function simulateSpecialist(
  options: SimulateSpecialistOptions,
): Promise<SimulateSpecialistResult> {
  const fixture = resolveFixture(options);
  const providerAvailable = hasProviderKeys();
  const fixtureMode = options.fixtureMode ?? 'temp';
  const expected = fixture?.expected;

  if (fixture?.requiresProvider && !providerAvailable) {
    return {
      ok: true,
      status: 'skipped',
      specialist: options.specialist,
      fixtureId: fixture.id,
      fixtureMode,
      providerAvailable,
      skippedReason: 'provider_keys_missing',
      expected,
      notes: ['Fixture requires DEEPSEEK_API_KEY or FEATHERLESS_API_KEY.'],
    };
  }

  const world = await prepareHarnessWorld({
    fixtureMode,
    sessionId: options.sessionId,
    playerId: options.playerId,
    turnId: options.turnId,
  });
  const input =
    fixture?.input ?? options.input ?? defaultInput(options.specialist);
  const ctx: ToolContext = {
    sessionId: world.sessionId,
    playerId: world.playerId,
    turnId: world.turnId,
    signal: new AbortController().signal,
  };

  if (options.specialist === 'quest_pacer') {
    await questPacerHook.run(
      {
        sessionId: world.sessionId,
        playerId: world.playerId,
        turnId: world.turnId,
        signal: ctx.signal!,
      },
      { text: 'devtool quest pacer fixture', toolHistory: [], narrative: '' },
    );
    const questSignals = await loadQuestPacerSignals(world.playerId);
    return finalize({
      options,
      fixture,
      fixtureMode,
      providerAvailable,
      expected,
      world,
      questSignals,
    });
  }

  if (options.specialist === 'quest_watcher') {
    await prepareQuestWatcherFixture(world);
    const record = isRecord(input) ? input : {};
    await questWatcherHook.run(
      {
        sessionId: world.sessionId,
        playerId: world.playerId,
        turnId: world.turnId,
        signal: ctx.signal!,
      },
      {
        text:
          typeof record['text'] === 'string'
            ? record['text']
            : 'I open the old latch.',
        toolHistory: [],
        narrative:
          typeof record['narrative'] === 'string'
            ? record['narrative']
            : 'The old latch gives way.',
      },
    );
    return finalize({
      options,
      fixture,
      fixtureMode,
      providerAvailable,
      expected,
      world,
      toolResult: { ok: true, data: { ran: true } },
    });
  }

  if (options.specialist === 'adventure_materializer') {
    await prepareAdventureMaterializerFixture(world, input);
    await adventureMaterializerHook.run(
      {
        sessionId: world.sessionId,
        playerId: world.playerId,
        turnId: world.turnId,
        signal: ctx.signal!,
      },
      {
        text:
          isRecord(input) && typeof input['text'] === 'string'
            ? input['text']
            : 'I follow the hidden marker.',
        toolHistory: [],
        narrative:
          isRecord(input) && typeof input['narrative'] === 'string'
            ? input['narrative']
            : 'A hidden marker catches the light.',
        mode: 'travel',
      },
    );
    const rows = await listAdventureQueue({
      sessionId: world.sessionId,
      playerId: world.playerId,
      statuses: ['ready', 'rejected', 'failed'],
      limit: 5,
    });
    const ready = rows.find((row) => row.status === 'ready');
    return finalize({
      options,
      fixture,
      fixtureMode,
      providerAvailable,
      expected,
      world,
      toolResult: ready
        ? { ok: true, data: { queueId: ready.id, status: ready.status } }
        : {
            ok: false,
            error: `adventure materializer did not produce ready row: ${rows.map((row) => `${row.id}:${row.status}`).join(',')}`,
          },
    });
  }

  if (options.specialist === 'protagonist_action_renderer') {
    const protagonistResult = simulateProtagonistRenderer(input);
    return finalize({
      options,
      fixture,
      fixtureMode,
      providerAvailable,
      expected,
      world,
      protagonistResult,
    });
  }

  const toolCall = coerceToolCall(options.specialist, input);
  const toolResult = await executeTool(toolCall.toolName, toolCall.args, ctx);
  return finalize({
    options,
    fixture,
    fixtureMode,
    providerAvailable,
    expected,
    world,
    toolResult,
  });
}

export async function runSpecialistFixtures(
  fixtureIds: string[],
  fixtureMode: FixtureMode = 'temp',
): Promise<{
  ok: boolean;
  summary: { passed: number; failed: number; skipped: number; total: number };
  results: SimulateSpecialistResult[];
}> {
  const results: SimulateSpecialistResult[] = [];
  for (const fixtureId of fixtureIds) {
    const fixture = fixtureById(fixtureId);
    if (!fixture) throw new Error(`unknown fixture: ${fixtureId}`);
    results.push(
      await simulateSpecialist({
        specialist: fixture.specialist,
        fixtureId,
        fixtureMode,
      }),
    );
  }
  const summary = {
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    total: results.length,
  };
  return { ok: summary.failed === 0, summary, results };
}

function resolveFixture(
  options: SimulateSpecialistOptions,
): SpecialistFixture | undefined {
  if (options.fixtureId) {
    const fixture = fixtureById(options.fixtureId);
    if (!fixture) throw new Error(`unknown fixture: ${options.fixtureId}`);
    if (fixture.specialist !== options.specialist) {
      throw new Error(
        `fixture ${fixture.id} targets ${fixture.specialist}, not ${options.specialist}`,
      );
    }
    return fixture;
  }
  if (options.input !== undefined) return undefined;
  return fixturesFor(options.specialist)[0];
}

async function prepareHarnessWorld(args: {
  fixtureMode: FixtureMode;
  sessionId?: string;
  playerId?: number;
  turnId?: string;
}): Promise<HarnessWorld> {
  if (args.fixtureMode === 'none') {
    if (!args.sessionId || args.playerId == null) {
      throw new Error('fixtureMode=none requires both sessionId and playerId');
    }
    return {
      sessionId: args.sessionId,
      playerId: args.playerId,
      turnId: args.turnId ?? `devtool-${Date.now()}`,
    };
  }

  let pgliteDataDir: string | undefined;
  if (args.fixtureMode === 'temp') {
    clearConfigEnv('DATABASE_URL');
    const base =
      rawConfigEnv('GREENHAVEN_DEVTOOLS_TMP') ??
      (process.platform === 'win32' ? 'C:\\tmp' : '/tmp');
    await mkdir(base, { recursive: true });
    pgliteDataDir = await mkdtemp(path.join(base, 'greenhaven-specialist-'));
    setConfigEnv('PGLITE_DATA_DIR', pgliteDataDir);
  }

  await runMigrations();
  const seeded = await seedHarnessWorld(args.sessionId);
  return {
    ...seeded,
    playerId: args.playerId ?? seeded.playerId,
    turnId: args.turnId ?? `devtool-${Date.now()}`,
    pgliteDataDir,
  };
}

async function seedHarnessWorld(
  sessionIdOverride?: string,
): Promise<HarnessWorld> {
  const laneId = await upsertEntity({
    kind: 'location',
    displayName: HARNESS_NAMES.lane,
    summary: 'A narrow test lane used by the specialist harness.',
    profile: {},
    tags: ['devtool', 'harness'],
  });
  const basementId = await upsertEntity({
    kind: 'location',
    displayName: HARNESS_NAMES.basement,
    summary: 'A locked test basement used by the movement harness.',
    profile: {},
    tags: ['devtool', 'harness'],
  });
  const mikkaId = await upsertEntity({
    kind: 'person',
    displayName: HARNESS_NAMES.mikka,
    summary: 'A test merchant used by the voice harness.',
    profile: { home_id: String(laneId) },
    tags: ['devtool', 'harness'],
  });
  const giverId = await upsertEntity({
    kind: 'person',
    displayName: HARNESS_NAMES.giver,
    summary: 'A quest giver intentionally absent from recent chat.',
    profile: { home_id: String(laneId) },
    tags: ['devtool', 'harness'],
  });
  const questId = await upsertEntity({
    kind: 'quest',
    displayName: HARNESS_NAMES.quest,
    summary: 'A stale harness quest.',
    profile: { giver: HARNESS_NAMES.giver },
    tags: ['devtool', 'harness'],
  });
  void basementId;
  void mikkaId;
  void giverId;

  const playerId = await upsertEntity({
    kind: 'player',
    displayName: HARNESS_NAMES.player,
    summary: 'Synthetic player for specialist devtools.',
    profile: {},
    tags: ['devtool', 'harness'],
  });
  await query(
    `INSERT INTO players (entity_id, public_id, current_location_id, metadata)
     VALUES ($1, $2::uuid, $3, '{}'::jsonb)
     ON CONFLICT (entity_id) DO UPDATE
       SET current_location_id = EXCLUDED.current_location_id,
           metadata = COALESCE(players.metadata, '{}'::jsonb) - 'quest_pacer'`,
    [playerId, randomUUID(), laneId],
  );

  const sessionId = sessionIdOverride ?? randomUUID();
  await query(
    `INSERT INTO sessions (id, player_id, metadata)
     VALUES ($1, $2, '{"devtool":"specialist_harness"}'::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET player_id = EXCLUDED.player_id,
           last_seen = now()`,
    [sessionId, playerId],
  );
  await query(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload,
        player_id, location_entity_id)
     VALUES ($1, $2, 'player', $3, 1, '{}'::jsonb, $2, $4)`,
    [
      sessionId,
      playerId,
      'I ask Mikka about the palace rumor in the market lane.',
      laneId,
    ],
  );
  await query(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase,
        current_stage_id, started_at, metadata)
     VALUES ($1, $2, 'active', 0, NULL, now() - interval '7 days', '{}'::jsonb)
     ON CONFLICT (player_id, quest_entity_id) DO UPDATE
       SET status = 'active',
           started_at = now() - interval '7 days',
           current_stage_id = NULL,
           metadata = '{}'::jsonb`,
    [playerId, questId],
  );

  return {
    sessionId,
    playerId,
    turnId: `devtool-${Date.now()}`,
    laneId,
    basementId,
    mikkaId,
  };
}

async function prepareQuestWatcherFixture(world: HarnessWorld): Promise<void> {
  const questId = await upsertEntity({
    kind: 'quest',
    displayName: 'GH Harness Watcher Quest',
    summary: 'A staged quest used by the Quest Watcher harness.',
    profile: {
      goal: 'Open the old cellar door.',
      stages: [
        {
          id: 'open_latch',
          title: 'Open the latch',
          next_stage: 'enter_cellar',
        },
        { id: 'enter_cellar', title: 'Enter the cellar' },
      ],
    },
    tags: ['devtool', 'harness'],
  });
  await query(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase,
        current_stage_id, started_at, metadata)
     VALUES ($1, $2, 'active', 1, 'open_latch', now(), '{}'::jsonb)
     ON CONFLICT (player_id, quest_entity_id) DO UPDATE
       SET status = 'active',
           current_phase = 1,
           current_stage_id = 'open_latch',
           started_at = now(),
           metadata = '{}'::jsonb`,
    [world.playerId, questId],
  );
}

async function prepareAdventureMaterializerFixture(
  world: HarnessWorld,
  input: unknown,
): Promise<void> {
  const record = isRecord(input) ? input : {};
  const requestedKind =
    typeof record['adventureKind'] === 'string'
      ? record['adventureKind']
      : 'hidden_location';
  const context: AdventureTableContext = {
    playerLevel: 2,
    currentLocationId: world.laneId ?? null,
    mode: 'travel',
    activeQuestCount: 0,
    recentCombat: false,
    recentDanger: null,
    cooldownKinds: new Set<AdventureKind>(),
  };
  const seed = `specialist-adventure-${requestedKind}`;
  let sequence = 1;
  let rolled = rollAdventureOracle({ seed, sequence, context });
  while (rolled.selectedKind !== requestedKind && sequence < 100) {
    sequence += 1;
    rolled = rollAdventureOracle({ seed, sequence, context });
  }
  await maybeEnqueueAdventureOpportunity(
    {
      sessionId: world.sessionId,
      playerId: world.playerId,
      turnId: world.turnId,
      source: 'manual_debug',
      mode: 'travel',
      seed,
      sequence,
      visible: false,
    },
    {
      text:
        typeof record['text'] === 'string'
          ? record['text']
          : 'I follow the hidden marker.',
      narrative:
        typeof record['narrative'] === 'string'
          ? record['narrative']
          : 'A hidden marker catches the light.',
      toolHistory: [],
      mode: 'travel',
    },
  );
}

async function upsertEntity(args: {
  kind: string;
  displayName: string;
  summary: string;
  profile: Record<string, unknown>;
  tags: string[];
}): Promise<number> {
  const existing = await query<{ id: number }>(
    `SELECT id FROM entities
      WHERE kind = $1 AND display_name = $2
      ORDER BY id
      LIMIT 1`,
    [args.kind, args.displayName],
  );
  // ARCH-19 Phase 4 (migration 0123) — derive normalized columns
  // from the raw post-patch profile so retired-key inputs still flow
  // into cartridge_id / topology_parent_id / dynamic_origin, but
  // persist a stripped JSONB / tags so the stored row no longer
  // carries them.
  const projected = projectEntityNormalizedColumns({
    profile: args.profile,
    tags: args.tags,
  });
  const profileForPersist = JSON.stringify(
    stripRetiredProfileKeysForPersist(args.profile as Record<string, unknown>),
  );
  const tagsForPersist = stripRetiredTagsForPersist(args.tags);
  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await query(
      `UPDATE entities
          SET summary = $2,
              cartridge_id = NULLIF(
                TRIM((COALESCE(profile, '{}'::jsonb) || $3::jsonb)->>'cartridge_id'),
                ''
              ),
              topology_parent_id = (
                SELECT inner_e.id
                  FROM entities inner_e
                 WHERE inner_e.id = safe_to_bigint(
                         (COALESCE(profile, '{}'::jsonb) || $3::jsonb)->>'topology_parent_id'
                       )
                   AND inner_e.kind IN ('location', 'district')
              ),
              dynamic_origin = COALESCE(
                (COALESCE(profile, '{}'::jsonb) || $3::jsonb)->>'origin' = 'dynamic'
                OR 'dynamic' = ANY($4::text[]),
                false
              ),
              profile = (COALESCE(profile, '{}'::jsonb) || $3::jsonb)
                          - ARRAY['cartridge_id', 'topology_parent_id', 'origin']::text[],
              tags = $4,
              updated_at = now()
        WHERE id = $1`,
      [id, args.summary, profileForPersist, tagsForPersist],
    );
    return id;
  }
  const inserted = await query<{ id: number }>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       cartridge_id, topology_parent_id, dynamic_origin
     )
     VALUES (
       $1, $2, $3, $4::jsonb, $5,
       $6,
       (SELECT inner_e.id FROM entities inner_e
          WHERE inner_e.id = $7::bigint
            AND inner_e.kind IN ('location', 'district')),
       $8
     )
     RETURNING id`,
    [
      args.kind,
      args.displayName,
      args.summary,
      profileForPersist,
      tagsForPersist,
      projected.cartridge_id,
      projected.topology_parent_id,
      projected.dynamic_origin,
    ],
  );
  return inserted.rows[0]!.id;
}

function coerceToolCall(
  specialist: SpecialistHarnessName,
  input: unknown,
): { toolName: string; args: unknown } {
  if (isRecord(input) && typeof input['toolName'] === 'string') {
    return { toolName: input['toolName'], args: input['args'] ?? {} };
  }
  if (specialist === 'cartridge_steward') {
    return { toolName: 'create_entity', args: input };
  }
  return { toolName: 'narrate', args: input };
}

function defaultInput(specialist: SpecialistHarnessName): unknown {
  const fixture = fixturesFor(specialist)[0];
  if (!fixture) throw new Error(`no default fixture for ${specialist}`);
  return fixture.input;
}

async function loadQuestPacerSignals(playerId: number): Promise<unknown[]> {
  const r = await query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const metadata = r.rows[0]?.metadata ?? {};
  const pacer = metadata['quest_pacer'];
  if (!isRecord(pacer)) return [];
  const signals = pacer['signals'];
  return Array.isArray(signals) ? signals : [];
}

function simulateProtagonistRenderer(input: unknown): ProtagonistHarnessResult {
  const record = isRecord(input) ? input : {};
  const rawText =
    typeof record['rawText'] === 'string'
      ? record['rawText']
      : 'I take @Mikka by the hand.';
  const knownMentionNames = Array.isArray(record['knownMentionNames'])
    ? record['knownMentionNames'].filter(
        (name): name is string => typeof name === 'string',
      )
    : [];
  const candidate = parseProtagonistCandidate(record['candidate']);
  if (!candidate) {
    return {
      rawText,
      visibleText: rawText,
      changed: false,
      skippedReason: 'invalid_candidate',
    };
  }
  const validation = validateProtagonistRenderCandidate(
    rawText,
    candidate,
    knownMentionNames,
  );
  if (!validation.ok) {
    return {
      rawText,
      visibleText: rawText,
      changed: false,
      skippedReason: validation.reason,
    };
  }
  if (candidate.mode !== 'render' || !candidate.changed) {
    return {
      rawText,
      visibleText: rawText,
      changed: false,
      skippedReason: candidate.skipped_reason ?? 'candidate_skipped',
    };
  }
  return {
    rawText,
    visibleText: candidate.rendered_text.trim(),
    changed: candidate.rendered_text.trim() !== rawText,
    skippedReason: null,
  };
}

function parseProtagonistCandidate(
  value: unknown,
): ProtagonistActionRendererOutput | null {
  if (!isRecord(value)) return null;
  const direct = value as Record<string, unknown>;
  const candidate: ProtagonistActionRendererOutput = {
    mode: direct['mode'] === 'skip' ? 'skip' : 'render',
    changed: direct['changed'] === true,
    rendered_text:
      typeof direct['rendered_text'] === 'string'
        ? direct['rendered_text']
        : '',
    intent_summary:
      typeof direct['intent_summary'] === 'string'
        ? direct['intent_summary']
        : null,
    meaning_delta:
      direct['meaning_delta'] === 'possible' ||
      direct['meaning_delta'] === 'changed'
        ? direct['meaning_delta']
        : 'none',
    preserved_elements: parsePreservedElements(direct['preserved_elements']),
    confidence:
      typeof direct['confidence'] === 'number' ? direct['confidence'] : 0,
    skipped_reason:
      typeof direct['skipped_reason'] === 'string'
        ? direct['skipped_reason']
        : null,
  };
  return candidate;
}

function parsePreservedElements(
  value: unknown,
): ProtagonistActionRendererOutput['preserved_elements'] {
  const record = isRecord(value) ? value : {};
  return {
    actor:
      typeof record['actor'] === 'string' ? record['actor'] : 'player_hero',
    targets: stringArray(record['targets']),
    actions: stringArray(record['actions']),
    direct_speech: stringArray(record['direct_speech']),
    mechanical_tokens: stringArray(record['mechanical_tokens']),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function finalize(args: {
  options: SimulateSpecialistOptions;
  fixture?: SpecialistFixture;
  fixtureMode: FixtureMode;
  providerAvailable: boolean;
  expected?: HarnessExpectation;
  world: HarnessWorld;
  toolResult?: ToolResult;
  questSignals?: unknown[];
  protagonistResult?: ProtagonistHarnessResult;
}): SimulateSpecialistResult {
  const notes: string[] = [];
  const expected = args.expected;
  let passed = true;

  if (expected) {
    if (expected.kind === 'tool_rejected') {
      const rejected =
        args.toolResult?.ok === false && args.toolResult.rejected === true;
      const includes =
        !expected.errorIncludes ||
        String(args.toolResult?.error ?? '').includes(expected.errorIncludes);
      passed = rejected && includes;
      notes.push(
        rejected
          ? `tool rejected: ${args.toolResult?.error ?? '<no error>'}`
          : 'tool was not rejected',
      );
    } else if (expected.kind === 'tool_accepted') {
      passed = args.toolResult?.ok === true;
      notes.push(passed ? 'tool accepted' : 'tool was not accepted');
    } else if (expected.kind === 'quest_signal') {
      const found = (args.questSignals ?? []).some(
        (signal) =>
          isRecord(signal) && signal['signal_type'] === expected.signalType,
      );
      passed = found;
      notes.push(
        found
          ? `quest signal found: ${expected.signalType}`
          : `quest signal missing: ${expected.signalType}`,
      );
    } else {
      const result = args.protagonistResult;
      const changedOk = result?.changed === expected.changed;
      const includesOk =
        !expected.visibleIncludes ||
        Boolean(result?.visibleText.includes(expected.visibleIncludes));
      const skipOk =
        !expected.skippedReasonIncludes ||
        Boolean(
          result?.skippedReason?.includes(expected.skippedReasonIncludes),
        );
      passed = Boolean(result) && changedOk && includesOk && skipOk;
      notes.push(
        passed
          ? `protagonist render changed=${String(result?.changed)}`
          : `protagonist render mismatch: ${JSON.stringify(result)}`,
      );
    }
  } else {
    notes.push('no expectation supplied');
  }

  const status: HarnessStatus = passed ? 'passed' : 'failed';
  return {
    ok: passed,
    status,
    specialist: args.options.specialist,
    fixtureId: args.fixture?.id,
    fixtureMode: args.fixtureMode,
    providerAvailable: args.providerAvailable,
    expected,
    toolResult: args.toolResult,
    questSignals: args.questSignals,
    protagonistResult: args.protagonistResult,
    context: {
      sessionId: args.world.sessionId,
      playerId: args.world.playerId,
      turnId: args.world.turnId,
      pgliteDataDir: args.world.pgliteDataDir,
    },
    notes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
