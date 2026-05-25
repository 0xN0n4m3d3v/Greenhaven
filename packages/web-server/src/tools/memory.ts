/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Memory bank tools.
//
// Embedding generation is deferred — `add_memory` writes the row with
// a NULL embedding; a separate worker (or the model's next-turn
// summary call) backfills it. This keeps per-turn latency bounded
// even when the cartridge accumulates dozens of memories per turn.
//
// query_memory falls back to plain-text search when no embedding
// is yet stored, so fresh writes are still findable.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {
  inferMemoryCategory,
  memoryFamilyForCategory,
  MEMORY_CATEGORIES,
  MEMORY_FAMILIES,
  salienceBump,
  assignMemoryCluster,
  attachMemoryToThread,
  insertNpcMemory,
  bumpNpcMemorySalience,
  queryNpcMemories,
} from '../domain/memory/index.js';
import {registerTool, resolveEntityId} from './base.js';

const EntityRef = z.union([z.string(), z.number().int().positive()]);

const AddMemoryArgs = z.object({
  /** Whose memory bank this lands in. */
  owner: EntityRef,
  /** Subject of the memory (typically a player). Null for ambient memories. */
  about: EntityRef.nullable(),
  text: z.string().min(1).max(2000),
  importance: z.number().min(0).max(1).default(0.5),
  tags: z.array(z.string()).default([]),
  sensitive: z.boolean().default(false),
  /** Memory channel:
   *   - 'public' (default) — surfaced in the owner NPC's preamble AND
   *     available to cross-NPC inference. Visible to the player-facing
   *     UI through the "memory:added" event card.
   *   - 'private' — internal monologue / private notes. Only ever shown
   *     to THIS owner NPC's own preamble. Never surfaced to other NPCs,
   *     never rendered in player chat. Use for "she suspects something",
   *     "he resents this", "I should remember not to trust her" notes. */
  visibility: z.enum(['public', 'private']).default('public'),
  kind: z.enum(MEMORY_CATEGORIES).optional(),
  source_turn_id: z.string().min(1).max(120).optional(),
  source_tool: z.string().min(1).max(80).optional(),
});

async function resolveOrPlayer(
  name: string | number,
  _playerId: number | undefined,
): Promise<number | null> {
  return resolveEntityId(name);
}

