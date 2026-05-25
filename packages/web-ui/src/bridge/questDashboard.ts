/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-QUEST-1 — Quest Dashboard bridge.
//
// Owns the `/api/player/:id/quest-dashboard` read surface so
// `QuestDashboardSurface` and `useQuestDashboard` never call
// `fetch(...)` directly. This is now the only quest bridge.

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

const EMPTY_SUMMARY: QuestDashboardSummary = {
  total: 0,
  active: 0,
  choiceRequired: 0,
  offered: 0,
  completed: 0,
  failed: 0,
  archived: 0,
};

/**
 * Returns `null` when the endpoint replies non-2xx so the hook
 * can surface a focused error state without leaking HTTP details
 * to the surface body.
 */
export async function fetchQuestDashboard(args: {
  playerId: number;
  language?: string | null;
  baseUrl?: string;
}): Promise<QuestDashboardSnapshot | null> {
  const params = args.language
    ? `?language=${encodeURIComponent(args.language)}`
    : '';
  const r = await fetch(
    `${args.baseUrl ?? ''}/api/player/${args.playerId}/quest-dashboard${params}`,
    {credentials: 'include'},
  );
  if (!r.ok) return null;
  const data = (await r.json()) as Partial<QuestDashboardSnapshot>;
  return {
    playerId: data.playerId ?? args.playerId,
    summary: data.summary ?? {...EMPTY_SUMMARY},
    active: data.active ?? [],
    choiceRequired: data.choiceRequired ?? [],
    offered: data.offered ?? [],
    completed: data.completed ?? [],
    failed: data.failed ?? [],
    archived: data.archived ?? [],
    recentEvents: data.recentEvents ?? [],
  };
}
