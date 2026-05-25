import { playerScopedChatPredicate } from '../chatHistoryScope.js';
import { query } from '../db.js';
import {
  selectDialoguePrivateNotes,
  selectDialoguePublicHighlights,
  selectDialogueRollingSummary,
} from '../domain/memory/index.js';
import { loc, locQuestStageField } from '../i18n.js';
import { telemetry } from '../telemetry/index.js';
import { isNarrateControlText, sanitiseNarrateText } from '../tools/narrate.js';
import { getEntityRuntimeContext } from '../tools/runtimeContext.js';
import { bandFor } from '../tools/strings.js';
import {
  fetchEntity,
  renderInstructions,
  renderProfile,
  renderRuntime,
  type EntityRow,
} from './entitySections.js';

interface ChatHistoryRow {
  author_entity_id: number | null;
  author_name: string | null;
  author_kind: string | null;
  tone: string;
  text: string;
  turn_index: number;
}
/**
 * Static portion of the dialogue partner: identity, summary, profile.
 * Stays the same as long as the player is in dialogue with this NPC.
 */
export async function renderDialoguePartnerProfile(
  npcId: number,
  lang = 'en',
): Promise<string> {
  const npc = await fetchEntity(npcId, lang);
  if (!npc) return '';
  const lines: string[] = [
    '## DIALOGUE PARTNER (you are now embodying this character)',
    `**${npc.display_name}** (id ${npc.id}, kind=${npc.kind})`,
    npc.summary ? `> ${npc.summary}` : null,
    renderProfile(npc.profile),
  ].filter((s): s is string => Boolean(s !== null));
  return lines.join('\n');
}

