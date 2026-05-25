/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-QUEST-1 — Quest Dashboard snapshot service.
//
// Stable read-only DTO consumed by `GET /api/player/:id/quest-dashboard`
// and the `useQuestDashboard` hook. Unlike the compact-panel
// `QuestLogService`, this service:
//
//   * Batch-loads `player_quests` joined with quest `entities` in
//     one query so there is no per-quest entity/profile lookup
//     loop.
//   * Groups quests into `active`, `choiceRequired`, `offered`,
//     `completed`, `failed`, `archived` from a single result set,
//     where `choiceRequired` is the subset of `active` rows with
//     `accumulated_state.awaiting_choice === true`.
//   * Walks the quest profile's `stages` array once per row to
//     produce a stable timeline (each stage gets its id, name,
//     description, status of `done | current | upcoming`) and a
//     conservative `nextActionHint` derived from the current
//     stage's `description` or first unsatisfied objective.
//   * Evaluates the current stage's objectives via the same
//     `evaluateObjective` helper the compact panel uses, so
//     ✓/☐ indicators come from durable state, not parsed prose.
//   * Pulls a short `recentEvents` list out of `gui_events` —
//     filtered to `quest:*` + `adventure:hook` / `adventure:expired`
//     event types — so the dashboard surfaces a real history rail
//     without scraping chat text.
//
// Returns `null` for unknown players (route surfaces 404). The
// DTO field names mirror existing camelCase conventions in
// `bridge/inventory.ts` so the web-ui consumer is symmetrical.

import {query} from '../db.js';
import {loc, locQuestStageField, resolveLanguage} from '../i18n.js';
import {evaluateObjective} from '../quest/objectiveEvaluators.js';
import {describeObjective} from '../turnContext/index.js';

export type QuestStatus =
  | 'active'
  | 'completed'
  | 'failed'
  | 'offered'
  | 'archived'
  | 'unseen';

export interface QuestDashboardObjective {
  text: string;
  satisfied: boolean;
  detail: string | null;
}

export interface QuestDashboardStage {
  id: string;
  name: string;
  description: string;
  status: 'done' | 'current' | 'upcoming';
}

export interface QuestDashboardRewards {
  xp?: number;
  strings?: Array<{npc: string; delta: number}>;
  items?: Array<{name: string; quantity?: number}>;
  sex_move_eligible?: boolean;
}

export interface QuestDashboardCard {
  id: number;
  name: string;
  summary: string | null;
  status: QuestStatus;
  awaitingChoice: boolean;
  tags: string[];
  partner: string | null;
  giver: string | null;
  location: string | null;
  rewards: QuestDashboardRewards | null;
  startedAt: string | null;
  completedAt: string | null;
  stage: {id: string; name: string; description: string} | null;
  stages: QuestDashboardStage[];
  objectives: QuestDashboardObjective[];
  nextActionHint: string | null;
}

export interface QuestDashboardSummary {
  total: number;
  active: number;
  choiceRequired: number;
  offered: number;
  completed: number;
  failed: number;
  archived: number;
}

export interface QuestDashboardEvent {
  id: number;
  type: string;
  questEntityId: number | null;
  questName: string | null;
  payload: Record<string, unknown>;
  releasedAt: string | null;
  createdAt: string;
}

export interface QuestDashboardSnapshot {
  playerId: number;
  summary: QuestDashboardSummary;
  active: QuestDashboardCard[];
  choiceRequired: QuestDashboardCard[];
  offered: QuestDashboardCard[];
  completed: QuestDashboardCard[];
  failed: QuestDashboardCard[];
  archived: QuestDashboardCard[];
  recentEvents: QuestDashboardEvent[];
}

interface QuestJoinRow {
  quest_entity_id: number;
  status: string;
  current_stage_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  accumulated_state: Record<string, unknown> | null;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown> | null;
  i18n: Record<string, Record<string, unknown>> | null;
}

interface GuiEventRow {
  id: number;
  event_type: string;
  payload: Record<string, unknown> | null;
  released_at: string | null;
  created_at: string;
}

// FEAT-QUEST-1 dashboard event taxonomy. Every emit site in the
// current server: `tools/quest.ts:emitQuestCard` (created /
// started / advanced / completed), `quest/questEngine.ts`
// (`quest:changed` + `quest:choice_required`),
// `agents/questWatcher.ts` (`quest:auto_advanced`),
// `domain/adventure/runtime/adventureQueue.ts` (`adventure:hook`,
// `adventure:expired`), and `domain/adventure/AdventureService.ts`
// (`adventure:accepted`). The hook's refresh list mirrors this
// array so the surface stays in sync with whatever the broker /
// scripted tools / watchers actually fire.
export const QUEST_DASHBOARD_EVENT_TYPES = [
  'quest:created',
  'quest:started',
  'quest:advanced',
  'quest:auto_advanced',
  'quest:choice_required',
  'quest:completed',
  'quest:changed',
  'adventure:hook',
  'adventure:accepted',
  'adventure:expired',
] as const;
const QUEST_EVENT_TYPES: readonly string[] = QUEST_DASHBOARD_EVENT_TYPES;

