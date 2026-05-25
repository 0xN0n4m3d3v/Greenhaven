/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Rolling summary post-turn agent.
//
// Memory tier C: when a per-NPC conversation thread grows past the
// 12-message hot window, the older chunk needs a compressed
// representation so the NPC remembers "the shape of the conversation"
// even when the verbatim text scrolls off the preamble. This agent runs
// once every ~10 messages of dialogue with the active partner and
// writes a 2-3 sentence summary into NPC memory (via MemoryService) with
// tag='rolling_summary'. The dialogueContext read-path renders it
// under "Earlier conversation with this player (rolling summary)".
//
// Idempotence: keyed on the highest turn_index that has been summarised
// so far, stored in metadata.up_to_turn. We only run if there are at
// least ROLLING_SUMMARY_TRIGGER new messages since the last summary.
//
// Failure mode: fail-open. If the LLM call or DB write fails, the
// preamble simply lacks the cold-tail block; play continues with the
// hot window alone.

import {z} from 'zod';
import {playerScopedChatPredicate} from '../chatHistoryScope.js';
import {query} from '../db.js';
import {
  readRollingDialogueSummaryCheckpoint,
  upsertRollingDialogueSummary,
} from '../domain/memory/index.js';
import {
  runSpecialist,
  type PostTurnHook,
  type SpecialistContext,
} from './base.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
  POST_TURN_SPECIALIST_WATCHDOG_MS,
} from '../postTurnTiming.js';

const ROLLING_SUMMARY_TRIGGER = 10;
const ROLLING_SUMMARY_WINDOW = 20;

