/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Scene-level chat history summariser. Last 5 turns stay verbatim in
// the dynamic context; everything older gets folded into a 3-5 bullet
// summary that's cached per (session, scene) and only regenerated when
// the older-tail extends. Saves ~700 input tokens per turn after the
// chat exceeds 5 messages.

import {generateText} from 'ai';
import {query} from '../db.js';
import {sessionPlayerScopedChatPredicate} from '../chatHistoryScope.js';
import type {RunnerProviders} from './providers.js';

interface SceneSummary {
  sessionId: string;
  sceneEntityId: number;
  summary: string;
  generatedAtTurnIndex: number;
}

const cache = new Map<string, SceneSummary>();

export async function getOrBuildSceneSummary(args: {
  providers: RunnerProviders;
  sessionId: string;
  playerId: number;
  signal: AbortSignal;
}): Promise<string | null> {
  const player = await query<{current_scene_id: number | null}>(
    `SELECT current_scene_id FROM players WHERE entity_id = $1`,
    [args.playerId],
  );
  const sceneId = player.rows[0]?.current_scene_id;
  if (!sceneId) return null;

  const cacheKey = `${args.sessionId}:${args.playerId}:${sceneId}`;
  const messages = await query<{
    turn_index: number;
    tone: string;
    text: string;
    author_entity_id: number | null;
  }>(
    `SELECT cm.turn_index, cm.tone, cm.text, cm.author_entity_id
       FROM chat_messages cm
      WHERE ${sessionPlayerScopedChatPredicate('cm', 1, 2)}
       ORDER BY turn_index DESC LIMIT 50`,
    [args.sessionId, args.playerId],
  );
  if (messages.rows.length <= 5) return null;

  const olderRows = messages.rows.slice(5).reverse();
  if (olderRows.length === 0) return null;

  const cached = cache.get(cacheKey);
  const latestOlderTurnIndex = olderRows[olderRows.length - 1]!.turn_index;
  if (cached && cached.generatedAtTurnIndex >= latestOlderTurnIndex) {
    return cached.summary;
  }

  const text = olderRows
    .map(r => `[turn ${r.turn_index}] ${r.tone}: ${r.text}`)
    .join('\n');
  const r = await generateText({
    model: args.providers.broker,
    prompt: `Summarize the earlier portion of this RPG scene as 3-5 bullet points. Focus on facts and decisions, not prose.\n\n${text}`,
    temperature: 0.0,
    maxOutputTokens: 250,
    abortSignal: args.signal,
  });
  const summary = `Earlier in this scene:\n${r.text.trim()}`;
  // Evict oldest entry if cache exceeds cap (prevents unbounded
  // growth under multi-tenant Postgres with many sessions).
  if (cache.size >= 256) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(cacheKey, {
    sessionId: args.sessionId,
    sceneEntityId: sceneId,
    summary,
    generatedAtTurnIndex: latestOlderTurnIndex,
  });
  return summary;
}
