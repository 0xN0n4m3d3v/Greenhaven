/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 43 — Per-NPC Voice Engine (variant C: post-write enrichment).
//
// Async post-turn hook. Scans turnRecord.toolHistory for add_memory
// calls; for each NPC-owned memory written this turn, runs a focused
// LLM call that enriches the memory in three ways:
//
//   1. voice rewrite — first-person, NPC-specific idioms and register
//   2. internal_reflection (optional) — inner thought the NPC would
//      think but not say; surfaces in future preambles + as
//      addendum on the chat memory card
//   3. cross-reference (optional) — links_to_memory_id +
//      link_reason connecting this memory to a related prior one
//
// All NPC memories pass through Voice Engine — broker-direct,
// Director-emitted, Coordinator-emitted, Quest-Watcher-emitted,
// scripted-action-emitted. Single source of truth for voice
// consistency.
//
// Per-entry fail-open via Promise.allSettled. Idempotent: rows with
// metadata.voiced_by already set are skipped (don't re-voice and
// drift further). Original draft text is preserved in
// metadata.draft_text for forensics + rollback.

import {z} from 'zod';
import {playerScopedChatPredicate} from '../chatHistoryScope.js';
import {query, withTransaction} from '../db.js';
import {
  applyNpcVoiceEnrichment,
  selectNpcMemoryById,
  selectVoicePastMemoryCandidates,
  type NpcMemoryRowById,
  type VoicePastMemoryRow,
} from '../domain/memory/index.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import {
  runSpecialist,
  type PostTurnHook,
  type SpecialistContext,
  type SpecialistDef,
} from './base.js';
import {npcVoicePrompt} from './npcVoicePrompt.js';
import {languageHint} from './scriptUtil.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
  POST_TURN_SPECIALIST_WATCHDOG_MS,
} from '../postTurnTiming.js';

// ── Public hook ────────────────────────────────────────────────────────

export const npcVoiceHook: PostTurnHook = {
  name: 'npc_voice',
  presentation: {
    slotKey: 'post.npc_voice',
    lane: 'rail',
    ordinal: 50,
    visible: false,
    barrierMode: 'non_blocking',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, turnRecord) {
    const memoryIds: number[] = [];
    for (const call of turnRecord.toolHistory) {
      if (call.name !== 'add_memory') continue;
      const r = call.result as Record<string, unknown> | null | undefined;
      const id = r?.['id'];
      if (typeof id === 'number') memoryIds.push(id);
    }
    if (memoryIds.length === 0) return;

    await Promise.allSettled(
      memoryIds.map(id => enrichOneMemory(id, ctx)),
    );
  },
};

// ── Specialist definition ──────────────────────────────────────────────

const VoiceOutput = z.object({
  voiced_text: z.string().min(1).max(500),
  internal_reflection: z.string().max(300),
  links_to_memory_id: z.number().int().nullable(),
  link_reason: z.string().max(300),
});

export type VoiceBrief = z.infer<typeof VoiceOutput>;

interface VoiceInput {
  npc_name: string;
  npc_speech_style: string | null;
  npc_persona: string | null;
  draft_text: string;
  about_name: string | null;
  importance: number;
  tags: string[];
  recent_utterances: string[];
  past_memories: Array<{
    id: number;
    text: string;
    tags: string[];
    about_name: string | null;
  }>;
  language: string;
}

const def: SpecialistDef<VoiceInput, VoiceBrief> = {
  name: 'npc_voice',
  mode: 'async',
  buildPrompt(input) {
    return {
      system: npcVoicePrompt.buildSystem(input),
      user: npcVoicePrompt.buildUser(input),
    };
  },
  outputSchema: VoiceOutput,
  timeoutMs: POST_TURN_SPECIALIST_WATCHDOG_MS,
  temperature: 0.5, // voice has style — slight variability welcome
  maxOutputTokens: 600,
};

// ── Per-memory enrichment ─────────────────────────────────────────────

type MemoryRow = NpcMemoryRowById;

interface OwnerEntity {
  id: number;
  kind: string;
  display_name: string;
  profile: Record<string, unknown> | null;
}

/**
 * Enrich a single memory by id. Public so the debug endpoint can
 * trigger it directly without going through the postTurn hook.
 * Forces re-voicing when `force=true`.
 */
