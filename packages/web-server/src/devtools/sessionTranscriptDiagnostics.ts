/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';

export interface SessionTranscriptMessage {
  id: number;
  turn_index: number;
  created_at: string;
  tone: string | null;
  author_entity_id: number | null;
  author_name: string | null;
  len: number;
  preview: string;
  turn_id: string | null;
  tool_names_for_turn: string[];
  has_json_fence: boolean;
  has_handoff_marker: boolean;
  looks_like_narrate_args: boolean;
}

export interface SessionTurnWatchdog {
  turn_id: string;
  markers: string[];
  tool_names: string[];
  tool_count: number;
  mutation_tool_count: number;
  non_player_response_count: number;
  player_message_count: number;
  has_broker_telemetry: boolean;
  first_tool_at: string | null;
  last_tool_at: string | null;
}

export interface SessionPostTurnSlotDiagnostic {
  slot_id: number;
  turn_id: string | null;
  slot_key: string;
  hook_name: string;
  ordinal: number;
  barrier_mode: string;
  slot_status: string;
  event_status: string;
  reason: string | null;
  deadline_ms: number | null;
  duration_ms: number | null;
  emitted_event_ids: number[];
  age_ms: number;
  expires_at: string | null;
  expired: boolean;
}

export interface SessionEventOrderGap {
  event_id: number;
  event_type: string;
  reason: string;
  release_seq: number | null;
}

export interface SessionUnanchoredGuiEvent {
  event_id: number;
  event_type: string;
  lane: string;
  phase: string;
  turn_id: string | null;
  message_id: number | null;
  display_policy: Record<string, unknown> | null;
}

export interface SessionOpenBarrierDiagnostic {
  turn_id: string | null;
  pending_slots: number;
  oldest_age_ms: number;
}

export interface SessionQueuedVisibleLeak {
  queue_id: number;
  turn_id: string;
  status: string;
  chat_rows: number;
}

export interface SessionDuplicateQuestCard {
  turn_id: string | null;
  event_type: string;
  quest_id: number | null;
  count: number;
  event_ids: number[];
}

export interface SessionAdventureQueueDepth {
  player_id: number;
  status: string;
  count: number;
}

export interface SessionStaleAdventureQueueRow {
  queue_id: number;
  player_id: number;
  adventure_kind: string;
  status: string;
  age_ms: number;
}

export interface SessionAdventureDuplicateDedupe {
  player_id: number;
  dedupe_key: string;
  count: number;
  queue_ids: number[];
}

export interface SessionNonReplayableAdventureRoll {
  roll_id: number;
  queue_id: number | null;
  reason: string;
}

export interface SessionTranscriptDiagnostics {
  selected_session_id: string | null;
  transcript_limit: number;
  transcript: SessionTranscriptMessage[];
  flagged_messages: SessionTranscriptMessage[];
  turn_watchdog: SessionTurnWatchdog[];
  post_turn_slots: SessionPostTurnSlotDiagnostic[];
  event_order_gaps: SessionEventOrderGap[];
  unanchored_chat_visible_events: SessionUnanchoredGuiEvent[];
  open_barriers: SessionOpenBarrierDiagnostic[];
  queued_visible_leaks: SessionQueuedVisibleLeak[];
  duplicate_quest_cards: SessionDuplicateQuestCard[];
  adventure_queue_depth: SessionAdventureQueueDepth[];
  stale_adventure_queue: SessionStaleAdventureQueueRow[];
  duplicate_adventure_dedupe: SessionAdventureDuplicateDedupe[];
  non_replayable_adventure_rolls: SessionNonReplayableAdventureRoll[];
}

interface ChatRow {
  id: number;
  turn_index: number;
  created_at: string;
  tone: string | null;
  author_entity_id: number | null;
  author_name: string | null;
  text: string;
  payload: unknown;
}

