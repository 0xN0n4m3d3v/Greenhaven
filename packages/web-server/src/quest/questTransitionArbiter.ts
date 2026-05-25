/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';
import {dispatch, type ToolResult} from '../tools/base.js';
import type {ToolHistoryEntry} from '../sessionManager.js';

export interface QuestTransitionProposal {
  source: 'quest_engine' | 'quest_watcher' | 'broker_tool';
  sessionId: string;
  playerId: number;
  turnId: string;
  questId: number;
  expectedCurrentStageId?: string | null;
  action: 'start' | 'advance' | 'complete' | 'fail';
  toStage?: string;
  outcome?: 'completed' | 'failed';
  reason: string;
  evidenceToolInvocationIds?: number[];
  turnToolHistory?: ToolHistoryEntry[];
}

export type QuestTransitionVerdict =
  | {
      ok: true;
      dispatchTool: 'start_quest' | 'advance_quest' | 'complete_quest';
      dispatchArgs: Record<string, unknown>;
      dedupeKey: string;
    }
  | {
      ok: false;
      reason: string;
      diagnosticPayload: Record<string, unknown>;
    };

export type QuestTransitionApplication =
  | {
      applied: true;
      verdict: Extract<QuestTransitionVerdict, {ok: true}>;
      result: ToolResult;
    }
  | {
      applied: false;
      verdict: Extract<QuestTransitionVerdict, {ok: false}>;
    };

interface QuestState {
  questId: number;
  title: string;
  profile: Record<string, unknown>;
  status: string | null;
  currentStageId: string | null;
}

export async function applyQuestTransitionProposal(
  proposal: QuestTransitionProposal,
): Promise<QuestTransitionApplication> {
  const startedAt = Date.now();
  const verdict = await validateQuestTransitionProposal(proposal);
  if (!verdict.ok) {
    await recordArbiterTelemetry(proposal, verdict.reason, Date.now() - startedAt);
    return {applied: false, verdict};
  }

  const result = await dispatch(verdict.dispatchTool, verdict.dispatchArgs, {
    sessionId: proposal.sessionId,
    playerId: proposal.playerId,
    turnId: proposal.turnId,
    toolHistorySource: proposal.source === 'quest_watcher' ? 'direct' : 'direct',
  });
  if (!result.ok) {
    await recordArbiterTelemetry(
      proposal,
      `dispatch_failed:${result.error ?? 'unknown'}`,
      Date.now() - startedAt,
    );
    return {
      applied: false,
      verdict: {
        ok: false,
        reason: 'dispatch_failed',
        diagnosticPayload: {
          ...baseDiagnostic(proposal),
          dispatchTool: verdict.dispatchTool,
          dispatchError: result.error ?? null,
        },
      },
    };
  }

  await recordArbiterTelemetry(proposal, 'applied', Date.now() - startedAt);
  return {applied: true, verdict, result};
}

