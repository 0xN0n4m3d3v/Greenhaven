/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — narrate SSE / GUI-event surface.
//
// The original `tools/narrate.ts` had a handful of `.sse.emit(...)`
// calls each annotated with an `SSE-OK` rationale (the chat_messages
// INSERT happens before this point; SseBridge.emit auto-defers via
// onTransactionCommit when nested in a transaction; the live-prose
// channel is not a state-change in its own right). Those rationales
// migrate verbatim so the local ESLint rule documenting the contract
// continues to pass.

import {bindReleasedTurnGuiEventsToMessage, emitGuiEvent} from '../../guiEventOutbox.js';
import {emitEntityMediaScript} from '../../services/CartridgeMediaScriptService.js';
import {sessionManager} from '../../sessionManager.js';
import type {ToolContext} from '../base.js';
import type {DialogueParticipantUpdate} from '../../dialogueParticipants.js';

export async function emitDialogueEngaged(args: {
  ctx: ToolContext;
  authorId: number;
  authorName: string | null;
  update: DialogueParticipantUpdate;
}): Promise<void> {
  if (
    !args.update.changed ||
    args.update.state.focused_partner_id !== args.authorId
  ) {
    return;
  }
  const session = sessionManager.get(args.ctx.sessionId);
  if (session) {
    await emitGuiEvent(
      args.ctx,
      'dialogue:engaged',
      {
        npcId: args.authorId,
        npcName: args.authorName,
      },
      {phase: 'narration'},
    );
    await emitEntityMediaScript(args.ctx, args.authorId, 'person').catch(
      (err) => {
        console.warn(
          '[narrate] dialogue partner media failed (continuing):',
          err instanceof Error ? err.message : err,
        );
      },
    );
  }
  // SSE-OK: emit outside tx (reason: setDialogueParticipants in
  // dialogueSync is the canonical dialogue-participant write;
  // SseBridge.emit auto-defers via onTransactionCommit when nested
  // in withTransaction).
  session?.sse.emit('dialogue:participants_updated', {
    focused_partner_id: args.update.state.focused_partner_id,
    participant_ids: args.update.state.participant_ids,
    participants: args.update.participants,
    source: args.update.state.source,
  });
}

export function emitDialogueParticipantsCleared(args: {
  sessionId: string;
  cleared: DialogueParticipantUpdate;
}): void {
  if (!args.cleared.changed) return;
  const session = sessionManager.get(args.sessionId);
  // SSE-OK: emit outside tx (reason: clearDialogueParticipants in
  // dialogueSync is the canonical write; SseBridge.emit auto-defers
  // via onTransactionCommit when nested in withTransaction).
  session?.sse.emit('dialogue:participants_updated', {
    focused_partner_id: args.cleared.state.focused_partner_id,
    participant_ids: args.cleared.state.participant_ids,
    participants: args.cleared.participants,
    source: args.cleared.state.source,
  });
}

export interface NarrateStreamArgs {
  ctx: ToolContext;
  messageId: number | null;
  messageTurnIndex: number;
  authorName: string | null;
  authorId: number | null;
  tone: 'npc' | 'narrator' | 'system';
  mood: string | null;
  mentions: Array<{id: number; name: string; kind: string}>;
  text: string;
}

/**
 * Final post-insert sequence: tell the UI who's talking before any
 * content delta lands, bind released-turn GUI events to the just-
 * INSERTed chat_messages row, then push the prose as a single
 * `content` delta (if the model didn't already stream it via natural
 * Content events). Accumulate the narrativeBuffer that postTurnPhase
 * specialists read in lieu of tool history.
 */
export async function emitNarrationStream(
  args: NarrateStreamArgs,
): Promise<void> {
  const session = sessionManager.get(args.ctx.sessionId);
  if (session?.activeTurn && args.messageId != null) {
    session.activeTurn.finalMessageId = args.messageId;
  }
  // SSE-OK: emit outside tx (reason: chat_messages INSERT for the
  // narrator row already happened just above; this is the streaming-
  // content delivery surface that tells the UI who is talking before
  // any content delta lands).
  session?.sse.emit('narrate', {
    turnId: args.ctx.turnId,
    messageId: args.messageId,
    turnIndex: args.messageTurnIndex,
    author: args.authorName,
    authorId: args.authorId,
    tone: args.tone,
    mood: args.mood,
    mentions: args.mentions,
  });
  await bindReleasedTurnGuiEventsToMessage({
    sessionId: args.ctx.sessionId,
    turnId: args.ctx.turnId,
    messageId: args.messageId,
  });
  // Push prose as a single content delta IFF the model didn't
  // already stream it via natural Content events this turn. Without
  // the gate, a model that both streams AND calls narrate(text=…)
  // would have its prose accumulated twice in the UI's turnText
  // buffer — the bubble showed the same paragraphs back-to-back.
  if (!session?.activeTurn?.streamedContent) {
    const active = session?.activeTurn;
    const streamSeq =
      active && args.ctx.turnId && active.turnId === args.ctx.turnId
        ? (active.streamSeq = (active.streamSeq ?? 0) + 1)
        : null;
    // SSE-OK: emit outside tx (reason: streaming narrator content
    // delta; the chat_messages row was already INSERTed above, this
    // surface is the live-prose delivery channel, not a state-change
    // in its own right).
    session?.sse.emit('content', {
      turnId: args.ctx.turnId,
      streamSeq,
      delta: args.text,
    });
  }

  // Spec 39 — accumulate visible narrative for postTurnPhase
  // specialists (Quest Watcher needs to read what the player saw,
  // not just what tools fired).
  if (session?.activeTurn) {
    const prior = session.activeTurn.narrativeBuffer ?? '';
    session.activeTurn.narrativeBuffer = prior
      ? `${prior}\n\n${args.text}`
      : args.text;
  }
}
