/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BatchOperationPlan {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  depends_on?: string[];
}

export interface ConflictIssue {
  code: string;
  operation_id: string;
  message: string;
  conflicts_with?: string;
}

export interface ConflictVerdict {
  ok: boolean;
  issues: ConflictIssue[];
}

export function resolveBatchConflicts(
  operations: BatchOperationPlan[],
): ConflictVerdict {
  const issues: ConflictIssue[] = [];
  const runtimeWrites = new Map<string, string>();
  const movementTargets = new Map<string, string>();
  const inventoryConsumes = new Map<string, string>();
  const questOps = new Map<string, {firstTool: string; firstOp: string}>();

  for (const op of operations) {
    collectRuntimeWrites(op, runtimeWrites, issues);
    collectMovement(op, movementTargets, issues);
    collectInventoryConsumes(op, inventoryConsumes, issues);
    collectQuestOps(op, questOps, issues);
  }

  return {ok: issues.length === 0, issues};
}

function collectRuntimeWrites(
  op: BatchOperationPlan,
  seen: Map<string, string>,
  issues: ConflictIssue[],
): void {
  const fieldIds: string[] = [];
  if (op.tool === 'set_runtime_field') {
    const fieldId = numberLike(op.args['field_id']);
    if (fieldId) fieldIds.push(fieldId);
  } else if (op.tool === 'apply_runtime_field_patch') {
    const patches = Array.isArray(op.args['patches']) ? op.args['patches'] : [];
    for (const patch of patches) {
      if (!patch || typeof patch !== 'object') continue;
      const fieldId = numberLike((patch as Record<string, unknown>)['field_id']);
      if (fieldId) fieldIds.push(fieldId);
    }
  }

  for (const fieldId of fieldIds) {
    const key = `runtime:${fieldId}`;
    const previous = seen.get(key);
    if (previous) {
      issues.push({
        code: 'duplicate_runtime_field_write',
        operation_id: op.id,
        conflicts_with: previous,
        message: `runtime field ${fieldId} is written more than once`,
      });
    } else {
      seen.set(key, op.id);
    }
  }
}

function collectMovement(
  op: BatchOperationPlan,
  seen: Map<string, string>,
  issues: ConflictIssue[],
): void {
  if (op.tool !== 'move_player') return;
  const target = numberLike(op.args['target_location_id']);
  if (!target) return;
  const previousTarget = [...seen.keys()][0];
  const previousOp = previousTarget ? seen.get(previousTarget) : undefined;
  if (previousTarget && previousTarget !== target && previousOp) {
    issues.push({
      code: 'incompatible_movement',
      operation_id: op.id,
      conflicts_with: previousOp,
      message: `batch moves the player to both ${previousTarget} and ${target}`,
    });
    return;
  }
  seen.set(target, op.id);
}

function collectInventoryConsumes(
  op: BatchOperationPlan,
  seen: Map<string, string>,
  issues: ConflictIssue[],
): void {
  const keys: string[] = [];
  if (op.tool === 'inventory_transfer') {
    const from = stringLike(op.args['from']);
    const item = stringLike(op.args['item']);
    if (from && item) keys.push(`transfer:${from}:${item}`);
  } else if (op.tool === 'give_to_npc' || op.tool === 'use_item') {
    const item = stringLike(op.args['item_slug']);
    if (item) keys.push(`player:${item}`);
  }

  for (const key of keys) {
    const previous = seen.get(key);
    if (previous) {
      issues.push({
        code: 'duplicate_inventory_consumption',
        operation_id: op.id,
        conflicts_with: previous,
        message: `inventory source/item ${key} is consumed more than once`,
      });
    } else {
      seen.set(key, op.id);
    }
  }
}

function collectQuestOps(
  op: BatchOperationPlan,
  seen: Map<string, {firstTool: string; firstOp: string}>,
  issues: ConflictIssue[],
): void {
  if (
    op.tool !== 'start_quest' &&
    op.tool !== 'advance_quest' &&
    op.tool !== 'complete_quest'
  ) {
    return;
  }
  const quest = stringLike(op.args['quest']);
  if (!quest) return;
  const player =
    stringLike(op.args['player_id']) ?? stringLike(op.args['player']) ?? 'current-player';
  const key = `${player}:${quest}`;
  const previous = seen.get(key);
  if (previous) {
    issues.push({
      code: 'duplicate_quest_operation',
      operation_id: op.id,
      conflicts_with: previous.firstOp,
      message: `quest ${quest} for ${player} has multiple operations in one batch (${previous.firstTool}, ${op.tool})`,
    });
    return;
  }
  seen.set(key, {firstTool: op.tool, firstOp: op.id});
}

function stringLike(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberLike(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return String(Number(value));
  }
  return null;
}
