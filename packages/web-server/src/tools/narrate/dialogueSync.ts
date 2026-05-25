/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — dialogue/author bookkeeping for narrate.
//
// Responsibilities:
//   - load the active player frame (dialogue partner / scene /
//     location);
//   - resolve the bubble's author with the canonical fallback chain
//     (explicit arg → dialogue_partner_id → current_scene_id →
//      current_location_id → null);
//   - auto-correct tone vs author kind (`person` → `npc`,
//     `location`/`scene` → `narrator`);
//   - author auto-swap: location/scene author + speech-opening
//     punctuation under an active partner → re-attribute to the
//     partner;
//   - auto-engage dialogue when an NPC speaks via narrate;
//   - scene-shift partner clear when a narrator-toned bubble
//     mentions people but not the current partner.
//
// The helpers do not emit SSE directly — they return the mutated
// state to the caller, and `sseEmit.ts` owns the `dialogue:*` SSE
// surface so the order matches the original `tools/narrate.ts`.

import {query} from '../../db.js';
import {
  clearDialogueParticipants,
  setDialogueParticipants,
  type DialogueParticipantUpdate,
} from '../../dialogueParticipants.js';
import {resolveEntityId} from '../base.js';

export type AuthorKind = string | null;
export type NarrateTone = 'npc' | 'narrator' | 'system';

export interface PlayerFrame {
  dialogue_partner_id: number | null;
  current_scene_id: number | null;
  current_location_id: number | null;
}

export interface AuthorState {
  authorId: number | null;
  authorName: string | null;
  authorKind: AuthorKind;
}

