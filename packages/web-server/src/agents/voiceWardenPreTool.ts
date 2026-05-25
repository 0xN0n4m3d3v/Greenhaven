/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 54 — Voice Consistency Validator (LLM-based, multilingual).
//
// Pre-tool validator on `narrate`. Detects voice/author mismatch
// patterns via the Voice Warden specialist (LLM, see
// voiceWardenPrompt.ts). NO hardcoded language word lists. The
// model semantically distinguishes scene-framing prose from
// NPC-dialogue prose in any script the runtime encounters.
//
// Failure modes flagged:
//   - dialogue_under_location: place author with NPC speech
//   - scene_under_npc:         NPC author with pure scene framing
//
// On match, dispatch returns:
//   {ok: false, rejected: true, reason, suggestion: {action, ...}}
// so the broker sees a structured error and retries with a split.
//
// Fail-open: any internal error / LLM timeout → pass. The
// post-turn observer + synth-fallback voice repair are the
// safety nets.

import {z} from 'zod';
import {query} from '../db.js';
import {loadPresentNpcCandidates} from '../dialogueParticipants.js';
import {sessionManager} from '../sessionManager.js';
import {runSpecialist} from './base.js';
import type {ToolContext, PreToolValidator} from '../tools/base.js';
import {registerPreToolValidatorSpecialist} from '../specialists/registry.js';
import {voiceWardenPrompt} from './voiceWardenPrompt.js';

interface NarrateArgs {
  author?: string;
  tone?: string;
  text?: string;
}

const VerdictSchema = z.object({
  verdict: z.enum([
    'ok',
    'mismatch_dialogue_under_location',
    'mismatch_scene_under_npc',
    'mismatch_player_pov_under_npc',
  ]),
  reason: z.string().min(1).max(300),
  suggested_author_kind: z
    .enum(['person', 'location', 'scene', 'player'])
    .nullable()
    .optional(),
  suggested_speaker_name: z.string().nullable().optional(),
  split_action: z.string().nullable().optional(),
});

const validator: PreToolValidator = async (toolName, args, ctx) => {
  if (toolName !== 'narrate') return {ok: true};
  try {
    return await detect(args as NarrateArgs, ctx);
  } catch (err) {
    // CATCH-WARN-OK: pre-tool validator that explicitly fails open so the broker's narrate call still proceeds; the post-turn voice consistency check still runs and is the canonical observer for voice violations.
    console.warn(
      '[voice_warden_pretool] failed-open:',
      err instanceof Error ? err.message : err,
    );
    return {ok: true};
  }
};

async function detect(
  args: NarrateArgs,
  ctx: ToolContext,
): Promise<
  {ok: true} | {ok: false; reason: string; suggestion?: Record<string, unknown>}