export async function validateQuestTransitionProposal(
  proposal: QuestTransitionProposal,
): Promise<QuestTransitionVerdict> {
  const state = await loadQuestState(proposal.playerId, proposal.questId);
  if (!state) {
    return reject(proposal, 'quest_not_found');
  }

  const duplicate = await findSameTurnQuestMutation(proposal, state.title);
  if (duplicate) {
    return reject(proposal, 'already_handled_same_turn', {
      duplicateTool: duplicate.toolName,
      duplicateInvocationId: duplicate.invocationId,
      duplicateSource: duplicate.source,
    });
  }

  if (proposal.action === 'start') {
    if (state.status != null) {
      return reject(proposal, 'quest_already_known', {status: state.status});
    }
    return {
      ok: true,
      dispatchTool: 'start_quest',
      dispatchArgs: {quest_id: proposal.questId, player_id: proposal.playerId},
      dedupeKey: dedupeKey(proposal),
    };
  }

  if (state.status == null) {
    return reject(proposal, 'quest_not_started');
  }
  if (state.status !== 'active') {
    return reject(proposal, 'quest_not_active', {status: state.status});
  }
  if (
    proposal.expectedCurrentStageId !== undefined &&
    normalizedNullable(proposal.expectedCurrentStageId) !== normalizedNullable(state.currentStageId)
  ) {
    return reject(proposal, 'stale_current_stage', {
      expectedCurrentStageId: proposal.expectedCurrentStageId ?? null,
      currentStageId: state.currentStageId,
    });
  }
  if (!hasConcreteEvidence(proposal)) {
    return reject(proposal, 'missing_concrete_evidence');
  }

  if (proposal.action === 'advance') {
    const toStage = proposal.toStage?.trim();
    if (!toStage) return reject(proposal, 'missing_to_stage');
    if (!isLegalQuestStageTransition(state.profile, state.currentStageId, toStage)) {
      return reject(proposal, 'illegal_stage_transition', {
        currentStageId: state.currentStageId,
        toStage,
      });
    }
    const locationEvidence = await validateSpawnedLocationStageEvidence(
      proposal,
      state,
      toStage,
    );
    if (!locationEvidence.ok) {
      return reject(proposal, locationEvidence.reason, locationEvidence.extra);
    }
    const itemEvidence = await validateQuestItemStageEvidence(
      proposal,
      state,
      toStage,
    );
    if (!itemEvidence.ok) {
      return reject(proposal, itemEvidence.reason, itemEvidence.extra);
    }
    return {
      ok: true,
      dispatchTool: 'advance_quest',
      dispatchArgs: {
        quest_id: proposal.questId,
        player_id: proposal.playerId,
        to_stage: toStage,
      },
      dedupeKey: dedupeKey(proposal),
    };
  }

  if (proposal.action === 'complete' || proposal.action === 'fail') {
    const outcome =
      proposal.action === 'fail' ? 'failed' : proposal.outcome ?? 'completed';
    if (outcome === 'completed' && !isTerminalQuestStage(state.profile, state.currentStageId)) {
      return reject(proposal, 'stage_not_terminal', {
        currentStageId: state.currentStageId,
      });
    }
    return {
      ok: true,
      dispatchTool: 'complete_quest',
      dispatchArgs: {
        quest_id: proposal.questId,
        player_id: proposal.playerId,
        outcome,
      },
      dedupeKey: dedupeKey(proposal),
    };
  }

  return reject(proposal, 'unsupported_action');
}

export function isLegalQuestStageTransition(
  profile: Record<string, unknown>,
  currentStageId: string | null,
  toStage: string,
): boolean {
  const stages = readStages(profile);
  if (!toStage || stages.length === 0) return false;
  const currentIndex = stages.findIndex(stage => stage.id === currentStageId);
  if (currentIndex < 0) return false;
  const current = stages[currentIndex]!;
  const allowed = new Set<string>();
  if (typeof current.nextStage === 'string' && current.nextStage.length > 0) {
    allowed.add(current.nextStage);
  }
  for (const option of current.choiceTargets) {
    allowed.add(option);
  }
  if (allowed.size === 0 && currentIndex + 1 < stages.length) {
    allowed.add(stages[currentIndex + 1]!.id);
  }
  return allowed.has(toStage);
}

export function isTerminalQuestStage(
  profile: Record<string, unknown>,
  currentStageId: string | null,
): boolean {
  const stages = readStages(profile);
  if (stages.length === 0) return true;
  const currentIndex = stages.findIndex(stage => stage.id === currentStageId);
  if (currentIndex < 0) return false;
  const current = stages[currentIndex]!;
  return (
    current.nextStage == null ||
    current.nextStage === '' ||
    currentIndex === stages.length - 1
  );
}

async function loadQuestState(
  playerId: number,
  questId: number,
): Promise<QuestState | null> {
  const row = await query<{
    quest_id: number;
    title: string;
    profile: Record<string, unknown> | null;
    status: string | null;
    current_stage_id: string | null;
  }>(
    `SELECT e.id AS quest_id,
            e.display_name AS title,
            e.profile,
            pq.status,
            pq.current_stage_id
       FROM entities e
       LEFT JOIN player_quests pq
         ON pq.quest_entity_id = e.id AND pq.player_id = $2
      WHERE e.id = $1
        AND e.kind = 'quest'
      LIMIT 1`,
    [questId, playerId],
  );
  const found = row.rows[0];
  if (!found) return null;
  return {
    questId: Number(found.quest_id),
    title: found.title,
    profile:
      found.profile && typeof found.profile === 'object' && !Array.isArray(found.profile)
        ? found.profile
        : {},
    status: found.status,
    currentStageId: found.current_stage_id,
  };
}

