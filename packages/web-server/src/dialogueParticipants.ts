/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from './db.js';

export type DialogueParticipantSource =
  | 'mentions'
  | 'tool'
  | 'narrate'
  | 'route'
  | 'session_reset';

export interface DialogueParticipantState {
  focused_partner_id: number | null;
  participant_ids: number[];
  updated_at_turn: string | null;
  source: DialogueParticipantSource | 'legacy' | 'none';
}

export interface DialogueParticipantView {
  id: number;
  display_name: string;
}

export interface DialogueParticipantUpdate {
  changed: boolean;
  state: DialogueParticipantState;
  participants: DialogueParticipantView[];
  rejected_ids: number[];
  rejected_focus_id: number | null;
}

interface PlayerDialogueRow {
  entity_id: number;
  dialogue_partner_id: number | null;
  current_location_id: number | null;
  current_scene_id: number | null;
  metadata: Record<string, unknown> | null;
}

interface EntityPresenceRow {
  id: number;
  kind: string;
  display_name: string;
  profile: Record<string, unknown> | null;
}

// DP-1 — characters that count as part of a `@mention` token's
// tail. Letters and digits (Unicode-aware so Cyrillic, Greek, etc.
// behave correctly) and underscores extend the token; everything
// else (whitespace, punctuation, end-of-string) terminates it.
// This deliberately mirrors `\w` semantics so `@Mikka_x` stays
// glued and `@Mikka.` / `@Mikka,` / `@Mikka)` / `@Mikka!` /
// `@Mikka?` / `@Mikka<space>` / `@Mikka<eof>` all release the
// boundary. The class is duplicated below as a literal regex so
// the lookup is hot-path-free.
const MENTION_TOKEN_CONTINUES = /[\p{L}\p{N}_]/u;

function isMentionTailBoundary(nextChar: string | undefined): boolean {
  return nextChar === undefined || !MENTION_TOKEN_CONTINUES.test(nextChar);
}

