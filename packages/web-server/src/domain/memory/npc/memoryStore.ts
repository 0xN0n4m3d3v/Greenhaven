/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-4 — broker-tool memory store.
//
// Owns the raw `npc_memories` INSERT / SELECT / UPDATE statements that
// `tools/memory.ts` and `tools/worldMemory.ts` previously hand-wrote
// in line with their broker-tool wiring. Splitting these into typed
// helpers keeps direct `npc_memories` SQL inside `domain/memory/**`
// per ARCH-4 criterion (b) while preserving every existing broker
// contract: schemas, importance/salience seeds, kind/family inference,
// reference counting, and ordering rules are owned by the calling
// tools so the tool surfaces stay broker-stable. The helpers below
// are pure-data DB writers / readers; they take fully-resolved
// inputs and return shapes the tools forward to the broker.

import {query} from '../../../db.js';

export interface NpcMemoryInsertInput {
  ownerEntityId: number;
  aboutEntityId: number | null;
  text: string;
  importance: number;
  tags: string[];
  sensitive: boolean;
  salience: number;
  memoryKind: string;
  memoryFamily: string;
  sourceTurnId: string | null;
  sourceTool: string | null;
  /** Optional JSONB payload; pass `null` to write NULL into the column. */
  metadata: Record<string, unknown> | null;
}

/** INSERT a row into `npc_memories` and return the new id. The
 *  caller owns importance, salience, kind, family, tag, and metadata
 *  computation. */
export async function insertNpcMemory(
  input: NpcMemoryInsertInput,
): Promise<{id: number}> {
  const r = await query<{id: number}>(
    `INSERT INTO npc_memories
       (owner_entity_id, about_entity_id, text, importance, tags, sensitive,
        salience, memory_kind, memory_family, source_turn_id, source_tool,
        metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now())
     RETURNING id`,
    [
      input.ownerEntityId,
      input.aboutEntityId,
      input.text,
      input.importance,
      input.tags,
      input.sensitive,
      input.salience,
      input.memoryKind,
      input.memoryFamily,
      input.sourceTurnId,
      input.sourceTool,
      input.metadata == null ? null : JSON.stringify(input.metadata),
    ],
  );
  return {id: r.rows[0]!.id};
}

export interface NpcMemoryBumpInput {
  memoryId: number;
  /** Live-recall increment supplied by the caller. */
  bump: number;
  /** Caller-resolved turn index (e.g. `MAX(chat_messages.turn_index)`). */
  currentTurn: number;
  /** Caller-supplied salience seeder. The helper applies the function to
   *  the current row's salience (falling back to `importance`, then
   *  `0.5`) and persists the result. Keeping this as a parameter
   *  means `domain/memory/kinds.ts:salienceBump` stays the single
   *  authority on bump arithmetic without circular imports. */
  applyBump: (current: number, bump: number) => number;
}

export type NpcMemoryBumpResult =
  | {ok: true; salience: number; reference_count: number}
  | {ok: false; error: string};

/** SELECT the current salience/importance of a memory row, compute
 *  the next salience via the caller-supplied bump function, and
 *  UPDATE in place. Returns a discriminated union the broker tool
 *  forwards as-is. */
export async function bumpNpcMemorySalience(
  input: NpcMemoryBumpInput,
): Promise<NpcMemoryBumpResult> {
  const current = await query<{salience: number; importance: number}>(
    `SELECT salience, importance FROM npc_memories WHERE id = $1`,
    [input.memoryId],
  );
  const row = current.rows[0];
  if (!row) {
    return {ok: false, error: `unknown memory_id ${input.memoryId}`};
  }
  const nextSalience = input.applyBump(
    Number(row.salience ?? row.importance ?? 0.5),
    input.bump,
  );
  const r = await query<{
    salience: number;
    importance: number;
    reference_count: number;
  }>(
    `UPDATE npc_memories
        SET salience = $2,
            last_referenced_turn = $3,
            last_referenced_at = now(),
            reference_count = reference_count + 1,
            updated_at = now()
      WHERE id = $1
      RETURNING salience, importance, reference_count`,
    [input.memoryId, nextSalience, input.currentTurn],
  );
  if (r.rows.length === 0) {
    return {
      ok: false,
      error: `memory ${input.memoryId} not found — may have been deleted`,
    };
  }
  const updated = r.rows[0]!;
  return {
    ok: true,
    salience: updated.salience,
    reference_count: updated.reference_count,
  };
}

export interface NpcMemoryQueryFilters {
  ownerEntityId: number;
  aboutEntityId?: number | null;
  /** Free-text query — ILIKE substring match. */
  query?: string;
  minImportance?: number;
  memoryKind?: string;
  memoryFamily?: string;
  /** Match any of the given tag strings via PostgreSQL array overlap. */
  tagsAny?: string[];
  limit: number;
}

export interface NpcMemoryQueryRow {
  id: number;
  text: string;
  importance: number;
  salience: number;
  memory_kind: string;
  memory_family: string;
  reference_count: number;
  tags: string[];
  created_at: string;
  about_entity_id: number | null;
}

export interface ArchivalNpcMemoryInput {
  ownerEntityId: number;
  aboutEntityId: number | null;
  text: string;
  importance: number;
  tags: string[];
  sensitive: boolean;
  salience: number;
  sourceTurnId: string | null;
  sourceTool: string;
  metadata: Record<string, unknown> | null;
}