export async function buildSessionTranscriptDiagnostics(opts: {
  sessionId: string | null;
  limit?: number;
}): Promise<SessionTranscriptDiagnostics> {
  const limit = clampLimit(opts.limit ?? 80);
  if (!opts.sessionId) {
    return {
      selected_session_id: null,
      transcript_limit: limit,
      transcript: [],
      flagged_messages: [],
      turn_watchdog: [],
      post_turn_slots: [],
      event_order_gaps: [],
      unanchored_chat_visible_events: [],
      open_barriers: [],
      queued_visible_leaks: [],
      duplicate_quest_cards: [],
      adventure_queue_depth: [],
      stale_adventure_queue: [],
      duplicate_adventure_dedupe: [],
      non_replayable_adventure_rolls: [],
    };
  }

  const rows = await query<ChatRow>(
    `SELECT cm.id, cm.turn_index, cm.created_at::text AS created_at,
            cm.tone, cm.author_entity_id, e.display_name AS author_name,
            cm.text, cm.payload
       FROM chat_messages cm
       LEFT JOIN entities e ON e.id = cm.author_entity_id
      WHERE cm.session_id = $1
      ORDER BY cm.turn_index DESC, cm.id DESC
      LIMIT $2`,
    [opts.sessionId, limit],
  );
  const ordered = rows.rows.slice().reverse();
  const turnIds = Array.from(
    new Set(
      ordered
        .map(row => turnIdFromPayload(row.payload))
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const toolsByTurn = new Map<string, string[]>();
  const toolRowsByTurn = new Map<string, ToolDiagnosticRow[]>();
  if (turnIds.length > 0) {
    const toolRows = await query<ToolDiagnosticRow>(
      `SELECT turn_id, tool_name, error, result, invoked_at::text AS invoked_at
         FROM tool_invocations
        WHERE session_id = $1
          AND turn_id = ANY($2::text[])
        ORDER BY turn_id, invoked_at, id`,
      [opts.sessionId, turnIds],
    );
    for (const row of toolRows.rows) {
      const list = toolsByTurn.get(row.turn_id) ?? [];
      if (!list.includes(row.tool_name)) list.push(row.tool_name);
      toolsByTurn.set(row.turn_id, list);
      const detailList = toolRowsByTurn.get(row.turn_id) ?? [];
      detailList.push(row);
      toolRowsByTurn.set(row.turn_id, detailList);
    }
  }
  const telemetryRolesByTurn = await loadTelemetryRoles(opts.sessionId, turnIds);
  const postTurnSlots = await loadPostTurnSlotDiagnostics(opts.sessionId);
  const guiDiagnostics = await loadGuiEventDiagnostics(opts.sessionId);
  const adventureDiagnostics = await loadAdventureQueueDiagnostics(opts.sessionId);

  const transcript = ordered.map(row => {
    const turnId = turnIdFromPayload(row.payload);
    const flags = flagsForText(row.text);
    return {
      id: Number(row.id),
      turn_index: Number(row.turn_index),
      created_at: row.created_at,
      tone: row.tone,
      author_entity_id:
        row.author_entity_id == null ? null : Number(row.author_entity_id),
      author_name: row.author_name,
      len: row.text.length,
      preview: preview(row.text),
      turn_id: turnId,
      tool_names_for_turn: turnId ? (toolsByTurn.get(turnId) ?? []) : [],
      ...flags,
    };
  });

  return {
    selected_session_id: opts.sessionId,
    transcript_limit: limit,
    transcript,
    flagged_messages: transcript.filter(
      row =>
        row.has_json_fence ||
        row.has_handoff_marker ||
        row.looks_like_narrate_args,
    ),
    turn_watchdog: buildTurnWatchdog(
      turnIds,
      transcript,
      toolRowsByTurn,
      telemetryRolesByTurn,
    ),
    post_turn_slots: postTurnSlots,
    event_order_gaps: guiDiagnostics.eventOrderGaps,
    unanchored_chat_visible_events: guiDiagnostics.unanchored,
    open_barriers: buildOpenBarrierDiagnostics(postTurnSlots),
    queued_visible_leaks: await loadQueuedVisibleLeaks(opts.sessionId),
    duplicate_quest_cards: guiDiagnostics.duplicateQuestCards,
    adventure_queue_depth: adventureDiagnostics.depth,
    stale_adventure_queue: adventureDiagnostics.stale,
    duplicate_adventure_dedupe: adventureDiagnostics.duplicates,
    non_replayable_adventure_rolls: adventureDiagnostics.nonReplayable,
  };
}

interface ToolDiagnosticRow {
  turn_id: string;
  tool_name: string;
  error: string | null;
  result: unknown;
  invoked_at: string;
}

async function loadTelemetryRoles(
  sessionId: string,
  turnIds: string[],
): Promise<Map<string, string[]>> {
  const rolesByTurn = new Map<string, string[]>();
  if (turnIds.length === 0) return rolesByTurn;
  const rows = await query<{turn_id: string; role: string}>(
    `SELECT DISTINCT turn_id, role
       FROM turn_telemetry
      WHERE session_id = $1
        AND turn_id = ANY($2::text[])
      ORDER BY turn_id, role`,
    [sessionId, turnIds],
  );
  for (const row of rows.rows) {
    const roles = rolesByTurn.get(row.turn_id) ?? [];
    roles.push(row.role);
    rolesByTurn.set(row.turn_id, roles);
  }
  return rolesByTurn;
}

async function loadPostTurnSlotDiagnostics(
  sessionId: string,
): Promise<SessionPostTurnSlotDiagnostic[]> {
  const rows = await query<{
    id: number | string;
    turn_id: string | null;
    status: string;
    payload: Record<string, unknown> | null;
    expires_at: string | null;
    age_ms: number | string;
  }>(
    `SELECT id, turn_id, status, payload,
            expires_at::text AS expires_at,
            (EXTRACT(EPOCH FROM (now() - created_at)) * 1000)::int AS age_ms
       FROM gui_events
      WHERE session_id = $1
        AND event_type = 'presentation:slot'
        AND (
          status = 'pending'
          OR payload->>'slot_status' IN ('failed', 'expired')
          OR (expires_at IS NOT NULL AND expires_at < now())
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [sessionId],
  );
  return rows.rows.map(row => {
    const payload = row.payload ?? {};
    const emittedEventIds = Array.isArray(payload['emitted_event_ids'])
      ? (payload['emitted_event_ids'] as unknown[])
          .map(Number)
          .filter(Number.isFinite)
      : [];
    const slotStatus = String(payload['slot_status'] ?? 'pending');
    return {
      slot_id: Number(row.id),
      turn_id: row.turn_id,
      slot_key: String(payload['slot_key'] ?? ''),
      hook_name: String(payload['hook_name'] ?? ''),
      ordinal: Number(payload['ordinal'] ?? 0),
      barrier_mode: String(payload['barrier_mode'] ?? 'chat_visible'),
      slot_status: slotStatus,
      event_status: row.status,
      reason:
        typeof payload['reason'] === 'string'
          ? (payload['reason'] as string)
          : null,
      deadline_ms:
        typeof payload['deadline_ms'] === 'number'
          ? (payload['deadline_ms'] as number)
          : null,
      duration_ms:
        typeof payload['duration_ms'] === 'number'
          ? (payload['duration_ms'] as number)
          : null,
      emitted_event_ids: emittedEventIds,
      age_ms: Number(row.age_ms ?? 0),
      expires_at: row.expires_at,
      expired:
        slotStatus === 'expired' ||
        (row.expires_at != null && Date.parse(row.expires_at) < Date.now()),
    };
  });
}

async function loadGuiEventDiagnostics(sessionId: string): Promise<{
  eventOrderGaps: SessionEventOrderGap[];
  unanchored: SessionUnanchoredGuiEvent[];
  duplicateQuestCards: SessionDuplicateQuestCard[];
}> {
  const released = await query<{
    id: number | string;
    event_type: string;
    release_seq: number | string | null;
  }>(
    `SELECT id, event_type, release_seq
       FROM gui_events
      WHERE session_id = $1
        AND status = 'released'
      ORDER BY release_seq ASC NULLS LAST, id ASC
      LIMIT 500`,
    [sessionId],
  );
  const eventOrderGaps: SessionEventOrderGap[] = [];
  const seenSeq = new Set<number>();
  for (const row of released.rows) {
    const releaseSeq = row.release_seq == null ? null : Number(row.release_seq);
    if (releaseSeq == null || !Number.isFinite(releaseSeq)) {
      eventOrderGaps.push({
        event_id: Number(row.id),
        event_type: row.event_type,
        reason: 'missing_release_seq',
        release_seq: null,
      });
      continue;
    }
    if (seenSeq.has(releaseSeq)) {
      eventOrderGaps.push({
        event_id: Number(row.id),
        event_type: row.event_type,
        reason: 'duplicate_release_seq',
        release_seq: releaseSeq,
      });
    }
    seenSeq.add(releaseSeq);
  }

  const unanchoredRows = await query<{
    id: number | string;
    event_type: string;
    lane: string;
    phase: string;
    turn_id: string | null;
    message_id: number | string | null;
    display_policy: Record<string, unknown> | null;
  }>(
    `SELECT id, event_type, lane, phase, turn_id, message_id, display_policy
       FROM gui_events
      WHERE session_id = $1
        AND status = 'released'
        AND lane <> 'rail'
        AND COALESCE(event_type, '') <> 'presentation:slot'
        AND message_id IS NULL
        AND turn_id IS NULL
        AND COALESCE(display_policy->>'anchor', '') NOT IN ('turn_id', 'message_id', 'none')
      ORDER BY release_seq ASC NULLS LAST, id ASC
      LIMIT 100`,
    [sessionId],
  );
  const unanchored = unanchoredRows.rows.map(row => ({
    event_id: Number(row.id),
    event_type: row.event_type,
    lane: row.lane,
    phase: row.phase,
    turn_id: row.turn_id,
    message_id: row.message_id == null ? null : Number(row.message_id),
    display_policy: row.display_policy,
  }));

  const duplicateRows = await query<{
    turn_id: string | null;
    event_type: string;
    quest_id: number | string | null;
    count: number | string;
    event_ids: Array<number | string> | null;
  }>(
    `SELECT turn_id,
            event_type,
            COALESCE(payload->>'questId', payload->>'quest_id') AS quest_id,
            COUNT(*)::int AS count,
            array_agg(id ORDER BY release_seq ASC NULLS LAST, id ASC) AS event_ids
       FROM gui_events
      WHERE session_id = $1
        AND status = 'released'
        AND event_type IN ('quest:advanced', 'quest:completed', 'quest:auto_advanced')
      GROUP BY turn_id, event_type, COALESCE(payload->>'questId', payload->>'quest_id')
     HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 100`,
    [sessionId],
  );
  const duplicateQuestCards = duplicateRows.rows.map(row => ({
    turn_id: row.turn_id,
    event_type: row.event_type,
    quest_id: row.quest_id == null ? null : Number(row.quest_id),
    count: Number(row.count),
    event_ids: (row.event_ids ?? []).map(Number).filter(Number.isFinite),
  }));

  return {eventOrderGaps, unanchored, duplicateQuestCards};
}

function buildOpenBarrierDiagnostics(
  slots: SessionPostTurnSlotDiagnostic[],
): SessionOpenBarrierDiagnostic[] {
  const byTurn = new Map<string, SessionPostTurnSlotDiagnostic[]>();
  for (const slot of slots) {
    if (slot.slot_status !== 'pending') continue;
    const key = slot.turn_id ?? '<none>';
    const list = byTurn.get(key) ?? [];
    list.push(slot);
    byTurn.set(key, list);
  }
  return Array.from(byTurn.entries()).map(([turnId, list]) => ({
    turn_id: turnId === '<none>' ? null : turnId,
    pending_slots: list.length,
    oldest_age_ms: Math.max(...list.map(slot => slot.age_ms)),
  }));
}

async function loadQueuedVisibleLeaks(
  sessionId: string,
): Promise<SessionQueuedVisibleLeak[]> {
  const rows = await query<{
    queue_id: number | string;
    turn_id: string;
    status: string;
    chat_rows: number | string;
  }>(
    `SELECT q.id AS queue_id,
            q.turn_id,
            q.status,
            COUNT(cm.id)::int AS chat_rows
       FROM turn_ingress_queue q
       LEFT JOIN chat_messages cm
         ON cm.session_id = q.session_id
        AND cm.payload->>'turn_id' = q.turn_id
      WHERE q.session_id = $1
        AND q.status = 'queued'
      GROUP BY q.id, q.turn_id, q.status
     HAVING COUNT(cm.id) > 0
      ORDER BY q.id ASC`,
    [sessionId],
  );
  return rows.rows.map(row => ({
    queue_id: Number(row.queue_id),
    turn_id: row.turn_id,
    status: row.status,
    chat_rows: Number(row.chat_rows),
  }));
}

async function loadAdventureQueueDiagnostics(sessionId: string): Promise<{
  depth: SessionAdventureQueueDepth[];
  stale: SessionStaleAdventureQueueRow[];
  duplicates: SessionAdventureDuplicateDedupe[];
  nonReplayable: SessionNonReplayableAdventureRoll[];
}> {
  const depthRows = await query<{
    player_id: number | string;
    status: string;
    count: number | string;
  }>(
    `SELECT player_id, status, COUNT(*)::int AS count
       FROM adventure_queue
      WHERE session_id = $1
      GROUP BY player_id, status
      ORDER BY player_id, status`,
    [sessionId],
  );
  const staleRows = await query<{
    id: number | string;
    player_id: number | string;
    adventure_kind: string;
    status: string;
    age_ms: number | string;
  }>(
    `SELECT id, player_id, adventure_kind, status,
            (EXTRACT(EPOCH FROM (now() - created_at)) * 1000)::int AS age_ms
       FROM adventure_queue
      WHERE session_id = $1
        AND status IN ('queued', 'materializing')
        AND created_at < now() - interval '15 minutes'
      ORDER BY created_at ASC, id ASC
      LIMIT 100`,
    [sessionId],
  );
  const duplicateRows = await query<{
    player_id: number | string;
    dedupe_key: string;
    count: number | string;
    queue_ids: Array<number | string> | null;
  }>(
    `SELECT player_id, dedupe_key, COUNT(*)::int AS count,
            array_agg(id ORDER BY id ASC) AS queue_ids
       FROM adventure_queue
      WHERE session_id = $1
        AND dedupe_key IS NOT NULL
      GROUP BY player_id, dedupe_key
     HAVING COUNT(*) > 1
      ORDER BY count DESC, player_id ASC
      LIMIT 100`,
    [sessionId],
  );
  const nonReplayableRows = await query<{
    roll_id: number | string;
    queue_id: number | string | null;
    reason: string | null;
  }>(
    `SELECT r.id AS roll_id,
            r.adventure_queue_id AS queue_id,
            CASE
              WHEN r.seed IS NULL OR r.seed = '' THEN 'missing_seed'
              WHEN r.sequence IS NULL THEN 'missing_sequence'
              WHEN r.die IS NULL OR r.die = '' THEN 'missing_die'
              WHEN r.table_id IS NULL OR r.table_id = '' THEN 'missing_table_id'
              WHEN jsonb_typeof(r.candidates) <> 'array' THEN 'candidates_not_array'
              WHEN aq.id IS NULL THEN 'missing_queue_row'
              WHEN aq.adventure_kind <> r.selected_kind THEN 'selected_kind_mismatch'
              ELSE NULL
            END AS reason
       FROM adventure_oracle_rolls r
       LEFT JOIN adventure_queue aq ON aq.id = r.adventure_queue_id
      WHERE r.session_id = $1
        AND (
          r.seed IS NULL OR r.seed = ''
          OR r.sequence IS NULL
          OR r.die IS NULL OR r.die = ''
          OR r.table_id IS NULL OR r.table_id = ''
          OR jsonb_typeof(r.candidates) <> 'array'
          OR aq.id IS NULL
          OR aq.adventure_kind <> r.selected_kind
        )
      ORDER BY r.id ASC
      LIMIT 100`,
    [sessionId],
  );

  return {
    depth: depthRows.rows.map(row => ({
      player_id: Number(row.player_id),
      status: row.status,
      count: Number(row.count),
    })),
    stale: staleRows.rows.map(row => ({
      queue_id: Number(row.id),
      player_id: Number(row.player_id),
      adventure_kind: row.adventure_kind,
      status: row.status,
      age_ms: Number(row.age_ms),
    })),
    duplicates: duplicateRows.rows.map(row => ({
      player_id: Number(row.player_id),
      dedupe_key: row.dedupe_key,
      count: Number(row.count),
      queue_ids: (row.queue_ids ?? []).map(Number).filter(Number.isFinite),
    })),
    nonReplayable: nonReplayableRows.rows
      .filter(row => row.reason)
      .map(row => ({
        roll_id: Number(row.roll_id),
        queue_id: row.queue_id == null ? null : Number(row.queue_id),
        reason: row.reason ?? 'unknown',
      })),
  };
}

function buildTurnWatchdog(
  turnIds: string[],
  transcript: SessionTranscriptMessage[],
  toolRowsByTurn: Map<string, ToolDiagnosticRow[]>,
  telemetryRolesByTurn: Map<string, string[]>,
): SessionTurnWatchdog[] {
  const messagesByTurn = new Map<string, SessionTranscriptMessage[]>();
  for (const message of transcript) {
    if (!message.turn_id) continue;
    const list = messagesByTurn.get(message.turn_id) ?? [];
    list.push(message);
    messagesByTurn.set(message.turn_id, list);
  }

  return turnIds
    .map(turnId => {
      const messages = messagesByTurn.get(turnId) ?? [];
      const tools = toolRowsByTurn.get(turnId) ?? [];
      const roles = telemetryRolesByTurn.get(turnId) ?? [];
      const toolNames = [...new Set(tools.map(row => row.tool_name))];
      const mutationToolCount = tools.filter(row =>
        MUTATION_TOOL_NAMES.has(row.tool_name),
      ).length;
      const firstNarrateIndex = tools.findIndex(row => row.tool_name === 'narrate');
      const mutationBeforeNarrate =
        firstNarrateIndex >= 0
          ? tools
              .slice(0, firstNarrateIndex)
              .filter(row => MUTATION_TOOL_NAMES.has(row.tool_name)).length
          : mutationToolCount;
      const playerMessageCount = messages.filter(
        row => row.tone === 'player',
      ).length;
      const nonPlayerResponseCount = messages.filter(
        row => row.tone !== 'player',
      ).length;
      const hasBrokerTelemetry = roles.includes('broker');
      const hasNarrateTool = tools.some(row => row.tool_name === 'narrate');
      const narrationQuarantined = tools.some(row =>
        row.tool_name === 'narrate' &&
        (row.error?.startsWith('quarantined:') ||
          resultHasQuarantine(row.result)),
      );
      const markers: string[] = [];
      if (mutationToolCount > 0 && nonPlayerResponseCount === 0) {
        markers.push('mutated_without_narration');
      }
      if (narrationQuarantined) markers.push('narration_quarantined');
      if (hasBrokerTelemetry && !hasNarrateTool && nonPlayerResponseCount === 0) {
        markers.push('broker_no_final_narrate');
      }
      if (mutationBeforeNarrate >= 4) {
        markers.push('long_mutation_chain_before_narrate');
      }
      return {
        turn_id: turnId,
        markers,
        tool_names: toolNames,
        tool_count: tools.length,
        mutation_tool_count: mutationToolCount,
        non_player_response_count: nonPlayerResponseCount,
        player_message_count: playerMessageCount,
        has_broker_telemetry: hasBrokerTelemetry,
        first_tool_at: tools[0]?.invoked_at ?? null,
        last_tool_at: tools[tools.length - 1]?.invoked_at ?? null,
      };
    })
    .filter(row => row.markers.length > 0);
}

function resultHasQuarantine(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>)['quarantined'] === true
  );
}

const MUTATION_TOOL_NAMES = new Set([
  'add_memory',
  'advance_quest',
  'apply_runtime_field_patch',
  'apply_surface',
  'award_xp',
  'batch_mutate_world',
  'change_stat',
  'complete_quest',
  'create_entity',
  'create_quest',
  'damage',
  'death_save',
  'heal',
  'inventory_transfer',
  'mark_downed',
  'move_player',
  'set_runtime_field',
  'spend_currency',
  'start_quest',
  'string_award',
  'string_spend',
  'unlock_skill',
]);

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 80;
  return Math.max(1, Math.min(300, Math.trunc(limit)));
}

function turnIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const turnId = (payload as Record<string, unknown>)['turn_id'];
  return typeof turnId === 'string' && turnId.trim() ? turnId : null;
}

function flagsForText(text: string): {
  has_json_fence: boolean;
  has_handoff_marker: boolean;
  looks_like_narrate_args: boolean;
} {
  const trimmed = text.trim();
  const hasJsonFence = /```(?:json)?/i.test(text);
  const hasHandoffMarker = /\bBroker stage complete\b/i.test(text);
  const looksLikeNarrateArgs =
    (/^\{[\s\S]*"text"\s*:[\s\S]*\}$/.test(trimmed) ||
      /"text"\s*:/.test(trimmed)) &&
    (/"author"\s*:/.test(trimmed) ||
      /"tone"\s*:/.test(trimmed) ||
      /"done"\s*:/.test(trimmed) ||
      hasJsonFence ||
      hasHandoffMarker);
  return {
    has_json_fence: hasJsonFence,
    has_handoff_marker: hasHandoffMarker,
    looks_like_narrate_args: looksLikeNarrateArgs,
  };
}

function preview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}