async function findSameTurnQuestMutation(
  proposal: QuestTransitionProposal,
  questTitle: string,
): Promise<{source: 'history' | 'audit'; toolName: string; invocationId?: number} | null> {
  const toolNames = new Set(['advance_quest', 'complete_quest']);
  if (proposal.action === 'start') toolNames.add('start_quest');

  for (const entry of proposal.turnToolHistory ?? []) {
    if (!entry.ok || !toolNames.has(entry.name)) continue;
    if (questRecordMatches(entry.args, proposal.questId, questTitle)) {
      return {source: 'history', toolName: entry.name};
    }
    if (questRecordMatches(entry.result, proposal.questId, questTitle)) {
      return {source: 'history', toolName: entry.name};
    }
  }

  const rootTurnId = rootTurn(proposal.turnId);
  const auditToolSql =
    proposal.action === 'start'
      ? "('start_quest', 'advance_quest', 'complete_quest')"
      : "('advance_quest', 'complete_quest')";
  const audit = await query<{
    id: number | string;
    tool_name: string;
  }>(
    `SELECT id, tool_name
       FROM tool_invocations
      WHERE session_id = $1
        AND (turn_id = $2 OR turn_id LIKE ($2 || ':%'))
        AND tool_name IN ${auditToolSql}
        AND error IS NULL
        AND (
          args->>'quest_id' = $3
          OR args->>'quest_entity_id' = $3
          OR result->>'quest_id' = $3
          OR result->>'quest_entity_id' = $3
          OR LOWER(COALESCE(args->>'quest', '')) = LOWER($4)
        )
      ORDER BY id ASC
      LIMIT 1`,
    [proposal.sessionId, rootTurnId, String(proposal.questId), questTitle],
  );
  const row = audit.rows[0];
  if (!row) return null;
  if (!toolNames.has(row.tool_name)) return null;
  return {
    source: 'audit',
    toolName: row.tool_name,
    invocationId: Number(row.id),
  };
}

function questRecordMatches(
  record: unknown,
  questId: number,
  questTitle: string,
): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const data = record as Record<string, unknown>;
  return [
    data['quest_id'],
    data['quest_entity_id'],
    data['quest'],
  ].some(value => questRefMatches(value, questId, questTitle));
}

function questRefMatches(
  value: unknown,
  questId: number,
  questTitle: string,
): boolean {
  if (value == null) return false;
  if (typeof value === 'number') return value === questId;
  const text = String(value).trim();
  if (!text) return false;
  if (text === String(questId)) return true;
  return text.toLowerCase() === questTitle.toLowerCase();
}

function hasConcreteEvidence(proposal: QuestTransitionProposal): boolean {
  if ((proposal.evidenceToolInvocationIds?.length ?? 0) > 0) return true;
  if ((proposal.turnToolHistory?.length ?? 0) > 0) return true;
  return proposal.reason.trim().length >= 12;
}

async function validateSpawnedLocationStageEvidence(
  proposal: QuestTransitionProposal,
  state: QuestState,
  toStage: string,
): Promise<
  | {ok: true}
  | {ok: false; reason: string; extra: Record<string, unknown>}
> {
  if (proposal.source !== 'quest_watcher') return {ok: true};
  if (!isTerminalQuestStage(state.profile, toStage)) return {ok: true};

  const spawnedLocationIds = await loadSpawnedLocationIds(state.profile);
  if (spawnedLocationIds.length === 0) return {ok: true};
  const spawned = new Set(spawnedLocationIds);

  for (const entry of proposal.turnToolHistory ?? []) {
    if (!entry.ok || entry.name !== 'move_player') continue;
    const argsTarget = readPositiveId(asRecord(entry.args)['target_location_id']);
    const resultTarget = readPositiveId(asRecord(entry.result)['toId']);
    if ((argsTarget != null && spawned.has(argsTarget)) ||
        (resultTarget != null && spawned.has(resultTarget))) {
      return {ok: true};
    }
  }

  const player = await query<{current_location_id: number | string | null}>(
    `SELECT current_location_id
       FROM players
      WHERE entity_id = $1`,
    [proposal.playerId],
  );
  const currentLocationId = readPositiveId(player.rows[0]?.current_location_id);
  if (currentLocationId != null && spawned.has(currentLocationId)) {
    return {ok: true};
  }

  return {
    ok: false,
    reason: 'spawned_location_stage_without_move_player',
    extra: {
      toStage,
      currentLocationId,
      spawnedLocationIds,
      requiredTool: 'move_player',
    },
  };
}

