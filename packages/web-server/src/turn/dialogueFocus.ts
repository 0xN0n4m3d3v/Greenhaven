/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 — dialogue focus reconciliation.
//
// Moved out of `turnRunnerV2.ts` so the `RouteResolutionPhase` can
// import this helper without creating a `phase → runner → phase`
// cycle.  The contract, GUI/SSE event emission, and non-fatal
// try/catch behavior match the previous inline helper byte-for-byte;
// only the location of the code changed.

import type {DialogueAct, Mode} from '../ai/classifier.js';
import {
  clearDialogueParticipants,
  loadCompanionIdsForPlayer,
  loadDialogueParticipantState,
  setDialogueParticipants,
  type DialogueParticipantUpdate,
} from '../dialogueParticipants.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import type {Session} from '../sessionManager.js';

export interface ReconcileDialogueFocusOptions {
  actionId?: string;
  session?: Session;
  turnId?: string | null;
}

// X-3 classifier-hint refactor — the farewell branch used to inspect
// raw player text with an en+ru goodbye regex. The mode classifier now
// emits a structured `DialogueAct` (`farewell` / `action` / `none`)
// alongside `mode`, so we route on the classifier's intent label
// instead of re-parsing the prose. See `feedback_no_language_hardcode`.
export async function reconcileDialogueFocusForTurn(
  playerId: number,
  mode: Mode,
  dialogueAct: DialogueAct,
  opts: ReconcileDialogueFocusOptions = {},
): Promise<void> {
  try {
    const [state, companionIds] = await Promise.all([
      loadDialogueParticipantState(playerId),
      loadCompanionIdsForPlayer(playerId),
    ]);
    const focusedId = state.focused_partner_id;
    const focusedIsCompanion =
      focusedId != null && companionIds.includes(focusedId);
    const npcActionId = parseEntityActionId(opts.actionId, 'npc');
    if (npcActionId != null) {
      const participantIds = uniquePositiveIds([npcActionId, ...companionIds]);
      const update = await setDialogueParticipants(playerId, {
        focusedId: npcActionId,
        participantIds,
        explicitParticipantIds: participantIds,
        preserveExisting: false,
        source: 'route',
        turnId: opts.turnId,
        sessionId: opts.session?.id,
      });
      if (update.rejected_focus_id === npcActionId) return;
      await emitDialogueParticipantsUpdate(playerId, update, opts, {
        reason: 'player_addressed_npc',
      });
      return;
    }

    if (focusedId == null) return;
    if (focusedIsCompanion) {
      const companionOnly =
        isTravelActionId(opts.actionId) || mode !== 'dialogue';
      const participantIds = companionOnly
        ? companionIds
        : uniquePositiveIds([...state.participant_ids, ...companionIds]);
      const update = await setDialogueParticipants(playerId, {
        focusedId,
        participantIds,
        explicitParticipantIds: companionIds,
        preserveExisting: false,
        source: 'route',
        turnId: opts.turnId,
        sessionId: opts.session?.id,
      });
      await emitDialogueParticipantsUpdate(playerId, update, opts);
      return;
    }

    const isFarewell = dialogueAct === 'farewell';
    const shouldRelease =
      isTravelActionId(opts.actionId) || mode !== 'dialogue' || isFarewell;
    if (!shouldRelease) return;

    const update = await clearDialogueParticipants(playerId, {
      source: 'route',
      turnId: opts.turnId,
    });
    await emitDialogueParticipantsUpdate(playerId, update, opts, {
      reason: isTravelActionId(opts.actionId)
        ? 'player_moved_focus'
        : isFarewell
          ? 'player_farewell'
          : 'player_action',
    });
  } catch (err) {
    // CATCH-WARN-OK: focus reconcile is a best-effort dialogue-state realignment; the broker turn proceeds with the prior focus state, and the underlying `setDialogueParticipants` write surfaces its own SQL errors through the writer-side telemetry channel.
    console.warn(
      '[turnV2] dialogue focus reconcile failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}

async function emitDialogueParticipantsUpdate(
  playerId: number,
  update: DialogueParticipantUpdate,
  opts: {session?: Session; turnId?: string | null},
  switchEvent?: {reason: string},
): Promise<void> {
  if (!update.changed || !opts.session) return;
  if (switchEvent) {
    const focused = update.participants.find(
      (p) => p.id === update.state.focused_partner_id,
    );
    await emitGuiEvent(
      {
        sessionId: opts.session.id,
        playerId,
        turnId: opts.turnId ?? undefined,
      },
      'dialogue:partner_switched',
      {
        partner_id: update.state.focused_partner_id,
        partner_name: focused?.display_name ?? null,
        reason: switchEvent.reason,
      },
    );
  }
  // SSE-OK: emit outside tx (reason: setDialogueParticipants
  // above is the canonical dialogue-focus write; SseBridge.emit
  // auto-defers via onTransactionCommit when nested in
  // withTransaction).
  opts.session.sse.emit('dialogue:participants_updated', {
    focused_partner_id: update.state.focused_partner_id,
    participant_ids: update.state.participant_ids,
    participants: update.participants,
    source: update.state.source,
  });
}

function parseEntityActionId(
  actionId: string | undefined,
  prefix: string,
): number | null {
  if (!actionId?.startsWith(`${prefix}:`)) return null;
  const raw = actionId.slice(prefix.length + 1).split(':', 1)[0];
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isTravelActionId(actionId: string | undefined): boolean {
  return (
    parseEntityActionId(actionId, 'location') != null ||
    parseEntityActionId(actionId, 'scene') != null ||
    parseEntityActionId(actionId, 'travel') != null
  );
}

function uniquePositiveIds(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
