/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// GMV2-RUNTIME-4 — authored NPC relationship trigger application.
//
// `relationship_trigger_rules` comes from the Obsidian bridge beside the
// writer-facing `Relationship Triggers` prose. This tool applies exactly one
// authored rule for the active player. It is intentionally narrower than
// `string_award`: the caller must point at a concrete NPC + 1-based rule number
// and provide evidence for the backend-confirmed event that fired it.

import {createHash} from 'node:crypto';
import {z} from 'zod';
import {query, withTransaction} from '../db.js';
import {MemoryService} from '../domain/memory/index.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {emitFieldChange} from '../runtimeFieldEvents.js';
import {
  stringEdgeId,
  stringIntensityForCount,
  stringKindForCount,
  stringValenceForCount,
} from '../stringsContract.js';
import {registerTool, resolveEntityId, ToolExecutionError} from './base.js';
import {addString, bandFor, readStrings} from './strings.js';
import {applyMaterializersForTrigger} from './materializer.js';

interface RelationshipTriggerRule {
  kind?: unknown;
  delta?: unknown;
  condition?: unknown;
  mentions?: unknown;
  source?: unknown;
}

const ApplyRelationshipTriggerArgs = z.object({
  npc: z
    .string()
    .min(1)
    .describe('NPC display name or entity id whose authored trigger fired.'),
  rule_number: z
    .number()
    .int()
    .min(1)
    .describe('1-based index in profile.relationship_trigger_rules.'),
  evidence: z
    .string()
    .min(5)
    .max(500)
    .describe('Short backend-confirmed reason/event that matched the rule.'),
});

