import {query} from '../db.js';
import {
  loadDialogueParticipantState,
  loadParticipantViews,
} from '../dialogueParticipants.js';
import type {
  CoordinatorInput,
  ParticipantState,
  PartnerState,
} from './intimacyCoordinatorTypes.js';

export async function loadCoordinatorInput(args: {
  playerId: number;
  sessionId: string;
  playerProse: string;
  language: string | null;
}): Promise<CoordinatorInput | null> {
  const partner = await loadPartner(args.playerId);
  if (!partner) return null;
  return {
    player_prose: args.playerProse,
    player: await loadPlayerIdentity(args.playerId),
    partner,
    language: args.language,
    participants: await loadParticipants(args.playerId),
    active_intimacy_quest_phase: await loadActiveIntimacyQuestPhase(args.playerId),
    recent_intimate_beats: await loadRecentBeats(args.sessionId),
  };
}

async function loadPlayerIdentity(
  playerId: number,
): Promise<{id: number; name: string}> {
  const r = await query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1 AND kind = 'player'`,
    [playerId],
  );
  return {
    id: playerId,
    name: r.rows[0]?.display_name ?? String(playerId),
  };
}

async function loadPartner(playerId: number): Promise<PartnerState | null> {
  const partnerRow = await query<{
    id: number;
    display_name: string;
    profile: Record<string, unknown> | null;
  }>(
    `SELECT e.id, e.display_name, e.profile
       FROM players p
       JOIN entities e ON e.id = p.dialogue_partner_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  const row = partnerRow.rows[0];
  if (!row) return null;

  const mood = await loadRuntimeFieldString(row.id, 'mood');
  const strings = await loadStringsForPlayer(row.id, playerId);
  const cartridgeQuest = await loadActiveCartridgeIntimacyQuest(
    row.id,
    playerId,
  );
  const sexMove =
    (row.profile?.['sex_move'] as Record<string, unknown> | null) ?? null;

  return {
    name: row.display_name,
    mood,
    strings,
    intimacy_quest_active: cartridgeQuest,
    sex_move: sexMove,
  };
}

async function loadParticipants(playerId: number): Promise<ParticipantState[]> {
  const state = await loadDialogueParticipantState(playerId);
  const views = await loadParticipantViews(state.participant_ids);
  const out: ParticipantState[] = [];
  for (const view of views) {
    out.push({
      id: view.id,
      name: view.display_name,
      mood: await loadRuntimeFieldString(view.id, 'mood'),
      strings: await loadStringsForPlayer(view.id, playerId),
    });
  }
  return out;
}

async function loadRuntimeFieldString(
  ownerEntityId: number,
  fieldKey: string,
): Promise<string | null> {
  const r = await query<{effective_value: unknown}>(
    `SELECT COALESCE(rv.value, f.default_value) AS effective_value
       FROM runtime_fields f
       LEFT JOIN runtime_values rv ON rv.field_id = f.id
      WHERE f.owner_entity_id = $1 AND f.field_key = $2
      LIMIT 1`,
    [ownerEntityId, fieldKey],
  );
  const v = r.rows[0]?.effective_value;
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return String(v);
}

async function loadStringsForPlayer(
  npcEntityId: number,
  playerId: number,
): Promise<number> {
  const r = await query<{effective_value: unknown}>(
    `SELECT COALESCE(rv.value, f.default_value) AS effective_value
       FROM runtime_fields f
       LEFT JOIN runtime_values rv ON rv.field_id = f.id
      WHERE f.owner_entity_id = $1 AND f.field_key = 'strings'
      LIMIT 1`,
    [npcEntityId],
  );
  const v = r.rows[0]?.effective_value;
  if (!v || typeof v !== 'object') return 0;
  const entry = (v as Record<string, unknown>)[String(playerId)];
  if (typeof entry === 'number') return entry;
  if (entry && typeof entry === 'object') {
    const inner = (entry as Record<string, unknown>)['value'];
    if (typeof inner === 'number') return inner;
  }
  return 0;
}

async function loadActiveCartridgeIntimacyQuest(
  partnerEntityId: number,
  playerId: number,
): Promise<string | null> {
  const r = await query<{title: string}>(
    `SELECT e.display_name AS title
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status = 'active'
        AND e.tags && ARRAY['intimate','intimacy']::text[]
        AND (
          (e.profile->>'giver') = (SELECT display_name FROM entities WHERE id = $2)
          OR (e.profile->>'beneficiary') = (SELECT display_name FROM entities WHERE id = $2)
          OR (e.profile->>'partner') = (SELECT display_name FROM entities WHERE id = $2)
          OR (e.profile->>'giver_id') = $2::text
          OR (e.profile->>'beneficiary_id') = $2::text
        )
      ORDER BY pq.started_at DESC, pq.quest_entity_id DESC
      LIMIT 1`,
    [playerId, partnerEntityId],
  );
  return r.rows[0]?.title ?? null;
}

async function loadActiveIntimacyQuestPhase(
  playerId: number,
): Promise<string | null> {
  const r = await query<{current_stage_id: string | null}>(
    `SELECT pq.current_stage_id
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status = 'active'
        AND e.tags && ARRAY['intimate','intimacy']::text[]
      ORDER BY pq.started_at DESC, pq.quest_entity_id DESC
      LIMIT 1`,
    [playerId],
  );
  return r.rows[0]?.current_stage_id ?? null;
}

async function loadRecentBeats(
  sessionId: string,
): Promise<CoordinatorInput['recent_intimate_beats']> {
  const r = await query<{
    invoked_at: string;
    tool_name: string;
    args: Record<string, unknown> | null;
  }>(
    `SELECT invoked_at::text AS invoked_at, tool_name, args
       FROM tool_invocations
      WHERE tool_name IN ('start_quest','advance_quest','complete_quest')
      ORDER BY invoked_at DESC
      LIMIT 8`,
    [],
  );
  void sessionId; // future: filter by session
  return r.rows
    .filter(row => {
      const stage = String((row.args ?? {})['to_stage'] ?? '');
      return ['approach', 'consent', 'foreplay', 'climax', 'aftermath'].includes(
        stage,
      );
    })
    .slice(0, 5)
    .map(row => ({
      when: row.invoked_at,
      phase: String((row.args ?? {})['to_stage'] ?? '?'),
    }));
}
