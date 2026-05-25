/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 138: read-only quest conductor packet. Existing questEngine and
// questTransitionArbiter remain authority; this module only frames state.

import {query} from '../db.js';
import {
  selectQuestActorMemoryIds,
  selectQuestTagMemoryIds,
  selectRecentFailureMemoryExists,
} from '../domain/memory/index.js';
import {evaluateObjective} from './objectiveEvaluators.js';
import {isLegalQuestStageTransition} from './questTransitionArbiter.js';
import {
  isDynamicQuestProfile,
  readDynamicQuestPlan,
  type DynamicQuestPlanOverlay,
} from './dynamicQuestPlan.js';
import {recommendedSpecialistsForPhase} from './questDirectorSpecialists.js';

export type QuestDirectorPhase =
  | 'mobilizing'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'blocked'
  | 'recovering'
  | 'settled';

export interface QuestDirectorPacket {
  questId: number;
  title: string;
  status: string;
  currentStageId: string | null;
  phase: QuestDirectorPhase;
  stageProgress: {
    currentIndex: number;
    totalStages: number;
    objectiveCount: number;
    satisfiedObjectiveCount: number;
  };
  requiredActions: string[];
  blockers: string[];
  legalTransitions: string[];
  relevantActorIds: number[];
  relevantMemoryIds: number[];
  recommendedSpecialists: string[];
  dynamicPlan?: DynamicQuestPlanOverlay;
}

interface QuestRow {
  quest_entity_id: number;
  title: string;
  status: string;
  current_stage_id: string | null;
  profile: Record<string, unknown> | null;
  tags: string[] | null;
  // ARCH-19 pre-Phase-4 hardening — normalized column read so
  // dynamic-quest detection does not depend on the soon-to-be-dropped
  // `profile.origin` JSONB key.
  dynamic_origin: boolean | null;
  accumulated_state: unknown;
  started_at: Date | string | null;
}

interface StageInfo {
  id: string;
  index: number;
  objectives: Array<Record<string, unknown>>;
  prerequisites: Array<Record<string, unknown>>;
  nextTargets: string[];
}

export async function buildQuestDirectorPacket(args: {
  playerId: number;
  questId: number;
  sessionId?: string;
  recentToolCalls?: Array<{name: string; args: Record<string, unknown>}>;
}): Promise<QuestDirectorPacket | null> {
  const row = await loadQuestRow(args.playerId, args.questId);
  if (!row) return null;
  return buildQuestDirectorPacketFromRow(row, {
    playerId: args.playerId,
    sessionId: args.sessionId ?? '',
    recentToolCalls: args.recentToolCalls ?? [],
  });
}

export async function buildQuestDirectorPacketsForPlayer(args: {
  playerId: number;
  sessionId?: string;
  limit?: number;
}): Promise<QuestDirectorPacket[]> {
  const rows = await query<QuestRow>(
    `SELECT pq.quest_entity_id,
            e.display_name AS title,
            pq.status,
            pq.current_stage_id,
            e.profile,
            e.tags,
            e.dynamic_origin,
            pq.accumulated_state,
            pq.started_at
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status IN ('active', 'offered', 'completed', 'failed')
      ORDER BY CASE WHEN pq.status = 'active' THEN 0 ELSE 1 END,
               pq.started_at NULLS LAST,
               pq.quest_entity_id
      LIMIT $2`,
    [args.playerId, args.limit ?? 3],
  );
  const packets: QuestDirectorPacket[] = [];
  for (const row of rows.rows) {
    const packet = await buildQuestDirectorPacketFromRow(row, {
      playerId: args.playerId,
      sessionId: args.sessionId ?? '',
      recentToolCalls: [],
    });
    packets.push(packet);
  }
  return packets;
}

export function renderQuestDirectorPacket(packet: QuestDirectorPacket): string {
  const lines = [
    `Quest Director: phase=${packet.phase}; progress=${packet.stageProgress.currentIndex}/${packet.stageProgress.totalStages}; objectives=${packet.stageProgress.satisfiedObjectiveCount}/${packet.stageProgress.objectiveCount}.`,
  ];
  if (packet.requiredActions.length > 0) {
    lines.push(`  Required: ${packet.requiredActions.join(' | ')}`);
  }
  if (packet.blockers.length > 0) {
    lines.push(`  Blockers: ${packet.blockers.join(' | ')}`);
  }
  if (packet.legalTransitions.length > 0) {
    lines.push(`  Legal transitions: ${packet.legalTransitions.join(', ')}`);
  }
  if (packet.relevantMemoryIds.length > 0) {
    lines.push(`  Relevant memories: ${packet.relevantMemoryIds.join(', ')}`);
  }
  if (packet.recommendedSpecialists.length > 0) {
    lines.push(`  Specialists: ${packet.recommendedSpecialists.join(', ')}`);
  }
  if (packet.dynamicPlan) {
    const active = packet.dynamicPlan.steps.find(
      (step) => step.status === 'in_progress',
    );
    lines.push(
      `  Dynamic plan: ${packet.dynamicPlan.steps.length} steps; active=${active?.id ?? 'none'}`,
    );
  }
  return lines.join('\n');
}

