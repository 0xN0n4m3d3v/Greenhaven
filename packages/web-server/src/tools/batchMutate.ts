/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {withTransaction} from '../db.js';
import {executeTool, registerTool, type ToolContext, type ToolResult} from './base.js';
import {
  resolveBatchConflicts,
  type BatchOperationPlan,
  type ConflictIssue,
} from './conflictResolver.js';

const ALLOWED_BATCH_TOOLS = new Set([
  'set_runtime_field',
  'apply_runtime_field_patch',
  'inventory_transfer',
  'use_item',
  'equip_item',
  'give_to_npc',
  'award_xp',
  'change_stat',
  'unlock_skill',
  'award_progression_xp',
  'award_title',
  'equip_title',
  'spend_stat_point',
  'spend_skill_point',
  'award_inspiration',
  'spend_inspiration',
  'add_memory',
  'bump_memory_salience',
  'string_award',
  'string_spend',
  'apply_relationship_trigger_rule',
  'open_authored_scene',
  'choose_authored_scene_option',
  'close_authored_scene',
  'create_entity',
  'update_entity',
  'create_quest',
  'start_quest',
  'advance_quest',
  'complete_quest',
  'move_player',
  'damage',
  'heal',
  'mark_downed',
  'death_save',
  'stabilize',
  'apply_surface',
  'apply_intimacy_trigger',
  'apply_companion_rule_contract',
  'set_companion',
  'switch_dialogue_partner',
]);

const BatchOperationArgs = z.object({
  id: z.string().min(1).max(80).optional(),
  tool: z.string().min(1).max(120),
  args: z.record(z.unknown()).default({}),
  depends_on: z.array(z.string().min(1).max(80)).max(16).optional(),
});

const BatchMutateArgs = z.object({
  operations: z.array(BatchOperationArgs).min(1).max(12),
  atomic: z.boolean().default(true),
  reason: z.string().min(3).max(300),
});

interface BatchMutateInput {
  reason: string;
  atomic?: boolean;
  operations: Array<{
    id?: string;
    tool: string;
    args?: Record<string, unknown>;
    depends_on?: string[];
  }>;
}

interface ChildResult {
  id: string;
  tool: string;
  ok: boolean;
  data?: unknown;
}

registerTool({
  name: 'batch_mutate_world',
  description:
    'Atomically execute a small allow-listed batch of world mutation tools. Each child still uses the normal schema, pre-tool validators, execution, and audit path. narrate/read tools/recursive batch calls are denied; call narrate separately after the batch.',
  paramsSchema: BatchMutateArgs,
  async execute(args, ctx) {
    if (!args.atomic) {
      throw new Error('batch_mutate_world currently supports atomic=true only');
    }

    const operations = prepareOperations(args);
    const structuralIssues = validateOperationStructure(operations);
    if (structuralIssues.length > 0) {
      throw new Error(formatIssues('batch_structure_rejected', structuralIssues));
    }

    const conflictVerdict = resolveBatchConflicts(operations);
    if (!conflictVerdict.ok) {
      throw new Error(formatIssues('batch_conflict_rejected', conflictVerdict.issues));
    }

    const childResults = await withTransaction(async () => {
      const results: ChildResult[] = [];
      for (const op of operations) {
        const result = await executeTool(op.tool, op.args, childContext(ctx, op.id));
        if (!result.ok) {
          throw new Error(formatChildFailure(op, result));
        }
        results.push({
          id: op.id,
          tool: op.tool,
          ok: true,
          data: result.data,
        });
      }
      return results;
    });

    return {
      atomic: true,
      reason: args.reason,
      operation_count: childResults.length,
      conflict_verdict: conflictVerdict,
      operations: childResults,
    };
  },
});

function prepareOperations(args: BatchMutateInput): BatchOperationPlan[] {
  return args.operations.map((op, index) => ({
    id: op.id?.trim() || `op${index + 1}`,
    tool: op.tool.trim(),
    args: op.args ?? {},
    depends_on: op.depends_on?.map(dep => dep.trim()).filter(Boolean),
  }));
}

function validateOperationStructure(
  operations: BatchOperationPlan[],
): ConflictIssue[] {
  const issues: ConflictIssue[] = [];
  const seen = new Set<string>();

  for (const op of operations) {
    if (seen.has(op.id)) {
      issues.push({
        code: 'duplicate_operation_id',
        operation_id: op.id,
        message: `operation id ${op.id} is duplicated`,
      });
    }

    if (op.tool === 'batch_mutate_world') {
      issues.push({
        code: 'recursive_batch_denied',
        operation_id: op.id,
        message: 'batch_mutate_world cannot call itself',
      });
    } else if (!ALLOWED_BATCH_TOOLS.has(op.tool)) {
      issues.push({
        code: 'tool_not_allowlisted',
        operation_id: op.id,
        message: `tool ${op.tool} is not allowed in batch_mutate_world`,
      });
    }

    for (const dep of op.depends_on ?? []) {
      if (!seen.has(dep)) {
        issues.push({
          code: 'invalid_dependency_order',
          operation_id: op.id,
          message: `depends_on ${dep} must refer to an earlier operation id`,
        });
      }
    }

    seen.add(op.id);
  }

  return issues;
}

function childContext(ctx: ToolContext, operationId: string): ToolContext {
  return {
    ...ctx,
    turnId: ctx.turnId ? `${ctx.turnId}:${operationId}` : operationId,
    toolHistorySource: 'batch_child',
    batchId: ctx.batchId ?? ctx.turnId ?? 'batch_mutate_world',
    operationId,
  };
}

function formatChildFailure(op: BatchOperationPlan, result: ToolResult): string {
  return `batch child ${op.id} (${op.tool}) failed: ${result.error ?? 'unknown error'}`;
}

function formatIssues(prefix: string, issues: ConflictIssue[]): string {
  const compact = issues
    .slice(0, 5)
    .map(issue =>
      `${issue.operation_id}:${issue.code}${
        issue.conflicts_with ? ` with ${issue.conflicts_with}` : ''
      }`,
    )
    .join('; ');
  return `${prefix}: ${compact}`;
}