registerTool({
  name: 'apply_relationship_trigger_rule',
  description:
    'Apply one authored NPC Relationship Trigger rule. Use this instead of freeform string_award when an imported NPC profile exposes relationship_trigger_rules. Requires exact 1-based rule_number and evidence. Idempotent per player/NPC/rule so the same authored trigger cannot be farmed repeatedly.',
  paramsSchema: ApplyRelationshipTriggerArgs,
  async execute(args, ctx) {
    const npcId = await resolveEntityId(args.npc);
    if (npcId == null) {
      throw new ToolExecutionError(`unknown NPC: ${args.npc}`, {rejected: true});
    }

    const row = await loadNpcWithRules(npcId);
    if (!row) {
      throw new ToolExecutionError(`entity ${npcId} not found`, {rejected: true});
    }
    if (row.kind !== 'person') {
      throw new ToolExecutionError(
        `apply_relationship_trigger_rule target must be kind='person'; got kind='${row.kind}'`,
        {rejected: true},
      );
    }

    const rules = readRelationshipRules(row.profile);
    const rule = rules[args.rule_number - 1];
    if (!rule) {
      throw new ToolExecutionError(
        `relationship trigger rule ${args.rule_number} not found for ${row.display_name}`,
        {rejected: true, suggestion: {available_rules: rules.length}},
      );
    }
    if (rule.kind !== 'strings_delta') {
      throw new ToolExecutionError(
        `unsupported relationship trigger rule kind: ${String(rule.kind)}`,
        {rejected: true, suggestion: {rule_number: args.rule_number}},
      );
    }
    const delta = Number(rule.delta);
    if (!Number.isInteger(delta) || delta < -3 || delta > 3 || delta === 0) {
      throw new ToolExecutionError(
        `invalid relationship trigger delta: ${String(rule.delta)}`,
        {rejected: true, suggestion: {rule_number: args.rule_number}},
      );
    }
    const condition = String(rule.condition ?? '').trim();
    if (!condition) {
      throw new ToolExecutionError(
        `relationship trigger rule ${args.rule_number} has no condition`,
        {rejected: true},
      );
    }

    const ruleKey = relationshipRuleKey(npcId, args.rule_number, rule);
    const result = await withTransaction(async () => {
      const alreadyApplied = await selectAppliedRelationshipMemory(
        npcId,
        ctx.playerId,
        ruleKey,
      );
      if (alreadyApplied != null) {
        const current = await readStrings(npcId);
        return {
          ok: true,
          already_applied: true,
          npc: row.display_name,
          npcId,
          rule_number: args.rule_number,
          rule_key: ruleKey,
          delta,
          condition,
          remaining: Number(current[String(ctx.playerId)] ?? 0),
          memory_id: alreadyApplied,
        } as const;
      }

      const remaining = await addString(npcId, ctx.playerId, delta);
      const memory = await MemoryService.insertNpcMemory({
        ownerEntityId: npcId,
        aboutEntityId: ctx.playerId,
        text: `Relationship trigger applied: ${condition}`,
        importance: 0.55,
        tags: [
          'relationship',
          'strings',
          'authored-trigger',
          `rule:${ruleKey}`,
        ],
        sensitive: false,
        salience: 0.6,
        memoryKind: 'relationship_trigger_applied',
        memoryFamily: 'relationship',
        sourceTurnId: ctx.turnId ?? null,
        sourceTool: 'apply_relationship_trigger_rule',
        metadata: {
          rule_key: ruleKey,
          rule_number: args.rule_number,
          delta,
          condition,
          evidence: args.evidence,
          mentions: Array.isArray(rule.mentions) ? rule.mentions : [],
          source: rule.source ?? 'npc_relationship_triggers',
        },
      });
      return {
        ok: true,
        already_applied: false,
        npc: row.display_name,
        npcId,
        rule_number: args.rule_number,
        rule_key: ruleKey,
        delta,
        condition,
        remaining,
        memory_id: memory.id,
      } as const;
    });

    if (!result.already_applied) {
      const strings = await readStrings(npcId);
      emitFieldChange(ctx.sessionId, {
        owner_entity_id: npcId,
        field_key: 'strings',
        value: strings,
        source: 'apply_relationship_trigger_rule',
      });
      await emitGuiEvent(ctx, 'string:changed', {
        stringId: stringEdgeId(ctx.playerId, npcId),
        from: ctx.playerId,
        to: npcId,
        kind: stringKindForCount(result.remaining),
        intensity: stringIntensityForCount(result.remaining),
        valence: stringValenceForCount(result.remaining),
        turnId: ctx.turnId ?? null,
        npcId,
        npcName: row.display_name,
        delta,
        newValue: result.remaining,
        band: bandFor(result.remaining),
        reason: args.evidence,
        summary: condition,
        source: 'authored_relationship_trigger',
          ruleNumber: args.rule_number,
        });
      const sourceSlug = sourceSlugFromProfile(row.profile);
      if (sourceSlug) {
        await applyMaterializersForTrigger(ctx, 'relationship', {sourceSlug});
      }
    }

    return result;
  },
});

async function loadNpcWithRules(npcId: number): Promise<{
  kind: string;
  display_name: string;
  profile: unknown;
} | null> {
  const r = await query<{kind: string; display_name: string; profile: unknown}>(
    `SELECT kind, display_name, profile FROM entities WHERE id = $1`,
    [npcId],
  );
  return r.rows[0] ?? null;
}

function readRelationshipRules(profile: unknown): RelationshipTriggerRule[] {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return [];
  }
  const raw = (profile as Record<string, unknown>)['relationship_trigger_rules'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is RelationshipTriggerRule =>
      item != null && typeof item === 'object' && !Array.isArray(item),
  );
}

function sourceSlugFromProfile(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return null;
  }
  const value = (profile as Record<string, unknown>)['source_slug'];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function relationshipRuleKey(
  npcId: number,
  ruleNumber: number,
  rule: RelationshipTriggerRule,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        npcId,
        ruleNumber,
        kind: rule.kind ?? null,
        delta: rule.delta ?? null,
        condition: rule.condition ?? null,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return `${npcId}:${ruleNumber}:${digest}`;
}

async function selectAppliedRelationshipMemory(
  npcId: number,
  playerId: number,
  ruleKey: string,
): Promise<number | null> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND about_entity_id = $2
        AND source_tool = 'apply_relationship_trigger_rule'
        AND metadata->>'rule_key' = $3
      ORDER BY id ASC
      LIMIT 1`,
    [npcId, playerId, ruleKey],
  );
  return r.rows[0]?.id ?? null;
}
