/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {query} from '../db.js';
import {
  selectRecentMemoriesAboutPlayer,
  selectRelationshipMemories,
} from '../domain/memory/index.js';
import {registerTool, resolveEntityId} from './base.js';
import {bandFor, readStrings} from './strings.js';

type Confidence = 'low' | 'medium' | 'high';

const TargetArgs = z.object({
  target: z.string().min(1),
  player: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(6),
});

const RecentHistoryArgs = z.object({
  session_id: z.string().optional(),
  domains: z
    .array(z.enum(['tools', 'quests', 'inventory', 'memories', 'chat']))
    .default(['tools', 'quests', 'inventory', 'memories']),
  limit: z.number().int().min(1).max(30).default(12),
});

const PredictConsequenceArgs = z.object({
  tool_name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  session_id: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});

registerTool({
  name: 'summarize_relationships',
  description:
    'Read-only. Summarize the relationship between the current player and a target NPC/entity using strings, memories, recent dialogue, and recent tool events. Returns compact evidence, not raw logs.',
  paramsSchema: TargetArgs,
  async execute(args, ctx) {
    const limit = args.limit ?? 6;
    await assertRequestedPlayerMatchesContext(args.player, ctx.playerId);
    const targetId = await resolveEntityId(args.target);
    if (targetId == null) return {ok: false, error: `unknown target: ${args.target}`};
    const [target, strings, memories, dialogue, toolEvents] = await Promise.all([
      loadEntity(targetId),
      readStrings(targetId),
      loadRelationshipMemories(ctx.playerId, targetId, limit),
      loadRecentDialogue(ctx.playerId, targetId, limit),
      loadRelationshipToolEvents(ctx.playerId, args.target, limit),
    ]);
    const stringCount = Number(strings[String(ctx.playerId)] ?? 0);
    const stringBand = bandFor(stringCount);
    const evidence = [
      ...memories.map(m => ({
        type: 'memory',
        id: m.id,
        text: m.text,
        importance: m.importance,
        tags: m.tags,
      })),
      ...dialogue.map(d => ({
        type: 'dialogue',
        id: d.id,
        author: d.author_name,
        text: d.text,
        at: d.created_at,
      })),
      ...toolEvents.map(t => ({
        type: 'tool',
        id: t.id,
        tool: t.tool_name,
        args: t.args,
        at: t.invoked_at,
      })),
    ].slice(0, limit);
    const unresolved = unresolvedTensions(stringCount, memories);
    return {
      ok: true,
      target: target ?? {id: targetId, display_name: args.target},
      relationship: {
        strings: stringCount,
        string_band: stringBand,
        social_band: socialBandFor(stringCount, memories),
        confidence: confidenceFor(evidence.length, stringCount),
      },
      evidence,
      unresolved_tensions: unresolved,
    };
  },
});

registerTool({
  name: 'evaluate_social_standing',
  description:
    'Read-only. Deterministically classify the current player relationship to an NPC/entity as hostile, neutral, friendly, or intimate, citing strings and memory evidence.',
  paramsSchema: TargetArgs,
  async execute(args, ctx) {
    const limit = args.limit ?? 6;
    await assertRequestedPlayerMatchesContext(args.player, ctx.playerId);
    const targetId = await resolveEntityId(args.target);
    if (targetId == null) return {ok: false, error: `unknown target: ${args.target}`};
    const [strings, memories, recentTools] = await Promise.all([
      readStrings(targetId),
      loadRelationshipMemories(ctx.playerId, targetId, limit),
      loadRelationshipToolEvents(ctx.playerId, args.target, limit),
    ]);
    const stringCount = Number(strings[String(ctx.playerId)] ?? 0);
    const socialBand = socialBandFor(stringCount, memories);
    return {
      ok: true,
      target: args.target,
      band: socialBand,
      string_band: bandFor(stringCount),
      score: stringCount,
      confidence: confidenceFor(memories.length + recentTools.length, stringCount),
      evidence: [
        {type: 'strings', value: stringCount, band: bandFor(stringCount)},
        ...memories.slice(0, limit).map(m => ({
          type: 'memory',
          id: m.id,
          text: m.text,
          importance: m.importance,
          tags: m.tags,
        })),
        ...recentTools.slice(0, limit).map(t => ({
          type: 'tool',
          id: t.id,
          tool: t.tool_name,
          args: t.args,
        })),
      ].slice(0, limit + 1),
    };
  },
});