registerTool({
  name: 'add_memory',
  description:
    "Persist a long-term memory in an NPC's memory bank. importance 0.0-1.0 governs retention priority. tags are free-form strings — convention: 'entity:<id>' for cross-references, 'sensitive' on private content. Use numeric entity ids for player references.",
  paramsSchema: AddMemoryArgs,
  async execute(args, ctx) {
    const ownerId = await resolveOrPlayer(args.owner, ctx.playerId);
    if (ownerId == null) throw new Error(`unknown owner: ${args.owner}`);
    const aboutId =
      args.about === null ? null : await resolveOrPlayer(args.about, ctx.playerId);
    if (args.about !== null && aboutId == null)
      throw new Error(`unknown about: ${args.about}`);

    // Spec 34 — salience seeded from importance: high-importance
    // memories surface in the preamble's top-3 by default.
    const importance = args.importance ?? 0.5;
    const salience = importance * 0.9 + 0.1;
    const kind = inferMemoryCategory({
      explicitCategory: args.kind,
      tags: args.tags,
      text: args.text,
      sensitive: args.sensitive,
    });
    const family = memoryFamilyForCategory(kind);
    const r = await insertNpcMemory({
      ownerEntityId: ownerId,
      aboutEntityId: aboutId,
      text: args.text,
      importance,
      tags: args.tags ?? [],
      sensitive: args.sensitive ?? false,
      salience,
      memoryKind: kind,
      memoryFamily: family,
      sourceTurnId: args.source_turn_id ?? ctx.turnId ?? null,
      sourceTool: args.source_tool ?? null,
      metadata: {visibility: args.visibility ?? 'public'},
    });

    // Resolve display_names for the SSE event card.
    const names = await query<{id: number; display_name: string}>(
      `SELECT id, display_name FROM entities
        WHERE id = ANY($1::bigint[])`,
      [[ownerId, aboutId].filter((x): x is number => x != null)],
    );
    const nameById = new Map(names.rows.map(r => [r.id, r.display_name]));

    const memoryId = r.id;

    // Private memories never surface to the player-facing chat / event
    // log. They are an NPC's internal monologue and only show up in the
    // NPC's own preamble next turn. The public path keeps the existing
    // "memory:added" SSE card.
    if ((args.visibility ?? 'public') === 'public') {
      await emitGuiEvent(ctx, 'memory:added', {
        memoryId,
        ownerId,
        ownerName: nameById.get(ownerId) ?? null,
        aboutId,
        aboutName: aboutId != null ? (nameById.get(aboutId) ?? null) : null,
        text: args.text,
        importance,
        tags: args.tags,
        sensitive: args.sensitive,
        kind,
        family,
      });
    }

    await attachMemoryToThread({
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      memoryId,
    }).catch(err => {
      // CATCH-WARN-OK: per-memory thread attach is a best-effort archival side effect; the memory INSERT above has already committed and `attachMemoryToThread` surfaces its own thread-write SQL telemetry.
      console.warn(
        '[add_memory] session thread attach skipped:',
        err instanceof Error ? err.message : err,
      );
    });
    await assignMemoryCluster(memoryId).catch(err => {
      // CATCH-WARN-OK: clustering is a post-commit enrichment; the memory INSERT has already succeeded and `assignMemoryCluster` records its own clustering telemetry on the way in.
      console.warn(
        '[add_memory] cluster assignment skipped:',
        err instanceof Error ? err.message : err,
      );
    });

    return {id: memoryId, owner_id: ownerId, about_id: aboutId, kind, family};
  },
});

// Spec 34 / 137 - broker-callable salience bumper. Mark a memory as
// referenced this turn; salience is live recall heat and is not capped
// by durable importance.
const BumpSalienceArgs = z.object({
  memory_id: z.number().int().positive(),
  bump: z.number().min(0).max(0.5).default(0.1),
});

registerTool({
  name: 'bump_memory_salience',
  description:
    'Mark a memory as referenced this turn. Increases live salience so it surfaces in future preambles. Use when narrating or relying on a memory in prose.',
  paramsSchema: BumpSalienceArgs,
  async execute(args, ctx) {
    const turnRow = await query<{turn_no: number}>(
      `SELECT COALESCE(MAX(turn_index), 0) AS turn_no
         FROM chat_messages WHERE session_id = $1`,
      [ctx.sessionId],
    );
    const currentTurn = Number(turnRow.rows[0]?.turn_no ?? 0);
    return bumpNpcMemorySalience({
      memoryId: args.memory_id,
      bump: args.bump ?? 0.1,
      currentTurn,
      applyBump: salienceBump,
    });
  },
});

const QueryMemoryArgs = z.object({
  owner: EntityRef,
  /** Optional filter: only memories about this entity (e.g. the current player). */
  about: EntityRef.nullable().optional(),
  /** Free-text query — currently uses ILIKE; vector search lands in a follow-up. */
  query: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(5),
  /** Minimum importance threshold. */
  min_importance: z.number().min(0).max(1).optional(),
  kind: z.enum(MEMORY_CATEGORIES).optional(),
  family: z.enum(MEMORY_FAMILIES).optional(),
  tags_any: z.array(z.string()).max(12).optional(),
});

