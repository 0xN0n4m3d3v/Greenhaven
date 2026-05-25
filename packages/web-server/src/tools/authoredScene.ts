/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// GMV2-RUNTIME-3 — authored scene state machine.
//
// The Obsidian bridge already imports scene frames. These tools turn
// those frames into server-canon state:
//   * open_authored_scene sets players.current_scene_id and stores a
//     compact active-scene packet in players.metadata;
//   * choose_authored_scene_option records a backend-confirmed choice;
//   * close_authored_scene clears the active scene and applies the
//     supported memory / strings plan.
//
// The model still narrates the prose, but it no longer has to pretend
// a scene choice happened without a durable runtime write.

import {z} from 'zod';
import {query, withTransaction, type TxClient} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {MemoryService} from '../domain/memory/index.js';
import {
  findSceneInstructionEntry,
  type SceneInstructionEntry,
  type SceneStateField,
} from '../services/SceneInstructionBridgeService.js';
import {
  resolveActivePlayerCartridgeContext,
} from '../services/CartridgePlaythroughService.js';
import {addString, readStrings} from './strings.js';
import {registerTool, ToolExecutionError} from './base.js';
import {emitFieldChange} from '../runtimeFieldEvents.js';
import {applyMaterializersForTrigger} from './materializer.js';
import {emitEntityMediaScript} from '../services/CartridgeMediaScriptService.js';

const ACTIVE_SCENE_META_KEY = 'active_authored_scene';
const LAST_SCENE_META_KEY = 'last_authored_scene';
const SCENE_STATE_SCHEMA = 'greenhaven.authored_scene_state.v1';

const OpenSceneArgs = z.object({
  scene_slug: z.string().min(1).max(160),
  evidence: z.string().min(3).max(600),
});

const ChooseSceneOptionArgs = z.object({
  scene_slug: z.string().min(1).max(160).optional(),
  choice_number: z.number().int().positive().optional(),
  choice_text: z.string().min(1).max(500).optional(),
  evidence: z.string().min(3).max(600),
}).refine(
  args => args.choice_number != null || !!args.choice_text?.trim(),
  {message: 'choice_number or choice_text is required'},
);

const CloseSceneArgs = z.object({
  scene_slug: z.string().min(1).max(160).optional(),
  result: z.enum(['success', 'failure', 'neutral']).default('neutral'),
  evidence: z.string().min(3).max(600),
  outcome_summary: z.string().max(1000).optional(),
});

interface ActiveAuthoredSceneState {
  schema_version: typeof SCENE_STATE_SCHEMA;
  status: 'active' | 'closed';
  scene_slug: string;
  scene_mention: string;
  scene_entity_id: number;
  current_beat_index: number;
  selected_choices: SceneChoiceRecord[];
  opened_turn_id: string | null;
  opened_evidence: string;
  last_evidence?: string;
  result?: 'success' | 'failure' | 'neutral';
}

interface SceneChoiceRecord {
  choice_number: number | null;
  choice_text: string;
  evidence: string;
  turn_id: string | null;
}

interface PlayerMetaRow {
  current_location_id: number | null;
  metadata: unknown;
}

interface SceneEntityRow {
  id: number;
}

interface StringDeltaPlan {
  npcId: number;
  npcName: string;
  delta: number;
  line: string;
}

interface StatusPlan {
  actorId: number;
  actorName: string;
  statusKind: string;
  statusValue: string;
  intensity: number;
  line: string;
}