/** Archival-write variant of `insertNpcMemory`. Mirrors the historical
 *  narrate/synth/auto-snapshot/sweeper INSERT column set, which OMITS
 *  `memory_kind` / `memory_family` (leaving them at DB defaults) and
 *  fills the remaining columns from caller input. Use this for
 *  `narrate` internal-monologue + auto-snapshot, `narrationSynthesis`
 *  synth auto-snapshot, `PlayerMessagePersistencePhase` player-utterance
 *  snapshot, and `narrativeClaimSweeper` unfinished-canon notes. */
export async function insertArchivalNpcMemory(
  input: ArchivalNpcMemoryInput,
): Promise<{id: number}> {
  const r = await query<{id: number}>(
    `INSERT INTO npc_memories
       (owner_entity_id, about_entity_id, text, importance, tags,
        sensitive, salience, source_turn_id, source_tool, metadata,
        updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
     RETURNING id`,
    [
      input.ownerEntityId,
      input.aboutEntityId,
      input.text,
      input.importance,
      input.tags,
      input.sensitive,
      input.salience,
      input.sourceTurnId,
      input.sourceTool,
      input.metadata == null ? null : JSON.stringify(input.metadata),
    ],
  );
  return {id: r.rows[0]!.id};
}

export interface RollingDialogueSummaryInput {
  ownerEntityId: number;
  aboutEntityId: number;
  text: string;
  upToTurn: number;
}

/** Atomic replace for the per-(owner, about) `rolling_summary`
 *  memory. Deletes any prior rows tagged `rolling_summary` for that
 *  pair, then INSERTs a new row with `metadata.up_to_turn` carrying
 *  the high-water mark. Caller-supplied text is written verbatim. */
export async function upsertRollingDialogueSummary(
  input: RollingDialogueSummaryInput,
): Promise<void> {
  await query(
    `DELETE FROM npc_memories
      WHERE owner_entity_id = $1
        AND about_entity_id = $2
        AND 'rolling_summary' = ANY(COALESCE(tags, ARRAY[]::text[]))`,
    [input.ownerEntityId, input.aboutEntityId],
  );
  await query(
    `INSERT INTO npc_memories
       (owner_entity_id, about_entity_id, text, importance, tags, metadata)
     VALUES ($1, $2, $3, 0.6,
             ARRAY['rolling_summary']::text[],
             jsonb_build_object('visibility', 'public', 'up_to_turn', $4::int))`,
    [input.ownerEntityId, input.aboutEntityId, input.text, input.upToTurn],
  );
}

/** Reads the latest `metadata.up_to_turn` value from any
 *  `rolling_summary` memory row for the given (owner, about) pair.
 *  Returns 0 when no checkpoint exists yet so callers can compare
 *  with `MAX(turn_index)` directly. */
export async function readRollingDialogueSummaryCheckpoint(input: {
  ownerEntityId: number;
  aboutEntityId: number;
}): Promise<number> {
  const r = await query<{up_to_turn: number | null}>(
    `SELECT (metadata->>'up_to_turn')::int AS up_to_turn
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND about_entity_id = $2
        AND 'rolling_summary' = ANY(COALESCE(tags, ARRAY[]::text[]))
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.ownerEntityId, input.aboutEntityId],
  );
  const raw = Number(r.rows[0]?.up_to_turn ?? 0);
  return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

export interface NpcMemoryRowById {
  id: number;
  owner_entity_id: number;
  about_entity_id: number | null;
  text: string;
  importance: number;
  tags: string[];
  metadata: Record<string, unknown> | null;
}

/** SELECT a single `npc_memories` row by id, returning the column
 *  shape `npcVoice.enrichOneMemory` relies on (snake_case to match the
 *  prior inline `loadMemoryRow` interface so the migration is a pure
 *  call-site swap). Returns `null` when the row is missing. */
export async function selectNpcMemoryById(
  memoryId: number,
): Promise<NpcMemoryRowById | null> {
  const r = await query<NpcMemoryRowById>(
    `SELECT id, owner_entity_id, about_entity_id, text, importance, tags, metadata
       FROM npc_memories
      WHERE id = $1`,
    [memoryId],
  );
  return r.rows[0] ?? null;
}

export interface ActorMemoryFamilyRow {
  id: number;
  memory_family: string | null;
  memory_kind: string | null;
  salience: number;
  importance: number;
}

/** Read the top-N memory rows an actor owns about either the world
 *  (about=NULL) or the requesting player. Used by
 *  `actorCorePacket.loadMemoryFamilies` to roll memories up into
 *  family buckets; the ranking SQL stays identical so the family
 *  ordering rendered into the broker preamble does not shift. */
export async function selectActorMemoryFamilies(input: {
  ownerEntityId: number;
  aboutEntityId: number;
  limit: number;
}): Promise<ActorMemoryFamilyRow[]> {
  const r = await query<ActorMemoryFamilyRow>(
    `SELECT id, memory_family, memory_kind, salience, importance
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND (about_entity_id IS NULL OR about_entity_id = $2)
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT $3`,
    [input.ownerEntityId, input.aboutEntityId, input.limit],
  );
  return r.rows;
}

export interface ActorPromiseRow {
  id: number;
  text: string;
  tags: string[];
}

/** Read the promise-flagged memories an actor holds about the player
 *  (or about no-one), preserving the salience/importance/created_at
 *  ordering `actorCorePacket.loadRelationshipSlice` relied on for
 *  active-promise + open-debt enumeration. */
export async function selectActorPromiseMemories(input: {
  ownerEntityId: number;
  aboutEntityId: number;
  limit: number;
}): Promise<ActorPromiseRow[]> {
  const r = await query<ActorPromiseRow>(
    `SELECT id, text, tags
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND (about_entity_id IS NULL OR about_entity_id = $2)
        AND memory_kind = 'promise'
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT $3`,
    [input.ownerEntityId, input.aboutEntityId, input.limit],
  );
  return r.rows;
}

export interface DialoguePublicMemoryRow {
  text: string;
  importance: number;
  tags: string[];
  salience: number;
}

/** Highlights: top-N highest-salience PUBLIC memories the NPC holds
 *  about the active player. Drives the "What this NPC remembers" block
 *  of the dialogue preamble; excludes rolling-summary rows (rendered
 *  via the cold-tail helper) and private notes (rendered separately).
 *  Ordering matches the original inline `ORDER BY salience DESC`. */
export async function selectDialoguePublicHighlights(input: {
  ownerEntityId: number;
  aboutEntityId: number;
  limit: number;
}): Promise<DialoguePublicMemoryRow[]> {
  const r = await query<DialoguePublicMemoryRow>(
    `SELECT text, importance, tags, salience
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND about_entity_id = $2
        AND COALESCE(metadata->>'visibility', 'public') = 'public'
        AND NOT ('rolling_summary' = ANY(COALESCE(tags, ARRAY[]::text[])))
      ORDER BY salience DESC LIMIT $3`,
    [input.ownerEntityId, input.aboutEntityId, input.limit],
  );
  return r.rows;
}

export interface DialogueRollingSummaryRow {
  text: string;
  created_at: Date;
}

/** Cold-tail rolling-summary fetch for the (NPC, player) pair. The
 *  rollingDialogueSummary post-turn agent writes exactly one row per
 *  pair via `upsertRollingDialogueSummary`; this helper reads the
 *  latest one (LIMIT 1 by created_at) so the dialogue preamble can
 *  render the "Earlier conversation" block. */
export async function selectDialogueRollingSummary(input: {
  ownerEntityId: number;
  aboutEntityId: number;
}): Promise<DialogueRollingSummaryRow | null> {
  const r = await query<DialogueRollingSummaryRow>(
    `SELECT text, created_at
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND about_entity_id = $2
        AND 'rolling_summary' = ANY(COALESCE(tags, ARRAY[]::text[]))
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.ownerEntityId, input.aboutEntityId],
  );
  return r.rows[0] ?? null;
}