async function validateQuestItemStageEvidence(
  proposal: QuestTransitionProposal,
  state: QuestState,
  toStage: string,
): Promise<
  | {ok: true}
  | {ok: false; reason: string; extra: Record<string, unknown>}
> {
  if (proposal.source !== 'quest_watcher') return {ok: true};
  if (!stageRequiresPlayerHeldQuestItem(state.profile, state.currentStageId, toStage)) {
    return {ok: true};
  }

  const itemEntityIds = readQuestItemEntityIds(state.profile);
  if (itemEntityIds.length === 0) return {ok: true};

  const holders = await loadQuestItemHolders(itemEntityIds);
  const notCarried = itemEntityIds.filter(
    itemId =>
      !holders.some(
        holder =>
          holder.itemEntityId === itemId &&
          holder.holderEntityId === proposal.playerId,
      ),
  );
  if (notCarried.length === 0) return {ok: true};

  return {
    ok: false,
    reason: 'quest_item_not_carried_for_delivery_stage',
    extra: {
      currentStageId: state.currentStageId,
      toStage,
      requiredHolderEntityId: proposal.playerId,
      itemEntityIds,
      notCarried,
      holders,
    },
  };
}

function stageRequiresPlayerHeldQuestItem(
  profile: Record<string, unknown>,
  currentStageId: string | null,
  toStage: string,
): boolean {
  const stages = readStages(profile);
  const current = stages.find(stage => stage.id === currentStageId);
  const next = stages.find(stage => stage.id === toStage);
  const text = [
    current?.id,
    current?.title,
    next?.id,
    next?.title,
    profile['goal'],
  ]
    .filter(value => typeof value === 'string')
    .join(' ');
  return QUEST_ITEM_CARRY_STAGE_RE.test(text);
}

// LANGUAGE-REGEX-OK: cartridge-author keyword heuristic for "this quest stage involves carrying a quest item" — operates over English+Russian quest-stage titles authored by the cartridge writer, not over player chat. The 26-language broker classifier is bypassed deliberately here because the input is authored text in a known cartridge language pair, not a player utterance. Tracked in critique-report/fixspecs/16_tier5_quality.md#x-cross for future cartridge-meta migration.
const QUEST_ITEM_CARRY_STAGE_RE =
  /\b(deliver|delivery|carry|courier|hand[_ -]?off|letter|envelope|parcel|package)\b|достав|нести|отнес|переда|письм|конверт|посылк|ящик/i;

function readQuestItemEntityIds(profile: Record<string, unknown>): number[] {
  const raw = Array.isArray(profile['quest_items'])
    ? (profile['quest_items'] as Array<Record<string, unknown>>)
    : [];
  return raw
    .map(item => readPositiveId(item['entity_id']))
    .filter((id): id is number => id != null);
}

async function loadQuestItemHolders(
  itemEntityIds: readonly number[],
): Promise<Array<{
  itemEntityId: number;
  holderEntityId: number;
  holderName: string | null;
  count: number;
}>> {
  if (itemEntityIds.length === 0) return [];
  const rows = await query<{
    item_entity_id: number | string;
    holder_entity_id: number | string;
    holder_name: string | null;
    count: number | string;
  }>(
    `SELECT ie.item_entity_id,
            ie.holder_entity_id,
            holder.display_name AS holder_name,
            ie.count
       FROM inventory_entries ie
       LEFT JOIN entities holder ON holder.id = ie.holder_entity_id
      WHERE ie.item_entity_id = ANY($1::bigint[])
        AND ie.count > 0
     UNION ALL
     SELECT i.legacy_entity_id AS item_entity_id,
            pi.player_id AS holder_entity_id,
            holder.display_name AS holder_name,
            pi.quantity AS count
       FROM items i
       JOIN player_inventory pi ON pi.item_id = i.id
       LEFT JOIN entities holder ON holder.id = pi.player_id
      WHERE i.legacy_entity_id = ANY($1::bigint[])
        AND pi.quantity > 0`,
    [itemEntityIds],
  );
  return rows.rows.flatMap(row => {
    const itemEntityId = readPositiveId(row.item_entity_id);
    const holderEntityId = readPositiveId(row.holder_entity_id);
    if (itemEntityId == null || holderEntityId == null) return [];
    return [{
      itemEntityId,
      holderEntityId,
      holderName: row.holder_name ?? null,
      count: Number(row.count),
    }];
  });
}

