/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';
import {loc, locQuestStageField, resolveLanguage} from '../i18n.js';
import {evaluateObjective} from '../quest/objectiveEvaluators.js';
import {describeObjective} from '../turnContext/index.js';

export interface ActiveQuestPayload {
  id: number;
  name: string;
  summary: string | null;
  tags: unknown;
  partner: unknown;
  rewards: unknown;
  started_at: string;
  completed_at: string | null;
  stage?: {id: string; name: unknown; description: unknown};
  objectives?: Array<{text: string; satisfied: boolean; detail: string | null}>;
}

export interface QuestLogPayload {
  active: ActiveQuestPayload[];
  completed: ActiveQuestPayload[];
  failed: ActiveQuestPayload[];
}

export class QuestLogService {
  static async log(
    playerId: number,
    requestedLanguage?: string | null,
  ): Promise<QuestLogPayload | null> {
    const playerLang = await query<{preferred_language: string | null}>(
      `SELECT preferred_language FROM players WHERE entity_id = $1`,
      [playerId],
    );
    if (!playerLang.rows[0]) return null;

    const lang = resolveLanguage({
      turnLang: requestedLanguage ?? null,
      playerLang: playerLang.rows[0].preferred_language ?? null,
    });
    const rows = await query<{
      quest_entity_id: number;
      status: string;
      current_stage_id: string | null;
      started_at: string;
      completed_at: string | null;
    }>(
      `SELECT quest_entity_id, status, current_stage_id, started_at, completed_at
         FROM player_quests
        WHERE player_id = $1
        ORDER BY started_at DESC LIMIT 50`,
      [playerId],
    );

    const active: ActiveQuestPayload[] = [];
    const completed: ActiveQuestPayload[] = [];
    const failed: ActiveQuestPayload[] = [];

    for (const r of rows.rows) {
      const q = await query<{
        display_name: string;
        profile: unknown;
        summary: string | null;
        i18n: Record<string, Record<string, unknown>> | null;
      }>(
        `SELECT display_name, profile, summary, i18n FROM entities WHERE id = $1`,
        [r.quest_entity_id],
      );
      if (!q.rows[0]) continue;
      const questRecord = {i18n: q.rows[0].i18n ?? null};
      const profile = (q.rows[0].profile ?? {}) as Record<string, unknown>;
      const stages = Array.isArray(profile['stages'])
        ? (profile['stages'] as Array<Record<string, unknown>>)
        : [];
      const stage = stages.find(s => s['id'] === r.current_stage_id);

      const base: ActiveQuestPayload = {
        id: r.quest_entity_id,
        name: q.rows[0].display_name,
        summary: loc(questRecord, lang, 'summary', q.rows[0].summary),
        tags: profile['tags'] ?? [],
        partner: profile['partner'] ?? null,
        rewards: profile['rewards'] ?? null,
        started_at: r.started_at,
        completed_at: r.completed_at,
      };

      if (r.status === 'active' && stage) {
        const objectives = Array.isArray(stage['objectives'])
          ? (stage['objectives'] as Array<Record<string, unknown>>)
          : [];
        const objResults = await Promise.all(
          objectives.map(async o => ({
            obj: o,
            ...(await evaluateObjective(o, {
              playerId,
              sessionId: '',
              recentToolCalls: [],
            })),
          })),
        );
        active.push({
          ...base,
          stage: {
            id: String(stage['id']),
            name: locQuestStageField(
              questRecord,
              lang,
              stage,
              'name',
              stage['name'],
            ),
            description: locQuestStageField(
              questRecord,
              lang,
              stage,
              'description',
              stage['description'],
            ),
          },
          objectives: objResults.map(o => ({
            text: describeObjective(o.obj),
            satisfied: o.satisfied,
            detail: o.detail ?? null,
          })),
        });
      } else if (r.status === 'completed') {
        completed.push(base);
      } else if (r.status === 'failed') {
        failed.push(base);
      }
    }

    return {active, completed, failed};
  }
}