export interface DialoguePrivateNoteRow {
  text: string;
  salience: number;
}

/** Private notes: PRIVATE-visibility memories the NPC has written about
 *  the player (internal monologue, deliberate `add_memory(...visibility:
 *  'private')`). Only ever rendered inside THIS NPC's preamble; the
 *  caller never surfaces these to the player-facing chat. */
export async function selectDialoguePrivateNotes(input: {
  ownerEntityId: number;
  aboutEntityId: number;
  limit: number;
}): Promise<DialoguePrivateNoteRow[]> {
  const r = await query<DialoguePrivateNoteRow>(
    `SELECT text, salience
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND about_entity_id = $2
        AND COALESCE(metadata->>'visibility', 'public') = 'private'
      ORDER BY salience DESC LIMIT $3`,
    [input.ownerEntityId, input.aboutEntityId, input.limit],
  );
  return r.rows;
}

export interface VoicePastMemoryRow {
  id: number;
  text: string;
  tags: string[];
  about_id: number | null;
}

export interface VoicePastMemoryQuery {
  ownerEntityId: number;
  aboutEntityId: number | null;
  tags: string[];
  excludeMemoryId: number;
  limit: number;
}

/** Rank the NPC's prior memories for a candidate cross-reference link
 *  while voice-enriching a fresh write. Score combines about-entity
 *  match (+2.0), tag overlap (+1.0), and `importance * 0.5`; ties
 *  break by `created_at DESC`. Returned rows are the NPC voice
 *  specialist's `past_memories` input candidates; callers resolve
 *  `about_name` separately via the entities table. */
export async function selectVoicePastMemoryCandidates(
  input: VoicePastMemoryQuery,
): Promise<VoicePastMemoryRow[]> {
  const r = await query<{
    id: number;
    text: string;
    tags: string[];
    about_id: number | null;
    score: number;
  }>(
    `SELECT m.id,
            m.text,
            m.tags,
            m.about_entity_id AS about_id,
            (
              CASE WHEN m.about_entity_id = $2 THEN 2.0 ELSE 0.0 END
            + CASE WHEN m.tags && $3::text[] THEN 1.0 ELSE 0.0 END
            + (m.importance * 0.5)
            ) AS score
       FROM npc_memories m
      WHERE m.owner_entity_id = $1
        AND m.id <> $4
      ORDER BY score DESC, m.created_at DESC
      LIMIT $5`,
    [
      input.ownerEntityId,
      input.aboutEntityId,
      input.tags,
      input.excludeMemoryId,
      input.limit,
    ],
  );
  return r.rows.map(row => ({
    id: row.id,
    text: row.text,
    tags: row.tags,
    about_id: row.about_id,
  }));
}

export interface NpcVoiceEnrichmentInput {
  memoryId: number;
  voicedText: string;
  /** JSONB patch merged into the existing `metadata` column via
   *  `COALESCE(metadata, '{}') || $::jsonb`. Caller composes the
   *  `voiced_by` / `voiced_at` / `draft_text` / `internal_reflection`
   *  / `links_to_memory_id` / `link_reason` keys so the audit trail
   *  surface stays at the agent boundary. */
  enrichmentPatch: Record<string, unknown>;
}

/** Apply the NPC voice agent's rewrite + metadata patch to an
 *  existing memory row. The single UPDATE statement matches the
 *  prior inline `applyEnrichment` SQL byte-for-byte so the
 *  `withTransaction(...)` rollback contract exercised by
 *  `npcVoiceTransactional.test.ts` continues to hold. */
