/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 / USER-5 / USER-6 phase — `turn.start` SSE emit + player
// chat message persistence + `message:created` SSE emit.
//
//   1. Emit `turn.start` over SSE with the broker user-prompt text.
//      `turn.start` is a turn-lifecycle marker the UI uses to mark
//      the queued job as running; it is NOT a DB state-change event,
//      so it stays outside the transaction.  See `SSE-OK` comment
//      below.
//   2. Open a transaction. Inside it:
//        * Read the next turn index (`SELECT MAX(turn_index)+1`).
//        * Read the player's current location.
//        * `loadWitnessIdsForLocation(...)` — uses the same
//          AsyncLocalStorage-routed `query()`, so the witness
//          lookup runs against the tx client.
//        * Read the active dialogue partner.
//        * INSERT INTO `chat_messages` (player row, witness scope).
//        * If a dialogue partner is active, AWAIT the INSERT INTO
//          NPC-memory auto-snapshot via `MemoryService`. No more
//          fire-and-forget:
//          if the snapshot fails, the whole transaction rolls back,
//          leaving neither row committed.
//        * Register `gameplay:turn.player_message.persisted`
//          telemetry through `onTransactionCommit(...)` so the
//          event is only recorded after COMMIT.
//        * Emit `message:created` via `session.sse.emit(...)`. The
//          SseBridge auto-routes the emit through
//          `onTransactionCommit(...)`, so the UI never sees the
//          event for a rolled-back row.
//   3. If the transaction commits, store
//      `{messageId, turnIndex, persisted:true}` on state. If it
//      rolls back (insert / witness / snapshot / partner-lookup
//      failure), store `{messageId:null, turnIndex:null,
//      persisted:false}`, log the same warning, and let the turn
//      continue.
//
// USER-5 / USER-6 scope: this slice covers the player-message slice
// of those tickets — the broader project-wide commit-hook audit
// (every state-changing SSE in the codebase) is still open.

import {
  onTransactionCommit,
  query,
  withTransaction,
  type TxClient,
} from '../../db.js';
import {insertArchivalNpcMemory} from '../../domain/memory/index.js';
import {loadWitnessIdsForLocation} from '../../locationPresence.js';
import {resolveActivePlayerCartridgeId} from '../../services/CartridgePlaythroughService.js';
import {telemetry} from '../../telemetry/index.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';
import {readTurnPreparationFromState} from './PlayerPromptPhase.js';

export interface PlayerMessagePersistenceResult {
  /** Persisted `chat_messages.id`, or `null` when the transaction
   *  rolled back (the warning is already logged). */
  messageId: number | null;
  /** `chat_messages.turn_index` of the inserted row, or
   *  `null` when nothing was committed. */
  turnIndex: number | null;
  /** True iff the transaction committed. Drives the
   *  `message:created` SSE emit and the
   *  `turn.player_message.persisted` telemetry record. */
  persisted: boolean;
}

export const PLAYER_MESSAGE_PERSISTENCE_STATE_KEY =
  'playerMessagePersistence' as const;

export function readPlayerMessagePersistenceFromState(
  context: TurnContext,
): PlayerMessagePersistenceResult {
  const raw = context.state[PLAYER_MESSAGE_PERSISTENCE_STATE_KEY];
  if (raw == null) {
    throw new Error(
      'playerMessagePersistencePhase did not run before ' +
        'readPlayerMessagePersistenceFromState',
    );
  }
  return raw as PlayerMessagePersistenceResult;
}

export const playerMessagePersistencePhase: Phase = {
  name: 'player_message_persistence',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId} = context;
    const {rawPlayerText, visiblePlayerText, playerRenderMeta} =
      readTurnPreparationFromState(context);

    // SSE-OK: emit outside tx (reason: turn lifecycle marker, not
    // DB state-change). The UI uses `turn.start` to flip the queued
    // job into "running"; whether the chat_messages row commits or
    // rolls back, the turn is still running.
    session.sse.emit('turn.start', {
      turnId,
      text: rawPlayerText,
      originalText: rawPlayerText,
      visibleText: visiblePlayerText,
      actionId: input.actionId,
    });

    context.state[PLAYER_MESSAGE_PERSISTENCE_STATE_KEY] =
      await persistPlayerMessageOrLog({
        session,
        input,
        turnId,
        rawPlayerText,
        visiblePlayerText,
        playerRenderMeta,
      });
  },
};

interface PersistArgs {
  session: TurnContext['session'];
  input: TurnContext['input'];
  turnId: string;
  rawPlayerText: string;
  visiblePlayerText: string;
  playerRenderMeta: unknown;
}