export async function enrichOneMemory(
  memoryId: number,
  ctx: SpecialistContext,
  force = false,
): Promise<{voiced: boolean; reason?: string} | null> {
  const memRow = await loadMemoryRow(memoryId);
  if (!memRow) return {voiced: false, reason: 'memory not found'};

  // Idempotency: skip already-voiced rows unless forced.
  if (!force && memRow.metadata?.['voiced_by']) {
    return {voiced: false, reason: 'already voiced'};
  }

  const owner = await loadOwnerEntity(memRow.owner_entity_id);
  if (!owner) return {voiced: false, reason: 'owner not found'};

  // Skip player memories: the player writes their own
  // voice in prose; broker draft is fine.
  if (owner.kind === 'player') {
    return {voiced: false, reason: 'owner is player'};
  }

  const speechStyle =
    typeof owner.profile?.['speech_style'] === 'string'
      ? (owner.profile['speech_style'] as string)
      : null;
  const persona =
    typeof owner.profile?.['persona'] === 'string'
      ? (owner.profile['persona'] as string)
      : null;
  if (!speechStyle && !persona) {
    return {voiced: false, reason: 'no voice profile'};
  }

  const aboutName =
    memRow.about_entity_id != null
      ? await loadEntityName(memRow.about_entity_id)
      : null;
  const recent = await loadRecentUtterances(owner.display_name, ctx.playerId, 3);
  const past = await loadPastMemoryCandidates(
    owner.id,
    memRow.about_entity_id,
    memRow.tags,
    memRow.id,
    2,
  );
  const language = ctx.language ?? languageHint(memRow.text);

  const brief = await runSpecialist(
    def,
    {
      npc_name: owner.display_name,
      npc_speech_style: speechStyle,
      npc_persona: persona,
      draft_text: memRow.text,
      about_name: aboutName,
      importance: memRow.importance,
      tags: memRow.tags,
      recent_utterances: recent,
      past_memories: past,
      language,
    },
    ctx,
  );
  if (!brief) return {voiced: false, reason: 'specialist fail-open'};

  // Validate cross-reference: only accept link if the id is in the
  // candidate set we passed in (defends against hallucinated ids).
  const validLinkId =
    brief.links_to_memory_id != null &&
    past.some(m => m.id === brief.links_to_memory_id)
      ? brief.links_to_memory_id
      : null;

  const grounding = validateVoiceGrounding(brief, {
    draftText: memRow.text,
    ownerName: owner.display_name,
    aboutName,
    recentUtterances: recent,
    pastMemories: past.map(m => m.text),
  });
  if (!grounding.ok) {
    return {voiced: false, reason: grounding.reason};
  }

  // USER-5/USER-6 — the LLM/specialist work above runs outside any
  // transaction (slow, no DB writes). The durable enrichment and the
  // memory:enriched GUI event share one transaction so a failed
  // applyEnrichment rolls back the gui_events INSERT and the deferred
  // SSE never escapes.
  await withTransaction(async () => {
    await applyEnrichment(memRow, brief, validLinkId);
    await emitEnrichedSse(ctx, {
      memoryId: memRow.id,
      ownerId: owner.id,
      ownerName: owner.display_name,
      voiced_text: brief.voiced_text,
      internal_reflection:
        brief.internal_reflection.trim() === '' ? null : brief.internal_reflection,
      links_to_memory_id: validLinkId,
      link_reason: brief.link_reason.trim() === '' ? null : brief.link_reason,
    });
  });

  return {voiced: true};
}

// ── DB helpers ─────────────────────────────────────────────────────────

export function validateVoiceGrounding(
  brief: VoiceBrief,
  evidence: {
    draftText: string;
    ownerName: string;
    aboutName: string | null;
    recentUtterances: string[];
    pastMemories: string[];
  },
): {ok: true} | {ok: false; reason: string} {
  const evidenceText = [
    evidence.draftText,
    evidence.ownerName,
    evidence.aboutName ?? '',
    `@${evidence.ownerName}`,
    evidence.aboutName ? `@${evidence.aboutName}` : '',
    ...evidence.recentUtterances,
    ...evidence.pastMemories,
  ].join('\n');
  const outputText = [
    brief.voiced_text,
    brief.internal_reflection,
    brief.link_reason,
  ].join('\n');

  const evidenceNumbers = extractNumberTokens(evidenceText);
  for (const token of extractNumberTokens(outputText)) {
    if (!evidenceNumbers.has(token)) {
      return {ok: false, reason: `ungrounded_voice_number:${token}`};
    }
  }

  const evidenceMentions = extractAtMentions(evidenceText);
  for (const mention of extractAtMentions(outputText)) {
    if (!evidenceMentions.has(mention)) {
      return {ok: false, reason: `ungrounded_voice_mention:${mention}`};
    }
  }

  return {ok: true};
}

function extractNumberTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  // LANGUAGE-REGEX-OK: Unicode-number-class extractor (`\p{Number}` + decimal/date/time separators). Pure wire-format token harvest with no English/Russian word content; used to compare numeric mentions across NPC voice rewrites.
  for (const match of text.matchAll(/\p{Number}+(?:[.,:/-]\p{Number}+)*/gu)) {
    tokens.add(match[0]);
  }
  return tokens;
}