export async function applyNpcVoiceEnrichment(
  input: NpcVoiceEnrichmentInput,
): Promise<void> {
  await query(
    `UPDATE npc_memories
        SET text = $1,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE id = $3`,
    [input.voicedText, JSON.stringify(input.enrichmentPatch), input.memoryId],
  );
}

export interface RelationshipMemoryRow {
  id: number;
  text: string;
  importance: number;
  tags: string[];
  created_at: string;
}

/** Bidirectional relationship memory read for the sensing tools:
 *  rows where the target NPC has memories ABOUT the player, OR the
 *  player has memories ABOUT the target NPC. Ordered by
 *  `importance DESC, created_at DESC` to match the prior inline
 *  SQL in `tools/worldSensing.ts` so the `summarize_relationships`
 *  and `evaluate_social_standing` tool outputs preserve their
 *  evidence ordering. */
export async function selectRelationshipMemories(input: {
  playerEntityId: number;
  targetEntityId: number;
  limit: number;
}): Promise<RelationshipMemoryRow[]> {
  const r = await query<RelationshipMemoryRow>(
    `SELECT id, text, importance, tags, created_at
       FROM npc_memories
      WHERE (
        owner_entity_id = $1 AND about_entity_id = $2
      ) OR (
        owner_entity_id = $2 AND about_entity_id = $1
      )
      ORDER BY importance DESC, created_at DESC
      LIMIT $3`,
    [input.targetEntityId, input.playerEntityId, input.limit],
  );
  return r.rows;
}

export interface RecentMemoryAboutPlayerRow {
  id: number;
  owner: string;
  text: string;
  importance: number;
  tags: string[];
  at: string;
}

/** Read recent memories OTHER NPCs hold about the player, joined to
 *  the owning entity's `display_name`. Drives the `memories` domain
 *  of `get_recent_history`. The entity JOIN is kept inside the
 *  helper because the rendered "memory + memory owner" pairing is a
 *  memory-pack surface — callers consume the rows as a single event
 *  shape (`{owner, text, importance, tags, at}`). Ordering is
 *  `importance DESC, created_at DESC` to match the prior inline
 *  SQL. */
export async function selectRecentMemoriesAboutPlayer(input: {
  playerEntityId: number;
  limit: number;
}): Promise<RecentMemoryAboutPlayerRow[]> {
  const r = await query<RecentMemoryAboutPlayerRow>(
    `SELECT m.id,
            owner.display_name AS owner,
            m.text,
            m.importance,
            m.tags,
            m.created_at AS at
       FROM npc_memories m
       JOIN entities owner ON owner.id = m.owner_entity_id
      WHERE m.about_entity_id = $1
      ORDER BY m.importance DESC, m.created_at DESC
      LIMIT $2`,
    [input.playerEntityId, input.limit],
  );
  return r.rows;
}

export interface QuestRewardMemoryInput {
  ownerEntityId: number;
  aboutEntityId: number | null;
  text: string;
  importance: number;
  tags: string[];
}

/** Quest-reward memory write triggered by `applyQuestRewards`. The
 *  column set matches the historical inline INSERT byte-for-byte:
 *  only `owner_entity_id`, `about_entity_id`, `text`, `importance`,
 *  `tags`, and `sensitive = false` are written, leaving
 *  `memory_kind` / `memory_family` / `salience` / `source_turn_id`
 *  / `source_tool` / `metadata` at their DB defaults. No id is
 *  returned because the caller composes `applied['memory']` from
 *  the inputs without needing the row id. */
export async function insertQuestRewardMemory(
  input: QuestRewardMemoryInput,
): Promise<void> {
  await query(
    `INSERT INTO npc_memories
       (owner_entity_id, about_entity_id, text, importance, tags, sensitive)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [
      input.ownerEntityId,
      input.aboutEntityId,
      input.text,
      input.importance,
      input.tags,
    ],
  );
}

/** Top-N memory ids owned by any of the given actors (about the
 *  player or about nobody). Drives `questDirectorPacket`'s
 *  "relevantMemoryIds" surface. Ordering preserved verbatim:
 *  `salience DESC, importance DESC, created_at DESC`. */
export async function selectQuestActorMemoryIds(input: {
  actorEntityIds: number[];
  playerEntityId: number;
  limit: number;
}): Promise<number[]> {
  if (input.actorEntityIds.length === 0) return [];
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE owner_entity_id = ANY($1::bigint[])
        AND (about_entity_id IS NULL OR about_entity_id = $2)
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT $3`,
    [input.actorEntityIds, input.playerEntityId, input.limit],
  );
  return r.rows.map(row => Number(row.id));
}

/** Top-N memory ids tagged with any of the given quest tags OR
 *  flagged as `quest_lesson` kind. Drives the second half of
 *  `questDirectorPacket`'s "relevantMemoryIds" surface. Ordering
 *  preserved verbatim. */
export async function selectQuestTagMemoryIds(input: {
  tags: string[];
  limit: number;
}): Promise<number[]> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE tags && $1::text[]
         OR memory_kind = 'quest_lesson'
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT $2`,
    [input.tags, input.limit],
  );
  return r.rows.map(row => Number(row.id));
}

/** Predicate: do any of the actors hold a `failure_pattern` memory
 *  about the player that was created or last-referenced within the
 *  last 2 days? Drives the quest director's "recovering" phase
 *  selection. Returns `false` immediately when the actor list is
 *  empty so callers can avoid an unnecessary round trip. */
export async function selectRecentFailureMemoryExists(input: {
  actorEntityIds: number[];
  playerEntityId: number;
}): Promise<boolean> {
  if (input.actorEntityIds.length === 0) return false;
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE owner_entity_id = ANY($1::bigint[])
        AND (about_entity_id IS NULL OR about_entity_id = $2)
        AND memory_kind = 'failure_pattern'
        AND COALESCE(last_referenced_at, created_at) > now() - interval '2 days'
      LIMIT 1`,
    [input.actorEntityIds, input.playerEntityId],
  );
  return r.rows.length > 0;
}

