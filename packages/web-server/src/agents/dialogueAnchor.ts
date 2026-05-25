/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 45 — Dialogue Anchor.
//
// Async post-turn observer of dialogue arcs. Fires when:
//   - player has dialogue_partner_id set
//   - turn included at least one narrate (dialogue beat happened)
//
// Loads partner profile + last 5 exchanges + previous emotional_beat
// (from prior anchor write), runs a focused LLM, writes hints to
// players.metadata.dialogue_anchor[<partner_id>] = {
//   emotional_beat, beat_reason, voice_drift_score,
//   voice_drift_examples, memory_threshold_crossed,
//   memory_threshold_reason, updated_at_turn
// }
//
// Next preamble's dialogue state block surfaces the hints under
// `## DIALOGUE ANCHOR`. Broker reads and adapts.
//
// Per-spec: post-turn fail-open. Any error path leaves metadata
// unchanged; preamble simply lacks the ANCHOR block next turn.

import {z} from 'zod';
import {playerScopedChatPredicate} from '../chatHistoryScope.js';
import {query} from '../db.js';
import {
  runSpecialist,
  type PostTurnHook,
  type SpecialistContext,
  type SpecialistDef,
} from './base.js';
import {dialogueAnchorPrompt} from './dialogueAnchorPrompt.js';
import {languageHint} from './scriptUtil.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
  POST_TURN_SPECIALIST_WATCHDOG_MS,
} from '../postTurnTiming.js';

// ── Public hook ────────────────────────────────────────────────────────

