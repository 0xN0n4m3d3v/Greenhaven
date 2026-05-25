/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { query } from './db.js';
import { insertArchivalNpcMemory } from './domain/memory/index.js';
import {
  loadPresentNpcCandidates,
  setDialogueParticipants,
} from './dialogueParticipants.js';
import {
  bindReleasedTurnGuiEventsToMessage,
  emitGuiEvent,
} from './guiEventOutbox.js';
import type { Session, ToolHistoryEntry } from './sessionManager.js';
import {
  recordSyntheticToolInvocation,
  resolveEntityId,
} from './tools/base.js';
import { loadWitnessIdsForLocation } from './locationPresence.js';
import { resolveActivePlayerCartridgeId } from './services/CartridgePlaythroughService.js';
import { isNarrateControlText } from './tools/narrate.js';
import { sanitiseNarrateTextWithReport } from './tools/narrate/sanitiser.js';
import { recordNarrateSanitiserTelemetry } from './tools/narrate/sanitiserTelemetry.js';
import {
  enforceCanonicalMentionText,
  getAllMentionEntities,
  scanMentions,
} from './tools/runtimeContext.js';

export type SynthesiseNarrateSource =
  | 'narrator_synth_fallback'
  | 'broker_narrate_fast_path'
  | 'adventure_accept_followup'
  | 'intimacy_empty_broker_fallback'
  | 'intimacy_state_broker_fallback'
  | 'combat_negotiation_empty_broker_fallback'
  | 'broker_tools_no_visible_output_fallback';

export interface SynthesisedNarrateResult {
  messageId: number | null;
  turnIndex: number;
  text: string;
}

export async function currentLocationAuthorId(
  playerId: number,
): Promise<number | null> {
  const r = await query<{ current_location_id: number | null }>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return r.rows[0]?.current_location_id ?? null;
}

export function emitContentDelta(
  session: Session,
  turnId: string,
  delta: string,
): void {
  const active = session.activeTurn;
  if (
    active?.turnId === turnId &&
    (active.abortController.signal.aborted ||
      active.resetRequestedAt != null ||
      active.timeoutRequestedAt != null)
  ) {
    return;
  }
  if (session.resetTurnIds.has(turnId)) return;
  const streamSeq =
    active && active.turnId === turnId
      ? (active.streamSeq = (active.streamSeq ?? 0) + 1)
      : undefined;
  // SSE-OK: emit outside tx (reason: streaming narrator content
  // chunk; the chat_messages row is written later by the
  // synthesise* path and emitted via `narrate`, not here).
  session.sse.emit('content', { turnId, streamSeq: streamSeq ?? null, delta });
}