function extractAtMentions(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/@[^\s@,.;:!?()[\]{}"']+(?:\s+[^\s@,.;:!?()[\]{}"']+)*/gu)) {
    tokens.add(match[0].trim());
  }
  return tokens;
}

async function loadMemoryRow(id: number): Promise<MemoryRow | null> {
  return selectNpcMemoryById(id);
}

async function loadOwnerEntity(id: number): Promise<OwnerEntity | null> {
  const r = await query<OwnerEntity>(
    `SELECT id, kind, display_name, profile FROM entities WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function loadEntityName(id: number): Promise<string | null> {
  const r = await query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.display_name ?? null;
}

async function loadRecentUtterances(
  authorDisplayName: string,
  playerId: number,
  limit: number,
): Promise<string[]> {
  const r = await query<{content: string}>(
    `SELECT cm.text AS content
      FROM chat_messages cm
      JOIN entities e ON e.id = cm.author_entity_id
      WHERE LOWER(e.display_name) = LOWER($1)
        AND ${playerScopedChatPredicate('cm', 3)}
      ORDER BY cm.id DESC
      LIMIT $2`,
    [authorDisplayName, limit, playerId],
  );
  return r.rows.map(row => row.content).filter(c => c && c.length > 0);
}

interface PastMemoryCandidate {
  id: number;
  text: string;
  tags: string[];
  about_name: string | null;
}

async function loadPastMemoryCandidates(
  ownerId: number,
  aboutId: number | null,
  tags: string[],
  excludeId: number,
  limit: number,
): Promise<PastMemoryCandidate[]> {
  // Prefer (1) same about_entity, (2) tag overlap, (3) recent + high
  // importance. The MemoryService helper owns the ranked
  // past-memory SELECT (score = about-match + tag-overlap +
  // importance*0.5, tie-break by created_at DESC); this caller still
  // resolves `about_name` via the entities table since that is not a
  // memory-pack concern.
  const rows: VoicePastMemoryRow[] = await selectVoicePastMemoryCandidates({
    ownerEntityId: ownerId,
    aboutEntityId: aboutId,
    tags,
    excludeMemoryId: excludeId,
    limit,
  });
  // Resolve about_name for the ones we picked.
  const ids = rows.map(row => row.about_id).filter((x): x is number => x != null);
  const names = new Map<number, string>();
  if (ids.length > 0) {
    const nameR = await query<{id: number; display_name: string}>(
      `SELECT id, display_name FROM entities WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    for (const row of nameR.rows) names.set(row.id, row.display_name);
  }
  return rows.map(row => ({
    id: row.id,
    text: row.text,
    tags: row.tags,
    about_name: row.about_id != null ? names.get(row.about_id) ?? null : null,
  }));
}

async function applyEnrichment(
  mem: MemoryRow,
  brief: VoiceBrief,
  linkId: number | null,
): Promise<void> {
  const enrichment = {
    draft_text: mem.text,
    voiced_by: 'agent:npc_voice',
    voiced_at: new Date().toISOString(),
    internal_reflection:
      brief.internal_reflection.trim() === '' ? null : brief.internal_reflection,
    links_to_memory_id: linkId,
    link_reason: brief.link_reason.trim() === '' ? null : brief.link_reason,
  };
  // USER-5/USER-6 — runs through the same AsyncLocalStorage-bound
  // `query()` the outer `withTransaction(...)` swaps to the tx client,
  // so the UPDATE stays inside the enrichment transaction and the
  // rollback contract exercised by `npcVoiceTransactional.test.ts`
  // continues to hold.
  await applyNpcVoiceEnrichment({
    memoryId: mem.id,
    voicedText: brief.voiced_text,
    enrichmentPatch: enrichment,
  });
}

async function emitEnrichedSse(
  ctx: SpecialistContext,
  payload: {
    memoryId: number;
    ownerId: number;
    ownerName: string;
    voiced_text: string;
    internal_reflection: string | null;
    links_to_memory_id: number | null;
    link_reason: string | null;
  },
): Promise<void> {
  await (ctx.presentation?.emit('memory:enriched', payload, {
    playerId: ctx.playerId,
    turnId: ctx.turnId,
    lane: 'post_response',
    phase: 'post_turn',
  }) ?? emitGuiEventForSession(ctx.sessionId, 'memory:enriched', payload, {
    playerId: ctx.playerId,
    turnId: ctx.turnId,
    lane: 'post_response',
    phase: 'post_turn',
  }));
}

// Note: `languageHint` is imported from scriptUtil — covers Latin /
// Cyrillic / Hebrew / Arabic / CJK / Hangul / Devanagari / Bengali /
// Thai / Greek / Armenian / Georgian etc. via Unicode script blocks.
// The hint is a starting point; the LLM prompt itself is the real
// language detector and adjusts as needed.