async function buildQuestDirectorPacketFromRow(
  row: QuestRow,
  ctx: {
    playerId: number;
    sessionId: string;
    recentToolCalls: Array<{name: string; args: Record<string, unknown>}>;
  },
): Promise<QuestDirectorPacket> {
  const profile = objectOrEmpty(row.profile);
  const stages = readStages(profile);
  const current = stages.find((stage) => stage.id === row.current_stage_id);
  const objectiveResults = current
    ? await Promise.all(
        current.objectives.map((objective) =>
          evaluateObjective(objective, {
            playerId: ctx.playerId,
            sessionId: ctx.sessionId,
            recentToolCalls: ctx.recentToolCalls,
          }),
        ),
      )
    : [];
  const prereqResults = current
    ? await Promise.all(
        current.prerequisites.map((objective) =>
          evaluateObjective(objective, {
            playerId: ctx.playerId,
            sessionId: ctx.sessionId,
            recentToolCalls: ctx.recentToolCalls,
          }),
        ),
      )
    : [];
  const satisfiedObjectiveCount = objectiveResults.filter(
    (result) => result.satisfied,
  ).length;
  const blockers: string[] = [];
  if (row.status === 'active' && stages.length === 0) {
    blockers.push('quest profile has no stages');
  }
  if (row.status === 'active' && !current) {
    blockers.push('current_stage_id does not match a quest stage');
  }
  prereqResults.forEach((result, index) => {
    if (!result.satisfied) {
      blockers.push(`prerequisite ${index + 1} not satisfied: ${result.detail ?? 'missing evidence'}`);
    }
  });

  const legalTransitions =
    current?.nextTargets.filter((target) =>
      isLegalQuestStageTransition(profile, row.current_stage_id, target),
    ) ?? [];
  if (
    row.status === 'active' &&
    current &&
    current.nextTargets.length > 0 &&
    legalTransitions.length === 0
  ) {
    blockers.push('declared next stage is not legal according to arbiter');
  }

  // ARCH-19 pre-Phase-4 hardening — pass the normalized
  // `entities.dynamic_origin` column so the upcoming JSONB drop
  // cannot demote a runtime-spawned quest to "authored".
  const dynamic = isDynamicQuestProfile(profile, row.tags ?? [], {
    dynamicOriginColumn: row.dynamic_origin,
  });
  const dynamicPlanResult = readDynamicQuestPlan(row.accumulated_state);
  if (dynamic && !dynamicPlanResult.ok) {
    blockers.push(...dynamicPlanResult.errors.slice(0, 2));
  }
  const accumulated = objectOrEmpty(row.accumulated_state);
  if (accumulated['timeout_failure'] === true || accumulated['pending_failure'] === true) {
    blockers.push('quest accumulated_state marks a timeout or pending failure');
  }

  const allObjectivesSatisfied =
    current != null &&
    current.objectives.length > 0 &&
    satisfiedObjectiveCount === current.objectives.length;
  const actors = relevantActorIds(profile).slice(0, 6);
  const relevantMemoryIdsForQuest = await loadRelevantMemoryIds({
    playerId: ctx.playerId,
    questId: Number(row.quest_entity_id),
    actorIds: actors,
    dynamicPlan: dynamicPlanResult.plan,
  });
  const hasFailureMemory = await hasRecentFailureMemory({
    playerId: ctx.playerId,
    actorIds: actors,
  });
  const phase = selectPhase({
    status: row.status,
    blocked: blockers.length > 0,
    dynamic,
    hasValidDynamicPlan: dynamicPlanResult.ok,
    allObjectivesSatisfied,
    current,
    hasFailureMemory,
  });
  return {
    questId: Number(row.quest_entity_id),
    title: row.title,
    status: row.status,
    currentStageId: row.current_stage_id,
    phase,
    stageProgress: {
      currentIndex: current ? current.index + 1 : 0,
      totalStages: stages.length,
      objectiveCount: current?.objectives.length ?? 0,
      satisfiedObjectiveCount,
    },
    requiredActions: requiredActionsForPhase(phase, dynamic),
    blockers: blockers.slice(0, 6),
    legalTransitions: legalTransitions.slice(0, 6),
    relevantActorIds: actors,
    relevantMemoryIds: relevantMemoryIdsForQuest,
    recommendedSpecialists: recommendedSpecialistsForPhase(phase),
    dynamicPlan: dynamic && dynamicPlanResult.ok ? dynamicPlanResult.plan : undefined,
  };
}