export const rollingDialogueSummaryHook: PostTurnHook = {
  name: 'rolling_dialogue_summary',
  presentation: {
    slotKey: 'post.rolling_dialogue_summary',
    lane: 'rail',
    ordinal: 55,
    visible: false,
    barrierMode: 'non_blocking',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx) {
    try {
      await runOnce(ctx);
    } catch (err) {
      // CATCH-WARN-OK: post-turn slot wrapper; the slot's own `presentationSlot.telemetry` (S-14) records the slot outcome with the failure status.
      console.warn(
        '[agent:rolling_dialogue_summary] failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    }
  },
};

async function runOnce(ctx: SpecialistContext): Promise<void> {
  const player = await query<{
    dialogue_partner_id: number | null;
  }>(
    `SELECT dialogue_partner_id FROM players WHERE entity_id = $1`,
    [ctx.playerId],
  );
  const partnerId = player.rows[0]?.dialogue_partner_id ?? null;
  if (partnerId == null) return;

  // Last summary checkpoint for this (NPC, player) pair. The helper
  // owns the `metadata->>'up_to_turn'` SQL and returns 0 when no prior
  // rolling_summary exists, replacing the previous raw SELECT.
  const checkpointTurn = await readRollingDialogueSummaryCheckpoint({
    ownerEntityId: partnerId,
    aboutEntityId: ctx.playerId,
  });

  // Count new messages in this NPC's scope since the checkpoint.
  const countRow = await query<{n: number; max_turn: number}>(
    `SELECT COUNT(*)::int AS n, COALESCE(MAX(cm.turn_index), 0) AS max_turn
       FROM chat_messages cm
      WHERE cm.session_id = $1
        AND cm.turn_index > ${checkpointTurn}
        AND ${playerScopedChatPredicate('cm', 3)}
        AND (
          cm.author_entity_id = $2
          OR $2 = ANY(cm.witness_entity_ids)
          OR (cm.witness_entity_ids IS NULL
              AND (cm.author_entity_id = $3 OR cm.tone = 'player'))
        )`,
    [ctx.sessionId, partnerId, ctx.playerId],
  );
  const newCount = Number(countRow.rows[0]?.n ?? 0);
  const maxTurn = Number(countRow.rows[0]?.max_turn ?? checkpointTurn);
  if (newCount < ROLLING_SUMMARY_TRIGGER) return;

  // Pull the chunk to fold (everything from checkpoint+1 to now).
  const chunk = await query<{
    author_entity_id: number | null;
    author_name: string | null;
    tone: string;
    text: string;
    turn_index: number;
  }>(
    `SELECT cm.author_entity_id,
            e.display_name AS author_name,
            cm.tone, cm.text, cm.turn_index
       FROM chat_messages cm
       LEFT JOIN entities e ON e.id = cm.author_entity_id
      WHERE cm.session_id = $1
        AND cm.turn_index > ${checkpointTurn}
        AND ${playerScopedChatPredicate('cm', 3)}
        AND (
          cm.author_entity_id = $2
          OR $2 = ANY(cm.witness_entity_ids)
          OR (cm.witness_entity_ids IS NULL
              AND (cm.author_entity_id = $3 OR cm.tone = 'player'))
        )
      ORDER BY cm.turn_index ASC
      LIMIT ${ROLLING_SUMMARY_WINDOW}`,
    [ctx.sessionId, partnerId, ctx.playerId],
  );
  if (chunk.rows.length === 0) return;

  const partnerRow = await query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [partnerId],
  );
  const partnerName = partnerRow.rows[0]?.display_name ?? `entity ${partnerId}`;
  const playerRow = await query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [ctx.playerId],
  );
  const playerName = playerRow.rows[0]?.display_name ?? 'the player';

  const transcript = chunk.rows
    .map(r => {
      const who =
        r.tone === 'player' ? playerName : r.author_name ?? 'narrator';
      return `[${r.turn_index}] ${who}: ${r.text.replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n')
    .slice(0, 6000);

  const Schema = z.object({summary: z.string().min(8).max(900)});
  const result = await runSpecialist(
    {
      name: 'rolling_dialogue_summary',
      mode: 'async',
      outputSchema: Schema,
      timeoutMs: POST_TURN_SPECIALIST_WATCHDOG_MS,
      temperature: 0.3,
      maxOutputTokens: 400,
      buildPrompt: (input: unknown) => {
        const i = input as {
          partnerName: string;
          playerName: string;
          transcript: string;
          priorSummary?: string | null;
        };
        return {
          system:
            'You compress an unfolding conversation between an NPC and a player into a single short paragraph that the NPC can remember verbatim. Write IN-WORLD from the NPC\'s memory perspective. Return JSON only.\n' +
            '\n' +
            'Rules:\n' +
            '- 2–4 sentences, max ~600 characters.\n' +
            '- Include WHAT the player asked or did, WHAT was offered or refused, WHAT was agreed.\n' +
            '- Include emotional shifts and any commitments. No quoted speech.\n' +
            '- Match the language the conversation is in.\n' +
            '- Do NOT invent facts that are not in the transcript.\n' +
            '\n' +
            'Output shape: {"summary": "..."}.',
          user: [
            `NPC: ${i.partnerName}`,
            `Player: ${i.playerName}`,
            i.priorSummary
              ? `Earlier summary (already in the NPC's memory; extend it, do not repeat it):\n${i.priorSummary}`
              : '(no earlier summary)',
            'Recent transcript to compress:',
            i.transcript,
          ].join('\n\n'),
        };
      },
    },
    {
      partnerName,
      playerName,
      transcript,
      priorSummary: null,
    },
    {
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      signal: ctx.signal,
    },
  );
  if (!result || !result.summary.trim()) return;

  // Replace previous rolling_summary for this pair: we store ONE current
  // summary at a time (older ones become stale because the chunk they
  // covered is already inside the new one). The helper owns the
  // delete-then-insert behavior so the SQL stays inside `domain/memory/`.
  await upsertRollingDialogueSummary({
    ownerEntityId: partnerId,
    aboutEntityId: ctx.playerId,
    text: result.summary.trim(),
    upToTurn: maxTurn,
  });
}