registerTool({
  name: 'query_memory',
  description:
    "Recall memories from a specific NPC's bank. Filter by `about` to narrow to memories of one player/entity. Returns top N by importance + recency. Use numeric entity ids for player references.",
  paramsSchema: QueryMemoryArgs,
  async execute(args, ctx) {
    const ownerId = await resolveOrPlayer(args.owner, ctx.playerId);
    if (ownerId == null) throw new Error(`unknown owner: ${args.owner}`);
    const aboutId =
      args.about == null ? null : await resolveOrPlayer(args.about, ctx.playerId);

    const memories = await queryNpcMemories({
      ownerEntityId: ownerId,
      aboutEntityId: aboutId,
      query: args.query,
      minImportance: args.min_importance,
      memoryKind: args.kind,
      memoryFamily: args.family,
      tagsAny: args.tags_any,
      limit: args.limit ?? 5,
    });
    return {memories};
  },
});

// recall_partner_history — text search across the conversation thread
// SCOPED to this NPC. Returns at most N matching chat_messages where the
// NPC was either the author or a witness at the time. Used by the
// broker to fish out something the player references ("remember when I
// told you about the varan?") without padding every preamble with the
// full thread.
const RecallPartnerHistoryArgs = z.object({
  /** The NPC doing the recalling. Defaults to the active dialogue partner if omitted. */
  partner: EntityRef.optional(),
  /** Search query. ILIKE substring + full-text matching. */
  query: z.string().min(1).max(200),
  /** Max results to return. */
  limit: z.number().int().min(1).max(12).default(5),
});

registerTool({
  name: 'recall_partner_history',
  description:
    "Search this NPC's per-NPC view of the conversation log for messages matching `query`. Returns matching player/NPC bubbles with their turn_index in time order. Use when the player references an older beat or you want to remember a specific moment from earlier in the conversation. Scope is automatic: only messages the NPC authored or witnessed are searched — they never see what was said when they were absent.",
  paramsSchema: RecallPartnerHistoryArgs,
  async execute(args, ctx) {
    // Resolve the partner — default to player's active dialogue_partner_id.
    let partnerId: number | null = null;
    if (args.partner != null) {
      partnerId = await resolveOrPlayer(args.partner, ctx.playerId);
    } else {
      const pr = await query<{dialogue_partner_id: number | null}>(
        `SELECT dialogue_partner_id FROM players WHERE entity_id = $1`,
        [ctx.playerId],
      );
      partnerId = pr.rows[0]?.dialogue_partner_id ?? null;
    }
    if (partnerId == null) {
      return {ok: false, reason: 'no_partner', matches: []};
    }
    // Combined FTS + ILIKE search; FTS catches token matches even with
    // unrelated punctuation, ILIKE catches verbatim substrings the FTS
    // tokenizer might split.
    const rows = await query<{
      id: number;
      turn_index: number;
      author_name: string | null;
      tone: string;
      text: string;
    }>(
      `SELECT cm.id, cm.turn_index,
              e.display_name AS author_name,
              cm.tone, cm.text
         FROM chat_messages cm
         LEFT JOIN entities e ON e.id = cm.author_entity_id
        WHERE cm.session_id = $1
          AND (
            cm.author_entity_id = $2
            OR $2 = ANY(cm.witness_entity_ids)
            OR (cm.witness_entity_ids IS NULL
                AND (cm.author_entity_id = $3 OR cm.tone = 'player'))
          )
          AND (
            cm.text ILIKE '%' || $4 || '%'
            OR to_tsvector('simple', cm.text)
               @@ plainto_tsquery('simple', $4)
          )
        ORDER BY cm.turn_index DESC
        LIMIT $5`,
      [ctx.sessionId, partnerId, ctx.playerId, args.query, args.limit],
    );
    return {
      ok: true,
      partner_id: partnerId,
      query: args.query,
      matches: rows.rows
        .map(r => ({
          id: r.id,
          turn_index: r.turn_index,
          speaker: r.author_name ?? (r.tone === 'player' ? 'player' : 'narrator'),
          text: r.text.slice(0, 500),
        }))
        .reverse(),
    };
  },
});