export function idsInMentionOrder(
  text: string,
  mentions: Array<{id: number; name: string; kind: string}>,
): number[] {
  // DP-1 — the previous implementation used a naive
  // `text.indexOf('@' + name)`, which (a) returned `Mikka` as a
  // hit for `@Mikkael` (substring match) and (b) preferred the
  // shortest alias whenever two cartridge entities shared a prefix
  // (`@Mikka the Bold` could resolve to the bare `Mikka` ahead of
  // the longer alias). The replacement walks every `@name`
  // occurrence with two extra guards: the character immediately
  // after the name must be a token boundary (Unicode-aware,
  // including end-of-string), and longer names are processed
  // first so the longest valid mention consumes its span before
  // any shorter alias can claim the same text.
  const personMentions = mentions.filter((m) => m.kind === 'person');
  // Stable: longest name first, then by id so ties are deterministic.
  const sorted = [...personMentions].sort((a, b) => {
    if (a.name.length !== b.name.length) return b.name.length - a.name.length;
    return a.id - b.id;
  });
  type Span = {start: number; end: number};
  const consumedSpans: Span[] = [];
  const earliestIndex = new Map<number, number>();
  for (const mention of sorted) {
    const needle = `@${mention.name}`;
    let from = 0;
    while (from <= text.length) {
      const idx = text.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + needle.length;
      const nextChar = end < text.length ? text[end] : undefined;
      if (!isMentionTailBoundary(nextChar)) {
        from = idx + 1;
        continue;
      }
      const overlaps = consumedSpans.some(
        (s) => idx < s.end && end > s.start,
      );
      if (overlaps) {
        from = idx + 1;
        continue;
      }
      consumedSpans.push({start: idx, end});
      const prior = earliestIndex.get(mention.id);
      if (prior == null || idx < prior) earliestIndex.set(mention.id, idx);
      from = end;
    }
  }
  return [...earliestIndex.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}

export async function loadDialogueParticipantState(
  playerId: number,
): Promise<DialogueParticipantState> {
  const player = await loadPlayerDialogueRow(playerId);
  if (!player) {
    return {
      focused_partner_id: null,
      participant_ids: [],
      updated_at_turn: null,
      source: 'none',
    };
  }
  return readState(player);
}

export async function loadCompanionIdsForPlayer(
  playerId: number,
): Promise<number[]> {
  const rows = await query<{companions: unknown}>(
    `SELECT metadata->'companions' AS companions
       FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return readIdArray(rows.rows[0]?.companions);
}

export async function clearDialogueParticipants(
  playerId: number,
  opts: {source: DialogueParticipantSource; turnId?: string | null},
): Promise<DialogueParticipantUpdate> {
  const before = await loadDialogueParticipantState(playerId);
  const state: DialogueParticipantState = {
    focused_partner_id: null,
    participant_ids: [],
    updated_at_turn: opts.turnId ?? null,
    source: opts.source,
  };
  await query(
    `UPDATE players
        SET dialogue_partner_id = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dialogue_participants', $1::jsonb)
      WHERE entity_id = $2`,
    [JSON.stringify(state), playerId],
  );
  return {
    changed:
      before.focused_partner_id !== null || before.participant_ids.length > 0,
    state,
    participants: [],
    rejected_ids: [],
    rejected_focus_id: null,
  };
}

export async function setDialogueParticipants(
  playerId: number,
  opts: {
    focusedId: number | null;
    participantIds?: number[];
    preserveExisting?: boolean;
    sessionId?: string | null;
    explicitParticipantIds?: number[];
    allowRecentAuthors?: boolean;
    source: DialogueParticipantSource;
    turnId?: string | null;
  },
): Promise<DialogueParticipantUpdate> {
  const player = await loadPlayerDialogueRow(playerId);
  if (!player) {
    const state: DialogueParticipantState = {
      focused_partner_id: null,
      participant_ids: [],
      updated_at_turn: opts.turnId ?? null,
      source: opts.source,
    };
    return {
      changed: false,
      state,
      participants: [],
      rejected_ids: uniqueIds([
        ...(opts.focusedId == null ? [] : [opts.focusedId]),
        ...(opts.participantIds ?? []),
      ]),
      rejected_focus_id: opts.focusedId,
    };
  }

  const before = readState(player);
  if (opts.focusedId == null && (opts.participantIds ?? []).length === 0) {
    return clearDialogueParticipants(playerId, {
      source: opts.source,
      turnId: opts.turnId,
    });
  }

  const requested = uniqueIds([
    ...(opts.preserveExisting === false ? [] : before.participant_ids),
    ...(opts.focusedId == null ? [] : [opts.focusedId]),
    ...(opts.participantIds ?? []),
  ]);
  const valid = await filterPresentParticipantIds(player, requested, {
    sessionId: opts.sessionId,
    explicitParticipantIds: opts.explicitParticipantIds,
    allowRecentAuthors: opts.allowRecentAuthors,
  });
  const validSet = new Set(valid);
  const rejectedIds = requested.filter(id => !validSet.has(id));
  const rejectedFocus =
    opts.focusedId != null && !validSet.has(opts.focusedId)
      ? opts.focusedId
      : null;
  let focused =
    opts.focusedId != null && validSet.has(opts.focusedId)
      ? opts.focusedId
      : before.focused_partner_id != null && validSet.has(before.focused_partner_id)
        ? before.focused_partner_id
        : valid[0] ?? null;

  if (focused == null) {
    if (requested.length > 0 && valid.length === 0) {
      return {
        changed: false,
        state: before,
        participants: await loadParticipantViews(before.participant_ids),
        rejected_ids: rejectedIds,
        rejected_focus_id: rejectedFocus,
      };
    }
    return clearDialogueParticipants(playerId, {
      source: opts.source,
      turnId: opts.turnId,
    });
  }

  const participantIds = uniqueIds([focused, ...valid]);
  const state: DialogueParticipantState = {
    focused_partner_id: focused,
    participant_ids: participantIds,
    updated_at_turn: opts.turnId ?? null,
    source: opts.source,
  };
  await query(
    `UPDATE players
        SET dialogue_partner_id = $1,
            metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dialogue_participants', $2::jsonb)
      WHERE entity_id = $3`,
    [focused, JSON.stringify(state), playerId],
  );
  const participants = await loadParticipantViews(participantIds);
  return {
    changed: !sameState(before, state),
    state,
    participants,
    rejected_ids: rejectedIds,
    rejected_focus_id: rejectedFocus,
  };
}

export async function loadParticipantViews(
  ids: number[],
): Promise<DialogueParticipantView[]> {
  const unique = uniqueIds(ids);
  if (unique.length === 0) return [];
  const rows = await query<{id: number; display_name: string}>(
    `SELECT id, display_name FROM entities WHERE id = ANY($1::bigint[])`,
    [unique],
  );
  const byId = new Map(rows.rows.map(row => [Number(row.id), row.display_name]));
  return unique.flatMap(id => {
    const name = byId.get(id);
    return name ? [{id, display_name: name}] : [];
  });
}

export async function loadPresentNpcCandidates(
  playerId: number,
  opts: {
    sessionId?: string | null;
    currentLocationId?: number | null;
    allowRecentAuthors?: boolean;
  } = {},
): Promise<DialogueParticipantView[]> {
  const player = await loadPlayerDialogueRow(playerId);
  if (!player) return [];
  const currentLocationId =
    opts.currentLocationId === undefined
      ? player.current_location_id
      : opts.currentLocationId;
  const companionIds = readIdArray(player.metadata?.['companions']);
  const participantIds = readParticipantIds(player.metadata);
  const recentAuthorIds =
    opts.allowRecentAuthors === true
      ? await loadRecentSessionNpcAuthorIds(opts.sessionId, [])
      : [];
  const explicitIds = uniqueIds([
    ...companionIds,
    ...participantIds,
    ...recentAuthorIds,
  ]);
  // Use the same physical-presence sources as
  // locationPresence.loadPresentPeopleAtLocation so voiceWarden's "is this NPC
  // present?" check stays consistent with the rail panel and broker tools.
  // Authored scene participants are excluded from this static location sweep:
  // a scene can mention remote or historical actors. Active multi-NPC dialogue
  // still flows through explicit `dialogue_participants` metadata above.
  const rows = await query<{id: number; display_name: string}>(
    `WITH density_people AS (
       -- M-5: safe_to_bigint filters malformed and bigint-overflow ids
       -- to NULL so a garbage entry in local_density/scene/activity/
       -- quest JSON can no longer abort the voiceWarden presence check.
       -- M-6: safe_jsonb_array hardens the array-shape guard.
       SELECT safe_to_bigint(value) AS id
         FROM entities loc
         CROSS JOIN LATERAL jsonb_array_elements_text(
           safe_jsonb_array(loc.profile->'local_density'->'npc_ids')
         ) AS value
        WHERE loc.id = $1::bigint
          AND safe_to_bigint(value) IS NOT NULL
     ),
     activity_people AS (
       SELECT safe_to_bigint(a.profile->>'npc_entity_id') AS id
         FROM entities a
        WHERE a.kind = 'activity'
          AND a.profile->>'location_id' = $1::text
          AND safe_to_bigint(a.profile->>'npc_entity_id') IS NOT NULL
     ),
     quest_people AS (
       SELECT safe_to_bigint(giver.value) AS id
         FROM entities q
         CROSS JOIN LATERAL (
           VALUES
             (q.profile->>'giver_entity_id'),
             (q.profile->>'giver_id'),
             (q.profile->>'quest_giver_id'),
             (q.profile->>'source_entity_id')
         ) AS giver(value)
        WHERE q.kind = 'quest'
          AND q.profile->>'location_id' = $1::text
          AND safe_to_bigint(giver.value) IS NOT NULL
     ),
     linked_people AS (
       SELECT id FROM density_people
       UNION SELECT id FROM activity_people
       UNION SELECT id FROM quest_people
     )
     SELECT id, display_name FROM entities
      WHERE kind = 'person'
        AND (profile->>'hidden_until_stage') IS NULL
        AND (
          ($1::bigint IS NOT NULL AND (
            profile->>'home_id' = $1::text
            OR profile->>'current_location_id' = $1::text
            OR profile->>'location_id' = $1::text
            OR id IN (SELECT id FROM linked_people)
          ))
          OR id = ANY($2::bigint[])
        )
        AND NOT EXISTS (
          SELECT 1 FROM actor_statuses s
           WHERE s.player_id = $3
             AND s.actor_entity_id = entities.id
             AND s.intensity > 0
             AND s.status_kind IN ('dead', 'missing')
        )
      ORDER BY display_name`,
    [currentLocationId, explicitIds, playerId],
  );
  return rows.rows.map(row => ({
    id: Number(row.id),
    display_name: row.display_name,
  }));
}

async function loadPlayerDialogueRow(
  playerId: number,
): Promise<PlayerDialogueRow | null> {
  const rows = await query<PlayerDialogueRow>(
    `SELECT entity_id, dialogue_partner_id, current_location_id, current_scene_id, metadata
       FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return rows.rows[0] ?? null;
}

function readState(player: PlayerDialogueRow): DialogueParticipantState {
  const raw = player.metadata?.['dialogue_participants'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const focused = readPositiveId(obj['focused_partner_id']);
    const ids = uniqueIds(readIdArray(obj['participant_ids']));
    const participantIds = focused == null ? ids : uniqueIds([focused, ...ids]);
    return {
      focused_partner_id: focused,
      participant_ids: participantIds,
      updated_at_turn:
        typeof obj['updated_at_turn'] === 'string'
          ? (obj['updated_at_turn'] as string)
          : null,
      source: isSource(obj['source'])
        ? (obj['source'] as DialogueParticipantSource)
        : 'legacy',
    };
  }
  const focused = player.dialogue_partner_id;
  return {
    focused_partner_id: focused,
    participant_ids: focused == null ? [] : [focused],
    updated_at_turn: null,
    source: focused == null ? 'none' : 'legacy',
  };
}

async function filterPresentParticipantIds(
  player: PlayerDialogueRow,
  candidateIds: number[],
  opts: {
    sessionId?: string | null;
    explicitParticipantIds?: number[];
    allowRecentAuthors?: boolean;
  } = {},
): Promise<number[]> {
  const ids = uniqueIds(candidateIds);
  if (ids.length === 0) return [];
  const rows = await query<EntityPresenceRow>(
    `SELECT id, kind, display_name, profile
       FROM entities
      WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map(row => [Number(row.id), row]));
  const companionIds = new Set(readIdArray(player.metadata?.['companions']));
  const participantIds = new Set(readParticipantIds(player.metadata));
  const explicitIds = new Set(uniqueIds(opts.explicitParticipantIds ?? []));
  const unavailableIds = await loadUnavailableActorIds(player.entity_id, ids);
  const recentAuthorIds = new Set(
    opts.allowRecentAuthors === true
      ? await loadRecentSessionNpcAuthorIds(opts.sessionId, ids)
      : [],
  );
  return ids.filter(id => {
    const entity = byId.get(id);
    if (!entity || entity.kind !== 'person') return false;
    if (isHidden(entity.profile)) return false;
    if (unavailableIds.has(id)) return false;
    if (explicitIds.has(id)) return true;
    if (participantIds.has(id)) return true;
    if (recentAuthorIds.has(id)) return true;
    if (companionIds.has(id)) return true;
    if (player.current_location_id != null) {
      const homeId = readPositiveId(entity.profile?.['home_id']);
      if (homeId === player.current_location_id) return true;
      const currentLocationId = readPositiveId(
        entity.profile?.['current_location_id'],
      );
      if (currentLocationId === player.current_location_id) return true;
      const legacyLocationId = readPositiveId(entity.profile?.['location_id']);
      if (legacyLocationId === player.current_location_id) return true;
    }
    if (player.current_scene_id != null) {
      const sceneId = readPositiveId(entity.profile?.['scene_id']);
      if (sceneId === player.current_scene_id) return true;
      const sceneIds = readIdArray(entity.profile?.['scene_ids']);
      if (sceneIds.includes(player.current_scene_id)) return true;
    }
    return false;
  });
}

async function loadUnavailableActorIds(
  playerId: number,
  candidateIds: number[],
): Promise<Set<number>> {
  const ids = uniqueIds(candidateIds);
  if (ids.length === 0) return new Set();
  const rows = await query<{actor_entity_id: number}>(
    `SELECT actor_entity_id
       FROM actor_statuses
      WHERE player_id = $1
        AND actor_entity_id = ANY($2::bigint[])
        AND intensity > 0
        AND status_kind IN ('dead', 'missing')`,
    [playerId, ids],
  );
  return new Set(rows.rows.map(row => Number(row.actor_entity_id)));
}

async function loadRecentSessionNpcAuthorIds(
  sessionId: string | null | undefined,
  ids: number[],
): Promise<number[]> {
  if (!sessionId) return [];
  const filterIds = uniqueIds(ids);
  const rows = await query<{author_entity_id: number | null}>(
    `SELECT cm.author_entity_id
       FROM chat_messages cm
       JOIN entities e ON e.id = cm.author_entity_id
      WHERE cm.session_id = $1
        AND e.kind = 'person'
        AND ($2::boolean OR cm.author_entity_id = ANY($3::bigint[]))
      ORDER BY cm.id DESC
      LIMIT 40`,
    [sessionId, filterIds.length === 0, filterIds],
  );
  return uniqueIds(
    rows.rows
      .map(row => row.author_entity_id)
      .filter((id): id is number => typeof id === 'number'),
  );
}

function sameState(
  a: DialogueParticipantState,
  b: DialogueParticipantState,
): boolean {
  return (
    a.focused_partner_id === b.focused_partner_id &&
    a.participant_ids.length === b.participant_ids.length &&
    a.participant_ids.every((id, index) => id === b.participant_ids[index])
  );
}

function readIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readPositiveId)
    .filter((id): id is number => id != null);
}

function readPositiveId(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readParticipantIds(metadata: Record<string, unknown> | null): number[] {
  const raw = metadata?.['dialogue_participants'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  return uniqueIds([
    ...readIdArray(obj['participant_ids']),
    ...(readPositiveId(obj['focused_partner_id']) == null
      ? []
      : [readPositiveId(obj['focused_partner_id'])!]),
  ]);
}

function uniqueIds(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isHidden(profile: Record<string, unknown> | null): boolean {
  const gate = profile?.['hidden_until_stage'];
  return typeof gate === 'string' && gate.trim().length > 0;
}

function isSource(value: unknown): value is DialogueParticipantSource {
  return (
    value === 'mentions' ||
    value === 'tool' ||
    value === 'narrate' ||
    value === 'route' ||
    value === 'session_reset'
  );
}