async function loadSpawnedLocationIds(
  profile: Record<string, unknown>,
): Promise<number[]> {
  const spawned = profile['spawned_entities'];
  if (!spawned || typeof spawned !== 'object' || Array.isArray(spawned)) {
    return [];
  }
  const ids = Object.values(spawned as Record<string, unknown>)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0);
  if (ids.length === 0) return [];
  const rows = await query<{id: number}>(
    `SELECT id
       FROM entities
      WHERE id = ANY($1::bigint[])
        AND kind = 'location'`,
    [ids],
  );
  return rows.rows.map(row => Number(row.id));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPositiveId(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function reject(
  proposal: QuestTransitionProposal,
  reason: string,
  extra: Record<string, unknown> = {},
): QuestTransitionVerdict {
  return {
    ok: false,
    reason,
    diagnosticPayload: {
      ...baseDiagnostic(proposal),
      reason,
      ...extra,
    },
  };
}

function baseDiagnostic(proposal: QuestTransitionProposal): Record<string, unknown> {
  return {
    source: proposal.source,
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    playerId: proposal.playerId,
    questId: proposal.questId,
    action: proposal.action,
    toStage: proposal.toStage ?? null,
    outcome: proposal.outcome ?? null,
  };
}

function dedupeKey(proposal: QuestTransitionProposal): string {
  return [
    'quest-transition',
    proposal.sessionId,
    rootTurn(proposal.turnId),
    proposal.playerId,
    proposal.questId,
    proposal.action,
    proposal.toStage ?? proposal.outcome ?? '',
  ].join(':');
}

function normalizedNullable(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function rootTurn(turnId: string): string {
  const index = turnId.indexOf(':');
  return index > 0 ? turnId.slice(0, index) : turnId;
}

function readStages(profile: Record<string, unknown>): Array<{
  id: string;
  title: string;
  nextStage: string | null;
  choiceTargets: string[];
}> {
  const raw = Array.isArray(profile['stages'])
    ? (profile['stages'] as Array<Record<string, unknown>>)
    : [];
  return raw.flatMap(stage => {
    const id = typeof stage['id'] === 'string' ? stage['id'].trim() : '';
    if (!id) return [];
    const next = stage['next_stage'];
    const choiceTargets: string[] = [];
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      const options = Array.isArray((next as Record<string, unknown>)['options'])
        ? ((next as Record<string, unknown>)['options'] as Array<Record<string, unknown>>)
        : [];
      for (const option of options) {
        const target = option['target_stage_id'];
        if (typeof target === 'string' && target.trim()) {
          choiceTargets.push(target.trim());
        }
      }
    }
    return [{
      id,
      title: typeof stage['title'] === 'string' ? stage['title'].trim() : '',
      nextStage: typeof next === 'string' && next.trim() ? next.trim() : null,
      choiceTargets,
    }];
  });
}

async function recordArbiterTelemetry(
  proposal: QuestTransitionProposal,
  status: string,
  durationMs: number,
): Promise<void> {
  try {
    await query(
      `INSERT INTO turn_telemetry
         (session_id, turn_id, role, model_id, thinking, input_tokens,
          output_tokens, cache_hit_tokens, cache_miss_tokens,
          duration_ms, cost_usd, player_id, tier)
       VALUES ($1,$2,$3,$4,false,0,0,0,0,$5,0,$6,$7)`,
      [
        proposal.sessionId,
        proposal.turnId,
        `quest_transition_arbiter:${proposal.source}:${status.slice(0, 80)}`,
        'deterministic',
        durationMs,
        proposal.playerId,
        null,
      ],
    );
  } catch (err) {
    // Diagnostics must not affect quest processing, but log so
    // silent telemetry gaps don't mask quest bugs.
    // VOID-FF-OK: the dynamic-import callback itself records `telemetry.write_failed` through the facade; the load-or-record-failure is a tertiary diagnostic and any rejection here would still be reported via the same facade's internal sink-rejection logger.
    void import('../telemetry/index.js').then(({telemetry}) =>
      telemetry.record({
        channel: 'gameplay',
        name: 'telemetry.write_failed',
        error: err,
        data: {agent: 'quest_transition_arbiter', function: 'diagnosticsWrite'},
      }),
    );
  }
}
