/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 137: ambient memory/evidence thread. Threads group session continuity;
// they do not replace chat_messages, player_quests, or npc_memories.

import {query} from '../../../db.js';

export interface SessionMemoryThread {
  id: string;
  session_id: string | null;
  player_id: number;
  kind: string;
  title: string;
  metadata: Record<string, unknown>;
}

export function ambientThreadId(sessionId: string, at = new Date()): string {
  return `session:${sanitizeId(sessionId)}:${at.toISOString().slice(0, 10)}`;
}

export async function ensureSessionMemoryThread(args: {
  sessionId: string;
  playerId: number;
  kind?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<SessionMemoryThread> {
  const id = ambientThreadId(args.sessionId);
  const title = args.title ?? `Session continuity ${id.split(':').at(-1) ?? ''}`;
  const metadata = args.metadata ?? {};
  const rows = await query<SessionMemoryThread>(
    `INSERT INTO memory_threads
       (id, session_id, player_id, kind, title, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       session_id = EXCLUDED.session_id,
       player_id = EXCLUDED.player_id,
       kind = EXCLUDED.kind,
       title = EXCLUDED.title,
       metadata = memory_threads.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING id, session_id, player_id, kind, title, metadata`,
    [
      id,
      args.sessionId,
      args.playerId,
      args.kind ?? 'ambient',
      title,
      JSON.stringify(metadata),
    ],
  );
  return rows.rows[0]!;
}

export async function attachMemoryToThread(args: {
  sessionId: string;
  playerId: number;
  memoryId: number;
  questId?: number | null;
}): Promise<string> {
  const thread = await ensureSessionMemoryThread({
    sessionId: args.sessionId,
    playerId: args.playerId,
    metadata: {last_memory_id: args.memoryId},
  });
  const metadata = normalizeMetadata(thread.metadata);
  metadata['memory_ids'] = appendUniqueNumber(metadata['memory_ids'], args.memoryId, 80);
  if (args.questId != null) {
    metadata['quest_ids'] = appendUniqueNumber(metadata['quest_ids'], args.questId, 40);
  }
  await query(
    `UPDATE memory_threads
        SET metadata = $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [thread.id, JSON.stringify(metadata)],
  );
  return thread.id;
}

export async function recordThreadEvidence(args: {
  sessionId: string;
  playerId: number;
  kind: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const thread = await ensureSessionMemoryThread({
    sessionId: args.sessionId,
    playerId: args.playerId,
  });
  const metadata = normalizeMetadata(thread.metadata);
  const evidence = Array.isArray(metadata['evidence'])
    ? [...(metadata['evidence'] as unknown[])]
    : [];
  evidence.push({
    kind: args.kind,
    at: new Date().toISOString(),
    ...boundedPayload(args.payload),
  });
  metadata['evidence'] = evidence.slice(-40);
  await query(
    `UPDATE memory_threads
        SET metadata = $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [thread.id, JSON.stringify(metadata)],
  );
  return thread.id;
}

function appendUniqueNumber(value: unknown, item: number, max: number): number[] {
  const arr = Array.isArray(value)
    ? value.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0)
    : [];
  return [...new Set([...arr, item])].slice(-max);
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? {...(value as Record<string, unknown>)}
    : {};
}

function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload).slice(0, 10)) {
    if (typeof value === 'string') out[key] = value.slice(0, 240);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (value == null) out[key] = null;
    else out[key] = JSON.stringify(value).slice(0, 240);
  }
  return out;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80) || 'unknown';
}