async function persistPlayerMessageOrLog(
  args: PersistArgs,
): Promise<PlayerMessagePersistenceResult> {
  try {
    return await withTransaction(
      async (_tx: TxClient): Promise<PlayerMessagePersistenceResult> =>
        persistPlayerMessageTx(args),
    );
  } catch (err) {
    // CATCH-WARN-OK: this catch wraps the `withTransaction` block; rollback is automatic and the surrounding turn lifecycle reads `result` (still null on this branch) to skip downstream consumers. The transaction's SQL failure is recorded through the standard withTransaction telemetry channel (ARCH-16); re-recording here would double-emit.
    console.warn(
      '[turnV2] persisting player message failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
    return {messageId: null, turnIndex: null, persisted: false};
  }
}

async function persistPlayerMessageTx(
  args: PersistArgs,
): Promise<PlayerMessagePersistenceResult> {
  const {session, input, turnId, rawPlayerText, visiblePlayerText, playerRenderMeta} =
    args;
  const playerTurnIdx = await query<{n: number}>(
    `SELECT COALESCE(MAX(turn_index), 0) + 1 AS n
       FROM chat_messages WHERE session_id = $1`,
    [session.id],
  );
  // Witness scope: NPCs present at the player's current location
  // at the moment they spoke. `query()` is AsyncLocalStorage-routed
  // through the tx client when called inside `withTransaction`, so
  // this lookup also runs against the active transaction.
  const playerLocRow = await query<{current_location_id: number | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [input.playerId],
  );
  const cartridgeId = await resolveWitnessCartridgeId(input.playerId);
  const witnessIds = await loadWitnessIdsForLocation(
    playerLocRow.rows[0]?.current_location_id ?? null,
    cartridgeId ?? undefined,
  );

  // Active dialogue partner — used to auto-snapshot the player's
  // message into that NPC's memory bank.
  const dialoguePartner = await query<{dialogue_partner_id: number | null}>(
    `SELECT dialogue_partner_id FROM players WHERE entity_id = $1`,
    [input.playerId],
  );
  const partnerForSnapshot =
    dialoguePartner.rows[0]?.dialogue_partner_id ?? null;
  const insertedPlayerMessage = await query<{id: number; turn_index: number}>(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload, player_id, witness_entity_ids)
     VALUES ($1, $2, 'player', $3, $4, $5::jsonb, $6, $7::bigint[])
     RETURNING id, turn_index`,
    [
      session.id,
      input.playerId,
      visiblePlayerText,
      playerTurnIdx.rows[0]!.n,
      JSON.stringify({
        turn_id: turnId,
        source: 'user',
        actionId: input.actionId ?? null,
        original_text: rawPlayerText,
        visible_text: visiblePlayerText,
        protagonist_renderer: playerRenderMeta,
      }),
      input.playerId,
      witnessIds,
    ],
  );
  const playerMessageId = insertedPlayerMessage.rows[0]?.id ?? null;
  const playerTurnIndex =
    insertedPlayerMessage.rows[0]?.turn_index ?? playerTurnIdx.rows[0]!.n;

  await autoSnapshotPlayerUtterance({
    partnerForSnapshot,
    visiblePlayerText,
    playerId: input.playerId,
    turnId,
  });

  // USER-6 — `turn.player_message.persisted` telemetry and
  // `message:created` SSE both register through explicit commit
  // hooks. `SseBridge.emit` would also route through
  // `onTransactionCommit(...)` internally, but registering the hook
  // here keeps the rollback-safety contract testable and obvious at
  // the call site: on rollback the hooks never fire and the UI
  // never sees the event.
  registerCommitHooks({
    session,
    input,
    turnId,
    playerMessageId,
    playerTurnIndex,
    rawPlayerText,
    visiblePlayerText,
    playerRenderMeta,
  });

  return {
    messageId: playerMessageId,
    turnIndex: playerTurnIndex,
    persisted: playerMessageId != null,
  };
}

async function resolveWitnessCartridgeId(
  playerId: number,
): Promise<string | null> {
  try {
    return await resolveActivePlayerCartridgeId(playerId);
  } catch {
    return null;
  }
}

interface AutoSnapshotArgs {
  partnerForSnapshot: number | null;
  visiblePlayerText: string;
  playerId: number;
  turnId: string;
}

async function autoSnapshotPlayerUtterance(
  args: AutoSnapshotArgs,
): Promise<void> {
  // USER-5 — the auto-snapshot is AWAITED inside the same
  // transaction as the `chat_messages` insert. A failure here
  // rolls both rows back so we never end up with a player chat
  // row but no partner memory entry.
  if (args.partnerForSnapshot == null || !args.visiblePlayerText.trim()) return;
  const text =
    args.visiblePlayerText.length > 600
      ? args.visiblePlayerText.slice(0, 597).trimEnd() + '…'
      : args.visiblePlayerText;
  // USER-5 — `insertArchivalNpcMemory` writes through the same
  // AsyncLocalStorage-bound `query()` that `withTransaction` swaps to
  // the tx client, so the awaited INSERT stays inside the player-
  // message transaction. A throw here propagates and rolls both rows
  // back exactly like the prior inline SQL did.
  await insertArchivalNpcMemory({
    ownerEntityId: args.partnerForSnapshot,
    aboutEntityId: args.playerId,
    text,
    importance: 0.4,
    tags: ['narrate_auto', 'player_utterance'],
    sensitive: false,
    salience: 0.45,
    sourceTurnId: args.turnId,
    sourceTool: 'player_message.auto_snapshot',
    metadata: {visibility: 'public', auto: true},
  });
}

interface CommitHookArgs {
  session: TurnContext['session'];
  input: TurnContext['input'];
  turnId: string;
  playerMessageId: number | null;
  playerTurnIndex: number;
  rawPlayerText: string;
  visiblePlayerText: string;
  playerRenderMeta: unknown;
}

function registerCommitHooks(args: CommitHookArgs): void {
  const {
    session,
    input,
    turnId,
    playerMessageId,
    playerTurnIndex,
    rawPlayerText,
    visiblePlayerText,
    playerRenderMeta,
  } = args;
  onTransactionCommit(async () => {
    telemetry.record({
      channel: 'gameplay',
      name: 'turn.player_message.persisted',
      sessionId: session.id,
      playerId: input.playerId,
      turnId,
      data: {
        message_id: playerMessageId,
        turn_index: playerTurnIndex,
        text: visiblePlayerText,
        original_text: rawPlayerText,
        action_id: input.actionId ?? null,
      },
    });
  });
  onTransactionCommit(async () => {
    session.sse.emit('message:created', {
      messageId: playerMessageId,
      turnId,
      turnIndex: playerTurnIndex,
      tone: 'player',
      authorId: input.playerId,
      text: rawPlayerText,
      visibleText: visiblePlayerText,
      renderer: playerRenderMeta,
    });
  });
}