const RECENT_EVENT_LIMIT = 30;

export class QuestDashboardService {
  static async snapshot(
    playerId: number,
    requestedLanguage?: string | null,
  ): Promise<QuestDashboardSnapshot | null> {
    const player = await query<{preferred_language: string | null}>(
      `SELECT preferred_language FROM players WHERE entity_id = $1`,
      [playerId],
    );
    if (!player.rows[0]) return null;

    const lang = resolveLanguage({
      turnLang: requestedLanguage ?? null,
      playerLang: player.rows[0].preferred_language ?? null,
    });

    const rows = await query<QuestJoinRow>(
      `SELECT pq.quest_entity_id,
              pq.status,
              pq.current_stage_id,
              pq.started_at::text AS started_at,
              pq.completed_at::text AS completed_at,
              pq.accumulated_state,
              e.display_name,
              e.summary,
              e.profile,
              e.i18n
         FROM player_quests pq
         JOIN entities e ON e.id = pq.quest_entity_id
        WHERE pq.player_id = $1
        ORDER BY
          CASE pq.status
            WHEN 'active' THEN 0
            WHEN 'offered' THEN 1
            WHEN 'unseen' THEN 2
            WHEN 'completed' THEN 3
            WHEN 'failed' THEN 4
            ELSE 5
          END,
          pq.started_at DESC NULLS LAST,
          pq.quest_entity_id DESC
        LIMIT 100`,
      [playerId],
    );

    const active: QuestDashboardCard[] = [];
    const choiceRequired: QuestDashboardCard[] = [];
    const offered: QuestDashboardCard[] = [];
    const completed: QuestDashboardCard[] = [];
    const failed: QuestDashboardCard[] = [];
    const archived: QuestDashboardCard[] = [];

    for (const row of rows.rows) {
      const card = await buildCard(row, lang, playerId);
      switch (card.status) {
        case 'active':
          active.push(card);
          if (card.awaitingChoice) choiceRequired.push(card);
          break;
        case 'offered':
        case 'unseen':
          offered.push(card);
          break;
        case 'completed':
          completed.push(card);
          break;
        case 'failed':
          failed.push(card);
          break;
        case 'archived':
        default:
          archived.push(card);
          break;
      }
    }

    const summary: QuestDashboardSummary = {
      total: rows.rows.length,
      active: active.length,
      choiceRequired: choiceRequired.length,
      offered: offered.length,
      completed: completed.length,
      failed: failed.length,
      archived: archived.length,
    };

    const recentEvents = await loadRecentEvents(playerId);

    return {
      playerId,
      summary,
      active,
      choiceRequired,
      offered,
      completed,
      failed,
      archived,
      recentEvents,
    };
  }
}

async function buildCard(
  row: QuestJoinRow,
  lang: string,
  playerId: number,
): Promise<QuestDashboardCard> {
  const questRecord = {i18n: row.i18n ?? null};
  const profile = (row.profile ?? {}) as Record<string, unknown>;
  const stages = Array.isArray(profile['stages'])
    ? (profile['stages'] as Array<Record<string, unknown>>)
    : [];
  const tags = Array.isArray(profile['tags'])
    ? (profile['tags'] as unknown[]).map((t) => String(t))
    : [];
  const rewards = asRewards(profile['rewards']);
  const status = normalizeStatus(row.status);
  const accumulated = (row.accumulated_state ?? {}) as Record<string, unknown>;
  const awaitingChoice =
    status === 'active' && accumulated['awaiting_choice'] === true;

  const currentStageIndex = row.current_stage_id
    ? stages.findIndex((s) => String(s['id']) === row.current_stage_id)
    : -1;
  const stageTimeline: QuestDashboardStage[] = stages.map((s, index) => {
    const id = String(s['id'] ?? `stage-${index}`);
    const name = stringFromI18n(
      locQuestStageField(questRecord, lang, s, 'name', s['name']),
    );
    const description = stringFromI18n(
      locQuestStageField(questRecord, lang, s, 'description', s['description']),
    );
    let stageStatus: 'done' | 'current' | 'upcoming';
    if (status === 'completed') {
      stageStatus = 'done';
    } else if (status === 'failed') {
      stageStatus = index <= currentStageIndex ? 'done' : 'upcoming';
    } else if (currentStageIndex === -1) {
      stageStatus = 'upcoming';
    } else if (index < currentStageIndex) {
      stageStatus = 'done';
    } else if (index === currentStageIndex) {
      stageStatus = 'current';
    } else {
      stageStatus = 'upcoming';
    }
    return {id, name, description, status: stageStatus};
  });

  let stage: QuestDashboardCard['stage'] = null;
  const objectives: QuestDashboardObjective[] = [];
  let nextActionHint: string | null = null;
  const activeStage =
    currentStageIndex >= 0 ? stages[currentStageIndex] : undefined;
  if (activeStage) {
    stage = {
      id: String(activeStage['id']),
      name: stringFromI18n(
        locQuestStageField(
          questRecord,
          lang,
          activeStage,
          'name',
          activeStage['name'],
        ),
      ),
      description: stringFromI18n(
        locQuestStageField(
          questRecord,
          lang,
          activeStage,
          'description',
          activeStage['description'],
        ),
      ),
    };
    if (status === 'active') {
      const stageObjectives = Array.isArray(activeStage['objectives'])
        ? (activeStage['objectives'] as Array<Record<string, unknown>>)
        : [];
      // Evaluate objectives. Empty sessionId is the conventional
      // "no live turn context" probe — `evaluateObjective` reads
      // from durable state for the kinds we care about.
      const results = await Promise.all(
        stageObjectives.map(async (o) => ({
          obj: o,
          ...(await evaluateObjective(o, {
            playerId,
            sessionId: '',
            recentToolCalls: [],
          })),
        })),
      );
      for (const r of results) {
        objectives.push({
          text: describeObjective(r.obj),
          satisfied: r.satisfied,
          detail: r.detail ?? null,
        });
      }
      const firstUnsatisfied = objectives.find((o) => !o.satisfied);
      nextActionHint =
        firstUnsatisfied?.text ?? stage.description ?? stage.name ?? null;
    }
  }

  const localizedSummary = stringFromI18n(
    loc(questRecord, lang, 'summary', row.summary),
  );

  return {
    id: row.quest_entity_id,
    name: row.display_name,
    summary: localizedSummary || null,
    status,
    awaitingChoice,
    tags,
    partner: optionalString(profile['partner']),
    giver: optionalString(profile['giver']) ?? optionalString(profile['quest_giver']),
    location: optionalString(profile['location']) ?? optionalString(profile['region']),
    rewards,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    stage,
    stages: stageTimeline,
    objectives,
    nextActionHint,
  };
}

