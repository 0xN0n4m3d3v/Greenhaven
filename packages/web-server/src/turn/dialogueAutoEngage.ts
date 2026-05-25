/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 — auto-engage dialogue helper.
//
// Lives next to the turn lifecycle (rather than back inside
// `turnRunnerV2.ts`) so the `DialogueAutoEngagePhase` can import it
// without creating a `phase → runner → phase` cycle.  The contract,
// logging, GUI/SSE event emission, and non-fatal try/catch behavior
// match the previous inline helper byte-for-byte.

import {
  idsInMentionOrder,
  setDialogueParticipants,
} from '../dialogueParticipants.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {emitEntityMediaScript} from '../services/CartridgeMediaScriptService.js';
import type {Session} from '../sessionManager.js';
import {getAllMentionEntities, scanMentions} from '../tools/runtimeContext.js';

export async function maybeAutoEngageDialogue(
  playerId: number,
  text: string,
  opts: {session?: Session; turnId?: string | null} = {},
): Promise<void> {
  if (!text || !text.includes('@')) return;
  try {
    const mentionEntities = await getAllMentionEntities(playerId);
    const mentions = scanMentions(text, mentionEntities);
    const npcIds = idsInMentionOrder(text, mentions);
    const focusedId = npcIds[0] ?? null;
    if (focusedId == null) return;
    const update = await setDialogueParticipants(playerId, {
      focusedId,
      participantIds: npcIds,
      source: 'mentions',
      turnId: opts.turnId,
      sessionId: opts.session?.id,
      preserveExisting: false,
    });
    if (!update.changed) return;
    if (opts.session) {
      if (update.state.focused_partner_id != null) {
        const focused = update.participants.find(
          (p) => p.id === update.state.focused_partner_id,
        );
        await emitGuiEvent(
          {
            sessionId: opts.session.id,
            playerId,
            turnId: opts.turnId ?? undefined,
          },
          'dialogue:engaged',
          {
            npcId: update.state.focused_partner_id,
            npcName: focused?.display_name ?? null,
          },
        );
        await emitEntityMediaScript(
          {
            sessionId: opts.session.id,
            playerId,
            turnId: opts.turnId ?? undefined,
          },
          update.state.focused_partner_id,
          'person',
        ).catch((err) => {
          console.warn(
            '[turnV2] dialogue partner media failed (continuing):',
            err instanceof Error ? err.message : err,
          );
        });
      }
    }
    // SSE-OK: emit outside tx (reason: setDialogueParticipants
    // above is the canonical write; SseBridge.emit auto-defers
    // via onTransactionCommit when nested in withTransaction).
    opts.session?.sse.emit('dialogue:participants_updated', {
      focused_partner_id: update.state.focused_partner_id,
      participant_ids: update.state.participant_ids,
      participants: update.participants,
      source: update.state.source,
    });
  } catch (err) {
    // CATCH-WARN-OK: auto-engage is a best-effort dialogue-attach helper; the surrounding turn lifecycle continues without an engaged partner, and `setDialogueParticipants` errors are already captured by the writer-side telemetry in `dialogueParticipants.ts`.
    console.warn('[turnV2] auto-engage dialogue failed (non-fatal):', err);
  }
}
