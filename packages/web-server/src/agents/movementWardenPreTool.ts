/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 51 — Movement Warden hard rejection.
//
// Pre-tool validator on `narrate`. Spec 46 shipped Movement
// Warden as a postTurn observer that WARNED about narrator
// teleports via SSE; this validator BLOCKS them at dispatch
// time so broker retries with corrected args.
//
// Algorithm:
//   1. Skip if not narrate, or text empty.
//   2. Extract @-mentioned location names (Unicode-aware).
//   3. Resolve to entity ids; filter to kind='location';
//      drop the player's current_location_id.
//   4. If no remaining candidates → pass (most narrate calls).
//   5. Check tool_invocations for this turn — if move_player
//      already fired with target_location_id matching any
//      candidate, the placement is legitimate → pass.
//   6. Otherwise: invoke the LLM warden specialist (same
//      prompt as the postTurn observer — multilingual). If
//      it flags any candidate, return rejected.
//
// Fail-open: any internal error → pass. Timeout 4500ms hard
// cap so a hung LLM never deadlocks a player turn.
//
// Spec 46 postTurn observer stays as defense-in-depth: if
// pre-tool failed open and a teleport slipped through, the
// observer still emits the warning SSE.

import {z} from 'zod';
import {query} from '../db.js';
import {extractMentionsAnyScript} from './movementWarden.js';
import {movementWardenPrompt} from './movementWardenPrompt.js';
import {runSpecialist} from './base.js';
import type {ToolContext, PreToolValidator} from '../tools/base.js';
import {registerPreToolValidatorSpecialist} from '../specialists/registry.js';

const WardenOutput = z.object({
  flagged: z
    .array(
      z.object({
        location_id: z.number().int(),
        reason: z.string().min(1).max(280),
      }),
    )
    .max(5),
});

const validator: PreToolValidator = async (toolName, args, ctx) => {
  if (toolName !== 'narrate') return {ok: true};
  try {
    return await detect(args as {text?: string}, ctx);
  } catch (err) {
    // CATCH-WARN-OK: pre-tool validator that explicitly fails open so the broker's narrate call still proceeds; the post-turn movement_warden observer (above) still runs and is the canonical record path for teleport detection.
    console.warn(
      '[movement_warden_pretool] failed-open:',
      err instanceof Error ? err.message : err,
    );
    return {ok: true};
  }
};

async function detect(
  args: {text?: string},
  ctx: ToolContext,
): Promise<
  {ok: true} | {ok: false; reason: string; suggestion?: Record<string, unknown>}
> {
  const text = args.text ?? '';
  if (text.length === 0) return {ok: true};

  // 1. Extract @-mentions across any script (Unicode \p{L}\p{N}).
  const mentions = extractMentionsAnyScript(text);
  if (mentions.size === 0) return {ok: true};

  // 2. Resolve names to location entities.
  const names = [...mentions.keys()];
  const locRows = await query<{id: number; display_name: string}>(
    `SELECT id, display_name FROM entities
      WHERE kind = 'location' AND display_name = ANY($1::text[])`,
    [names],
  );
  if (locRows.rows.length === 0) return {ok: true};

  // 3. Load player's current location.
  const playerRow = await query<{current_location_id: number | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [ctx.playerId],
  );
  const currentLocationId = playerRow.rows[0]?.current_location_id ?? null;

  const candidates = locRows.rows.filter(r => r.id !== currentLocationId);
  if (candidates.length === 0) return {ok: true};

  // 4. Check this turn's move_player calls — if any matches a
  //    candidate, the placement is legitimate.
  if (ctx.turnId) {
    const moves = await query<{args: Record<string, unknown> | null}>(
      `SELECT args FROM tool_invocations
        WHERE tool_name = 'move_player' AND turn_id = $1`,
      [ctx.turnId],
    );
    for (const row of moves.rows) {
      const tid = Number(row.args?.['target_location_id']);
      if (Number.isFinite(tid) && candidates.some(c => c.id === tid)) {
        return {ok: true};
      }
    }
  }

  // 5. LLM verdict (multilingual semantic check).
  let currentLocationName: string | null = null;
  if (currentLocationId != null) {
    const cur = await query<{display_name: string}>(
      `SELECT display_name FROM entities WHERE id = $1`,
      [currentLocationId],
    );
    currentLocationName = cur.rows[0]?.display_name ?? null;
  }

  const fallbackAbort = new AbortController();
  const verdict = await runSpecialist(
    {
      name: 'movement_warden_pretool',
      mode: 'blocking' as const,
      outputSchema: WardenOutput,
      timeoutMs: 4500,
      temperature: 0.2,
      maxOutputTokens: 500,
      buildPrompt: (i: unknown) => ({
        system: movementWardenPrompt.system,
        user: movementWardenPrompt.buildUser(i as never),
      }),
    },
    {
      narrate_text: text,
      current_location_name: currentLocationName,
      candidate_locations: candidates.map(c => ({
        id: c.id,
        display_name: c.display_name,
      })),
    },
    {
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId ?? `pretool-${Date.now()}`,
      signal: ctx.signal ?? fallbackAbort.signal,
    },
  );
  if (!verdict || verdict.flagged.length === 0) return {ok: true};

  // 6. Pick the first flagged candidate as the rejection's primary
  //    reason. Validate the id is in the candidate set (defends
  //    against hallucinated ids).
  const candidateIds = new Set(candidates.map(c => c.id));
  const f = verdict.flagged.find(x => candidateIds.has(x.location_id));
  if (!f) return {ok: true};
  const loc = candidates.find(c => c.id === f.location_id);
  if (!loc) return {ok: true};

  return {
    ok: false,
    reason: `narrator teleport blocked: ${f.reason}`,
    suggestion: {
      action:
        `either (1) call move_player(target_location_id=${loc.id}, intent_source='user_command') BEFORE narrate when the player's input commanded the move, OR (2) rewrite the narrate so the player STAYS at their current location and @${loc.display_name} is referenced as a destination/topic — not a place they ARE.`,
      flagged_location_id: loc.id,
      flagged_location_name: loc.display_name,
      currentLocationId,
      currentLocationName,
    },
  };
}

registerPreToolValidatorSpecialist({
  name: 'movement_warden.narrate',
  phase: 'preToolValidator',
  toolName: 'narrate',
  validator,
});