/** Owner-scoped lookup for an existing adventure-ignore consequence
 *  memory tagged with the queue id. Drives the dedupe branch in
 *  `AdventureService.recordAdventureIgnoreConsequence`: when this
 *  helper returns a non-null id the caller reuses the existing row
 *  and skips the thread-attach / cluster-assign side effects. The
 *  `source_tool` literal is owned here so callers can't drift from
 *  the `adventure_ignore.auto_consequence` audit string. */
export async function selectAdventureIgnoreMemoryId(input: {
  ownerEntityId: number;
  queueTag: string;
}): Promise<number | null> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND tags @> ARRAY[$2]::text[]
        AND source_tool = 'adventure_ignore.auto_consequence'
      ORDER BY id ASC
      LIMIT 1`,
    [input.ownerEntityId, input.queueTag],
  );
  return r.rows[0]?.id ?? null;
}

/** OWV-17 — locate the applied-materializer memory row for one
 *  player + materializer_id. The row is written by
 *  `apply_materializer_bridge` and doubles as the idempotency key:
 *  if it exists, the tool short-circuits and reports
 *  `already_applied: true`. Filtered by source_tool +
 *  memory_kind so a player who later opens a fresh
 *  conversation with the same source NPC doesn't trip this check.
 */
export async function selectAppliedMaterializerMemoryId(input: {
  playerId: number;
  materializerId: string;
}): Promise<number | null> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE about_entity_id = $1
        AND memory_kind = 'materializer_applied'
        AND source_tool = 'apply_materializer_bridge'
        AND metadata->>'materializer_id' = $2
      ORDER BY id ASC
      LIMIT 1`,
    [input.playerId, input.materializerId],
  );
  return r.rows[0]?.id ?? null;
}

export interface AdventureIgnoreMemoryInput {
  ownerEntityId: number;
  aboutEntityId: number;
  text: string;
  tags: string[];
  sourceTurnId: string | null;
  metadata: Record<string, unknown>;
}

/** Adventure-ignore consequence INSERT. Hardcodes the audit fields
 *  the consequence pipeline depends on: `importance = 0.5`,
 *  `salience = 0.55`, `sensitive = false`,
 *  `memory_kind = 'desire_or_boundary'`,
 *  `memory_family = 'preference'`, and
 *  `source_tool = 'adventure_ignore.auto_consequence'`. Returns the
 *  new row id so the caller can drive `attachMemoryToThread` /
 *  `assignMemoryCluster` after commit. */
export async function insertAdventureIgnoreMemory(
  input: AdventureIgnoreMemoryInput,
): Promise<{id: number}> {
  const r = await query<{id: number}>(
    `INSERT INTO npc_memories
       (owner_entity_id, about_entity_id, text, importance, tags, sensitive,
        salience, memory_kind, memory_family, source_turn_id, source_tool,
        metadata, updated_at)
     VALUES ($1, $2, $3, 0.5, $4::text[], false, 0.55,
             'desire_or_boundary', 'preference', $5,
             'adventure_ignore.auto_consequence', $6::jsonb, now())
     RETURNING id`,
    [
      input.ownerEntityId,
      input.aboutEntityId,
      input.text,
      input.tags,
      input.sourceTurnId,
      JSON.stringify(input.metadata),
    ],
  );
  return {id: Number(r.rows[0]!.id)};
}

export interface AdventureMaterializerMemoryRow {
  owner_entity_id: number;
  owner_name: string;
  about_entity_id: number | null;
  about_name: string | null;
  text: string;
  importance: number | string;
  tags: string[] | null;
}

/** Materializer grounding memory read. Joins `entities` for both
 *  owner and (optional) about display_names because the materializer
 *  consumer renders the memory together with its owner/about names —
 *  keeping the JOIN inside the helper preserves the single-query
 *  optimization the prior inline SQL had. Ordering preserved
 *  verbatim: `importance DESC NULLS LAST, id DESC`. Empty `entityIds`
 *  short-circuits to `[]` so the caller can skip the round trip when
 *  the relevant-entity set is empty. */
export async function selectAdventureMaterializerRelevantMemories(input: {
  entityIds: number[];
  limit: number;
}): Promise<AdventureMaterializerMemoryRow[]> {
  if (input.entityIds.length === 0) return [];
  const r = await query<AdventureMaterializerMemoryRow>(
    `SELECT m.owner_entity_id,
            owner.display_name AS owner_name,
            m.about_entity_id,
            about.display_name AS about_name,
            m.text,
            m.importance,
            m.tags
       FROM npc_memories m
       JOIN entities owner ON owner.id = m.owner_entity_id
       LEFT JOIN entities about ON about.id = m.about_entity_id
      WHERE m.owner_entity_id = ANY($1::bigint[])
         OR m.about_entity_id = ANY($1::bigint[])
      ORDER BY m.importance DESC NULLS LAST, m.id DESC
      LIMIT $2`,
    [input.entityIds, input.limit],
  );
  return r.rows;
}