function selectPhase(input: {
  status: string;
  blocked: boolean;
  dynamic: boolean;
  hasValidDynamicPlan: boolean;
  allObjectivesSatisfied: boolean;
  current?: StageInfo;
  hasFailureMemory?: boolean;
}): QuestDirectorPhase {
  if (input.status === 'completed' || input.status === 'failed') return 'settled';
  if (input.status !== 'active') return 'mobilizing';
  if (input.hasFailureMemory) return 'recovering';
  if (input.blocked) return 'blocked';
  if (input.dynamic && !input.hasValidDynamicPlan) return 'planning';
  if (input.allObjectivesSatisfied) return 'reviewing';
  return 'executing';
}

function requiredActionsForPhase(
  phase: QuestDirectorPhase,
  dynamic: boolean,
): string[] {
  switch (phase) {
    case 'mobilizing':
      return ['Read current quest state before narrating progress.'];
    case 'planning':
      return dynamic
        ? ['Create or repair a 3-7 step dynamic quest plan overlay.']
        : ['Use authored quest stages; do not invent a parallel plan.'];
    case 'executing':
      return ['Resolve current stage objectives through tools, dice, inventory, runtime fields, or accepted narrative.'];
    case 'reviewing':
      return ['Let questEngine/questTransitionArbiter validate transition before claiming progress.'];
    case 'blocked':
      return ['Resolve named blockers before advancing or completing the quest.'];
    case 'recovering':
      return ['Read failure memories and choose a safer route before retrying.'];
    case 'settled':
      return ['Do not mutate settled quest state unless a new quest is opened.'];
  }
}

function relevantActorIds(profile: Record<string, unknown>): number[] {
  const keys = [
    'giver_entity_id',
    'giver_id',
    'source_entity_id',
    'quest_giver_id',
    'beneficiary_entity_id',
    'partner_entity_id',
    'target_entity_id',
  ];
  return [
    ...new Set(
      keys
        .map((key) => Number(profile[key]))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
}

function relevantMemoryIds(plan?: DynamicQuestPlanOverlay): number[] {
  if (!plan) return [];
  return [
    ...new Set(plan.steps.flatMap((step) => step.memoryIds)),
  ];
}

async function loadRelevantMemoryIds(args: {
  playerId: number;
  questId: number;
  actorIds: number[];
  dynamicPlan?: DynamicQuestPlanOverlay;
}): Promise<number[]> {
  const ids = new Set<number>(relevantMemoryIds(args.dynamicPlan));
  const actorIds = await selectQuestActorMemoryIds({
    actorEntityIds: args.actorIds,
    playerEntityId: args.playerId,
    limit: 8,
  });
  actorIds.forEach(id => ids.add(id));
  const tagIds = await selectQuestTagMemoryIds({
    tags: [`quest:${args.questId}`, `entity:${args.questId}`],
    limit: 6,
  });
  tagIds.forEach(id => ids.add(id));
  return [...ids].filter(id => Number.isInteger(id) && id > 0).slice(0, 8);
}

async function hasRecentFailureMemory(args: {
  playerId: number;
  actorIds: number[];
}): Promise<boolean> {
  return selectRecentFailureMemoryExists({
    actorEntityIds: args.actorIds,
    playerEntityId: args.playerId,
  });
}

async function loadQuestRow(
  playerId: number,
  questId: number,
): Promise<QuestRow | null> {
  const rows = await query<QuestRow>(
    `SELECT pq.quest_entity_id,
            e.display_name AS title,
            pq.status,
            pq.current_stage_id,
            e.profile,
            e.tags,
            e.dynamic_origin,
            pq.accumulated_state,
            pq.started_at
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.quest_entity_id = $2
      LIMIT 1`,
    [playerId, questId],
  );
  return rows.rows[0] ?? null;
}

function readStages(profile: Record<string, unknown>): StageInfo[] {
  const raw = Array.isArray(profile['stages'])
    ? (profile['stages'] as Array<Record<string, unknown>>)
    : [];
  return raw.map((stage, index) => ({
    id: String(stage['id'] ?? ''),
    index,
    objectives: recordArray(stage['objectives']),
    prerequisites: recordArray(stage['prerequisites']),
    nextTargets: readNextTargets(stage, raw, index),
  })).filter((stage) => stage.id.length > 0);
}

function readNextTargets(
  stage: Record<string, unknown>,
  all: Array<Record<string, unknown>>,
  index: number,
): string[] {
  const next = stage['next_stage'];
  const targets = new Set<string>();
  if (typeof next === 'string' && next.trim()) targets.add(next.trim());
  if (next && typeof next === 'object' && !Array.isArray(next)) {
    const options = (next as Record<string, unknown>)['options'];
    if (Array.isArray(options)) {
      options.forEach((option) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return;
        const target = (option as Record<string, unknown>)['target_stage_id'];
        if (typeof target === 'string' && target.trim()) targets.add(target.trim());
      });
    }
  }
  if (targets.size === 0 && index + 1 < all.length) {
    const fallback = all[index + 1]?.['id'];
    if (typeof fallback === 'string' && fallback.trim()) targets.add(fallback.trim());
  }
  return [...targets];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