async function loadRecentEvents(
  playerId: number,
): Promise<QuestDashboardEvent[]> {
  const rows = await query<GuiEventRow>(
    `SELECT id,
            event_type,
            payload,
            released_at::text AS released_at,
            created_at::text AS created_at
       FROM gui_events
      WHERE player_id = $1
        AND event_type = ANY($2::text[])
      ORDER BY id DESC
      LIMIT $3`,
    [playerId, QUEST_EVENT_TYPES, RECENT_EVENT_LIMIT],
  );
  return rows.rows.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const questEntityId = extractQuestEntityId(payload);
    const questName = extractQuestName(payload);
    return {
      id: r.id,
      type: r.event_type,
      questEntityId,
      questName,
      payload,
      releasedAt: r.released_at ?? null,
      createdAt: r.created_at,
    };
  });
}

// Different emit sites in the server use different field names for
// the same logical "which quest" pointer. Normalize them all here so
// the dashboard rail and tests don't have to special-case:
//
//   * `tools/quest.ts:emitQuestCard` → `{questId, title, ...}`
//   * `quest/questEngine.ts` quest:changed → `{quest_entity_id,
//     awaiting_choice, ...}`
//   * `agents/questWatcher.ts` quest:auto_advanced → `{questId,
//     ...}` (same emitter as `emitQuestCard`)
//
// Accept the four field-name variants the server actually writes so a
// future renamer here will only need to extend this table.
function extractQuestEntityId(payload: Record<string, unknown>): number | null {
  for (const key of [
    'questId',
    'quest_id',
    'questEntityId',
    'quest_entity_id',
  ]) {
    const raw = payload[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function extractQuestName(payload: Record<string, unknown>): string | null {
  for (const key of ['title', 'questName', 'quest_name']) {
    const raw = payload[key];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  }
  return null;
}

function normalizeStatus(raw: string): QuestStatus {
  switch (raw) {
    case 'active':
    case 'completed':
    case 'failed':
    case 'offered':
    case 'unseen':
    case 'archived':
      return raw;
    default:
      return 'archived';
  }
}

function asRewards(raw: unknown): QuestDashboardRewards | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: QuestDashboardRewards = {};
  if (typeof r['xp'] === 'number') out.xp = r['xp'];
  if (Array.isArray(r['strings'])) {
    out.strings = (r['strings'] as Array<Record<string, unknown>>)
      .map((s) => ({
        npc: typeof s['npc'] === 'string' ? s['npc'] : '',
        delta: typeof s['delta'] === 'number' ? s['delta'] : 0,
      }))
      .filter((s) => s.npc.length > 0);
  }
  if (Array.isArray(r['items'])) {
    out.items = (r['items'] as Array<Record<string, unknown>>)
      .map((s) => ({
        name: typeof s['name'] === 'string' ? s['name'] : '',
        ...(typeof s['quantity'] === 'number' ? {quantity: s['quantity']} : {}),
      }))
      .filter((s) => s.name.length > 0);
  }
  if (typeof r['sex_move_eligible'] === 'boolean') {
    out.sex_move_eligible = r['sex_move_eligible'];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function optionalString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringFromI18n(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const r = value as Record<string, unknown>;
    if (typeof r['text'] === 'string') return r['text'];
  }
  return value == null ? '' : String(value);
}
