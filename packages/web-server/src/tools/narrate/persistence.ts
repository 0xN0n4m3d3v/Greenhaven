/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — narrate persistence helpers.
//
// Responsibilities:
//   - session-existence guard (a UI reset between turn start and
//     narrate can vacate the sessions row);
//   - turn-index allocator;
//   - chat_messages INSERT with FK-race handling;
//   - private internal_monologue archive (via MemoryService);
//   - auto-snapshot of NPC utterance (via MemoryService).
//
// The chat_messages INSERT throws `StopExecution('session gone')`
// for the FK-race code paths so the broker loop exits cleanly
// rather than crashing the turn.

import {query} from '../../db.js';
import {insertArchivalNpcMemory} from '../../domain/memory/index.js';
import {StopExecution} from '../base.js';
import type {AuthorKind} from './dialogueSync.js';

export async function guardSessionExists(args: {
  sessionId: string;
  turnId: string | null | undefined;
}): Promise<void> {
  const sessionRow = await query<{id: string}>(
    `SELECT id FROM sessions WHERE id = $1`,
    [args.sessionId],
  );
  if (sessionRow.rows.length === 0) {
    console.warn(
      `[narrate] session ${args.sessionId} disappeared mid-turn; ` +
        `skipping chat_message insert (turn=${args.turnId ?? '<?>'})`,
    );
    throw new StopExecution('session gone');
  }
}

export async function allocateTurnIndex(sessionId: string): Promise<number> {
  const r = await query<{n: number}>(
    `SELECT COALESCE(MAX(turn_index), 0) + 1 AS n
       FROM chat_messages WHERE session_id = $1`,
    [sessionId],
  );
  return r.rows[0]!.n;
}

export interface ChatMessageInsertArgs {
  sessionId: string;
  authorId: number | null;
  tone: string;
  text: string;
  turnIndex: number;
  payload: Record<string, unknown>;
  playerId: number;
  locationEntityId: number | null;
  npcEntityId: number | null;
  witnessIds: number[];
  turnId: string | null | undefined;
}

export interface ChatMessageInsertResult {
  messageId: number | null;
  turnIndex: number;
}

export async function insertChatMessageOrStop(
  args: ChatMessageInsertArgs,
): Promise<ChatMessageInsertResult> {
  try {
    const inserted = await query<{id: number; turn_index: number}>(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index, payload,
          player_id, location_entity_id, npc_entity_id, witness_entity_ids)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::bigint[])
       RETURNING id, turn_index`,
      [
        args.sessionId,
        args.authorId,
        args.tone,
        args.text,
        args.turnIndex,
        JSON.stringify(args.payload),
        args.playerId,
        args.locationEntityId,
        args.npcEntityId,
        args.witnessIds,
      ],
    );
    return {
      messageId: inserted.rows[0]?.id ?? null,
      turnIndex: inserted.rows[0]?.turn_index ?? args.turnIndex,
    };
  } catch (err) {
    // FK race: session row vanished between guard SELECT and this INSERT
    // (UI reset / SSE reconnect / app close). Bail out without killing
    // the turn — there is no consumer for the bubble anyway.
    const code = (err as {code?: string} | null)?.code;
    const constraint = (err as {constraint?: string} | null)?.constraint;
    if (code === '23503' || constraint === 'chat_messages_session_id_fkey') {
      // CATCH-WARN-OK: explicit FK-race short-circuit; the immediately-following `throw new StopExecution('session gone')` ends the turn cleanly and the surrounding turn lifecycle records `turn:cancelled` telemetry through the standard pipeline.
      console.warn(
        `[narrate] chat_messages FK violated (session ${args.sessionId} ` +
          `gone mid-turn); skipping (turn=${args.turnId ?? '<?>'})`,
      );
      throw new StopExecution('session gone');
    }
    throw err;
  }
}

/**
 * Persist the internal monologue as a PRIVATE npc_memory owned by
 * the speaking NPC, about the active player. The dialogueContext
 * read-path renders private memories under the "private thoughts"
 * block of THIS NPC's own preamble — never to other NPCs, never to
 * the player UI. This is how NPCs accumulate inner state ("she
 * suspects something", "I should not trust this offer") without
 * leaking it through the public chat. Fire-and-forget.
 */
export function persistInternalMonologueMemory(args: {
  authorKind: AuthorKind;
  authorId: number | null;
  playerId: number;
  turnId: string | null | undefined;
  internalMonologue: string;
}): void {
  if (args.authorKind !== 'person' || args.authorId == null) return;
  if (args.playerId == null) return;
  void insertArchivalNpcMemory({
    ownerEntityId: args.authorId,
    aboutEntityId: args.playerId,
    text: args.internalMonologue.slice(0, 2000),
    importance: 0.5,
    tags: ['internal_monologue'],
    sensitive: true,
    salience: 0.55,
    sourceTurnId: args.turnId ?? null,
    sourceTool: 'narrate.internal_monologue',
    metadata: {visibility: 'private'},
  }).catch((err) => {
    // CATCH-WARN-OK: private monologue is a best-effort archival write; the narrate turn itself already succeeded and the broker output is committed elsewhere in the same flow, so an archive miss is non-product-impacting and recording it through telemetry would noise the gameplay channel.
    console.warn(
      '[narrate] private internal_monologue persist failed (continuing):',
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * STRUCTURAL MEMORY GUARANTEE.
 *
 * Every time an NPC speaks via narrate, automatically write a public
 * memory record on that NPC about the active player. This is the
 * floor — the broker is *supposed to* call add_memory on canonical
 * thresholds (memory.md), but in practice it often skips. The result
 * was that NPCs ended up with zero memories despite long
 * conversations. The auto-snapshot keeps importance/salience low
 * (0.4 / 0.45), tags 'narrate_auto' for the rolling summarizer to
 * dedupe, marks visibility public (these are utterances the NPC said
 * aloud), caps text to ~600 chars, and is fire-and-forget.
 */
export function persistAutoSnapshotMemory(args: {
  authorKind: AuthorKind;
  authorId: number | null;
  playerId: number;
  turnId: string | null | undefined;
  text: string;
}): void {
  if (args.authorKind !== 'person' || args.authorId == null) return;
  if (!args.playerId) return;
  const memText =
    args.text.length > 600
      ? args.text.slice(0, 597).trimEnd() + '…'
      : args.text;
  void insertArchivalNpcMemory({
    ownerEntityId: args.authorId,
    aboutEntityId: args.playerId,
    text: memText,
    importance: 0.4,
    tags: ['narrate_auto', 'interaction'],
    sensitive: false,
    salience: 0.45,
    sourceTurnId: args.turnId ?? null,
    sourceTool: 'narrate.auto_snapshot',
    metadata: {visibility: 'public', auto: true},
  }).catch((err) => {
    // CATCH-WARN-OK: auto-snapshot memory is a best-effort archival write; the narrate turn itself already succeeded and the next turn's memory loop will re-derive the snapshot, so a write miss is non-product-impacting.
    console.warn(
      '[narrate] auto-snapshot memory failed (continuing):',
      err instanceof Error ? err.message : err,
    );
  });
}