registerTool({
  name: 'get_recent_history',
  description:
    'Read-only. Return compact recent player/session history grouped into meaningful state-change events. Use domains to include tools, quests, inventory, memories, or chat.',
  paramsSchema: RecentHistoryArgs,
  async execute(args, ctx) {
    const limit = args.limit ?? 12;
    const domains = new Set(args.domains ?? ['tools', 'quests', 'inventory', 'memories']);
    const events: Array<Record<string, unknown>> = [];
    if (domains.has('tools')) {
      events.push(...await loadRecentToolEvents(ctx.playerId, args.session_id, limit));
    }
    if (domains.has('quests')) {
      events.push(...await loadRecentQuestEvents(ctx.playerId, limit));
    }
    if (domains.has('inventory')) {
      events.push(...await loadInventorySummary(ctx.playerId));
    }
    if (domains.has('memories')) {
      events.push(...await loadRecentMemoriesAboutPlayer(ctx.playerId, limit));
    }
    if (domains.has('chat')) {
      events.push(...await loadRecentPlayerChat(ctx.playerId, args.session_id, limit));
    }
    return {
      ok: true,
      player_id: ctx.playerId,
      session_id: args.session_id ?? null,
      domains: [...domains],
      events: sortEvents(events).slice(0, limit),
    };
  },
});

registerTool({
  name: 'predict_consequence',
  description:
    'Read-only. Inspect active quest predicates and obvious state constraints for a proposed tool call. Returns risk flags and likely progress without mutating state.',
  paramsSchema: PredictConsequenceArgs,
  async execute(args, ctx) {
    const limit = args.limit ?? 10;
    const proposedArgs = args.args ?? {};
    const [questSignals, stateRisks] = await Promise.all([
      inspectQuestPredicates(ctx.playerId, args.session_id, args.tool_name, proposedArgs, limit),
      inspectObviousStateConstraints(ctx.playerId, args.tool_name, proposedArgs),
    ]);
    const riskFlags = [...questSignals.risk_flags, ...stateRisks];
    return {
      ok: true,
      proposed: {tool_name: args.tool_name, args: proposedArgs},
      risk_flags: riskFlags.slice(0, limit),
      likely_progress: questSignals.likely_progress.slice(0, limit),
      unsupported_predicates: questSignals.unsupported_predicates.slice(0, limit),
      confidence: riskFlags.length > 0 || questSignals.likely_progress.length > 0
        ? 'medium'
        : 'low',
    };
  },
});

async function assertRequestedPlayerMatchesContext(
  player: string | undefined,
  playerId: number,
): Promise<void> {
  if (!player) return;
  const requested = await resolveEntityId(player, {playerId});
  if (requested != null && requested !== playerId) {
    throw new Error('world-sensing tools cannot inspect another player');
  }
}