export async function renderDialogueParticipants(
  participantIds: number[],
  focusedId: number | null,
  playerId: number,
  sessionId: string,
  limit: number,
  excludeTurnId: string | null = null,
): Promise<string | null> {
  const ids = uniquePositiveIds(participantIds);
  if (ids.length === 0) return null;
  const entityRows = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
       FROM entities
      WHERE id = ANY($1::bigint[])
        AND kind = 'person'`,
    [ids],
  );
  const byId = new Map(entityRows.rows.map((row) => [row.id, row]));
  const rtRows = await query<{
    owner_entity_id: number;
    field_key: string;
    effective_value: unknown;
  }>(
    `SELECT rf.owner_entity_id, rf.field_key,
            COALESCE(rv.value, rf.default_value) AS effective_value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = ANY($1::bigint[])
        AND rf.field_key IN ('mood', 'stance', 'strings')`,
    [ids],
  );
  const mood = new Map<number, string>();
  const stance = new Map<number, string>();
  const strings = new Map<number, { count: number; band: string }>();
  for (const row of rtRows.rows) {
    if (row.field_key === 'mood' && row.effective_value != null) {
      mood.set(row.owner_entity_id, String(row.effective_value));
    } else if (row.field_key === 'stance' && row.effective_value != null) {
      stance.set(row.owner_entity_id, String(row.effective_value));
    } else if (
      row.field_key === 'strings' &&
      row.effective_value &&
      typeof row.effective_value === 'object' &&
      !Array.isArray(row.effective_value)
    ) {
      const map = row.effective_value as Record<string, unknown>;
      const count = Number(map[String(playerId)] ?? 0);
      strings.set(row.owner_entity_id, { count, band: bandFor(count) });
    }
  }

  const recentRows = await query<{
    author_entity_id: number | null;
    text: string;
    turn_index: number;
  }>(
    `SELECT author_entity_id, text, turn_index
       FROM chat_messages cm
      WHERE cm.session_id = $1
        AND cm.author_entity_id = ANY($2::bigint[])
        AND ${playerScopedChatPredicate('cm', 3)}
        AND ($5::text IS NULL OR cm.payload->>'turn_id' IS DISTINCT FROM $5::text)
      ORDER BY turn_index DESC
      LIMIT $4`,
    [sessionId, ids, playerId, Math.max(limit, ids.length * 3), excludeTurnId],
  );
  const recent = new Map<number, string>();
  let droppedByFilter = 0;
  for (const row of recentRows.rows) {
    if (row.author_entity_id == null || recent.has(row.author_entity_id))
      continue;
    const clean = sanitisePromptHistoryNarration({
      author_entity_id: row.author_entity_id,
      author_name: byId.get(row.author_entity_id)?.display_name ?? null,
      author_kind: 'person',
      tone: 'npc',
      text: row.text,
      turn_index: row.turn_index,
    });
    if (clean) {
      recent.set(row.author_entity_id, clean);
    } else if (row.text && row.text.trim().length > 0) {
      droppedByFilter++;
    }
  }
  if (droppedByFilter > 0) {
    telemetry.record({
      channel: 'gameplay',
      name: 'turn_context.dialogue_history.bubble_dropped',
      sessionId,
      playerId,
      data: {
        droppedByFilter,
        participantIds: ids,
        message:
          'sanitiseNarrateText/isNarrateControlText filtered NPC bubble(s); broker preamble missing within-scene continuity for those authors',
      },
    });
  }

  const lines = ['## DIALOGUE PARTICIPANTS'];
  for (const id of ids) {
    const entity = byId.get(id);
    if (!entity) continue;
    const profile = entity.profile ?? {};
    const bits: string[] = [];
    const strInfo = strings.get(id);
    bits.push(
      strInfo
        ? `strings ${strInfo.count} (${strInfo.band})`
        : 'strings 0 (neutral)',
    );
    const moodValue = mood.get(id);
    if (moodValue) bits.push(`mood ${moodValue}`);
    const stanceValue = stance.get(id);
    if (stanceValue) bits.push(`stance ${stanceValue}`);
    const homeId = readContextPositiveId(profile['home_id']);
    if (homeId != null) bits.push(`home_id ${homeId}`);
    const focus = id === focusedId ? 'focused, ' : '';
    const involvement = recent.get(id);
    lines.push(
      `- @${entity.display_name} (id ${id}, ${focus}${bits.join(', ')})`,
    );
    if (involvement) {
      lines.push(`  recent: ${truncateLine(involvement, 220)}`);
    } else {
      lines.push('  recent: present in the current dialogue frame');
    }
  }
  lines.push(
    'Rule: keep one authored speaker per bubble. If multiple participants speak, split them into separate narrate calls with the correct author id/name. Companions listed here are valid shared-chat speakers and may answer local NPCs when addressed.',
  );
  return lines.join('\n');
}

/**
 * Dynamic portion of the dialogue partner: their runtime fields (HP,
 * mood, stance) plus the recent exchange. Moves turn-to-turn so it
 * lives in the dynamic block.
 */
export async function renderDialogueState(
  npcId: number,
  playerId: number,
  sessionId: string,
  limit: number,
  lang = 'en',
  excludeTurnId: string | null = null,
): Promise<string> {
  const ctx = await getEntityRuntimeContext(npcId, playerId);
  // Hot window — per-NPC scoped chat history. The NPC sees rows where:
  //   - they authored the message (their own narrate), OR
  //   - they were a witness at the location when the message was written
  //     (witness_entity_ids contains npcId), OR
  //   - the player spoke and this NPC was the active dialogue partner
  //     (legacy fallback for rows without witness_entity_ids).
  // The witness array is the new canonical isolation mechanism: a
  // conversation between the player and a different NPC in another
  // location does NOT bleed into this NPC's preamble.
  const hotLimit = Math.max(limit, 12);
  const history = await query<ChatHistoryRow>(
    `SELECT cm.author_entity_id, e.display_name AS author_name,
            e.kind AS author_kind, cm.tone, cm.text, cm.turn_index
       FROM chat_messages cm
       LEFT JOIN entities e ON e.id = cm.author_entity_id
      WHERE cm.session_id = $1
        AND ${playerScopedChatPredicate('cm', 3)}
        AND ($5::text IS NULL OR cm.payload->>'turn_id' IS DISTINCT FROM $5::text)
        AND (
          cm.author_entity_id = $2
          OR $2 = ANY(cm.witness_entity_ids)
          OR (cm.witness_entity_ids IS NULL
              AND (cm.author_entity_id = $3 OR cm.tone = 'player'))
        )
      ORDER BY cm.turn_index DESC
      LIMIT $4`,
    [sessionId, npcId, playerId, hotLimit, excludeTurnId],
  );
  const turns = history.rows.slice().reverse();

  const lines: string[] = ['## DIALOGUE PARTNER (live state)'];
  const rt = renderRuntime(ctx);
  if (rt) lines.push(rt);
  const ins = renderInstructions(ctx);
  if (ins) lines.push(ins);

  // Spec 45 — Dialogue Anchor hints stored on players.metadata.
  // Surfaces the partner's emotional_beat + voice-drift audit +
  // memory_threshold_crossed flag so the broker reads them instead
  // of re-deriving the partner's stance from scrollback.
  try {
    const anchorRow = await query<{ anchor: Record<string, unknown> | null }>(
      `SELECT (metadata->'dialogue_anchor'->$1) AS anchor
         FROM players WHERE entity_id = $2`,
      [String(npcId), playerId],
    );
    const anchor = anchorRow.rows[0]?.anchor;
    if (anchor && typeof anchor === 'object') {
      const beat = String(anchor['emotional_beat'] ?? '');
      const reason = String(anchor['beat_reason'] ?? '');
      const drift =
        typeof anchor['voice_drift_score'] === 'number'
          ? (anchor['voice_drift_score'] as number)
          : null;
      const crossed = Boolean(anchor['memory_threshold_crossed']);
      const memReason = anchor['memory_threshold_reason'] as string | null;
      lines.push('### DIALOGUE ANCHOR (last update from Anchor specialist)');
      if (beat) {
        lines.push(`- emotional_beat: ${beat}${reason ? ' — ' + reason : ''}`);
      }
      if (drift != null) {
        const tag = drift >= 0.8 ? '(good)' : '(check voice next turn)';
        lines.push(`- voice_drift_score: ${drift.toFixed(2)} ${tag}`);
      }
      if (crossed) {
        lines.push(
          `- memory_threshold_crossed: TRUE — ${memReason ?? 'add_memory before continuing'}`,
        );
      }
    }
  } catch (err) {
    telemetry.record({
      channel: 'gameplay',
      name: 'turn_context.dialogue_anchor.surface_failed',
      sessionId,
      playerId,
      error: err,
      data: {
        npcId,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // Highlights — top-3 highest-salience PUBLIC memories the NPC holds
  // about the player. Surfaces what they ACTUALLY remember so
  // prose-driven continuity references the right beats. Excludes
  // rolling_summary (rendered separately as Cold Tail below) and private
  // notes (rendered separately as Private Notes below).
  const memRows = await selectDialoguePublicHighlights({
    ownerEntityId: npcId,
    aboutEntityId: playerId,
    limit: 3,
  });
  if (memRows.length > 0) {
    lines.push(
      '### What this NPC remembers about the active player (top 3 by salience):',
    );
    for (const m of memRows) {
      lines.push(`- (sal ${Number(m.salience).toFixed(2)}) ${m.text}`);
    }
  }

  // Cold Tail — rolling summaries of older conversation chunks folded
  // out of the hot window. Generated by the rollingDialogueSummary
  // post-turn agent every 10 messages. There is at most one current
  // rolling_summary per (NPC, player) pair; older ones are kept for
  // continuity but only the latest is rendered.
  const summaryRow = await selectDialogueRollingSummary({
    ownerEntityId: npcId,
    aboutEntityId: playerId,
  });
  if (summaryRow && summaryRow.text.trim()) {
    lines.push('### Earlier conversation with this player (rolling summary):');
    lines.push(`- ${summaryRow.text.trim()}`);
  }

  // Private Notes — internal-monologue memories the NPC has written
  // about the player. Only ever shown to THIS NPC's preamble; never
  // surfaced to other NPCs, never rendered in the player-facing chat.
  // Comes from add_memory(..., visibility='private') or from
  // narrate.internal_monologue captured by the post-turn pipeline.
  const privateRows = await selectDialoguePrivateNotes({
    ownerEntityId: npcId,
    aboutEntityId: playerId,
    limit: 3,
  });
  if (privateRows.length > 0) {
    lines.push("### This NPC's private thoughts about the player (never shared aloud):");
    for (const m of privateRows) {
      lines.push(`- ${m.text}`);
    }
  }

  const questCommitments = await renderDialogueQuestCommitments(
    npcId,
    playerId,
    lang,
  );
  if (questCommitments) lines.push(questCommitments);

  lines.push('### Recent exchange with this player (oldest → newest):');
  if (turns.length === 0) {
    lines.push('  (nothing yet — this is the opening of your conversation)');
  } else {
    for (const t of turns) {
      const text =
        t.tone === 'player' ? t.text : sanitisePromptHistoryNarration(t);
      if (!text) continue;
      const who = t.author_name ?? (t.tone === 'player' ? 'Player' : '?');
      lines.push(`  ${who}: ${truncateLine(text, 360)}`);
    }
  }
  return lines.join('\n');
}

async function renderDialogueQuestCommitments(
  npcId: number,
  playerId: number,
  lang = 'en',
): Promise<string> {
  const rows = await query<{
    quest_entity_id: number;
    display_name: string;
    summary: string | null;
    i18n: Record<string, Record<string, unknown>> | null;
    current_stage_id: string | null;
    profile: unknown;
  }>(
    `SELECT pq.quest_entity_id,
            e.display_name,
            e.summary,
            e.i18n,
            pq.current_stage_id,
            e.profile
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status = 'active'
        AND (
          e.profile->>'giver_entity_id' = $2
          OR e.profile->>'giver_id' = $2
          OR e.profile->>'source_entity_id' = $2
          OR e.profile->>'quest_giver_id' = $2
        )
      ORDER BY pq.started_at DESC
      LIMIT 8`,
    [playerId, String(npcId)],
  );
  if (rows.rows.length === 0) return '';

  const out = [
    '### Active quests this NPC is responsible for',
    'Rule: these are established player quest facts. If the player asks this NPC about one of them, the NPC must acknowledge the job and answer from this canon instead of pretending ignorance or re-offering the hook.',
  ];
  for (const row of rows.rows) {
    const profile = (row.profile ?? {}) as Record<string, unknown>;
    const questRecord = { i18n: row.i18n ?? null };
    const name = row.display_name;
    const summary = loc(questRecord, lang, 'summary', row.summary);
    const goal = typeof profile['goal'] === 'string' ? profile['goal'] : null;
    out.push(`- ${name} (quest id ${row.quest_entity_id})`);
    if (summary) out.push(`  summary: ${summary}`);
    if (goal) out.push(`  goal: ${goal}`);

    const stages = Array.isArray(profile['stages'])
      ? (profile['stages'] as Array<Record<string, unknown>>)
      : [];
    const currentStage = stages.find((s) => s['id'] === row.current_stage_id);
    if (currentStage) {
      const stageName = locQuestStageField(
        questRecord,
        lang,
        currentStage,
        'name',
        currentStage['name'] ?? currentStage['title'],
      );
      const stageDescription = locQuestStageField(
        questRecord,
        lang,
        currentStage,
        'description',
        currentStage['description'],
      );
      out.push(`  current_stage: ${String(stageName ?? row.current_stage_id)}`);
      if (typeof stageDescription === 'string' && stageDescription.trim()) {
        out.push(`  stage_detail: ${stageDescription.trim()}`);
      }
    } else if (row.current_stage_id) {
      out.push(`  current_stage: ${row.current_stage_id}`);
    }
  }
  return out.join('\n');
}

function uniquePositiveIds(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function readContextPositiveId(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function truncateLine(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max
    ? single
    : single.slice(0, Math.max(0, max - 3)) + '...';
}

// X-3/X-4 follow-up #8 — prompt-history sanitisation. The previous
// `looksLikePlayerPovUnderNpc` helper inspected `text` with an en-only
// `\bI\s+(take|grab|hold|kiss|hug|ask|tell|lead|pull|push|follow|approach|attack|stab|hit)\b`
// regex, which silently dropped every Russian / Japanese / Chinese /
// etc. equivalent of the same beat. The upstream multilingual
// voice-warden specialist (`narrationSynthesis.runVoiceRepair`)
// already classifies `mismatch_player_pov_under_npc` and quarantines
// the row BEFORE it lands in `chat_messages`, so by the time the
// prompt-history sanitiser sees a row the bad class has been
// filtered upstream. Direct narrate-tool rows are governed by the
// broker prompt's voice-discipline rules and the narrate-tool
// control-text quarantine — both multilingual paths. Keeping the
// en-only regex here was a belt-and-suspenders that mostly produced
// false-negatives for every non-English language; deleting it is
// the language-agnostic fix.
function sanitisePromptHistoryNarration(row: ChatHistoryRow): string {
  const text = sanitiseNarrateText(row.text);
  if (!text || isNarrateControlText(text)) return '';
  return text;
}