registerTool({
  name: 'open_authored_scene',
  description:
    'Open one imported Obsidian-authored scene by scene_slug. Sets the active scene on the player, initializes scene state fields, stores the active-scene packet, and emits scene:opened. Use exact scene_slug from SCENE INSTRUCTIONS.',
  paramsSchema: OpenSceneArgs,
  async execute(args, ctx) {
    const cartridgeCtx = await resolveActivePlayerCartridgeContext(ctx.playerId);
    const scene = await requireScene(args.scene_slug, cartridgeCtx.cartridgeId);
    const sceneEntityId = await requireSceneEntityId(
      scene.sceneSlug,
      cartridgeCtx.cartridgeId,
    );
    await assertSceneLocationFitsPlayer(ctx.playerId, scene);
    const choices = parseChoices(scene.playerChoices);
    const scenePlateUrl = await loadEntityVisualAssetUrl(
      sceneEntityId,
      'scene_plate',
    );

    const state: ActiveAuthoredSceneState = {
      schema_version: SCENE_STATE_SCHEMA,
      status: 'active',
      scene_slug: scene.sceneSlug,
      scene_mention: scene.sceneMention,
      scene_entity_id: sceneEntityId,
      current_beat_index: 0,
      selected_choices: [],
      opened_turn_id: ctx.turnId ?? null,
      opened_evidence: args.evidence,
    };

    await withTransaction(async client => {
      await ensureSceneRuntimeFields(client, sceneEntityId, scene.stateFields);
      await setSeenFieldIfPresent(client, sceneEntityId, scene.sceneSlug);
      await writeActiveSceneState(client, ctx.playerId, state);
      await client.query(
        `UPDATE players SET current_scene_id = $1 WHERE entity_id = $2`,
        [sceneEntityId, ctx.playerId],
      );
      await client.query(
        `UPDATE hero_cartridge_states
            SET current_scene_id = $1,
                updated_at = now()
          WHERE player_id = $2
            AND cartridge_id = $3
            AND status = 'active'`,
        [sceneEntityId, ctx.playerId, cartridgeCtx.cartridgeId],
      );
      await emitGuiEvent(ctx, 'scene:opened', {
        sceneSlug: scene.sceneSlug,
        sceneMention: scene.sceneMention,
        sceneEntityId,
        scenePlateUrl,
        choices,
        evidence: args.evidence,
      });
    });
    await emitEntityMediaScript(ctx, sceneEntityId, 'scene').catch((err) => {
      console.warn(
        '[open_authored_scene] scene media script failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    });

    return {
      ok: true,
      scene_slug: scene.sceneSlug,
      scene_mention: scene.sceneMention,
      scene_entity_id: sceneEntityId,
      choices,
      state_fields_initialized: scene.stateFields.length,
    };
  },
});

registerTool({
  name: 'choose_authored_scene_option',
  description:
    'Record one backend-confirmed choice inside the currently open authored scene. Use a 1-based choice_number from player_choices when possible, or exact choice_text when the player phrases it freely.',
  paramsSchema: ChooseSceneOptionArgs,
  async execute(args, ctx) {
    const cartridgeCtx = await resolveActivePlayerCartridgeContext(ctx.playerId);
    const active = await requireActiveScene(ctx.playerId, args.scene_slug);
    const scene = await requireScene(active.scene_slug, cartridgeCtx.cartridgeId);
    const choices = parseChoices(scene.playerChoices);
    const selected = resolveChoice(args, choices);
    const record: SceneChoiceRecord = {
      choice_number: selected.choiceNumber,
      choice_text: selected.choiceText,
      evidence: args.evidence,
      turn_id: ctx.turnId ?? null,
    };

    const nextState: ActiveAuthoredSceneState = {
      ...active,
      current_beat_index: Math.min(
        active.current_beat_index + 1,
        Math.max(0, splitBeats(scene.beatByBeat).length - 1),
      ),
      selected_choices: [...active.selected_choices, record],
      last_evidence: args.evidence,
    };

    await withTransaction(async client => {
      await writeActiveSceneState(client, ctx.playerId, nextState);
      await emitGuiEvent(ctx, 'scene:choice_selected', {
        sceneSlug: scene.sceneSlug,
        sceneMention: scene.sceneMention,
        sceneEntityId: active.scene_entity_id,
        choiceNumber: record.choice_number,
        choiceText: record.choice_text,
        currentBeatIndex: nextState.current_beat_index,
        evidence: args.evidence,
      });
    });
    await applyMaterializersForTrigger(ctx, 'scene_choice', {
      sourceSlug: scene.sceneSlug,
    });

    return {
      ok: true,
      scene_slug: scene.sceneSlug,
      choice_number: record.choice_number,
      choice_text: record.choice_text,
      current_beat_index: nextState.current_beat_index,
      selected_choice_count: nextState.selected_choices.length,
    };
  },
});

registerTool({
  name: 'close_authored_scene',
  description:
    'Close the active authored scene as success, failure, or neutral. Clears players.current_scene_id, persists a scene memory, applies supported Memory And String Changes, and emits scene:closed.',
  paramsSchema: CloseSceneArgs,
  async execute(args, ctx) {
    const result = args.result ?? 'neutral';
    const cartridgeCtx = await resolveActivePlayerCartridgeContext(ctx.playerId);
    const active = await requireActiveScene(ctx.playerId, args.scene_slug);
    const scene = await requireScene(active.scene_slug, cartridgeCtx.cartridgeId);
    const stringPlans = await parseStringDeltaPlans(
      scene.memoryAndStringChanges,
      ctx.playerId,
    );
    const statusPlans = await parseStatusPlans(
      scene.memoryAndStringChanges,
      ctx.playerId,
    );
    const resultText =
      args.outcome_summary?.trim() ||
      (result === 'success'
        ? scene.successResult
        : result === 'failure'
          ? scene.failureResult
          : '') ||
      `Closed authored scene ${scene.sceneMention}.`;
    const closedState: ActiveAuthoredSceneState = {
      ...active,
      status: 'closed',
      result,
      last_evidence: args.evidence,
    };
    const appliedStrings: Array<{
      npcId: number;
      npcName: string;
      delta: number;
      newValue: number;
    }> = [];
    const appliedStatuses: Array<{
      actorId: number;
      actorName: string;
      statusKind: string;
      statusValue: string;
      intensity: number;
    }> = [];
    let memoryId: number | null = null;

    await withTransaction(async client => {
      for (const plan of stringPlans) {
        await ensureStringsField(client, plan.npcId);
        const newValue = await addString(plan.npcId, ctx.playerId, plan.delta);
        appliedStrings.push({
          npcId: plan.npcId,
          npcName: plan.npcName,
          delta: plan.delta,
          newValue,
        });
        emitFieldChange(ctx.sessionId, {
          owner_entity_id: plan.npcId,
          field_key: 'strings',
          value: await readStrings(plan.npcId),
          source: 'close_authored_scene',
        });
      }
      for (const plan of statusPlans) {
        await client.query(
          `INSERT INTO actor_statuses
             (player_id, actor_entity_id, status_kind, status_value, intensity,
              source, metadata, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'close_authored_scene', $6::jsonb, now())
           ON CONFLICT (player_id, actor_entity_id, status_kind) DO UPDATE SET
             status_value = EXCLUDED.status_value,
             intensity = EXCLUDED.intensity,
             source = EXCLUDED.source,
             metadata = actor_statuses.metadata || EXCLUDED.metadata,
             updated_at = now()`,
          [
            ctx.playerId,
            plan.actorId,
            plan.statusKind,
            plan.statusValue,
            plan.intensity,
            JSON.stringify({
              scene_slug: scene.sceneSlug,
              line: plan.line,
              turn_id: ctx.turnId ?? null,
            }),
          ],
        );
        appliedStatuses.push({
          actorId: plan.actorId,
          actorName: plan.actorName,
          statusKind: plan.statusKind,
          statusValue: plan.statusValue,
          intensity: plan.intensity,
        });
        await emitGuiEvent(ctx, 'actor:status_changed', {
          actorId: plan.actorId,
          actorName: plan.actorName,
          statusKind: plan.statusKind,
          statusValue: plan.statusValue,
          intensity: plan.intensity,
          reason: plan.line,
        });
      }
      const ownerId =
        scene.ownerNpcEntityId ??
        scene.participantEntityIds[0] ??
        active.scene_entity_id;
      const memory = await MemoryService.insertNpcMemory({
        ownerEntityId: ownerId,
        aboutEntityId: ctx.playerId,
        text: compactMemoryText(scene, result, resultText, args.evidence),
        importance: result === 'neutral' ? 0.45 : 0.65,
        tags: [
          'scene',
          'authored_scene',
          `scene:${scene.sceneSlug}`,
          `result:${result}`,
        ],
        sensitive: false,
        salience: result === 'neutral' ? 0.45 : 0.65,
        memoryKind: 'authored_scene_closed',
        memoryFamily: 'scene',
        sourceTurnId: ctx.turnId ?? null,
        sourceTool: 'close_authored_scene',
        metadata: {
          scene_slug: scene.sceneSlug,
          scene_entity_id: active.scene_entity_id,
          result,
          selected_choices: active.selected_choices,
          string_deltas: appliedStrings,
          status_changes: appliedStatuses,
        },
      });
      memoryId = memory.id;
      await clearActiveSceneState(client, ctx.playerId, closedState);
      await client.query(
        `UPDATE players SET current_scene_id = NULL WHERE entity_id = $1`,
        [ctx.playerId],
      );
      await client.query(
        `UPDATE hero_cartridge_states
            SET current_scene_id = NULL,
                updated_at = now()
          WHERE player_id = $1
            AND cartridge_id = $2
            AND status = 'active'`,
        [ctx.playerId, cartridgeCtx.cartridgeId],
      );
      await emitGuiEvent(ctx, 'scene:closed', {
        sceneSlug: scene.sceneSlug,
        sceneMention: scene.sceneMention,
        sceneEntityId: active.scene_entity_id,
        result,
        outcomeSummary: resultText,
        memoryId,
        selectedChoices: active.selected_choices,
        stringDeltas: appliedStrings,
        statusChanges: appliedStatuses,
        evidence: args.evidence,
      });
    });

    return {
      ok: true,
      scene_slug: scene.sceneSlug,
      result,
      memory_id: memoryId,
      string_deltas: appliedStrings,
      status_changes: appliedStatuses,
      selected_choice_count: active.selected_choices.length,
    };
  },
});

async function requireScene(
  sceneSlug: string,
  cartridgeId: string,
): Promise<SceneInstructionEntry> {
  const scene = await findSceneInstructionEntry(sceneSlug, {cartridgeId});
  if (!scene) {
    throw new ToolExecutionError(`unknown authored scene_slug: ${sceneSlug}`, {
      rejected: true,
      suggestion: {scene_slug: sceneSlug.trim().toLowerCase()},
    });
  }
  return scene;
}

async function requireSceneEntityId(
  sceneSlug: string,
  cartridgeId: string,
): Promise<number> {
  const rows = await query<SceneEntityRow>(
    `SELECT id
       FROM entities
      WHERE kind = 'scene'
        AND profile->>'source_slug' = $1
        AND cartridge_id = $2
      LIMIT 1`,
    [sceneSlug, cartridgeId],
  );
  const id = Number(rows.rows[0]?.id ?? NaN);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ToolExecutionError(
      `authored scene entity not imported for slug: ${sceneSlug}`,
      {rejected: true, suggestion: {scene_slug: sceneSlug}},
    );
  }
  return id;
}

async function loadEntityVisualAssetUrl(
  entityId: number,
  role: string,
): Promise<string | null> {
  const rows = await query<{profile: Record<string, unknown> | null}>(
    `SELECT profile FROM entities WHERE id = $1`,
    [entityId],
  );
  const raw = rows.rows[0]?.profile?.['visual_asset_urls'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[role];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

async function assertSceneLocationFitsPlayer(
  playerId: number,
  scene: SceneInstructionEntry,
): Promise<void> {
  if (scene.locationEntityId == null) return;
  const row = await query<PlayerMetaRow>(
    `SELECT current_location_id, metadata
       FROM players
      WHERE entity_id = $1`,
    [playerId],
  );
  const current = row.rows[0]?.current_location_id ?? null;
  if (current != null && Number(current) !== scene.locationEntityId) {
    throw new ToolExecutionError(
      `authored scene ${scene.sceneSlug} belongs to location ${scene.locationEntityId}, but player is at ${current}`,
      {
        rejected: true,
        suggestion: {
          scene_slug: scene.sceneSlug,
          required_location_id: scene.locationEntityId,
        },
      },
    );
  }
}

async function requireActiveScene(
  playerId: number,
  expectedSlug?: string,
): Promise<ActiveAuthoredSceneState> {
  const rows = await query<{metadata: unknown}>(
    `SELECT metadata FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const active = parseActiveScene(readObject(rows.rows[0]?.metadata)[ACTIVE_SCENE_META_KEY]);
  if (!active) {
    throw new ToolExecutionError('no active authored scene for player', {
      rejected: true,
    });
  }
  if (
    expectedSlug &&
    active.scene_slug !== expectedSlug.trim().toLowerCase()
  ) {
    throw new ToolExecutionError(
      `active authored scene is ${active.scene_slug}, not ${expectedSlug}`,
      {
        rejected: true,
        suggestion: {scene_slug: active.scene_slug},
      },
    );
  }
  return active;
}

function parseActiveScene(value: unknown): ActiveAuthoredSceneState | null {
  const obj = readObject(value);
  if (obj['schema_version'] !== SCENE_STATE_SCHEMA) return null;
  if (obj['status'] !== 'active') return null;
  const sceneSlug = readString(obj['scene_slug']);
  const sceneMention = readString(obj['scene_mention']) || `@${sceneSlug}`;
  const sceneEntityId = readPositiveNumber(obj['scene_entity_id']);
  if (!sceneSlug || sceneEntityId == null) return null;
  const selected = Array.isArray(obj['selected_choices'])
    ? obj['selected_choices']
        .map(parseChoiceRecord)
        .filter((row): row is SceneChoiceRecord => row != null)
    : [];
  return {
    schema_version: SCENE_STATE_SCHEMA,
    status: 'active',
    scene_slug: sceneSlug,
    scene_mention: sceneMention,
    scene_entity_id: sceneEntityId,
    current_beat_index: readNonNegativeNumber(obj['current_beat_index']) ?? 0,
    selected_choices: selected,
    opened_turn_id: readString(obj['opened_turn_id']) || null,
    opened_evidence: readString(obj['opened_evidence']) || '',
    last_evidence: readString(obj['last_evidence']) || undefined,
  };
}

function parseChoiceRecord(value: unknown): SceneChoiceRecord | null {
  const obj = readObject(value);
  const choiceText = readString(obj['choice_text']);
  if (!choiceText) return null;
  return {
    choice_number: readPositiveNumber(obj['choice_number']),
    choice_text: choiceText,
    evidence: readString(obj['evidence']) || '',
    turn_id: readString(obj['turn_id']) || null,
  };
}

async function writeActiveSceneState(
  client: TxClient,
  playerId: number,
  state: ActiveAuthoredSceneState,
): Promise<void> {
  await client.query(
    `UPDATE players
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              $2::text[],
              $3::jsonb,
              true
            )
      WHERE entity_id = $1`,
    [
      playerId,
      [ACTIVE_SCENE_META_KEY],
      JSON.stringify(state),
    ],
  );
}

async function clearActiveSceneState(
  client: TxClient,
  playerId: number,
  closedState: ActiveAuthoredSceneState,
): Promise<void> {
  await client.query(
    `UPDATE players
        SET metadata =
              jsonb_set(
                COALESCE(metadata, '{}'::jsonb) - $2,
                $3::text[],
                $4::jsonb,
                true
              )
      WHERE entity_id = $1`,
    [
      playerId,
      ACTIVE_SCENE_META_KEY,
      [LAST_SCENE_META_KEY],
      JSON.stringify(closedState),
    ],
  );
}

async function ensureSceneRuntimeFields(
  client: TxClient,
  sceneEntityId: number,
  fields: readonly SceneStateField[],
): Promise<void> {
  for (const field of fields) {
    if (!field.key.trim()) continue;
    await client.query(
      `INSERT INTO runtime_fields
         (owner_entity_id, field_key, value_type, default_value,
          allowed_values, scope, scope_per_player, description)
       VALUES ($1, $2, $3, $4::jsonb, NULL, $5, $6, $7)
       ON CONFLICT (owner_entity_id, field_key) DO UPDATE SET
         value_type = EXCLUDED.value_type,
         default_value = COALESCE(runtime_fields.default_value, EXCLUDED.default_value),
         scope = EXCLUDED.scope,
         scope_per_player = EXCLUDED.scope_per_player,
         description = COALESCE(runtime_fields.description, EXCLUDED.description)`,
      [
        sceneEntityId,
        field.key,
        normalizeFieldType(field.type),
        JSON.stringify(field.default ?? null),
        field.scope ?? 'session',
        field.scope === 'journey',
        field.description ?? null,
      ],
    );
  }
}

async function setSeenFieldIfPresent(
  client: TxClient,
  sceneEntityId: number,
  sceneSlug: string,
): Promise<void> {
  const expected = `${sceneSlug}_seen`;
  await client.query(
    `INSERT INTO runtime_values (field_id, value, source, updated_at)
       SELECT id, 'true'::jsonb, 'open_authored_scene', now()
         FROM runtime_fields
        WHERE owner_entity_id = $1
          AND field_key = $2
          AND value_type = 'bool'
     ON CONFLICT (field_id)
     DO UPDATE SET value = EXCLUDED.value,
                   source = EXCLUDED.source,
                   updated_at = now()`,
    [sceneEntityId, expected],
  );
}

async function ensureStringsField(
  client: TxClient,
  npcId: number,
): Promise<void> {
  await client.query(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value,
        scope, scope_per_player, description)
     VALUES ($1, 'strings', 'json', '{}'::jsonb,
             'permanent', false, 'Relationship strings with active players.')
     ON CONFLICT (owner_entity_id, field_key) DO NOTHING`,
    [npcId],
  );
}

function normalizeFieldType(type: string): string {
  const raw = type.trim().toLowerCase();
  if (raw === 'boolean') return 'bool';
  if (raw === 'integer') return 'int';
  if (raw === 'number') return 'float';
  if (raw === 'enum') return 'string';
  if (raw === 'bool' || raw === 'int' || raw === 'float' || raw === 'string') {
    return raw;
  }
  return 'json';
}

function resolveChoice(
  args: z.infer<typeof ChooseSceneOptionArgs>,
  choices: string[],
): {choiceNumber: number | null; choiceText: string} {
  if (args.choice_number != null) {
    const choiceText = choices[args.choice_number - 1];
    if (!choiceText) {
      throw new ToolExecutionError(
        `choice_number ${args.choice_number} is not available for active scene`,
        {
          rejected: true,
          suggestion: {available_choices: choices},
        },
      );
    }
    return {choiceNumber: args.choice_number, choiceText};
  }
  return {
    choiceNumber: null,
    choiceText: args.choice_text?.trim() ?? '',
  };
}

function parseChoices(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line =>
      line
        .trim()
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 12);
}

function splitBeats(value: string): string[] {
  return parseChoices(value);
}

async function parseStringDeltaPlans(
  value: string,
  playerId: number,
): Promise<StringDeltaPlan[]> {
  const out: StringDeltaPlan[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const deltaMatch = line.match(/([+-])\s*(?:(\d+)\s*)?strings?\b/i);
    if (!deltaMatch) continue;
    const mentions = extractMentionNames(line);
    if (mentions.length === 0) continue;
    const deltaBase = deltaMatch[2] ? Number(deltaMatch[2]) : /strong/i.test(line) ? 2 : 1;
    const delta = deltaMatch[1] === '-' ? -deltaBase : deltaBase;
    for (const mention of mentions) {
      const npc = await resolveMentionEntity(mention, playerId);
      if (!npc) continue;
      out.push({npcId: npc.id, npcName: npc.name, delta, line});
      if (out.length >= 8) return out;
    }
  }
  return out;
}

async function parseStatusPlans(
  value: string,
  playerId: number,
): Promise<StatusPlan[]> {
  const out: StatusPlan[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/\bstatus\b/i.test(line)) continue;
    const mentions = extractMentionNames(line);
    if (mentions.length === 0) continue;
    const statusKind = parseStatusKind(line);
    if (!statusKind) continue;
    const statusValue = parseStatusValue(line, statusKind);
    const intensityMatch = line.match(/\bintensity\s*[:=]?\s*(0(?:\.\d+)?|1(?:\.0+)?)\b/i);
    const intensity = intensityMatch ? Number(intensityMatch[1]) : 0.5;
    for (const mention of mentions) {
      const actor = await resolveMentionEntity(mention, playerId);
      if (!actor) continue;
      out.push({
        actorId: actor.id,
        actorName: actor.name,
        statusKind,
        statusValue,
        intensity: Math.max(0, Math.min(1, intensity)),
        line,
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

async function resolveMentionEntity(
  mention: string,
  playerId: number,
): Promise<{id: number; name: string} | null> {
  const name = mention.trim().replace(/[’']s\b.*$/i, '').trim();
  if (!name) return null;
  const slug = slugify(name);
  const rows = await query<{id: number; display_name: string}>(
    `SELECT id, display_name
       FROM entities
      WHERE id <> $3
        AND (
          lower(display_name) = lower($1)
          OR profile->>'source_slug' = $2
        )
      ORDER BY CASE WHEN lower(display_name) = lower($1) THEN 0 ELSE 1 END
      LIMIT 1`,
    [name, slug, playerId],
  );
  const row = rows.rows[0];
  return row ? {id: Number(row.id), name: row.display_name} : null;
}

function extractMentionNames(line: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of line.matchAll(/`?@([^`:\n,;]+)`?/g)) {
    const name = cleanMentionTail(match[1]?.trim() ?? '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function cleanMentionTail(value: string): string {
  return value
    .replace(
      /\s+\b(?:trust|fear|hostile|wounded|missing|dead|companion|status|intensity)\b.*$/i,
      '',
    )
    .replace(/\s+\band\s+@.*$/i, '')
    .trim();
}

function parseStatusKind(line: string): string | null {
  const lowered = line.toLowerCase();
  for (const kind of [
    'trust',
    'fear',
    'hostile',
    'wounded',
    'missing',
    'dead',
    'companion',
  ]) {
    if (new RegExp(`\\b${kind}\\b`, 'i').test(lowered)) return kind;
  }
  return null;
}

function parseStatusValue(line: string, kind: string): string {
  const afterKind = line.split(new RegExp(`\\b${kind}\\b\\s*[:=]?`, 'i'), 2)[1];
  const raw = (afterKind ?? kind)
    .replace(/\bintensity\s*[:=]?\s*\d+(?:\.\d+)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-:;.,\s]+|[-:;.,\s]+$/g, '');
  return (raw || kind).slice(0, 80);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compactMemoryText(
  scene: SceneInstructionEntry,
  result: 'success' | 'failure' | 'neutral',
  summary: string,
  evidence: string,
): string {
  return [
    `${scene.sceneMention} closed as ${result}.`,
    summary,
    `Evidence: ${evidence}`,
  ]
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