export const dialogueAnchorHook: PostTurnHook = {
  name: 'dialogue_anchor',
  presentation: {
    slotKey: 'post.dialogue_anchor',
    lane: 'rail',
    ordinal: 40,
    visible: false,
    barrierMode: 'non_blocking',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, turnRecord) {
    try {
      await runOnce(ctx, turnRecord.toolHistory);
    } catch (err) {
      // CATCH-WARN-OK: post-turn slot wrapper; the slot's own `presentationSlot.telemetry` (S-14) records the slot's outcome with the failure status, so re-emitting through `telemetry.record()` here would double-count.
      console.warn(
        '[agent:dialogue_anchor] failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    }
  },
};

async function runOnce(
  ctx: SpecialistContext,
  toolHistory: Array<{name: string; args: unknown; result?: unknown}>,
): Promise<void> {
  const sawNarrate = toolHistory.some(c => c.name === 'narrate');
  if (!sawNarrate) return;

  const player = await loadPlayerRow(ctx.playerId);
  if (!player?.dialogue_partner_id) return;

  const partner = await loadEntity(player.dialogue_partner_id);
  if (!partner) return;

  const speechStyle =
    typeof partner.profile?.['speech_style'] === 'string'
      ? (partner.profile['speech_style'] as string)
      : null;
  const persona =
    typeof partner.profile?.['persona'] === 'string'
      ? (partner.profile['persona'] as string)
      : null;

  const exchanges = await loadRecentExchanges(
    ctx.sessionId,
    ctx.playerId,
    partner.id,
    5,
  );
  if (exchanges.length === 0) return;

  const previousBeat = readPreviousBeat(player.metadata, partner.id);
  const language = ctx.language ?? languageHint(exchanges.map(e => e.text).join(' '));

  const brief = await runSpecialist(
    def,
    {
      partner_name: partner.display_name,
      partner_speech_style: speechStyle,
      partner_persona: persona,
      recent_exchanges: exchanges,
      previous_emotional_beat: previousBeat,
      language,
    },
    ctx,
  );
  if (!brief) return;

  // Validate voice_drift_examples against actual exchange text —
  // defends against the LLM inventing quotes.
  const validatedExamples = brief.voice_drift_examples.filter(q =>
    exchanges.some(e => e.text.includes(q)),
  );

  await persistAnchorHints(ctx.playerId, partner.id, ctx.turnId, {
    emotional_beat: brief.emotional_beat,
    beat_reason: brief.beat_reason,
    voice_drift_score: brief.voice_drift_score,
    voice_drift_examples: validatedExamples,
    memory_threshold_crossed: brief.memory_threshold_crossed,
    memory_threshold_reason:
      brief.memory_threshold_reason.trim() === ''
        ? null
        : brief.memory_threshold_reason,
  });

  for (const extraPartnerId of participantIdsFromPlayer(player)) {
    if (extraPartnerId === partner.id) continue;
    await runAnchorForPartner(ctx, player, extraPartnerId);
  }
}

// ── Specialist definition ──────────────────────────────────────────────

const AnchorOutput = z.object({
  emotional_beat: z.enum([
    'open',
    'guarded',
    'affectionate',
    'hostile',
    'amused',
    'angry',
    'curious',
    'withdrawn',
    'playful',
  ]),
  beat_reason: z.string().min(1).max(300),
  voice_drift_score: z.number().min(0).max(1),
  voice_drift_examples: z.array(z.string()).max(2),
  memory_threshold_crossed: z.boolean(),
  memory_threshold_reason: z.string().max(300),
});

export type AnchorBrief = z.infer<typeof AnchorOutput>;

interface AnchorInput {
  partner_name: string;
  partner_speech_style: string | null;
  partner_persona: string | null;
  recent_exchanges: Array<{role: 'player' | 'npc'; text: string}>;
  previous_emotional_beat: string | null;
  language: string;
}

const def: SpecialistDef<AnchorInput, AnchorBrief> = {
  name: 'dialogue_anchor',
  mode: 'async',
  buildPrompt(input) {
    return {
      system: dialogueAnchorPrompt.system,
      user: dialogueAnchorPrompt.buildUser(input),
    };
  },
  outputSchema: AnchorOutput,
  timeoutMs: POST_TURN_SPECIALIST_WATCHDOG_MS,
  temperature: 0.2,
  maxOutputTokens: 500,
};

// ── DB helpers ─────────────────────────────────────────────────────────

interface PlayerRow {
  entity_id: number;
  dialogue_partner_id: number | null;
  metadata: Record<string, unknown> | null;
}

interface EntityRow {
  id: number;
  display_name: string;
  profile: Record<string, unknown> | null;
}

async function loadPlayerRow(playerId: number): Promise<PlayerRow | null> {
  const r = await query<PlayerRow>(
    `SELECT entity_id, dialogue_partner_id, metadata
       FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return r.rows[0] ?? null;
}

async function loadEntity(id: number): Promise<EntityRow | null> {
  const r = await query<EntityRow>(
    `SELECT id, display_name, profile FROM entities WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function loadRecentExchanges(
  sessionId: string,
  playerId: number,
  partnerId: number,
  limit: number,
): Promise<Array<{role: 'player' | 'npc'; text: string}>> {
  const r = await query<{
    author_entity_id: number | null;
    text: string;
    tone: string | null;
  }>(
    `SELECT cm.author_entity_id, cm.text, cm.tone
       FROM chat_messages cm
      WHERE cm.session_id = $1
        AND ${playerScopedChatPredicate('cm', 2)}
        AND (cm.author_entity_id = $2 OR cm.author_entity_id = $3 OR cm.tone = 'player')
      ORDER BY id DESC
      LIMIT $4`,
    [sessionId, playerId, partnerId, limit * 2],
  );
  // Most recent first; reverse so oldest is first in the list.
  const rev = r.rows.slice().reverse();
  return rev
    .map(row => {
      const isPlayer =
        row.tone === 'player' || row.author_entity_id === playerId;
      const isPartner = row.author_entity_id === partnerId;
      if (!isPlayer && !isPartner) return null;
      return {
        role: (isPlayer ? 'player' : 'npc') as 'player' | 'npc',
        text: row.text,
      };
    })
    .filter((x): x is {role: 'player' | 'npc'; text: string} => x !== null)
    .slice(-limit);
}

function readPreviousBeat(
  metadata: Record<string, unknown> | null,
  partnerId: number,
): string | null {
  const anchor = metadata?.['dialogue_anchor'] as
    | Record<string, unknown>
    | undefined;
  if (!anchor) return null;
  const slot = anchor[String(partnerId)] as
    | Record<string, unknown>
    | undefined;
  if (!slot) return null;
  return typeof slot['emotional_beat'] === 'string'
    ? (slot['emotional_beat'] as string)
    : null;
}

interface PersistedHints {
  emotional_beat: string;
  beat_reason: string;
  voice_drift_score: number;
  voice_drift_examples: string[];
  memory_threshold_crossed: boolean;
  memory_threshold_reason: string | null;
}

async function persistAnchorHints(
  playerId: number,
  partnerId: number,
  turnId: string,
  hints: PersistedHints,
): Promise<void> {
  const slot = {
    ...hints,
    updated_at_turn: turnId,
    updated_at: new Date().toISOString(),
  };
  // Merge into players.metadata.dialogue_anchor[<partner_id>] without
  // touching other metadata keys or other partners' slots.
  await query(
    `UPDATE players
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'dialogue_anchor',
                         COALESCE(metadata->'dialogue_anchor', '{}'::jsonb)
                           || jsonb_build_object($1::text, $2::jsonb)
                       )
      WHERE entity_id = $3`,
    [String(partnerId), JSON.stringify(slot), playerId],
  );
}

// `languageHint` is imported from scriptUtil — universal script-
// based detector. The LLM prompt does the real semantic analysis.

// ── External force-run for debug endpoint ─────────────────────────────

async function runAnchorForPartner(
  ctx: SpecialistContext,
  player: PlayerRow,
  partnerId: number,
): Promise<void> {
  const partner = await loadEntity(partnerId);
  if (!partner) return;

  const speechStyle =
    typeof partner.profile?.['speech_style'] === 'string'
      ? (partner.profile['speech_style'] as string)
      : null;
  const persona =
    typeof partner.profile?.['persona'] === 'string'
      ? (partner.profile['persona'] as string)
      : null;
  const exchanges = await loadRecentExchanges(ctx.sessionId, ctx.playerId, partner.id, 5);
  if (exchanges.length === 0) return;

  const brief = await runSpecialist(
    def,
    {
      partner_name: partner.display_name,
      partner_speech_style: speechStyle,
      partner_persona: persona,
      recent_exchanges: exchanges,
      previous_emotional_beat: readPreviousBeat(player.metadata, partner.id),
      language: ctx.language ?? languageHint(exchanges.map(e => e.text).join(' ')),
    },
    ctx,
  );
  if (!brief) return;

  const validatedExamples = brief.voice_drift_examples.filter(q =>
    exchanges.some(e => e.text.includes(q)),
  );
  await persistAnchorHints(ctx.playerId, partner.id, ctx.turnId, {
    emotional_beat: brief.emotional_beat,
    beat_reason: brief.beat_reason,
    voice_drift_score: brief.voice_drift_score,
    voice_drift_examples: validatedExamples,
    memory_threshold_crossed: brief.memory_threshold_crossed,
    memory_threshold_reason:
      brief.memory_threshold_reason.trim() === ''
        ? null
        : brief.memory_threshold_reason,
  });
}

function participantIdsFromPlayer(player: PlayerRow): number[] {
  const out: number[] = [];
  const add = (id: unknown) => {
    const n =
      typeof id === 'number'
        ? id
        : typeof id === 'string' && id.trim().length > 0
          ? Number(id)
          : NaN;
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  };
  add(player.dialogue_partner_id);
  const raw = player.metadata?.['dialogue_participants'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const ids = (raw as Record<string, unknown>)['participant_ids'];
    if (Array.isArray(ids)) ids.forEach(add);
  }
  return out;
}

export async function forceRunForPlayer(
  playerId: number,
  ctx: SpecialistContext,
): Promise<{anchor_ran: boolean; brief: AnchorBrief | null}> {
  const player = await loadPlayerRow(playerId);
  if (!player?.dialogue_partner_id) {
    return {anchor_ran: false, brief: null};
  }
  const partner = await loadEntity(player.dialogue_partner_id);
  if (!partner) return {anchor_ran: false, brief: null};

  const speechStyle =
    typeof partner.profile?.['speech_style'] === 'string'
      ? (partner.profile['speech_style'] as string)
      : null;
  const persona =
    typeof partner.profile?.['persona'] === 'string'
      ? (partner.profile['persona'] as string)
      : null;
  const exchanges = await loadRecentExchanges(ctx.sessionId, playerId, partner.id, 5);
  if (exchanges.length === 0) return {anchor_ran: false, brief: null};

  const previousBeat = readPreviousBeat(player.metadata, partner.id);
  const language = ctx.language ?? languageHint(exchanges.map(e => e.text).join(' '));
  const brief = await runSpecialist(
    def,
    {
      partner_name: partner.display_name,
      partner_speech_style: speechStyle,
      partner_persona: persona,
      recent_exchanges: exchanges,
      previous_emotional_beat: previousBeat,
      language,
    },
    ctx,
  );
  if (brief) {
    const validatedExamples = brief.voice_drift_examples.filter(q =>
      exchanges.some(e => e.text.includes(q)),
    );
    await persistAnchorHints(playerId, partner.id, ctx.turnId, {
      emotional_beat: brief.emotional_beat,
      beat_reason: brief.beat_reason,
      voice_drift_score: brief.voice_drift_score,
      voice_drift_examples: validatedExamples,
      memory_threshold_crossed: brief.memory_threshold_crossed,
      memory_threshold_reason:
        brief.memory_threshold_reason.trim() === ''
          ? null
          : brief.memory_threshold_reason,
    });
  }
  return {anchor_ran: brief !== null, brief};
}
