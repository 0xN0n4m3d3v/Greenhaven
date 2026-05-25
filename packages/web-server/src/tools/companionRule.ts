/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// GMV2-RUNTIME-5 — authored companion-rule application.
//
// This is the narrow bridge between human-authored `Companion Rules` and the
// existing companion/hero-continuity runtime. The model points at a concrete
// imported rule; the backend decides whether that rule means follow or depart,
// updates the companion roster through `set_companion`, writes a continuity
// bond, and records an idempotency memory.

import {createHash} from 'node:crypto';
import {z} from 'zod';
import {query, withTransaction} from '../db.js';
import {MemoryService} from '../domain/memory/index.js';
import {
  HeroContinuityLedgerService,
  type CompanionBondStatus,
  type PortabilityState,
} from '../services/HeroContinuityLedgerService.js';
import {executeTool, registerTool, resolveEntityId, ToolExecutionError} from './base.js';

interface CompanionRule {
  kind?: unknown;
  label?: unknown;
  text?: unknown;
  mentions?: unknown;
  source?: unknown;
}

interface CompanionRuleContract {
  schema_version?: unknown;
  can_be_companion?: unknown;
  portability?: unknown;
  rules?: unknown;
}

const ApplyCompanionRuleArgs = z.object({
  npc: z.string().min(1).describe('NPC display name or entity id.'),
  rule_number: z
    .number()
    .int()
    .min(1)
    .describe('1-based index in profile.companion_rule_contract.rules.'),
  evidence: z
    .string()
    .min(5)
    .max(500)
    .describe('Short backend-confirmed reason/event that satisfied the rule.'),
});

registerTool({
  name: 'apply_companion_rule_contract',
  description:
    'Apply one authored NPC Companion Rules contract row. Use when profile.companion_rule_contract exists and a concrete rule has been satisfied. Join rules call set_companion(follow), refusal/depart rules call set_companion(stop_following), and the tool writes hero_companion_bonds plus an idempotent NPC memory.',
  paramsSchema: ApplyCompanionRuleArgs,
  async execute(args, ctx) {
    const npcId = await resolveEntityId(args.npc);
    if (npcId == null) {
      throw new ToolExecutionError(`unknown NPC: ${args.npc}`, {rejected: true});
    }

    const npc = await loadNpcWithCompanionContract(npcId);
    if (!npc) {
      throw new ToolExecutionError(`entity ${npcId} not found`, {rejected: true});
    }
    if (npc.kind !== 'person') {
      throw new ToolExecutionError(
        `apply_companion_rule_contract target must be kind='person'; got kind='${npc.kind}'`,
        {rejected: true},
      );
    }

    const contract = readCompanionRuleContract(npc.profile);
    const rules = readCompanionRules(contract);
    const rule = rules[args.rule_number - 1];
    if (!rule) {
      throw new ToolExecutionError(
        `companion rule ${args.rule_number} not found for ${npc.display_name}`,
        {rejected: true, suggestion: {available_rules: rules.length}},
      );
    }

    const action = companionActionForRule(rule);
    if (!action) {
      throw new ToolExecutionError(
        `companion rule kind ${String(rule.kind)} is guidance-only, not a roster mutation`,
        {rejected: true, suggestion: {rule_number: args.rule_number}},
      );
    }
    const text = String(rule.text ?? '').trim();
    if (!text) {
      throw new ToolExecutionError(
        `companion rule ${args.rule_number} has no text`,
        {rejected: true},
      );
    }

    const ruleKey = companionRuleKey(npcId, args.rule_number, rule);
    const result = await withTransaction(async () => {
      const alreadyApplied = await selectAppliedCompanionRuleMemory(
        npcId,
        ctx.playerId,
        ruleKey,
      );
      if (alreadyApplied != null) {
        return {
          ok: true,
          already_applied: true,
          npc: npc.display_name,
          npcId,
          rule_number: args.rule_number,
          rule_key: ruleKey,
          action,
          memory_id: alreadyApplied,
        } as const;
      }

      const setResult = await executeTool(
        'set_companion',
        {
          npc: String(npcId),
          action,
          reason: args.evidence,
        },
        ctx,
      );
      if (!setResult.ok) {
        throw new ToolExecutionError(
          setResult.error ?? 'set_companion failed',
          {rejected: setResult.rejected ?? true, suggestion: setResult.suggestion},
        );
      }

      const bond = await HeroContinuityLedgerService.upsertCompanionBond({
        playerId: ctx.playerId,
        companionKey: companionKeyForNpc(npcId, npc.profile),
        sourceEntityId: npcId,
        sourceCartridgeId: npc.cartridge_id,
        status: companionStatusForAction(action, rule),
        portability: companionPortabilityForContract(contract, action),
        publicSummary: text,
        privateSummary: args.evidence,
        bondPayload: {
          source: 'apply_companion_rule_contract',
          rule_key: ruleKey,
          rule_number: args.rule_number,
          rule_kind: rule.kind ?? null,
          rule_label: rule.label ?? null,
          rule_text: text,
          evidence: args.evidence,
          mentions: Array.isArray(rule.mentions) ? rule.mentions : [],
        },
      });

      const memory = await MemoryService.insertNpcMemory({
        ownerEntityId: npcId,
        aboutEntityId: ctx.playerId,
        text: `Companion rule applied: ${text}`,
        importance: 0.65,
        tags: [
          'companion',
          'authored-rule',
          action === 'follow' ? 'companion-joined' : 'companion-left',
          `rule:${ruleKey}`,
        ],
        sensitive: false,
        salience: 0.7,
        memoryKind: 'companion_rule_applied',
        memoryFamily: 'relationship',
        sourceTurnId: ctx.turnId ?? null,
        sourceTool: 'apply_companion_rule_contract',
        metadata: {
          rule_key: ruleKey,
          rule_number: args.rule_number,
          action,
          evidence: args.evidence,
          bond_id: bond.id,
          status: bond.status,
          portability: bond.portability,
        },
      });

      return {
        ok: true,
        already_applied: false,
        npc: npc.display_name,
        npcId,
        rule_number: args.rule_number,
        rule_key: ruleKey,
        action,
        bond_id: bond.id,
        bond_status: bond.status,
        portability: bond.portability,
        memory_id: memory.id,
      } as const;
    });

    return result;
  },
});

