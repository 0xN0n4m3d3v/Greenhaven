/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-NOTICE-1 — durable Notice Journal projection service.
//
// The Notice Journal surface (J hotkey) needs a server-owned,
// replayable, paginated log of story-worthy events for the player.
// The live `gui_events` outbox is canon for SSE traffic but is
// session-scoped, includes broker scheduling metadata, and mixes
// events the player should never see (turn/diagnostic noise). The
// previous UI was a thin re-render of in-memory `systemEvents`,
// which loses everything between reloads.
//
// This service projects a bounded, hand-curated subset of released
// `gui_events` rows into the `player_journal_entries` table on
// read. Each row carries:
//
//   * `entry_type` — coarse grouping the UI uses for filters
//     (`quest`, `progression`, `relationship`, `world`, `story`,
//     `system`).
//   * `event_type` — the raw `gui_events.event_type` for the
//     entry's source row, useful for type-specific rendering.
//   * `title` / `body` — short, deterministic strings derived from
//     structured payload fields only (never parsed prose). The UI
//     localizes via its own i18n table keyed off `event_type`.
//   * `payload` — the original `gui_events.payload`, so future UI
//     work can render richer cards without a migration.
//
// Materialization rules:
//
//   * Only `gui_events` rows with `status = 'released'` and a
//     non-null `player_id` matching the requested player are
//     considered. Pending / dead / failed / unreleased rows do not
//     project — the player has not seen them yet.
//   * Only event types in `IMPORTANT_EVENT_TYPES` project. Every
//     other event type (chat lifecycle, turn diagnostics, telemetry
//     bubbles, etc.) is filtered server-side. Adding a new event
//     type to the journal is a deliberate edit here plus an entry
//     in `EVENT_TO_ENTRY_TYPE`.
//   * `INSERT ... ON CONFLICT DO NOTHING` against the partial
//     unique index on `(player_id, source_event_id)` guarantees a
//     given gui_event materializes into at most one journal row,
//     so reading twice in a row does not duplicate.
//   * Title/body extraction is deterministic and falls back to
//     stable English placeholders when payload fields are missing.
//     The UI layer is responsible for localizing those placeholders
//     via `event_type` keys (handled in a later UI slice — see the
//     master plan FEAT-NOTICE-1 entry).
//
// Read API:
//
//   * `list(playerId, {limit, cursor, type})` returns the newest
//     `limit` entries (default 50, capped at 200) older than
//     `cursor` (numeric `id`, exclusive), optionally filtered to
//     `type`. The cursor is the smallest `id` returned; pass it
//     back to fetch the next page. `nextCursor` is `null` once
//     fewer than `limit` rows come back.
//   * `snapshot(playerId, opts)` is the read entry point used by
//     the route — it materializes pending gui_events first, then
//     calls `list`.

import {query} from '../db.js';

export type JournalEntryType =
  | 'quest'
  | 'progression'
  | 'relationship'
  | 'world'
  | 'story'
  | 'system';

