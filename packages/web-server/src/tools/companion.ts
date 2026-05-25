/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 52 — Companion auto-follow.
//
// `set_companion(npc, action='follow'|'stop_following')` adds or
// removes an NPC from the player's `players.metadata.companions[]`
// roster. Companions auto-follow on every move_player call (handled
// in tools/movement.ts) and appear in the next preamble's PEOPLE
// HERE at the player's current_location_id regardless of their
// profile.home_id (handled in turnContext/index.ts).
//
// The narrator therefore CANNOT desync companions from the player —
// their "location" is implicit (= player's). If a companion needs
// to be elsewhere, broker MUST call `set_companion(stop_following)`
// first.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {registerTool, resolveEntityId} from './base.js';

const SetCompanionArgs = z.object({
  /** NPC display_name OR entity id. Resolved via the standard helper. */
  npc: z.string(),
  action: z.enum(['follow', 'stop_following']),
  /** Short narrative reason — surfaces in the SSE event card. */
  reason: z.string().max(240).optional(),
});

export async function setCompanionState(
  args: z.infer<typeof SetCompanionArgs>,
  ctx: {playerId: number; sessionId?: string; turnId?: string},
): Promise<{
  ok: true;
  npc: string;
  npcId: number;
  action: 'follow' | 'stop_following';
  total: number;
  already: boolean;
}> {
  const npcId = await resolveEntityId(args.npc, {playerId: ctx.playerId});
  if (npcId == null) throw new Error(`unknown NPC: ${args.npc}`);

  // Validate the entity is kind='person'.
  const kindRow = await query<{kind: string; display_name: string}>(
    `SELECT kind, display_name FROM entities WHERE id = $1`,
    [npcId],
  );
  const ent = kindRow.rows[0];
  if (!ent) throw new Error(`entity ${npcId} not found`);
  if (ent.kind !== 'person') {
    throw new Error(
      `set_companion target must be kind='person'; got kind='${ent.kind}'`,
    );
  }

  // Read existing companions roster.
  const playerRow = await query<{metadata: Record<string, unknown> | null}>(
    `SELECT metadata FROM players WHERE entity_id = $1`,
    [ctx.playerId],
  );
  const meta = playerRow.rows[0]?.metadata ?? {};
  const current = Array.isArray(meta['companions'])
    ? (meta['companions'] as number[])
    : [];

  let next: number[];
  let already = false;
  if (args.action === 'follow') {
    if (current.includes(npcId)) {
      already = true;
      next = current;
    } else {
      next = [...current, npcId];
    }
  } else {
    if (!current.includes(npcId)) {
      already = true;
      next = current;
    } else {
      next = current.filter(x => x !== npcId);
    }
  }

  if (!already) {
    await query(
      `UPDATE players
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('companions', $1::jsonb)
        WHERE entity_id = $2`,
      [JSON.stringify(next), ctx.playerId],
    );
  }

  await query(
    `INSERT INTO actor_statuses
       (player_id, actor_entity_id, status_kind, status_value, intensity,
        source, metadata, updated_at)
     VALUES ($1, $2, 'companion', $3, $4, 'set_companion', $5::jsonb, now())
     ON CONFLICT (player_id, actor_entity_id, status_kind) DO UPDATE SET
       status_value = EXCLUDED.status_value,
       intensity = EXCLUDED.intensity,
       source = EXCLUDED.source,
       metadata = actor_statuses.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      ctx.playerId,
      npcId,
      args.action === 'follow' ? 'following' : 'not_following',
      args.action === 'follow' ? 1 : 0,
      JSON.stringify({
        reason: args.reason ?? null,
        turn_id: ctx.turnId ?? null,
      }),
    ],
  );

  if (ctx.sessionId) {
    await emitGuiEvent(
      {
        sessionId: ctx.sessionId,
        playerId: ctx.playerId,
        turnId: ctx.turnId,
      },
      args.action === 'follow' ? 'companion:added' : 'companion:removed',
      {
        npcId,
        npcName: ent.display_name,
        reason: args.reason ?? null,
        total: next.length,
        already,
      },
    );
  }

  return {
    ok: true,
    npc: ent.display_name,
    npcId,
    action: args.action,
    total: next.length,
    already,
  };
}

registerTool({
  name: 'set_companion',
  description:
    "Bond or unbond a companion NPC. " +
    "follow → adds the NPC to the player's companions roster; the NPC will auto-follow on every subsequent move_player and appears in PEOPLE HERE at the player's current location regardless of their profile.home_id. " +
    "stop_following → removes the NPC from the roster. " +
    "Pair with narrative beats: NPC swearing fealty, joining the party, departing in conflict. " +
    "NEVER narrate a companion at a different location than the player — Movement Warden will reject. If they need to be elsewhere, unbond first.",
  paramsSchema: SetCompanionArgs,
  async execute(args, ctx) {
    return await setCompanionState(args, ctx);
  },
});
