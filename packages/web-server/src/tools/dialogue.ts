/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 36 §5 — switch_dialogue_partner.
//
// Auto-engage already handles `@Mikka` mid-prose (player binds the
// partner by mention). This tool gives the broker an explicit handle:
// flip players.dialogue_partner_id to a different NPC mid-scene, the
// previous partner stays in scene but the DIALOGUE PARTNER preamble +
// memory injection (spec 34) re-rank around the new partner.

import {z} from 'zod';
import {query} from '../db.js';
import {
  clearDialogueParticipants,
  setDialogueParticipants,
} from '../dialogueParticipants.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {emitEntityMediaScript} from '../services/CartridgeMediaScriptService.js';
import {sessionManager} from '../sessionManager.js';
import {registerTool, resolveEntityId} from './base.js';

const SwitchPartnerArgs = z.object({
  partner: z.string(),
});

registerTool({
  name: 'switch_dialogue_partner',
  description:
    "Switch the active dialogue partner mid-scene. Old partner stays in scene but DIALOGUE PARTNER preamble + memory injection flip to the new partner. Pass 'null' or empty string to clear the partner.",
  paramsSchema: SwitchPartnerArgs,
  async execute(args, ctx) {
    const raw = args.partner.trim();
    if (raw === '' || raw.toLowerCase() === 'null') {
      const update = await clearDialogueParticipants(ctx.playerId, {
        source: 'tool',
        turnId: ctx.turnId,
      });
      await emitGuiEvent(ctx, 'dialogue:partner_switched', {
        partner_id: null,
      });
      // SSE-OK: emit outside tx (reason: clearDialogueParticipants
      // above is the canonical write; SseBridge.emit auto-defers
      // via onTransactionCommit when nested in withTransaction).
      sessionManager.get(ctx.sessionId)?.sse.emit('dialogue:participants_updated', {
        focused_partner_id: update.state.focused_partner_id,
        participant_ids: update.state.participant_ids,
        participants: update.participants,
        source: update.state.source,
      });
      return {ok: true, partner_id: null};
    }
    const partnerId = await resolveEntityId(raw);
    if (partnerId == null) return {ok: false, error: `unknown NPC: ${raw}`};
    const partner = await query<{kind: string; display_name: string}>(
      `SELECT kind, display_name FROM entities WHERE id = $1`,
      [partnerId],
    );
    if (partner.rows.length === 0)
      return {ok: false, error: `unknown entity: ${partnerId}`};
    if (partner.rows[0]!.kind !== 'person')
      return {ok: false, error: `not a person: ${partner.rows[0]!.display_name}`};
    const update = await setDialogueParticipants(ctx.playerId, {
      focusedId: partnerId,
      participantIds: [partnerId],
      source: 'tool',
      turnId: ctx.turnId,
      sessionId: ctx.sessionId,
    });
    if (update.rejected_focus_id === partnerId) {
      return {
        ok: false,
        error: `NPC is not present for this player: ${partner.rows[0]!.display_name}`,
      };
    }
    await emitGuiEvent(ctx, 'dialogue:partner_switched', {
      partner_id: partnerId,
      partner_name: partner.rows[0]!.display_name,
    });
    await emitEntityMediaScript(ctx, partnerId, 'person').catch((err) => {
      console.warn(
        '[switch_dialogue_partner] partner media script failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    });
    // SSE-OK: emit outside tx (reason: setDialogueParticipants
    // above is the canonical write; SseBridge.emit auto-defers
    // via onTransactionCommit when nested in withTransaction).
    sessionManager.get(ctx.sessionId)?.sse.emit('dialogue:participants_updated', {
      focused_partner_id: update.state.focused_partner_id,
      participant_ids: update.state.participant_ids,
      participants: update.participants,
      source: update.state.source,
    });
    return {ok: true, partner_id: partnerId, partner_name: partner.rows[0]!.display_name};
  },
});
