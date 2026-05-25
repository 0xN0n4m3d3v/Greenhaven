/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — auto-engage dialogue mode when the player's free
// text @-mentions an NPC.  Players can type "@Mikka, как дела?"
// without clicking a Talk button: the helper detects the address,
// sets `dialogue_partner_id`, emits the `dialogue:engaged` GUI event
// and the `dialogue:participants_updated` SSE event, and downstream
// (turn_context, narrate fallback) treat it as live dialogue with
// that NPC.  Switches partner if a different NPC is mentioned;
// preserves the existing partner when no NPC is mentioned (so
// mid-conversation "сколько за лампу?" continues with the current
// partner).  Non-fatal: a failure inside the helper is logged but
// never aborts the turn.

import {maybeAutoEngageDialogue} from '../dialogueAutoEngage.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const dialogueAutoEngagePhase: Phase = {
  name: 'dialogue_auto_engage',
  async run(context: TurnContext): Promise<void> {
    await maybeAutoEngageDialogue(
      context.input.playerId,
      context.input.text,
      {
        session: context.session,
        turnId: context.turnId,
      },
    );
  },
};
