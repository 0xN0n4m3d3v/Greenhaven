/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — Spec 25 quest-choice routing.
//
// Branch choices are routed by the stable actionId
// `quest-choice:<questId>:<targetStageId>`, NOT by parsing player-
// visible prose.  When the actionId matches, the player_quest's
// `accumulated_state` is updated with `pending_choice = <target>` and
// `awaiting_choice = false`; the downstream `EvaluateActiveQuestsPhase`
// then picks up the pending choice and advances the quest along the
// chosen branch in the same turn.
//
// Moved out of an inline `maybeApplyQuestChoice` helper in
// `turnRunnerV2.ts` as part of USER-4. Behavior is byte-for-byte
// identical with the previous inline regex; X-3 follow-up replaced
// the regex with a typed `parseQuestChoiceActionId` parser (modelled
// after `scriptedActions/actionIds.ts`) so the wire format stays
// readable and the X-3 language-regex rule no longer needs an escape
// hatch here.

import {query} from '../../db.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export interface ParsedQuestChoiceActionId {
  questId: number;
  targetStageId: string;
}

/**
 * Parse a `quest-choice:<questId>:<targetStageId>` action id into its
 * two components, or return `null` when the prefix is missing, the
 * quest id is not a positive integer, or the target stage id is empty.
 * The target stage id is the entire remainder after the second colon,
 * so cartridge IDs that themselves contain `:` (e.g. namespaced stage
 * keys like `route:dock:north`) round-trip unchanged.
 */
export function parseQuestChoiceActionId(
  actionId: string | null | undefined,
): ParsedQuestChoiceActionId | null {
  if (typeof actionId !== 'string' || actionId.length === 0) return null;
  const firstColon = actionId.indexOf(':');
  if (firstColon < 0) return null;
  if (actionId.slice(0, firstColon) !== 'quest-choice') return null;
  const secondColon = actionId.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  const questId = parsePositiveDecimalInt(
    actionId.slice(firstColon + 1, secondColon),
  );
  if (questId == null) return null;
  const targetStageId = actionId.slice(secondColon + 1).trim();
  if (targetStageId.length === 0) return null;
  return {questId, targetStageId};
}

/**
 * Strict positive-decimal integer scanner. Rejects anything `Number(...)`
 * would silently coerce: hex (`0x2`), exponent notation (`1e3`),
 * leading/trailing whitespace (` 2`), fractional values (`1.5`), bare
 * signs (`-3`), and zero. Keeps the old regex contract — the prior
 * `\d+` literal only matched ASCII digits 0–9 — without re-introducing
 * a regex literal the X-3 rule has to whitelist.
 */
function parsePositiveDecimalInt(raw: string): number | null {
  if (raw.length === 0) return null;
  let value = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 48 || code > 57) return null;
    value = value * 10 + (code - 48);
    if (value > Number.MAX_SAFE_INTEGER) return null;
  }
  return value > 0 ? value : null;
}

export const questChoicePhase: Phase = {
  name: 'quest_choice',
  async run(context: TurnContext): Promise<void> {
    await applyQuestChoice(
      context.session.id,
      context.input.playerId,
      context.input.actionId,
    );
  },
};

async function applyQuestChoice(
  sessionId: string,
  playerId: number,
  actionId?: string,
): Promise<void> {
  const parsed = parseQuestChoiceActionId(actionId);
  if (!parsed) return;
  const {questId, targetStageId: target} = parsed;
  const row = await query<{
    quest_entity_id: number;
    current_stage_id: string | null;
    profile: unknown;
    accumulated_state: unknown;
  }>(
    `SELECT pq.quest_entity_id, pq.current_stage_id, e.profile,
            pq.accumulated_state
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status = 'active'
        AND pq.quest_entity_id = $2`,
    [playerId, questId],
  );
  const r0 = row.rows[0];
  if (!r0) return;
  const profile = (r0.profile ?? {}) as Record<string, unknown>;
  const stages = Array.isArray(profile['stages'])
    ? (profile['stages'] as Array<Record<string, unknown>>)
    : [];
  const stage = stages.find((s) => s['id'] === r0.current_stage_id);
  const ns = stage?.['next_stage'] as Record<string, unknown> | undefined;
  if (!ns || ns['kind'] !== 'choice' || !Array.isArray(ns['options'])) return;
  const opt = (ns['options'] as Array<Record<string, unknown>>).find(
    (o) => String(o['target_stage_id'] ?? '').trim() === target,
  );
  if (!opt) return;
  const acc = (r0.accumulated_state ?? {}) as Record<string, unknown>;
  acc['pending_choice'] = target;
  acc['awaiting_choice'] = false;
  await query(
    `UPDATE player_quests SET accumulated_state = $1::jsonb
      WHERE player_id = $2 AND quest_entity_id = $3`,
    [JSON.stringify(acc), playerId, r0.quest_entity_id],
  );
  console.log(
    `[turnV2] quest-choice: ${questId} -> ${target} (sessionId=${sessionId})`,
  );
}