export async function synthesiseNarrate(
  session: Session,
  playerId: number,
  turnId: string,
  rawText: string,
  alreadyStreamed: boolean = false,
  narrateArgs?: Record<string, unknown>,
  source: SynthesiseNarrateSource = 'narrator_synth_fallback',
): Promise<SynthesisedNarrateResult | null> {
  const active = session.activeTurn;
  if (
    active?.turnId === turnId &&
    (active.abortController.signal.aborted ||
      active.resetRequestedAt != null ||
      active.timeoutRequestedAt != null)
  ) {
    return null;
  }
  if (session.resetTurnIds.has(turnId)) return null;
  // N-2 Phase 3 — synth-v2 IS the runtime visible-prose path the
  // broker takes via narrate-handoff and the empty/fallback synth
  // turns. It must emit the same `narrate.sanitiser.inspected` /
  // `narrate.sanitiser.fired` pair as the direct `narrate` tool so
  // the readiness gate has live coverage from real desktop traffic.
  // Non-runtime callers of `sanitiseNarrateText(...)` (dialogue
  // context builders, supportSmoke fixtures) intentionally stay on
  // the plain wrapper and remain telemetry-silent.
  const sanitiseReport = sanitiseNarrateTextWithReport(
    rawText,
    session.activeTurn?.language ?? null,
  );
  recordNarrateSanitiserTelemetry({
    ctx: {
      sessionId: session.id,
      playerId,
      turnId,
      synthSource: source,
    },
    report: sanitiseReport,
    source: 'narrate_synthesis',
  });
  let text = sanitiseReport.text;
  if (!text.trim()) return null;
  if (isNarrateControlText(text)) {
    const reason = 'control_shaped_narration';
    console.warn(
      '[synthesiseNarrate] quarantined control-shaped narration instead of persisting visible prose',
      { sessionId: session.id, turnId, preview: text.slice(0, 180) },
    );
    await recordSyntheticToolInvocation({
      ctx: { sessionId: session.id, playerId, turnId },
      toolName: 'narrate',
      args: { quarantined: true, reason },
      result: { ok: false, quarantined: true, reason },
      error: `quarantined:${reason}`,
      source: 'direct',
    });
    await emitGuiEvent(
      { sessionId: session.id, playerId, turnId },
      'narrate:quarantined',
      {
        turnId,
        reason,
        previewChars: Math.min(text.length, 180),
      },
      { lane: 'status', phase: 'support' },
    );
    return null;
  }

  const playerRow = await query<{
    dialogue_partner_id: number | null;
    current_scene_id: number | null;
    current_location_id: number | null;
  }>(
    `SELECT dialogue_partner_id, current_scene_id, current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const r0 = playerRow.rows[0];
  let authorId: number | null = null;
  const requestedAuthor = narrateArgs?.['author'];
  if (
    typeof requestedAuthor === 'string' ||
    typeof requestedAuthor === 'number'
  ) {
    authorId = await resolveEntityId(requestedAuthor);
  }
  authorId =
    authorId ??
    r0?.dialogue_partner_id ??
    r0?.current_scene_id ??
    r0?.current_location_id ??
    null;

  let authorName: string | null = null;
  let authorKind: string | null = null;
  if (authorId != null) {
    const e = await query<{ display_name: string; kind: string }>(
      `SELECT display_name, kind FROM entities WHERE id = $1`,
      [authorId],
    );
    authorName = e.rows[0]?.display_name ?? null;
    authorKind = e.rows[0]?.kind ?? null;
  }

  if (
    text.length >= 50 &&
    authorName != null &&
    r0?.current_location_id != null
  ) {
    try {
      const repaired = await runVoiceRepair({
        sessionId: session.id,
        playerId,
        turnId,
        text,
        authorName,
        authorKind: authorKind ?? 'unknown',
        tone: authorKind === 'person' ? 'npc' : 'narrator',
        currentLocationId: r0.current_location_id,
        language: session.activeTurn?.language ?? null,
        toolHistory: session.activeTurn?.toolHistory,
      });
      if (repaired?.action === 'quarantine') {
        const reason = 'player_pov_under_npc_author';
        console.warn(
          '[synthesiseNarrate] quarantined player-POV narration under NPC author',
          {
            sessionId: session.id,
            turnId,
            authorName,
            reason: repaired.reason,
          },
        );
        await recordSyntheticToolInvocation({
          ctx: { sessionId: session.id, playerId, turnId },
          toolName: 'narrate',
          args: {
            quarantined: true,
            reason,
            author: authorName,
          },
          result: {
            ok: false,
            quarantined: true,
            reason,
            voice_warden_reason: repaired.reason,
          },
          error: `quarantined:${reason}`,
          source: 'direct',
        });
        await emitGuiEvent(
          { sessionId: session.id, playerId, turnId },
          'narrate:quarantined',
          {
            turnId,
            reason,
            author: authorName,
          },
          { lane: 'status', phase: 'support' },
        );
        return null;
      }
      if (repaired?.action === 'swap') {
        authorId = repaired.entity.id;
        authorName = repaired.entity.display_name;
        authorKind = repaired.entity.kind;
      }
      if (repaired?.action === 'replace') {
        text = repaired.text;
      }
    } catch (err) {
      // CATCH-WARN-OK: voice-repair is a best-effort author-resolution refinement; the synthesiser proceeds with the auto-resolved author and the inspected/fired sanitizer telemetry pair already emitted above covers the readiness gate's live-traffic signal for this turn.
      console.warn(
        '[synthesiseNarrate] voice repair failed (continuing with auto-resolved author):',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const tone: 'npc' | 'narrator' = authorKind === 'person' ? 'npc' : 'narrator';
  const mentionEntities = await getAllMentionEntities(playerId);
  const mentionRepair = enforceCanonicalMentionText(text, mentionEntities);
  if (mentionRepair.changed) {
    text = mentionRepair.text;
  }
  const turnIndex = await query<{ n: number }>(
    `SELECT COALESCE(MAX(turn_index), 0) + 1 AS n FROM chat_messages WHERE session_id = $1`,
    [session.id],
  );
  // Set player_id / location_entity_id / npc_entity_id so synth-v2 rows
  // index the same way as direct narrate-tool rows. Without these columns
  // the playerScopedChatPredicate only keeps the row through its
  // NULL+non-player-author fallback path, which is fragile and made
  // synth-v2-saved scenes look like "Mikka has amnesia next turn"
  // whenever a downstream consumer required a non-NULL player_id.
  const playerFrame = r0;
  const npcEntityId =
    authorKind === 'person' ? authorId : playerFrame?.dialogue_partner_id ?? null;
  const locationEntityId =
    authorKind === 'location'
      ? authorId
      : playerFrame?.current_location_id ?? null;
  const witnessIds = await loadWitnessIdsForLocation(
    playerFrame?.current_location_id ?? null,
    await resolveWitnessCartridgeId(playerId),
  );
  const insertedMessage = await query<{ id: number }>(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload,
        player_id, location_entity_id, npc_entity_id, witness_entity_ids)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::bigint[])
     RETURNING id`,
    [
      session.id,
      authorId,
      tone,
      text,
      turnIndex.rows[0]!.n,
      JSON.stringify({
        turn_id: turnId,
        done: true,
        synthesised: true,
        source,
      }),
      playerId,
      locationEntityId,
      npcEntityId,
      witnessIds,
    ],
  );
  await recordSyntheticToolInvocation({
    ctx: { sessionId: session.id, playerId, turnId },
    toolName: 'narrate',
    args: {
      text,
      author: authorName ?? authorId,
      author_id: authorId,
      tone,
      done: true,
    },
    result: {
      ok: true,
      synthesised: true,
      source,
      message_id: insertedMessage.rows[0]?.id ?? null,
    },
    source: 'direct',
  });

  const messageId = insertedMessage.rows[0]?.id ?? null;
  if (session.activeTurn && messageId != null) {
    session.activeTurn.finalMessageId = messageId;
  }

  // Structural memory guarantee, mirrored from tools/narrate.ts. Without it
  // prose-leak turns (broker prose that bypassed the narrate tool) would
  // leave the speaking NPC with no memory of what they just said, which is
  // the original "Mikka has amnesia next turn" bug class.
  if (authorKind === 'person' && authorId != null && playerId) {
    const memText =
      text.length > 600 ? text.slice(0, 597).trimEnd() + '…' : text;
    void insertArchivalNpcMemory({
      ownerEntityId: authorId,
      aboutEntityId: playerId,
      text: memText,
      importance: 0.4,
      tags: ['narrate_auto', 'interaction'],
      sensitive: false,
      salience: 0.45,
      sourceTurnId: turnId ?? null,
      sourceTool: 'narrate.synth_auto_snapshot',
      metadata: {visibility: 'public', auto: true, source: 'synth-v2'},
    }).catch(err => {
      // CATCH-WARN-OK: auto-snapshot memory is a best-effort archival write; the synthesise turn itself already succeeded and the memory loop will re-derive on the next turn, mirroring the same pattern in `tools/narrate/persistence.ts`.
      console.warn(
        '[narrate:synth-v2] auto-snapshot memory failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    });
  }

  if (authorKind === 'person' && authorId != null) {
    const update = await setDialogueParticipants(playerId, {
      focusedId: authorId,
      participantIds: [authorId],
      source: 'narrate',
      turnId,
      sessionId: session.id,
    });
    if (update.changed && update.state.focused_partner_id === authorId) {
      await emitGuiEvent(
        { sessionId: session.id, playerId, turnId },
        'dialogue:engaged',
        {
          npcId: authorId,
          npcName: authorName,
        },
      );
      // SSE-OK: emit outside tx (reason: SseBridge.emit
      // auto-defers via onTransactionCommit when called inside
      // withTransaction; setDialogueParticipants above is its
      // own UPDATE without a wrapping tx today).
      session.sse.emit('dialogue:participants_updated', {
        focused_partner_id: update.state.focused_partner_id,
        participant_ids: update.state.participant_ids,
        participants: update.participants,
        source: update.state.source,
      });
    }
  }

  const mentions = scanMentions(text, mentionEntities);
  console.log(
    `[narrate:synth-v2] author=${authorName ?? '<auto>'} authorKind=${
      authorKind ?? '?'
    } tone=${tone} mentions=${
      mentions.map((m) => '@' + m.name).join(', ') || '(none)'
    } text_chars=${text.length} text="${text.slice(0, 120)}..."`,
  );
  // SSE-OK: emit outside tx (reason: the narrator row INSERT
  // happens just above in synthesiseNarrate; the `narrate` SSE is
  // the streaming-content delivery surface for that row. When the
  // caller wraps the synthesis in withTransaction, SseBridge.emit
  // auto-defers via onTransactionCommit; today most callers run
  // outside a tx and emit immediately).
  session.sse.emit('narrate', {
    turnId,
    messageId,
    turnIndex: turnIndex.rows[0]!.n,
    author: authorName,
    authorId,
    tone,
    mentions,
  });
  await bindReleasedTurnGuiEventsToMessage({
    sessionId: session.id,
    turnId,
    messageId,
  });
  if (!alreadyStreamed) {
    emitContentDelta(session, turnId, text);
  }
  if (session.activeTurn) {
    const prior = session.activeTurn.narrativeBuffer ?? '';
    session.activeTurn.narrativeBuffer = prior ? `${prior}\n\n${text}` : text;
  }
  return { messageId, turnIndex: turnIndex.rows[0]!.n, text };
}

async function resolveWitnessCartridgeId(
  playerId: number,
): Promise<string | undefined> {
  try {
    return await resolveActivePlayerCartridgeId(playerId);
  } catch {
    return undefined;
  }
}

type VoiceRepairResult =
  | {
      action: 'swap';
      entity: { id: number; display_name: string; kind: string };
    }
  | { action: 'quarantine'; reason: string }
  | { action: 'replace'; text: string; reason: string };

async function runVoiceRepair(opts: {
  sessionId: string;
  playerId: number;
  turnId: string;
  text: string;
  authorName: string;
  authorKind: string;
  tone: string;
  currentLocationId: number;
  language?: string | null;
  toolHistory?: readonly ToolHistoryEntry[];
}): Promise<VoiceRepairResult | null> {
  const { voiceWardenPrompt } = await import('./agents/voiceWardenPrompt.js');
  const { runSpecialist } = await import('./agents/base.js');
  const { z: zod } = await import('zod');

  const npcRows = await loadPresentNpcCandidates(opts.playerId, {
    sessionId: opts.sessionId,
    currentLocationId: opts.currentLocationId,
  });
  const candidateByName = new Map<
    string,
    { id: number; display_name: string }
  >();
  for (const r of npcRows) candidateByName.set(r.display_name, r);

  const locRow = await query<{ display_name: string; kind: string }>(
    `SELECT display_name, kind FROM entities WHERE id = $1`,
    [opts.currentLocationId],
  );
  const currentLocationName = locRow.rows[0]?.display_name ?? null;
  const currentLocationKind = locRow.rows[0]?.kind ?? 'location';

  const VerdictSchema = zod.object({
    verdict: zod.enum([
      'ok',
      'mismatch_dialogue_under_location',
      'mismatch_scene_under_npc',
      'mismatch_player_pov_under_npc',
    ]),
    reason: zod.string(),
    suggested_author_kind: zod
      .enum(['person', 'location', 'scene', 'player'])
      .nullable()
      .optional(),
    suggested_speaker_name: zod.string().nullable().optional(),
    split_action: zod.string().nullable().optional(),
  });

  const verdict = await runSpecialist(
    {
      name: 'voice_warden_synth_fallback',
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
      author_name: opts.authorName,
      author_kind: opts.authorKind,
      tone: opts.tone,
      text: opts.text,
      candidate_npcs: [...candidateByName.keys()],
      current_location_name: currentLocationName,
      language: opts.language ?? null,
    },
    {
      sessionId: opts.sessionId,
      playerId: opts.playerId,
      turnId: opts.turnId,
      signal: new AbortController().signal,
    },
  );
  if (!verdict || verdict.verdict === 'ok') return null;

  if (verdict.verdict === 'mismatch_player_pov_under_npc') {
    return { action: 'quarantine', reason: verdict.reason };
  }

  if (verdict.verdict === 'mismatch_dialogue_under_location') {
    if (
      !shouldApplyAbsentNpcDialogueFallback({
        text: opts.text,
        suggestedSpeakerName: verdict.suggested_speaker_name,
        candidateNames: [...candidateByName.keys()],
        toolHistory: opts.toolHistory,
      })
    ) {
      return null;
    }
    return {
      action: 'replace',
      reason: verdict.reason,
      text: absentNpcDialogueFallback({
        language: opts.language,
        currentLocationName,
      }),
    };
  }

  if (verdict.verdict === 'mismatch_scene_under_npc') {
    return {
      action: 'swap',
      entity: {
        id: opts.currentLocationId,
        display_name: currentLocationName ?? '',
        kind: currentLocationKind,
      },
    };
  }

  return null;
}

export function hasSuccessfulAuthoredSceneOpen(
  toolHistory: readonly ToolHistoryEntry[] | undefined,
): boolean {
  return (
    toolHistory?.some(
      entry => entry.name === 'open_authored_scene' && entry.ok !== false,
    ) ?? false
  );
}

export function shouldApplyAbsentNpcDialogueFallback(opts: {
  text: string;
  suggestedSpeakerName: unknown;
  candidateNames: readonly string[];
  toolHistory: readonly ToolHistoryEntry[] | undefined;
}): boolean {
  if (hasSuccessfulAuthoredSceneOpen(opts.toolHistory)) return false;
  const suggested =
    typeof opts.suggestedSpeakerName === 'string'
      ? opts.suggestedSpeakerName.trim()
      : '';
  if (suggested && opts.candidateNames.includes(suggested)) return false;
  return hasDirectSpeechCue(opts.text);
}

const DIRECT_SPEECH_OPENERS = new Set([
  '"',
  "'",
  '-',
  '—',
  '–',
  '“',
  '”',
  '‘',
  '’',
  '«',
  '»',
  '「',
  '『',
  '《',
]);

function hasDirectSpeechCue(text: string): boolean {
  for (const paragraph of text.split(/\r?\n+/u)) {
    const first = [...paragraph.trimStart()][0];
    if (first && DIRECT_SPEECH_OPENERS.has(first)) return true;
  }
  return false;
}

function absentNpcDialogueFallback(opts: {
  language?: string | null;
  currentLocationName: string | null;
}): string {
  const location = opts.currentLocationName
    ? `@${opts.currentLocationName}`
    : 'here';
  if (opts.language === 'ru') {
    return [
      `${location} отвечает тишиной: рядом нет собеседника, которому сейчас можно передать реплику.`,
      'Осмотрись вокруг: проверь людей рядом, предметы на виду, выходы и зацепки, которые могут двинуть сцену дальше.',
    ].join('\n\n');
  }
  return [
    `${location} answers with silence: no available speaker nearby can carry that line right now.`,
    'Look around instead: check people nearby, visible objects, exits, and hooks that can move the scene forward.',
  ].join('\n\n');
}
