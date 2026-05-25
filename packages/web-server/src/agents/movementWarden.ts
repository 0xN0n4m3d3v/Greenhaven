/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 46 — Movement Warden.
//
// Async post-turn observer. Detects narrator teleportation:
// when narrate text places the player at a location !==
// current_location_id WITHOUT a move_player tool call.
//
// Detection is LLM-based for full multilingual support — the
// prompt understands prose semantically in any language (Hebrew,
// Arabic, Japanese, Hindi, Cyrillic, Latin, ...) without a
// hardcoded pronoun list per language.
//
// Pipeline:
//   1. If toolHistory contains move_player → no teleport. Skip.
//   2. Collect @-mentions from narrate.text across the turn.
//   3. Resolve them to entity ids (filter kind='location').
//   4. Drop the player's current_location_id (those mentions are
//      not teleports — they're just identifying where the player
//      already is).
//   5. If 0 candidates remain → skip.
//   6. Run the LLM warden specialist: which candidates does the
//      prose actually PLACE the player at? Returns flagged[].
//   7. For each flagged location, emit `movement:teleport_detected`
//      SSE.
//
// Fail open at every stage: any error caught at top level; turn
// is unaffected.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import {
  runSpecialist,
  type PostTurnHook,
  type SpecialistContext,
  type SpecialistDef,
} from './base.js';
import {movementWardenPrompt} from './movementWardenPrompt.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
  POST_TURN_SPECIALIST_WATCHDOG_MS,
} from '../postTurnTiming.js';