export interface NoticeJournalEntry {
  id: number;
  entryType: JournalEntryType;
  eventType: string;
  sourceEventId: number | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  turnId: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface NoticeJournalSnapshot {
  playerId: number;
  entries: NoticeJournalEntry[];
  nextCursor: number | null;
}

export interface NoticeJournalListOptions {
  limit?: number;
  cursor?: number | null;
  type?: JournalEntryType | null;
}

// Bounded important-event taxonomy. Starts conservative; every new
// entry here is an explicit decision plus a row in
// `EVENT_TO_ENTRY_TYPE` plus (optionally) a title/body extractor.
export const IMPORTANT_EVENT_TYPES = [
  // Quest lifecycle. Matches the same set FEAT-QUEST-1 dashboard
  // consumes, minus the side-effect-only `quest:changed` /
  // `quest:choice_required` types (the dashboard surfaces choice
  // prompts; the journal records story beats).
  'quest:created',
  'quest:started',
  'quest:advanced',
  'quest:auto_advanced',
  'quest:completed',
  // Adventure beats the player committed to or missed.
  'adventure:accepted',
  'adventure:expired',
  // Memory beats — recorded NPC observations the player can revisit.
  'memory:added',
  'memory:enriched',
  // Relationship beats — strings + companions.
  'string:changed',
  'companion:added',
  'companion:removed',
  // Progression beats.
  'xp:awarded',
  'xp:levelup',
  // World beats.
  'location:first_entry',
] as const;

type ImportantEventType = (typeof IMPORTANT_EVENT_TYPES)[number];

// One-to-one mapping from `event_type` to the surface bucket. The
// UI uses `entryType` to drive filter chips; the raw `eventType` is
// preserved on each entry so type-specific rendering still works.
const EVENT_TO_ENTRY_TYPE: Record<ImportantEventType, JournalEntryType> = {
  'quest:created': 'quest',
  'quest:started': 'quest',
  'quest:advanced': 'quest',
  'quest:auto_advanced': 'quest',
  'quest:completed': 'quest',
  'adventure:accepted': 'story',
  'adventure:expired': 'story',
  'memory:added': 'system',
  'memory:enriched': 'system',
  'string:changed': 'relationship',
  'companion:added': 'relationship',
  'companion:removed': 'relationship',
  'xp:awarded': 'progression',
  'xp:levelup': 'progression',
  'location:first_entry': 'world',
};

const VALID_ENTRY_TYPES: ReadonlySet<JournalEntryType> = new Set([
  'quest',
  'progression',
  'relationship',
  'world',
  'story',
  'system',
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Cap how many fresh gui_events we project in one read. A normal
// session produces a handful of important events per turn — 500
// covers a long absence without blowing query budgets.
const MATERIALIZE_BATCH_LIMIT = 500;

interface GuiEventRow {
  id: number;
  session_id: string | null;
  event_type: string;
  payload: Record<string, unknown> | null;
  turn_id: string | null;
  released_at: string | null;
  created_at: string;
}

interface JournalRow {
  id: number;
  entry_type: JournalEntryType;
  event_type: string;
  source_event_id: number | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  turn_id: string | null;
  occurred_at: string;
  created_at: string;
}

export class NoticeJournalService {
  /**
   * The full read used by `GET /api/player/:id/notices`: project
   * any new important `gui_events` into journal rows, then return
   * the newest `limit` entries (optionally filtered by type).
   */
  static async snapshot(
    playerId: number,
    opts: NoticeJournalListOptions = {},
  ): Promise<NoticeJournalSnapshot | null> {
    const playerRow = await query<{entity_id: number}>(
      `SELECT entity_id FROM players WHERE entity_id = $1`,
      [playerId],
    );
    if (!playerRow.rows[0]) return null;
    await NoticeJournalService.materialize(playerId);
    return NoticeJournalService.list(playerId, opts);
  }

  /**
   * Pull released `gui_events` rows for this player whose
   * `event_type` is in `IMPORTANT_EVENT_TYPES` and that have no
   * journal entry yet, and insert one row per gui_event. The
   * `ON CONFLICT DO NOTHING` clause against the partial unique
   * index makes repeated calls a no-op.
   */
  static async materialize(playerId: number): Promise<number> {
    const events = await query<GuiEventRow>(
      `SELECT g.id,
              g.session_id,
              g.event_type,
              g.payload,
              g.turn_id,
              g.released_at::text AS released_at,
              g.created_at::text AS created_at
         FROM gui_events g
         LEFT JOIN player_journal_entries j
           ON j.player_id = $1
          AND j.source_event_id = g.id
        WHERE g.player_id = $1
          AND g.status = 'released'
          AND g.event_type = ANY($2::text[])
          AND j.id IS NULL
        ORDER BY g.id ASC
        LIMIT $3`,
      [playerId, IMPORTANT_EVENT_TYPES as readonly string[], MATERIALIZE_BATCH_LIMIT],
    );
    if (events.rows.length === 0) return 0;
    let inserted = 0;
    for (const row of events.rows) {
      const eventType = row.event_type as ImportantEventType;
      const entryType = EVENT_TO_ENTRY_TYPE[eventType];
      if (!entryType) continue;
      const rawPayload = (row.payload ?? {}) as Record<string, unknown>;
      // FEAT-MEMORY-1 — sanitize before persisting so newly
      // materialized memory rows never store raw NPC memory text /
      // category / tags / private reflections on disk.
      const payload = sanitizeJournalPayload(eventType, rawPayload);
      const title = deriveTitle(eventType, payload);
      const body = deriveBody(eventType, payload);
      const occurredAt = row.released_at ?? row.created_at;
      const result = await query(
        `INSERT INTO player_journal_entries (
           player_id, session_id, source_event_id,
           entry_type, event_type, title, body, payload, turn_id,
           occurred_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz)
         ON CONFLICT (player_id, source_event_id)
           WHERE source_event_id IS NOT NULL
           DO NOTHING`,
        [
          playerId,
          row.session_id,
          row.id,
          entryType,
          row.event_type,
          title,
          body,
          JSON.stringify(payload),
          row.turn_id,
          occurredAt,
        ],
      );
      if (result.rowCount && result.rowCount > 0) inserted += 1;
    }
    return inserted;
  }

  /**
   * Read-only cursor pagination over already-materialized journal
   * rows. Newest-first by `id`. `cursor` is exclusive: pass back
   * `nextCursor` from the previous page to fetch older rows.
   */
  static async list(
    playerId: number,
    opts: NoticeJournalListOptions = {},
  ): Promise<NoticeJournalSnapshot> {
    const limit = clampLimit(opts.limit);
    const cursor = readCursor(opts.cursor);
    const type = readEntryType(opts.type);
    const params: unknown[] = [playerId];
    let whereType = '';
    if (type) {
      params.push(type);
      whereType = ` AND entry_type = $${params.length}`;
    }
    let whereCursor = '';
    if (cursor != null) {
      params.push(cursor);
      whereCursor = ` AND id < $${params.length}`;
    }
    params.push(limit + 1);
    const rows = await query<JournalRow>(
      `SELECT id,
              entry_type,
              event_type,
              source_event_id,
              title,
              body,
              payload,
              turn_id,
              occurred_at::text AS occurred_at,
              created_at::text AS created_at
         FROM player_journal_entries
        WHERE player_id = $1${whereType}${whereCursor}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    );
    const entries = rows.rows.slice(0, limit).map(toEntry);
    // FEAT-MEMORY-1 — defensively sanitize legacy rows that may
    // have been materialized before the privacy fix landed. The
    // sanitizer is idempotent on already-clean payloads. The
    // legacy-title corrective pass also forces `title` through
    // `deriveTitle()` so any persisted leaky title (e.g.
    // `"betrayal"` from a pre-FEAT-MEMORY-1 row) is rewritten to
    // the generic `"Memory recorded"` / `"Memory deepened"`
    // placeholder before it leaves the service.
    for (const entry of entries) {
      const event = entry.eventType as ImportantEventType;
      if (event === 'memory:added' || event === 'memory:enriched') {
        entry.payload = sanitizeJournalPayload(event, entry.payload);
        entry.body = null;
        entry.title = deriveTitle(event, entry.payload) ?? entry.title;
      }
    }
    const nextCursor =
      rows.rows.length > limit
        ? (entries[entries.length - 1]?.id ?? null)
        : null;
    return {playerId, entries, nextCursor};
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw == null) return DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function readCursor(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  const n = Math.floor(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function readEntryType(raw: JournalEntryType | null | undefined): JournalEntryType | null {
  if (!raw) return null;
  return VALID_ENTRY_TYPES.has(raw) ? raw : null;
}

function toEntry(row: JournalRow): NoticeJournalEntry {
  return {
    id: Number(row.id),
    entryType: row.entry_type,
    eventType: row.event_type,
    sourceEventId: row.source_event_id != null ? Number(row.source_event_id) : null,
    title: row.title,
    body: row.body ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    turnId: row.turn_id ?? null,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

// Deterministic title extraction from structured payload fields.
// Every branch falls back to a stable English placeholder rather
// than scraping prose. The UI layer is responsible for translating
// those placeholders via `event_type` keys in a later slice.
function deriveTitle(
  eventType: ImportantEventType,
  payload: Record<string, unknown>,
): string {
  switch (eventType) {
    case 'quest:created':
      return (
        readString(payload, ['title', 'questName', 'quest_name']) ??
        'Quest offered'
      );
    case 'quest:started':
      return (
        readString(payload, ['title', 'questName', 'quest_name']) ??
        'Quest started'
      );
    case 'quest:advanced':
    case 'quest:auto_advanced':
      return (
        readString(payload, ['title', 'questName', 'quest_name']) ??
        'Quest advanced'
      );
    case 'quest:completed':
      return (
        readString(payload, ['title', 'questName', 'quest_name']) ??
        'Quest complete'
      );
    case 'adventure:accepted':
      return (
        readString(payload, ['title', 'adventureName', 'name']) ??
        'Adventure accepted'
      );
    case 'adventure:expired':
      return (
        readString(payload, ['title', 'adventureName', 'name']) ??
        'Adventure missed'
      );
    // FEAT-MEMORY-1 — memory beats render as content-less notices
    // both in the chat (`EventCardMemory`) and the journal. Never
    // surface the memory `kind` / `category`, which would leak
    // *what type* of NPC memory was recorded (e.g. `betrayal`,
    // `intimacy`). Use a stable, deterministic placeholder; the UI
    // localizes via `event_type` keys.
    case 'memory:added':
      return 'Memory recorded';
    case 'memory:enriched':
      return 'Memory deepened';
    case 'string:changed': {
      const name = readString(payload, ['npcName', 'npc_name']);
      const band = readString(payload, ['band']);
      if (name && band) return `${name} • ${band}`;
      return name ?? 'String shifted';
    }
    case 'companion:added':
      return readString(payload, ['npcName', 'npc_name']) ?? 'Companion joined';
    case 'companion:removed':
      return (
        readString(payload, ['npcName', 'npc_name']) ?? 'Companion departed'
      );
    case 'xp:awarded': {
      const amount = readNumber(payload, ['amount', 'delta']);
      if (amount != null) return `+${amount} XP`;
      return 'XP awarded';
    }
    case 'xp:levelup': {
      const level = readNumber(payload, ['newLevel', 'level']);
      if (level != null) return `Level ${level}`;
      return 'Level gained';
    }
    case 'location:first_entry':
      return (
        readString(payload, ['locationName', 'location_name']) ??
        'First entered location'
      );
  }
}

// Body is optional. Most cards already carry their punch line in
// the title; the body fills in `reason` / `summary` / `introBubble`
// when the payload supplies them. Truncates conservatively so the
// journal stays scannable.
function deriveBody(
  eventType: ImportantEventType,
  payload: Record<string, unknown>,
): string | null {
  switch (eventType) {
    case 'quest:created':
    case 'quest:started':
    case 'quest:advanced':
    case 'quest:auto_advanced':
    case 'quest:completed':
      return truncate(
        readString(payload, ['summary', 'description', 'goal']) ?? null,
      );
    case 'adventure:accepted':
    case 'adventure:expired':
      return truncate(
        readString(payload, ['summary', 'playerFacingHook', 'hook']) ?? null,
      );
    // FEAT-MEMORY-1 — memory beats never expose the underlying
    // NPC memory text / summary / private reflection in the
    // durable journal body. The chat EventCardMemory already
    // hides these; the journal projection must match that
    // contract.
    case 'memory:added':
    case 'memory:enriched':
      return null;
    case 'string:changed':
      return truncate(
        readString(payload, ['summary', 'reason']) ?? null,
      );
    case 'companion:added':
    case 'companion:removed':
      return truncate(readString(payload, ['reason']) ?? null);
    case 'xp:awarded':
      return truncate(readString(payload, ['reason']) ?? null);
    case 'xp:levelup':
      return null;
    case 'location:first_entry':
      return truncate(
        readString(payload, ['introBubble', 'summary']) ?? null,
      );
  }
}

const BODY_MAX_LEN = 320;

function truncate(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= BODY_MAX_LEN) return trimmed;
  return `${trimmed.slice(0, BODY_MAX_LEN - 1).trimEnd()}…`;
}

function readString(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

// FEAT-MEMORY-1 — strip private NPC memory text / category /
// tag / reflection fields from a memory event payload before
// the journal persists or returns it. The chat `EventCardMemory`
// already hides these; this helper enforces the same contract
// for the durable Notice Journal + its API JSON.
//
// The whitelist is intentionally narrow: only structured
// identifiers that the UI uses to render "X noticed something"
// survive. Anything that might contain raw memory prose, the
// reasoning behind a link, or the memory category leaks the
// NPC's private interiority and is dropped.
//
// Idempotent on already-sanitized payloads.
export function sanitizeJournalPayload(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (eventType !== 'memory:added' && eventType !== 'memory:enriched') {
    return payload;
  }
  const safe: Record<string, unknown> = {};
  const memoryIdSafeKeys: readonly string[] = [
    'memoryId',
    'ownerId',
    'ownerName',
    'aboutId',
    'aboutName',
  ];
  for (const key of memoryIdSafeKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      safe[key] = payload[key];
    }
  }
  // Importance is a numeric signal the chat card uses to pick its
  // verb ("noticed something" vs. "noticed something they will not
  // forget"). It does not reveal *what* was noticed, so it is safe
  // to surface. Clamp to a number to defang any non-numeric value
  // that might sneak in.
  if (typeof payload['importance'] === 'number') {
    safe['importance'] = payload['importance'];
  }
  return safe;
}

function readNumber(
  payload: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