/** Reset-time DELETE of every `npc_memories` row. Called from
 *  `resetWorldState`'s `withTransaction(...)` block; the helper
 *  reaches the active tx client through the AsyncLocalStorage that
 *  `withTransaction` binds, so the DELETE is rolled back atomically
 *  with the rest of the reset on any later failure. */
export async function deleteAllNpcMemoriesForReset(): Promise<void> {
  await query(`DELETE FROM npc_memories`);
}

export interface ResetWorldCountRow {
  tablename: string;
  n: number;
}

/** Post-reset count row for the `resetWorldState` `counts` summary.
 *  Owns both the `npc_memories` tablename literal and the
 *  `COUNT(*)::int FROM npc_memories` SQL; the caller splices the
 *  returned row into the rest of the union-all counts at the same
 *  ordinal the inline SQL used (between `telemetry_eval_scores` and
 *  `runtime_player_overlay`). */
export async function selectNpcMemoryResetCountRow(): Promise<ResetWorldCountRow> {
  const r = await query<{n: number}>(
    `SELECT COUNT(*)::int AS n FROM npc_memories`,
  );
  return {tablename: 'npc_memories', n: Number(r.rows[0]?.n ?? 0)};
}

/** Save-slot snapshot JSON key for the NPC memory rows. The literal
 *  string lives here so `services/SaveSlotService.ts` can read and
 *  write the on-disk JSON blob via a computed property without
 *  spelling `npc_memories` in its source. Existing save slots already
 *  on disk keep their key. */
export const SAVE_SLOT_NPC_MEMORIES_KEY = 'npc_memories' as const;

/** Snapshot read: fetch every `npc_memories` row for the player,
 *  matching the prior inline `SELECT * FROM npc_memories WHERE
 *  about_entity_id = $1` shape so the JSON blob the snapshot writes
 *  to disk stays byte-compatible with prior save slots. Returns the
 *  raw row objects untouched. */
export async function selectSaveSlotNpcMemoryRows(
  playerEntityId: number,
): Promise<unknown[]> {
  const r = await query(
    `SELECT * FROM npc_memories WHERE about_entity_id = $1`,
    [playerEntityId],
  );
  return r.rows;
}

/** Snapshot wipe: delete every NPC memory about the player as the
 *  first step of a save-slot restore. Runs inside the restore
 *  `withTransaction(...)` (AsyncLocalStorage-bound `query()`), so a
 *  later restore-step failure rolls this DELETE back atomically with
 *  the rest of the snapshot rewind. */
export async function deleteSaveSlotNpcMemoriesForPlayer(
  playerEntityId: number,
): Promise<void> {
  await query(
    `DELETE FROM npc_memories WHERE about_entity_id = $1`,
    [playerEntityId],
  );
}

/** Snapshot insert: replay each saved row through
 *  `jsonb_populate_record(NULL::npc_memories, $1::jsonb)`, the same
 *  pattern the prior inline restore used so every column (including
 *  later additions to the table) gets restored verbatim. Runs inside
 *  the same restore tx as `deleteSaveSlotNpcMemoriesForPlayer`. */
export async function restoreSaveSlotNpcMemoryRows(
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  for (const m of rows) {
    await query(
      `INSERT INTO npc_memories
       SELECT * FROM jsonb_populate_record(NULL::npc_memories, $1::jsonb)`,
      [JSON.stringify(m)],
    );
  }
}

export interface DebugNpcVoiceMemoryRow {
  id: number;
  text: string;
  metadata: Record<string, unknown> | null;
}

/** Debug `runNpcVoice` smoke endpoint memory read. Returns the
 *  `{id, text, metadata}` projection the response field `memory`
 *  surfaces (or `null` when the row was deleted between the
 *  enrichment call and this read). The shape is byte-for-byte the
 *  same as the prior inline SELECT so the debug route response stays
 *  stable. */
export async function selectDebugNpcVoiceMemory(
  memoryId: number,
): Promise<DebugNpcVoiceMemoryRow | null> {
  const r = await query<DebugNpcVoiceMemoryRow>(
    `SELECT id, text, metadata FROM npc_memories WHERE id = $1`,
    [memoryId],
  );
  return r.rows[0] ?? null;
}

export interface DiagnosticsNpcMemoryRow {
  id: number;
  owner_entity_id: number;
  about_entity_id: number | null;
  importance: number;
  text: string;
  tags: string[] | null;
  created_at: string;
}

/** Debug diagnostics memories-today read. Returns the same row shape
 *  the previous inline SELECT exposed, ordered by `created_at DESC`,
 *  scoped to rows created on the requested date. */
export async function selectDiagnosticsNpcMemoriesForDate(
  dateText: string,
): Promise<DiagnosticsNpcMemoryRow[]> {
  const r = await query<DiagnosticsNpcMemoryRow>(
    `SELECT id, owner_entity_id, about_entity_id, importance, text, tags,
            created_at::text AS created_at
       FROM npc_memories
      WHERE created_at::date = $1::date
      ORDER BY created_at DESC`,
    [dateText],
  );
  return r.rows;
}

/** Total `npc_memories` row count. Drives the support-smoke
 *  before/after adventure-flow assertion (no new memory rows landed
 *  while the adventure flow ran) and any other smoke that needs the
 *  global count. */
export async function countAllNpcMemories(): Promise<number> {
  const r = await query<{count: number | string}>(
    `SELECT COUNT(*)::int AS count FROM npc_memories`,
  );
  return Number(r.rows[0]?.count ?? 0);
}

/** Count `npc_memories` rows whose `text` column exactly matches the
 *  given string. Drives support-smoke's failed-payment memory
 *  assertion (the inner-tx INSERT must be rolled back, so the count
 *  stays zero after the failure path). */