export const movementWardenHook: PostTurnHook = {
  name: 'movement_warden',
  presentation: {
    slotKey: 'post.movement_warden',
    lane: 'status',
    ordinal: 30,
    visible: true,
    barrierMode: 'chat_visible',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, turnRecord) {
    try {
      await detectTeleport(ctx, turnRecord.toolHistory);
    } catch (err) {
      // CATCH-WARN-OK: post-turn slot wrapper; the slot's own `presentationSlot.telemetry` (S-14) records the slot outcome with the failure status.
      console.warn(
        '[agent:movement_warden] failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    }
  },
};

// ── Specialist definition ──────────────────────────────────────────────

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

interface WardenInput {
  narrate_text: string;
  current_location_name: string | null;
  candidate_locations: Array<{id: number; display_name: string}>;
}

const def: SpecialistDef<WardenInput, z.infer<typeof WardenOutput>> = {
  name: 'movement_warden',
  mode: 'async',
  buildPrompt(input) {
    return {
      system: movementWardenPrompt.system,
      user: movementWardenPrompt.buildUser(input),
    };
  },
  outputSchema: WardenOutput,
  timeoutMs: POST_TURN_SPECIALIST_WATCHDOG_MS,
  temperature: 0.2,
  maxOutputTokens: 500,
};

// ── Detection ──────────────────────────────────────────────────────────

async function detectTeleport(
  ctx: SpecialistContext,
  toolHistory: Array<{name: string; args: unknown; result?: unknown}>,
): Promise<void> {
  // 1. If a move_player call fired this turn, there's no teleport.
  if (toolHistory.some(c => c.name === 'move_player')) return;

  // 2. Collect narrate texts.
  const narrateTexts: string[] = [];
  for (const c of toolHistory) {
    if (c.name !== 'narrate') continue;
    const args = c.args as Record<string, unknown> | null;
    const text = args?.['text'];
    if (typeof text === 'string') narrateTexts.push(text);
  }
  if (narrateTexts.length === 0) return;
  const narrateText = narrateTexts.join('\n\n');

  // 3. Extract @-mentions across all narrate texts. The regex matches
  //    on letter ranges across the major scripts the runtime supports
  //    via scriptUtil; using \p{L} would be ideal but the canonical
  //    @-display_name is bounded by punctuation so we list the script
  //    blocks explicitly. (Future: switch to \p{L} once we need
  //    additional scripts not covered here.)
  const mentions = extractMentionsAnyScript(narrateText);
  if (mentions.size === 0) return;

  // 4. Resolve mentions to location entities.
  const names = [...mentions.keys()];
  const locationRows = await query<{id: number; display_name: string}>(
    `SELECT id, display_name FROM entities
      WHERE kind = 'location' AND display_name = ANY($1::text[])`,
    [names],
  );

  // 5. Load player's current location.
  const playerRow = await query<{current_location_id: number | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [ctx.playerId],
  );
  const currentLocationId = playerRow.rows[0]?.current_location_id ?? null;
  let currentLocationName: string | null = null;
  if (currentLocationId != null) {
    const cur = await query<{display_name: string}>(
      `SELECT display_name FROM entities WHERE id = $1`,
      [currentLocationId],
    );
    currentLocationName = cur.rows[0]?.display_name ?? null;
  }

  // 6. Build candidate list (mentions that are NOT current location).
  const candidates = locationRows.rows
    .filter(r => r.id !== currentLocationId)
    .map(r => ({id: r.id, display_name: r.display_name}));
  if (candidates.length === 0) return;

  // 7. LLM verdict.
  const verdict = await runSpecialist(
    def,
    {
      narrate_text: narrateText,
      current_location_name: currentLocationName,
      candidate_locations: candidates,
    },
    ctx,
  );
  if (!verdict || verdict.flagged.length === 0) return;

  // 8. Emit SSE per flagged candidate. Validate each id is in the
  //    candidate set we passed in (defends against hallucinated ids).
  const candidateIds = new Set(candidates.map(c => c.id));
  for (const f of verdict.flagged) {
    if (!candidateIds.has(f.location_id)) continue;
    const loc = candidates.find(c => c.id === f.location_id);
    if (!loc) continue;
    const excerpt = mentions.get(loc.display_name) ?? '';
    await (ctx.presentation?.emit(
      'movement:teleport_detected',
      {
        currentLocationId,
        currentLocationName,
        mentionedLocationId: loc.id,
        mentionedLocationName: loc.display_name,
        narrateExcerpt: excerpt.slice(0, 280),
        reason: f.reason,
      },
      {
        playerId: ctx.playerId,
        turnId: ctx.turnId,
        lane: 'post_response',
        phase: 'post_turn',
      },
    ) ?? emitGuiEventForSession(
      ctx.sessionId,
      'movement:teleport_detected',
      {
        currentLocationId,
        currentLocationName,
        mentionedLocationId: loc.id,
        mentionedLocationName: loc.display_name,
        narrateExcerpt: excerpt.slice(0, 280),
        reason: f.reason,
      },
      {
        playerId: ctx.playerId,
        turnId: ctx.turnId,
        lane: 'post_response',
        phase: 'post_turn',
      },
    ));
  }
}

/**
 * Extract `@<DisplayName>` mention candidates for ANY script. The parser does
 * not know the live entity catalogue, so it records every word-prefix inside a
 * mention span. This keeps exact DB resolution working for multi-word runtime
 * names such as `@Town square`, `@The Docks`, and `@Thief's market` without
 * falsely trusting the whole following sentence as an entity name.
 *
 * Returns candidate name -> +/-100-char excerpt around the first occurrence.
 */
export function extractMentionsAnyScript(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /@([^\s@,.;:!?()[\]{}"]+(?:\s+[^\s@,.;:!?()[\]{}"]+){0,7})/gu;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, (m.index ?? 0) - 100);
    const end = Math.min(text.length, (m.index ?? 0) + m[0]!.length + 100);
    const excerpt = text.slice(start, end);
    const words = m[1]!.trim().split(/\s+/).filter(Boolean);
    for (let i = 1; i <= words.length; i += 1) {
      const name = words.slice(0, i).join(' ').replace(/[.,;:!?]+$/, '').trim();
      if (!name || out.has(name)) continue;
      out.set(name, excerpt);
    }
  }
  return out;
}