export async function loadPlayerFrame(playerId: number): Promise<PlayerFrame | undefined> {
  const rows = await query<PlayerFrame>(
    `SELECT dialogue_partner_id, current_scene_id, current_location_id
       FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return rows.rows[0];
}

export async function resolveInitialAuthor(args: {
  rawAuthor: string | undefined;
  playerFrame: PlayerFrame | undefined;
}): Promise<AuthorState> {
  let authorId =
    args.rawAuthor == null ? null : await resolveEntityId(args.rawAuthor);

  // If the model didn't tag a speaker, fall back in this priority:
  //   1. dialogue_partner_id — player has actively engaged an NPC
  //      (clicked @-bubble OR /api/session/:id/dialogue/begin). Their
  //      response IS that NPC speaking; misattributing to location
  //      produces "Quickgrin Lane is talking like Mikka" bugs.
  //   2. current_scene_id — narrower than location, e.g. inside a
  //      booth at the lane.
  //   3. current_location_id — environmental fallback: when no
  //      specific character is embodied, the *place* narrates.
  if (authorId == null) {
    authorId =
      args.playerFrame?.dialogue_partner_id ??
      args.playerFrame?.current_scene_id ??
      args.playerFrame?.current_location_id ??
      null;
  }

  let authorName: string | null = null;
  let authorKind: AuthorKind = null;
  if (authorId != null) {
    const r = await query<{display_name: string; kind: string}>(
      `SELECT display_name, kind FROM entities WHERE id = $1`,
      [authorId],
    );
    authorName = r.rows[0]?.display_name ?? null;
    authorKind = r.rows[0]?.kind ?? null;
  }

  return {authorId, authorName, authorKind};
}

/**
 * Auto-correct tone vs author-kind mismatch. Models (Magnum-Diamond
 * especially) periodically pass tone='narrator' while writing
 * first-person NPC speech under author=<NPC>, which makes the UI
 * render the bubble in "narrator" style and skip the NPC context
 * menu (Reply / Attack / Persuade / etc.). Belt-and-suspenders: the
 * server snaps tone to match the author's entity kind. Returns the
 * (possibly-rewritten) tone so the caller can keep its own typed
 * `NarrateTone` binding.
 */
export function correctToneForAuthor(
  tone: NarrateTone,
  authorKind: AuthorKind,
): NarrateTone {
  if (authorKind === 'person' && tone !== 'npc') return 'npc';
  if ((authorKind === 'location' || authorKind === 'scene') && tone === 'npc') {
    return 'narrator';
  }
  return tone;
}

/**
 * Author auto-swap (language-neutral). When the broker writes a
 * bubble authored by a location/scene BUT the prose is clearly
 * first-person speech of the active dialogue partner (an NPC who is
 * right here), the bubble should be re-attributed to that NPC. The
 * location can't speak with "I…". Detection rule, no hardcoded
 * language keywords: prose opens with a dialogue-introduction punct
 * (em-dash, quote, guillemet) and the active dialogue_partner is a
 * person — those almost always indicate the partner is speaking.
 * Swap author → partner.
 */
export async function maybeAutoSwapAuthorToPartner(args: {
  text: string;
  tone: NarrateTone;
  author: AuthorState;
  playerFrame: PlayerFrame | undefined;
}): Promise<{author: AuthorState; tone: NarrateTone}> {
  const {text, tone, author, playerFrame} = args;
  const noSwap = {author, tone};
  if (tone !== 'narrator') return noSwap;
  if (
    author.authorKind !== 'location' &&
    author.authorKind !== 'scene' &&
    author.authorKind != null
  ) {
    return noSwap;
  }
  if (playerFrame?.dialogue_partner_id == null) return noSwap;

  const trimmed = text.trimStart();
  const opensWithSpeech =
    trimmed.startsWith('—') ||
    trimmed.startsWith('–') ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('"') ||
    trimmed.startsWith('“') ||
    trimmed.startsWith('«') ||
    trimmed.startsWith("'") ||
    trimmed.startsWith('‘');
  if (!opensWithSpeech) return noSwap;

  const partnerRow = await query<{display_name: string; kind: string}>(
    `SELECT display_name, kind FROM entities WHERE id = $1`,
    [playerFrame.dialogue_partner_id],
  );
  const partner = partnerRow.rows[0];
  if (!partner || partner.kind !== 'person') return noSwap;
  console.warn(
    `[narrate] author auto-swap: ${author.authorName ?? '<auto>'} → ${partner.display_name} ` +
      `(prose opens with speech under location/scene author; ` +
      `attributing to active dialogue partner)`,
  );
  return {
    author: {
      authorId: playerFrame.dialogue_partner_id,
      authorName: partner.display_name,
      authorKind: 'person',
    },
    tone: 'npc',
  };
}

/**
 * Auto-engage dialogue when an NPC speaks. Player addressed an NPC
 * (with or without explicit @-mention) → narrator wrote first-person
 * for that NPC → that's the moment the player conceptually entered
 * a dialogue. Set dialogue_partner_id so future turns route through
 * this NPC's per-player thread, and the UI shows the "End dialogue"
 * banner. Returns the participant update so the caller can emit
 * `dialogue:engaged` + `dialogue:participants_updated` in order.
 */
export async function maybeEngageDialogueOnNpcSpeak(args: {
  authorKind: AuthorKind;
  authorId: number | null;
  playerId: number;
  sessionId: string;
  turnId: string | null | undefined;
}): Promise<DialogueParticipantUpdate | null> {
  if (args.authorKind !== 'person' || args.authorId == null) return null;
  return setDialogueParticipants(args.playerId, {
    focusedId: args.authorId,
    participantIds: [args.authorId],
    source: 'narrate',
    turnId: args.turnId ?? null,
    sessionId: args.sessionId,
  });
}

/**
 * Scene-shift partner clear. When a NARRATOR-toned bubble fires with
 * a non-person author (location/scene/system) AND the prose mentions
 * at least one OTHER person who is NOT the current dialogue partner,
 * the active partner has fallen off-stage. Without this,
 * `dialogue_partner_id` sticks on the previous partner and the next
 * free_text turn misroutes back to them.
 *
 * Conservative trigger: only fires when *some* person mention exists
 * and the current partner is absent from mentions. A narrator bubble
 * that mentions no one leaves partner state untouched (atmosphere
 * description during an ongoing dialogue is legitimate).
 */
export async function maybeClearDialogueOnSceneShift(args: {
  narrateTone: NarrateTone;
  authorKind: AuthorKind;
  playerFrame: PlayerFrame | undefined;
  playerId: number;
  turnId: string | null | undefined;
  personMentions: Array<{id: number; name: string}>;
}): Promise<DialogueParticipantUpdate | null> {
  if (args.narrateTone !== 'narrator') return null;
  if (args.authorKind === 'person') return null;
  const partnerId = args.playerFrame?.dialogue_partner_id;
  if (partnerId == null) return null;
  if (args.personMentions.length === 0) return null;
  if (args.personMentions.some((m) => m.id === partnerId)) return null;

  const cleared = await clearDialogueParticipants(args.playerId, {
    source: 'narrate',
    turnId: args.turnId ?? null,
  });
  if (cleared.changed) {
    console.log(
      `[narrate] scene-shift: cleared dialogue_partner=${partnerId} ` +
        `(mentions=${args.personMentions.map((m) => '@' + m.name).join(',') || '(none)'})`,
    );
  }
  return cleared;
}