> {
  const text = (args.text ?? '').trim();
  const author = (args.author ?? '').trim();
  const tone = (args.tone ?? '').trim().toLowerCase();

  // Cheap structural skips — universal, no language words.
  if (text.length < 50) return {ok: true};
  let ent: {kind: string; display_name: string} | undefined;
  let currentLocationId: number | null = null;

  // Resolve author kind. Unknown author → let it land; the
  // tool's existing args validation handles bad references.
  if (author) {
    const r = await query<{kind: string; display_name: string}>(
      `SELECT kind, display_name FROM entities WHERE display_name = $1 LIMIT 1`,
      [author],
    );
    ent = r.rows[0];
  } else {
    const playerRow = await query<{
      dialogue_partner_id: number | null;
      current_scene_id: number | null;
      current_location_id: number | null;
    }>(
      `SELECT dialogue_partner_id, current_scene_id, current_location_id
         FROM players WHERE entity_id = $1`,
      [ctx.playerId],
    );
    const row = playerRow.rows[0];
    const fallbackId =
      row?.dialogue_partner_id ??
      row?.current_scene_id ??
      row?.current_location_id ??
      null;
    currentLocationId = row?.current_location_id ?? null;
    if (fallbackId != null) {
      const r = await query<{kind: string; display_name: string}>(
        `SELECT kind, display_name FROM entities WHERE id = $1 LIMIT 1`,
        [fallbackId],
      );
      ent = r.rows[0];
    }
  }
  if (!ent) return {ok: true};

  // Skip player/system kinds — those don't trigger this check.
  if (ent.kind === 'player' || ent.kind === 'system') return {ok: true};
  const deterministic = deterministicMismatch(ent, tone, text);
  if (deterministic) return deterministic;

  // Build the candidate NPC list and current location name. The
  // LLM uses these to suggest the actual speaker on a mismatch.
  if (currentLocationId == null) {
    const playerRow = await query<{
      current_location_id: number | null;
    }>(
      `SELECT current_location_id FROM players WHERE entity_id = $1`,
      [ctx.playerId],
    );
    currentLocationId = playerRow.rows[0]?.current_location_id ?? null;
  }

  let currentLocationName: string | null = null;
  let candidateNpcs: string[] = [];
  if (currentLocationId != null) {
    const locRow = await query<{display_name: string}>(
      `SELECT display_name FROM entities WHERE id = $1`,
      [currentLocationId],
    );
    currentLocationName = locRow.rows[0]?.display_name ?? null;

    const npcRows = await loadPresentNpcCandidates(ctx.playerId, {
      sessionId: ctx.sessionId,
      currentLocationId,
    });
    candidateNpcs = npcRows.map(r2 => r2.display_name);
  }

  const fallbackAbort = new AbortController();
  const verdict = await runSpecialist(
    {
      name: 'voice_warden_pretool',
      mode: 'blocking' as const,
      outputSchema: VerdictSchema,
      timeoutMs: 4500,
      temperature: 0.15,
      maxOutputTokens: 350,
      buildPrompt: (i: unknown) => ({
        system: voiceWardenPrompt.system,
        user: voiceWardenPrompt.buildUser(i as never),
      }),
    },
    {
      author_name: ent.display_name,
      author_kind: ent.kind,
      tone,
      text,
      candidate_npcs: candidateNpcs,
      current_location_name: currentLocationName,
      language: sessionManager.get(ctx.sessionId)?.activeTurn?.language ?? null,
    },
    {
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId ?? `voice-${Date.now()}`,
      signal: ctx.signal ?? fallbackAbort.signal,
    },
  );
  if (!verdict || verdict.verdict === 'ok') return {ok: true};
  const suggestedSpeaker = sanitizeSuggestedSpeakerName(
    verdict.suggested_speaker_name,
    candidateNpcs,
  );
  const action =
    verdict.verdict === 'mismatch_player_pov_under_npc'
      ? 'Do not put player-authored action or first-person hero POV inside an NPC bubble. Keep the player action in the player bubble and write only the NPC response or scene consequence through narrate.'
      : (verdict.split_action ??
        'Split the narrate so the prose matches the bubble label.');

  return {
    ok: false,
    reason: `voice/author mismatch: ${verdict.reason}`,
    suggestion: {
      action,
      verdict: verdict.verdict,
      flagged_author: ent.display_name,
      flagged_kind: ent.kind,
      missing_author: !author,
      suggested_author_kind: verdict.suggested_author_kind ?? null,
      suggested_speaker_name: suggestedSpeaker,
    },
  };
}

function deterministicMismatch(
  ent: {kind: string; display_name: string},
  tone: string,
  text: string,
):
  | {ok: false; reason: string; suggestion: Record<string, unknown>}
  | null {
  if ((ent.kind === 'location' || ent.kind === 'scene') && tone === 'npc') {
    return {
      ok: false,
      reason: 'voice/author mismatch: npc tone under non-person author',
      suggestion: {
        action:
          'Use tone="narrator" for location/scene narration, or set author to the actual NPC speaker.',
        verdict: 'mismatch_dialogue_under_location',
        flagged_author: ent.display_name,
        flagged_kind: ent.kind,
        suggested_author_kind: 'person',
      },
    };
  }

  if (ent.kind === 'person' && explicitlyMentionsAuthor(text, ent.display_name)) {
    return {
      ok: false,
      reason: 'voice/author mismatch: person-authored bubble explicitly mentions the same person as an entity',
      suggestion: {
        action:
          'Do not put scene framing about an NPC under that NPC bubble. Use a scene/location author for the framing, then a separate NPC bubble if the NPC speaks.',
        verdict: 'mismatch_scene_under_npc',
        flagged_author: ent.display_name,
        flagged_kind: ent.kind,
        suggested_author_kind: 'location',
      },
    };
  }

  return null;
}

function explicitlyMentionsAuthor(text: string, displayName: string): boolean {
  const name = displayName.trim();
  if (!name) return false;
  return text.includes(`@${name}`);
}

export function sanitizeSuggestedSpeakerName(
  suggestedSpeakerName: string | null | undefined,
  candidateNpcs: string[],
): string | null {
  if (!suggestedSpeakerName) return null;
  return candidateNpcs.includes(suggestedSpeakerName) ? suggestedSpeakerName : null;
}

registerPreToolValidatorSpecialist({
  name: 'voice_warden.narrate',
  phase: 'preToolValidator',
  toolName: 'narrate',
  validator,
});
