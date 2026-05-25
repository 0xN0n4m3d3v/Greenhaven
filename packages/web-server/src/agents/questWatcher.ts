/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 39 §5.2 — Quest Progression Watcher.
//
// Async post-turn specialist. Reads:
//   - All active quests for this player (with stages + objectives)
//   - The just-finished turn's tool history
//   - The visible narrative
//
// Decides for each active quest whether the player completed the
// current stage's implied objective. Conservative — only fires when
// evidence is unambiguous in tool_calls or narrative. Calls
// advance_quest / complete_quest server-side when it does. Emits
// quest:auto_advanced SSE so frontend shows a card.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import {
  runSpecialist,
  type PostTurnHook,
  type SpecialistDef,
} from './base.js';
import {questWatcherPrompt} from './questWatcherPrompt.js';
import {applyQuestTransitionProposal} from '../quest/questTransitionArbiter.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
  POST_TURN_SPECIALIST_WATCHDOG_MS,
} from '../postTurnTiming.js';

const WatcherOutput = z.object({
  decisions: z.array(
    z.object({
      quest_id: z.number().int().positive(),
      action: z.enum(['advance', 'complete', 'no_change']),
      to_stage: z.string().optional(),
      outcome: z.enum(['completed', 'failed']).optional(),
      reason: z.string().min(1).max(400),
    }),
  ),
});

export type WatcherDecisions = z.infer<typeof WatcherOutput>;

interface WatcherInput {
  player: {id: number; name: string};
  language: string;
  active_quests: Array<{
    id: number;
    title: string;
    summary: string | null;
    current_stage_id: string | null;
    stages: Array<{id: string; title: string; next_stage?: string}>;
    goal: string;
  }>;
  turn: {
    user_text: string;
    tool_calls: Array<{name: string; args: unknown}>;
    visible_narrative: string;
  };
}

const def: SpecialistDef<WatcherInput, WatcherDecisions> = {
  name: 'quest_watcher',
  mode: 'async',
  buildPrompt(input) {
    return {
      system: questWatcherPrompt.buildSystem(input),
      user: questWatcherPrompt.buildUser(input),
    };
  },
  outputSchema: WatcherOutput,
  timeoutMs: POST_TURN_SPECIALIST_WATCHDOG_MS,
};

export const questWatcherHook: PostTurnHook = {
  name: 'quest_watcher',
  presentation: {
    slotKey: 'post.quest_watcher',
    lane: 'post_response',
    ordinal: 10,
    visible: true,
    barrierMode: 'chat_visible',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, turnRecord) {
    // Pull active quests for the player.
    const quests = await query<{
      id: number;
      title: string;
      summary: string | null;
      current_stage_id: string | null;
      profile: Record<string, unknown> | null;
    }>(
      `SELECT q.id,
              q.display_name AS title,
              q.summary,
              pq.current_stage_id,
              q.profile
         FROM player_quests pq
         JOIN entities q ON q.id = pq.quest_entity_id
        WHERE pq.player_id = $1
          AND pq.status = 'active'`,
      [ctx.playerId],
    );
    if (quests.rows.length === 0) return;

    const activeQuests = quests.rows.map(q => {
      const profile = (q.profile ?? {}) as Record<string, unknown>;
      const stages = Array.isArray(profile['stages'])
        ? (profile['stages'] as Array<Record<string, unknown>>).map(s => ({
            id: String(s['id'] ?? ''),
            title: String(s['title'] ?? ''),
            next_stage:
              typeof s['next_stage'] === 'string'
                ? (s['next_stage'] as string)
                : undefined,
          }))
        : [];
      return {
        id: q.id,
        title: q.title,
        summary: q.summary,
        current_stage_id: q.current_stage_id,
        stages,
        goal:
          typeof profile['goal'] === 'string'
            ? (profile['goal'] as string)
            : '',
      };
    });

    const playerRow = await query<{display_name: string}>(
      `SELECT display_name FROM entities WHERE id = $1`,
      [ctx.playerId],
    );

    const input: WatcherInput = {
      player: {
        id: ctx.playerId,
        name: playerRow.rows[0]?.display_name ?? `player:${ctx.playerId}`,
      },
      language: ctx.language ?? 'en',
      active_quests: activeQuests,
      turn: {
        user_text: turnRecord.text,
        tool_calls: turnRecord.toolHistory.map(t => ({
          name: t.name,
          args: t.args,
        })),
        visible_narrative: turnRecord.narrative.slice(0, 4000),
      },
    };

    const decisions = await runSpecialist(def, input, ctx);
    if (!decisions) return; // fail open

    for (const d of decisions.decisions) {
      if (d.action === 'no_change') continue;

      try {
        const snapshot = activeQuests.find(q => q.id === d.quest_id);
        const application = await applyQuestTransitionProposal({
          source: 'quest_watcher',
          sessionId: ctx.sessionId,
          playerId: ctx.playerId,
          turnId: ctx.turnId,
          questId: d.quest_id,
          expectedCurrentStageId: snapshot?.current_stage_id ?? null,
          action: d.action === 'complete' && d.outcome === 'failed' ? 'fail' : d.action,
          toStage: d.to_stage,
          outcome: d.outcome,
          reason: d.reason,
          turnToolHistory: turnRecord.toolHistory,
        });
        if (!application.applied) continue;
        const resultData =
          application.result.data &&
          typeof application.result.data === 'object' &&
          !Array.isArray(application.result.data)
            ? (application.result.data as Record<string, unknown>)
            : {};
        if (resultData['changed'] === false || resultData['no_op'] === true) {
          continue;
        }
        const completed = d.action === 'complete';
        await (ctx.presentation?.emit(
          'quest:auto_advanced',
          {
            quest_id: d.quest_id,
            to_stage: d.to_stage ?? null,
            completed,
            outcome: completed ? d.outcome ?? 'completed' : null,
            reason: d.reason,
            agent: 'quest_watcher',
          },
          {
            playerId: ctx.playerId,
            turnId: ctx.turnId,
            lane: 'post_response',
            phase: 'post_turn',
          },
        ) ?? emitGuiEventForSession(
          ctx.sessionId,
          'quest:auto_advanced',
          {
            quest_id: d.quest_id,
            to_stage: d.to_stage ?? null,
            completed,
            outcome: completed ? d.outcome ?? 'completed' : null,
            reason: d.reason,
            agent: 'quest_watcher',
          },
          {
            playerId: ctx.playerId,
            turnId: ctx.turnId,
            lane: 'post_response',
            phase: 'post_turn',
          },
        ));
      } catch (err) {
        // CATCH-WARN-OK: per-quest dispatch failure inside the post-turn watcher; the outer `runOnce` aggregates the slot outcome through `presentationSlot.telemetry` (S-14), and the inner `agent:quest_watcher` dispatch already records its own questEngine-channel telemetry for the successful dispatch side.
        console.warn(
          `[agent:quest_watcher] dispatch failed for quest ${d.quest_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  },
};