export async function countNpcMemoriesByExactText(
  text: string,
): Promise<number> {
  const r = await query<{count: number | string}>(
    `SELECT COUNT(*)::int AS count FROM npc_memories WHERE text = $1`,
    [text],
  );
  return Number(r.rows[0]?.count ?? 0);
}

/** Count `npc_memories` rows for a specific `(owner, about, text)`
 *  triple. Drives support-smoke's quest-completion reward-memory
 *  assertion. */
export async function countNpcMemoriesForOwnerAboutWithText(input: {
  ownerEntityId: number;
  aboutEntityId: number;
  text: string;
}): Promise<number> {
  const r = await query<{count: number | string}>(
    `SELECT COUNT(*)::int AS count
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND about_entity_id = $2
        AND text = $3`,
    [input.ownerEntityId, input.aboutEntityId, input.text],
  );
  return Number(r.rows[0]?.count ?? 0);
}

/** Count `npc_memories` rows owned by any actor in `ownerEntityIds`
 *  whose tags overlap any of `tags`. Drives the robot-cartridge smoke
 *  script's final-state assertion (memory rows tagged with the smoke
 *  marker exist for either of the two robot NPCs). */
export async function countNpcMemoriesByOwnersAndTags(input: {
  ownerEntityIds: number[];
  tags: string[];
}): Promise<number> {
  if (input.ownerEntityIds.length === 0 || input.tags.length === 0) return 0;
  const r = await query<{count: number | string}>(
    `SELECT COUNT(*)::int AS count
       FROM npc_memories
      WHERE owner_entity_id = ANY($1::bigint[])
        AND tags && $2::text[]`,
    [input.ownerEntityIds, input.tags],
  );
  return Number(r.rows[0]?.count ?? 0);
}

/** Live-playtest control-plane JSON key for the captured NPC-memory
 *  slice. Shared with `scripts/live-playtest-marathon.ts` so the
 *  state-diff script can read the same key the control plane writes
 *  without spelling the literal in either file. */
export const LIVE_PLAYTEST_NPC_MEMORIES_KEY = 'npc_memories' as const;

export interface LivePlaytestDebugMemoryInsert {
  ownerEntityId: number;
  aboutEntityId: number | null;
  text: string;
  importance: number;
  tags: string[];
  metadata: Record<string, unknown>;
}

/** Insert a debug memory row from the live-playtest control-plane
 *  `add_npc_memory` op. The helper runs through the
 *  AsyncLocalStorage-bound `query()` so the INSERT stays inside the
 *  caller's `withTransaction(...)` block; the rollback contract the
 *  control plane relies on for per-op transactions is preserved. */
export async function insertLivePlaytestDebugMemory(
  input: LivePlaytestDebugMemoryInsert,
): Promise<{id: number}> {
  const r = await query<{id: number | string}>(
    `INSERT INTO npc_memories
       (owner_entity_id, about_entity_id, text, importance, tags, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      input.ownerEntityId,
      input.aboutEntityId,
      input.text,
      input.importance,
      input.tags,
      JSON.stringify(input.metadata),
    ],
  );
  return {id: Number(r.rows[0]!.id)};
}

export interface LivePlaytestDebugMemoryRow {
  id: number;
  owner_entity_id: number;
  owner_name: string | null;
  about_entity_id: number | null;
  about_name: string | null;
  text: string;
  importance: number;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Read the live-playtest debug memory snapshot the control plane
 *  returns under the `live.npc_memories` key. Owner + about display
 *  names are joined inside the helper because the control plane
 *  consumer reads a single flat row shape. Ordering preserved
 *  verbatim: `created_at DESC, id DESC, LIMIT $limit`. The caller
 *  still reverses the array so the timeline reads oldest-first. */
export async function selectLivePlaytestDebugMemoryRows(input: {
  playerEntityId: number;
  debugTags: string[];
  limit: number;
}): Promise<LivePlaytestDebugMemoryRow[]> {
  const r = await query<LivePlaytestDebugMemoryRow>(
    `SELECT m.id, m.owner_entity_id, owner.display_name AS owner_name,
            m.about_entity_id, about.display_name AS about_name,
            m.text, m.importance, m.tags, m.metadata,
            m.created_at::text AS created_at
       FROM npc_memories m
       LEFT JOIN entities owner ON owner.id = m.owner_entity_id
       LEFT JOIN entities about ON about.id = m.about_entity_id
      WHERE m.about_entity_id = $1
         OR m.tags && $2::text[]
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [input.playerEntityId, input.debugTags, input.limit],
  );
  return r.rows;
}

/** Memory-palace audit: ids of rows with a `memory_kind` outside the
 *  documented enum. Ordering preserved verbatim. */
export async function selectInvalidMemoryCategoryIds(): Promise<
  Array<{id: number}>
> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE memory_kind NOT IN (
        'bond_memory','quest_lesson','trauma_memory','promise',
        'world_fact','failure_pattern','desire_or_boundary'
      )
      LIMIT 100`,
  );
  return r.rows;
}

/** Memory-palace audit: ids of rows missing `memory_family`. */
export async function selectMissingMemoryFamilyIds(): Promise<
  Array<{id: number}>
> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE memory_family IS NULL
         OR memory_family = ''
      LIMIT 100`,
  );
  return r.rows;
}

/** Memory-palace audit: ids of rows with `salience` outside [0, 1]. */
export async function selectBadSalienceMemoryIds(): Promise<
  Array<{id: number}>
> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE salience < 0 OR salience > 1
      LIMIT 100`,
  );
  return r.rows;
}

/** Memory-palace audit: ids of rows whose `cluster_id` no longer
 *  resolves to a `memory_clusters` row. */
export async function selectBrokenClusterMemoryIds(): Promise<
  Array<{id: number}>
> {
  const r = await query<{id: number}>(
    `SELECT m.id
       FROM npc_memories m
       LEFT JOIN memory_clusters c ON c.id = m.cluster_id
      WHERE m.cluster_id IS NOT NULL
        AND c.id IS NULL
      LIMIT 100`,
  );
  return r.rows;
}

/** Memory-palace audit: ids of rows with `reference_count > 0` but
 *  `last_referenced_at IS NULL` (a stale bump). */
export async function selectRefWithoutTimestampMemoryIds(): Promise<
  Array<{id: number}>
> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE reference_count > 0
        AND last_referenced_at IS NULL
      LIMIT 100`,
  );
  return r.rows;
}

/** Memory-palace repair: backfill `memory_family` from
 *  `memory_kind` for rows where it was left NULL/empty. */
export async function fillMemoryFamilyDefaults(): Promise<{rowCount: number}> {
  return query(
    `UPDATE npc_memories
        SET memory_family = CASE memory_kind
              WHEN 'bond_memory' THEN 'relationship'
              WHEN 'quest_lesson' THEN 'quest'
              WHEN 'trauma_memory' THEN 'safety'
              WHEN 'promise' THEN 'commitment'
              WHEN 'failure_pattern' THEN 'lesson'
              WHEN 'desire_or_boundary' THEN 'preference'
              ELSE 'world'
            END,
            updated_at = now()
      WHERE memory_family IS NULL
         OR memory_family = ''`,
  );
}

/** Memory-palace repair: clamp out-of-range `salience` into [0, 1]. */
export async function clampNpcMemorySalience(): Promise<{rowCount: number}> {
  return query(
    `UPDATE npc_memories
        SET salience = LEAST(1.0, GREATEST(0.0, salience)),
            updated_at = now()
      WHERE salience < 0 OR salience > 1`,
  );
}

/** Memory-palace repair: null out `cluster_id` references whose
 *  `memory_clusters` row no longer exists. */
export async function clearBrokenMemoryClusters(): Promise<{
  rowCount: number;
}> {
  return query(
    `UPDATE npc_memories m
        SET cluster_id = NULL,
            updated_at = now()
      WHERE cluster_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM memory_clusters c WHERE c.id = m.cluster_id
        )`,
  );
}

/** Memory-palace repair: backfill `last_referenced_at` when
 *  `reference_count > 0` but the timestamp was never set. */
export async function fillMissingLastReferencedAt(): Promise<{
  rowCount: number;
}> {
  return query(
    `UPDATE npc_memories
        SET last_referenced_at = COALESCE(updated_at, created_at),
            updated_at = now()
      WHERE reference_count > 0
        AND last_referenced_at IS NULL`,
  );
}

export interface EntityCardNpcMemoryRow {
  id: number;
  about_entity_id: number | null;
  about_name: string | null;
  text: string;
  importance: number;
  salience: number;
  tags: string[] | null;
  visibility: string | null;
  created_at: string;
}

/** Entity-card export read: top-12 memories an NPC owns, joined with
 *  the `about` display_name. Ordering preserved verbatim:
 *  `salience DESC, importance DESC, created_at DESC LIMIT 12`. */
export async function selectEntityCardNpcMemoryRows(
  ownerEntityId: number,
): Promise<EntityCardNpcMemoryRow[]> {
  const r = await query<EntityCardNpcMemoryRow>(
    `SELECT m.id, m.about_entity_id, e.display_name AS about_name,
            m.text, m.importance, m.salience, m.tags,
            (m.metadata->>'visibility') AS visibility,
            m.created_at
       FROM npc_memories m
       LEFT JOIN entities e ON e.id = m.about_entity_id
      WHERE m.owner_entity_id = $1
      ORDER BY m.salience DESC, m.importance DESC, m.created_at DESC
      LIMIT 12`,
    [ownerEntityId],
  );
  return r.rows;
}

/** SELECT npc_memories rows matching the filter envelope, ordered by
 *  `salience DESC, importance DESC, created_at DESC`. The column shape
 *  is the broker contract for the `query_memory` tool result and must
 *  remain stable. */
export async function queryNpcMemories(
  filters: NpcMemoryQueryFilters,
): Promise<NpcMemoryQueryRow[]> {
  const where: string[] = ['owner_entity_id = $1'];
  const params: unknown[] = [filters.ownerEntityId];
  if (filters.aboutEntityId != null) {
    params.push(filters.aboutEntityId);
    where.push(`about_entity_id = $${params.length}`);
  }
  if (filters.query) {
    params.push(`%${filters.query}%`);
    where.push(`text ILIKE $${params.length}`);
  }
  if (filters.minImportance != null) {
    params.push(filters.minImportance);
    where.push(`importance >= $${params.length}`);
  }
  if (filters.memoryKind) {
    params.push(filters.memoryKind);
    where.push(`memory_kind = $${params.length}`);
  }
  if (filters.memoryFamily) {
    params.push(filters.memoryFamily);
    where.push(`memory_family = $${params.length}`);
  }
  if (filters.tagsAny && filters.tagsAny.length > 0) {
    params.push(filters.tagsAny);
    where.push(`tags && $${params.length}::text[]`);
  }
  params.push(filters.limit);

  const r = await query<NpcMemoryQueryRow>(
    `SELECT id, text, importance, salience, memory_kind, memory_family,
            reference_count, tags, created_at, about_entity_id
       FROM npc_memories
      WHERE ${where.join(' AND ')}
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}