async function loadNpcWithCompanionContract(npcId: number): Promise<{
  kind: string;
  display_name: string;
  cartridge_id: string | null;
  profile: unknown;
} | null> {
  const r = await query<{
    kind: string;
    display_name: string;
    cartridge_id: string | null;
    profile: unknown;
  }>(
    `SELECT kind, display_name, cartridge_id, profile
       FROM entities
      WHERE id = $1`,
    [npcId],
  );
  return r.rows[0] ?? null;
}

function readCompanionRuleContract(profile: unknown): CompanionRuleContract | null {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return null;
  }
  const raw = (profile as Record<string, unknown>)['companion_rule_contract'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as CompanionRuleContract;
}

function readCompanionRules(contract: CompanionRuleContract | null): CompanionRule[] {
  if (!contract || !Array.isArray(contract.rules)) return [];
  return contract.rules.filter(
    (item): item is CompanionRule =>
      item != null && typeof item === 'object' && !Array.isArray(item),
  );
}

function companionActionForRule(
  rule: CompanionRule,
): 'follow' | 'stop_following' | null {
  switch (rule.kind) {
    case 'join_condition':
      return 'follow';
    case 'refusal_condition':
    case 'depart_condition':
      return 'stop_following';
    default:
      return null;
  }
}

function companionStatusForAction(
  action: 'follow' | 'stop_following',
  rule: CompanionRule,
): CompanionBondStatus {
  if (action === 'follow') return 'bonded';
  return rule.kind === 'refusal_condition' ? 'suppressed' : 'departed';
}

function companionPortabilityForContract(
  contract: CompanionRuleContract | null,
  action: 'follow' | 'stop_following',
): PortabilityState {
  if (action !== 'follow') return 'local_locked';
  return contract?.portability === 'conditional_portable'
    ? 'portable'
    : 'local_locked';
}

function companionKeyForNpc(npcId: number, profile: unknown): string {
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    const sourceSlug = (profile as Record<string, unknown>)['source_slug'];
    if (typeof sourceSlug === 'string' && sourceSlug.trim()) {
      return `entity:${sourceSlug.trim()}`;
    }
  }
  return `entity:${npcId}`;
}

function companionRuleKey(
  npcId: number,
  ruleNumber: number,
  rule: CompanionRule,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        npcId,
        ruleNumber,
        kind: rule.kind ?? null,
        text: rule.text ?? null,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return `${npcId}:${ruleNumber}:${digest}`;
}

async function selectAppliedCompanionRuleMemory(
  npcId: number,
  playerId: number,
  ruleKey: string,
): Promise<number | null> {
  const r = await query<{id: number}>(
    `SELECT id
       FROM npc_memories
      WHERE owner_entity_id = $1
        AND about_entity_id = $2
        AND source_tool = 'apply_companion_rule_contract'
        AND metadata->>'rule_key' = $3
      ORDER BY id ASC
      LIMIT 1`,
    [npcId, playerId, ruleKey],
  );
  return r.rows[0]?.id ?? null;
}