async function loadEntity(id: number): Promise<Record<string, unknown> | null> {
  const r = await query<Record<string, unknown>>(
    `SELECT id, kind, display_name, summary, tags FROM entities WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function loadRelationshipMemories(
  playerId: number,
  targetId: number,
  limit: number,
): Promise<Array<{id: number; text: string; importance: number; tags: string[]; created_at: string}>> {
  return selectRelationshipMemories({
    playerEntityId: playerId,
    targetEntityId: targetId,
    limit,
  });
}

async function loadRecentDialogue(
  playerId: number,
  targetId: number,
  limit: number,
): Promise<Array<{id: number; author_name: string | null; text: string; created_at: string}>> {
  const r = await query<{id: number; author_name: string | null; text: string; created_at: string}>(
    `SELECT cm.id, e.display_name AS author_name, cm.text, cm.created_at
       FROM chat_messages cm
       LEFT JOIN entities e ON e.id = cm.author_entity_id
      WHERE cm.player_id = $1
        AND (cm.author_entity_id = $2 OR cm.npc_entity_id = $2)
      ORDER BY cm.id DESC
      LIMIT $3`,
    [playerId, targetId, limit],
  );
  return r.rows.reverse();
}

async function loadRelationshipToolEvents(
  playerId: number,
  targetName: string,
  limit: number,
): Promise<Array<{id: number; tool_name: string; args: unknown; invoked_at: string}>> {
  const r = await query<{id: number; tool_name: string; args: unknown; invoked_at: string}>(
    `SELECT id, tool_name, args, invoked_at
       FROM tool_invocations
      WHERE player_id = $1
        AND args::text ILIKE $2
        AND tool_name NOT IN ('summarize_relationships','evaluate_social_standing','get_recent_history','predict_consequence')
      ORDER BY id DESC
      LIMIT $3`,
    [playerId, `%${targetName}%`, limit],
  );
  return r.rows.reverse();
}

async function loadRecentToolEvents(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [playerId];
  let where = `player_id = $1`;
  if (sessionId) {
    params.push(sessionId);
    where = `(player_id = $1 OR session_id = $2)`;
  }
  params.push(limit);
  const r = await query<Record<string, unknown>>(
    `SELECT 'tool' AS domain, id, session_id, turn_id, tool_name,
            args, result, error, invoked_at AS at
       FROM tool_invocations
      WHERE ${where}
        AND tool_name NOT IN ('summarize_relationships','evaluate_social_standing','get_recent_history','predict_consequence')
      ORDER BY id DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

async function loadRecentQuestEvents(
  playerId: number,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const r = await query<Record<string, unknown>>(
    `SELECT 'quest' AS domain, pq.quest_entity_id, e.display_name AS quest,
            pq.status, pq.current_stage_id, pq.started_at, pq.completed_at,
            pq.metadata, COALESCE(pq.completed_at, pq.started_at, now()) AS at
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
      ORDER BY COALESCE(pq.completed_at, pq.started_at, now()) DESC
      LIMIT $2`,
    [playerId, limit],
  );
  return r.rows;
}

async function loadInventorySummary(playerId: number): Promise<Array<Record<string, unknown>>> {
  const playerInv = await query<Record<string, unknown>>(
    `SELECT 'inventory' AS domain, i.slug, i.category, pi.quantity,
            pi.equipped, pi.acquired_at AS at
       FROM player_inventory pi
       JOIN items i ON i.id = pi.item_id
      WHERE pi.player_id = $1
      ORDER BY i.category, i.slug`,
    [playerId],
  );
  const legacy = await query<Record<string, unknown>>(
    `SELECT 'inventory' AS domain, item.display_name AS item, ie.count,
            'legacy_inventory_entries' AS source, now() AS at
       FROM inventory_entries ie
       JOIN entities item ON item.id = ie.item_entity_id
      WHERE ie.holder_entity_id = $1
      ORDER BY item.display_name`,
    [playerId],
  );
  return [...playerInv.rows, ...legacy.rows];
}

async function loadRecentMemoriesAboutPlayer(
  playerId: number,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const rows = await selectRecentMemoriesAboutPlayer({
    playerEntityId: playerId,
    limit,
  });
  return rows.map(row => ({domain: 'memory', ...row}));
}

async function loadRecentPlayerChat(
  playerId: number,
  sessionId: string | undefined,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [playerId];
  let where = `cm.player_id = $1`;
  if (sessionId) {
    params.push(sessionId);
    where = `(cm.player_id = $1 OR cm.session_id = $2)`;
  }
  params.push(limit);
  const r = await query<Record<string, unknown>>(
    `SELECT 'chat' AS domain, cm.id, cm.session_id, e.display_name AS author,
            cm.tone, cm.text, cm.created_at AS at
       FROM chat_messages cm
       LEFT JOIN entities e ON e.id = cm.author_entity_id
      WHERE ${where}
      ORDER BY cm.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

function sortEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.sort((a, b) => String(b['at'] ?? '').localeCompare(String(a['at'] ?? '')));
}

async function inspectQuestPredicates(
  playerId: number,
  sessionId: string | undefined,
  proposedTool: string,
  proposedArgs: Record<string, unknown>,
  limit: number,
): Promise<{
  risk_flags: Array<Record<string, unknown>>;
  likely_progress: Array<Record<string, unknown>>;
  unsupported_predicates: Array<Record<string, unknown>>;
}> {
  const r = await query<{
    quest_entity_id: number;
    quest_title: string;
    current_stage_id: string | null;
    profile: Record<string, unknown>;
  }>(
    `SELECT pq.quest_entity_id, e.display_name AS quest_title,
            pq.current_stage_id, e.profile
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1 AND pq.status = 'active'
      ORDER BY pq.started_at DESC
      LIMIT $2`,
    [playerId, limit],
  );
  const risk_flags: Array<Record<string, unknown>> = [];
  const likely_progress: Array<Record<string, unknown>> = [];
  const unsupported_predicates: Array<Record<string, unknown>> = [];
  for (const quest of r.rows) {
    const profile = quest.profile ?? {};
    const failure = Array.isArray(profile['failure_conditions'])
      ? (profile['failure_conditions'] as Array<Record<string, unknown>>)
      : [];
    for (const predicate of failure) {
      const match = predicateMatchesTool(predicate, proposedTool, proposedArgs);
      if (match === true) {
        risk_flags.push({
          type: 'quest_failure_condition',
          quest_id: quest.quest_entity_id,
          quest: quest.quest_title,
          predicate,
        });
      } else if (match === null) {
        unsupported_predicates.push({
          quest_id: quest.quest_entity_id,
          quest: quest.quest_title,
          predicate,
        });
      }
    }
    const stage = currentStage(profile, quest.current_stage_id);
    const objectives = stage && Array.isArray(stage['objectives'])
      ? (stage['objectives'] as Array<Record<string, unknown>>)
      : [];
    for (const objective of objectives) {
      const match = predicateMatchesTool(objective, proposedTool, proposedArgs);
      if (match === true) {
        likely_progress.push({
          type: 'quest_objective_progress',
          quest_id: quest.quest_entity_id,
          quest: quest.quest_title,
          stage: quest.current_stage_id,
          objective,
        });
      } else if (match === null) {
        unsupported_predicates.push({
          quest_id: quest.quest_entity_id,
          quest: quest.quest_title,
          predicate: objective,
        });
      }
    }
  }
  void sessionId;
  return {risk_flags, likely_progress, unsupported_predicates};
}

function currentStage(
  profile: Record<string, unknown>,
  stageId: string | null,
): Record<string, unknown> | null {
  const stages = Array.isArray(profile['stages'])
    ? (profile['stages'] as Array<Record<string, unknown>>)
    : [];
  return stages.find(s => s['id'] === stageId) ?? stages[0] ?? null;
}

function predicateMatchesTool(
  predicate: Record<string, unknown>,
  toolName: string,
  args: Record<string, unknown>,
): boolean | null {
  if (predicate['kind'] !== 'tool_called') {
    return isSupportedPredictablePredicate(predicate) ? false : null;
  }
  if (predicate['tool'] !== toolName) return false;
  const pattern = isRecord(predicate['args_match'])
    ? predicate['args_match'] as Record<string, unknown>
    : {};
  return matchArgs(args, pattern);
}

function isSupportedPredictablePredicate(predicate: Record<string, unknown>): boolean {
  const kind = predicate['kind'];
  return kind === 'tool_called';
}

function matchArgs(args: Record<string, unknown>, pattern: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(pattern)) {
    if (key.endsWith('_min')) {
      const realKey = key.slice(0, -'_min'.length);
      if (Number(args[realKey] ?? 0) < Number(expected)) return false;
    } else if (args[key] !== expected) {
      return false;
    }
  }
  return true;
}

async function inspectObviousStateConstraints(
  playerId: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  if (toolName === 'move_player') {
    return inspectMoveRisk(playerId, args);
  }
  if (toolName === 'inventory_transfer') {
    return inspectInventoryRisk(playerId, args);
  }
  return [];
}

async function inspectMoveRisk(
  playerId: number,
  args: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const targetId = Number(args['target_location_id']);
  if (!Number.isInteger(targetId)) return [];
  const r = await query<{current_location_id: number | null; exits: unknown}>(
    `SELECT p.current_location_id, e.profile->'exits' AS exits
       FROM players p
       LEFT JOIN entities e ON e.id = p.current_location_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  const exits = readExitIdArray(r.rows[0]?.exits);
  if (r.rows[0]?.current_location_id === targetId || exits.includes(targetId)) return [];
  return [{
    type: 'movement_not_declared_exit',
    severity: 'medium',
    detail: `target_location_id ${targetId} is not in current location exits`,
  }];
}

async function inspectInventoryRisk(
  playerId: number,
  args: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const fromPlayerId = Number(args['from_player_id']);
  const from = String(args['from'] ?? '');
  const item = String(args['item'] ?? '');
  const count = Number(args['count'] ?? args['qty'] ?? 1);
  if (!item || !Number.isFinite(count)) return [];
  const fromId = Number.isInteger(fromPlayerId)
    ? fromPlayerId
    : from
    ? await resolveEntityId(from, {playerId})
    : null;
  if (fromId !== playerId) return [];
  const r = await query<{count: number}>(
    `SELECT COALESCE(SUM(count), 0)::int AS count
       FROM inventory_entries ie
       JOIN entities item ON item.id = ie.item_entity_id
      WHERE ie.holder_entity_id = $1
        AND item.display_name = $2`,
    [playerId, item],
  );
  const have = Number(r.rows[0]?.count ?? 0);
  if (have >= count) return [];
  return [{
    type: 'insufficient_inventory',
    severity: 'high',
    detail: `player has ${have} ${item}, proposed transfer needs ${count}`,
  }];
}

function socialBandFor(
  strings: number,
  memories: Array<{tags: string[]; importance: number}>,
): 'hostile' | 'neutral' | 'friendly' | 'intimate' {
  const intimateMemory = memories.some(m =>
    // LANGUAGE-REGEX-OK: cartridge-authored tag allowlist match (`intimate`/`romance`/`bond`) — runs over the structured `memories[].tags[]` array (canonical tag strings produced by the memory tools), not natural-language prose. The tag namespace is wire-format and authored in English by design.
    m.tags.some(tag => /intimate|romance|bond/i.test(tag)) && m.importance >= 0.6,
  );
  if (strings <= -2) return 'hostile';
  if (strings >= 6 || intimateMemory) return 'intimate';
  if (strings >= 2) return 'friendly';
  return 'neutral';
}

function confidenceFor(evidenceCount: number, stringCount: number): Confidence {
  if (evidenceCount >= 3 || Math.abs(stringCount) >= 3) return 'high';
  if (evidenceCount > 0 || stringCount !== 0) return 'medium';
  return 'low';
}

function unresolvedTensions(
  stringCount: number,
  memories: Array<{text: string; tags: string[]}>,
): string[] {
  const out: string[] = [];
  if (stringCount < 0) out.push('negative strings indicate unresolved friction');
  for (const memory of memories) {
    // LANGUAGE-REGEX-OK: cartridge-authored tag allowlist (`betray`/`debt`/`pending`/`leverage`) — same structured-tag namespace as `socialBandFor` above; matches canonical tag strings produced by the memory tools, not natural-language player text.
    if (memory.tags.some(tag => /betray|debt|pending|leverage/i.test(tag))) {
      out.push(memory.text.slice(0, 180));
    }
  }
  return out.slice(0, 4);
}

function readExitIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readExitId)
    .filter(item => Number.isInteger(item) && item > 0);
}

function readExitId(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Number((value as Record<string, unknown>)['id']);
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
