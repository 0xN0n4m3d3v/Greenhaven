/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 137/138: safe derived-state audit. This module reports and repairs
// only memory/packet metadata; it does not delete memories, alter quest
// status, or award XP.

import {query} from '../db.js';
import {
  clampNpcMemorySalience,
  clearBrokenMemoryClusters,
  fillMemoryFamilyDefaults,
  fillMissingLastReferencedAt,
  runMemoryMaintenance,
  selectBadSalienceMemoryIds,
  selectBrokenClusterMemoryIds,
  selectInvalidMemoryCategoryIds,
  selectMissingMemoryFamilyIds,
  selectRefWithoutTimestampMemoryIds,
} from '../domain/memory/index.js';

export interface MemoryPalaceAuditIssue {
  code: string;
  count: number;
  ids: Array<number | string>;
}

export interface MemoryPalaceAuditResult {
  ok: boolean;
  repaired: boolean;
  issues: MemoryPalaceAuditIssue[];
  repairs: Array<{code: string; count: number}>;
}

export async function auditMemoryPalace(options: {
  repair?: boolean;
} = {}): Promise<MemoryPalaceAuditResult> {
  const issues: MemoryPalaceAuditIssue[] = [];
  const repairs: Array<{code: string; count: number}> = [];

  issues.push(await issue('invalid_memory_kind', selectInvalidMemoryCategoryIds()));
  issues.push(await issue('missing_memory_family', selectMissingMemoryFamilyIds()));
  issues.push(await issue('salience_out_of_bounds', selectBadSalienceMemoryIds()));
  issues.push(await issue('broken_cluster_reference', selectBrokenClusterMemoryIds()));
  issues.push(
    await issue('referenced_without_timestamp', selectRefWithoutTimestampMemoryIds()),
  );
  issues.push(await issue('missing_current_stage', missingCurrentStageRows()));
  issues.push(await issue('invalid_dynamic_plan_overlay', invalidDynamicPlanRows()));

  if (options.repair) {
    repairs.push(await repair('fill_memory_family', fillMemoryFamilyDefaults()));
    repairs.push(await repair('clamp_salience', clampNpcMemorySalience()));
    repairs.push(
      await repair('clear_broken_cluster_reference', clearBrokenMemoryClusters()),
    );
    repairs.push(
      await repair('fill_last_referenced_at', fillMissingLastReferencedAt()),
    );
    const maintenance = await runMemoryMaintenance({force: true});
    repairs.push({code: 'forced_memory_maintenance', count: maintenance.decayed});
  }

  const liveIssues = issues.filter(item => item.count > 0);
  return {
    ok: liveIssues.length === 0,
    repaired: options.repair === true,
    issues: liveIssues,
    repairs,
  };
}

async function issue(
  code: string,
  rowsPromise: Promise<Array<{id: number | string}>>,
): Promise<MemoryPalaceAuditIssue> {
  const rows = await rowsPromise;
  return {code, count: rows.length, ids: rows.map(row => row.id).slice(0, 50)};
}

async function repair(
  code: string,
  promise: Promise<{rowCount: number}>,
): Promise<{code: string; count: number}> {
  const result = await promise;
  return {code, count: result.rowCount};
}

async function missingCurrentStageRows(): Promise<Array<{id: number}>> {
  const rows = await query<{id: number}>(
    `SELECT quest_entity_id AS id
       FROM player_quests
      WHERE status = 'active'
        AND current_stage_id IS NULL
      LIMIT 100`,
  );
  return rows.rows;
}

async function invalidDynamicPlanRows(): Promise<Array<{id: number}>> {
  const rows = await query<{id: number}>(
    `SELECT quest_entity_id AS id
       FROM player_quests
      WHERE accumulated_state ? 'quest_plan'
        AND jsonb_typeof(accumulated_state->'quest_plan'->'steps') = 'array'
        AND (
          jsonb_array_length(accumulated_state->'quest_plan'->'steps') < 3
          OR jsonb_array_length(accumulated_state->'quest_plan'->'steps') > 7
        )
      LIMIT 100`,
  );
  return rows.rows;
}

