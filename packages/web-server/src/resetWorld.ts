/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {getMeta} from './cartridge.js';
import {onTransactionCommit, query, withTransaction} from './db.js';
import {
  deleteAllNpcMemoriesForReset,
  selectNpcMemoryResetCountRow,
} from './domain/memory/index.js';
import {sessionManager} from './sessionManager.js';
import {telemetry} from './telemetry/index.js';
import {
  deleteTelemetryArtifactFiles,
  listAllTelemetryArtifactFiles,
} from './telemetryArtifacts.js';

// ARCH-19 Phase 3 — dynamic_origin column is the canonical signal.
// Legacy tag / origin profile keys are still written by historic
// rows but are no longer the read source.
export const DYNAMIC_ENTITY_WHERE_SQL = 'dynamic_origin = true';

export interface ResetWorldCount {
  tablename: string;
  n: number;
}

export interface ResetWorldResult {
  counts: ResetWorldCount[];
  dynamicEntitiesRemoved: number;
}

export async function resetWorldState(): Promise<ResetWorldResult> {
  const inventorySeeds = (await getMeta<
    Array<{holder_entity_id: number; item_entity_id: number; count: number}>
  >('reset_inventory_seeds', [])) ?? [];
  const runtimeOverrides = (await getMeta<
    Array<{field_id: number; value: unknown}>
  >('reset_runtime_overrides', [])) ?? [];

  let dynamicEntitiesRemoved = 0;

  const artifactRows = await listAllTelemetryArtifactFiles();

  await withTransaction(async tx => {
    await tx.query(`DELETE FROM turn_ingress_queue`);
    await tx.query(`DELETE FROM adventure_oracle_rolls`);
    await tx.query(`DELETE FROM adventure_queue`);
    await tx.query(`DELETE FROM gui_events`);
    await tx.query(`DELETE FROM chat_messages`);
    await tx.query(`DELETE FROM tool_invocations`);
    await tx.query(`DELETE FROM turn_telemetry`);
    await tx.query(`DELETE FROM performance_events`);
    await tx.query(`DELETE FROM telemetry_eval_scores`);
    await tx.query(`DELETE FROM telemetry_artifacts`);
    await tx.query(`DELETE FROM telemetry_metrics`);
    await tx.query(`DELETE FROM telemetry_events`);
    await tx.query(`DELETE FROM telemetry_spans`);
    await tx.query(`DELETE FROM telemetry_sessions`);
    await deleteAllNpcMemoriesForReset();
    await tx.query(`DELETE FROM runtime_player_overlay`);
    await tx.query(`DELETE FROM save_slots`);
    await tx.query(`DELETE FROM player_quests`);
    await tx.query(`DELETE FROM player_xp_log`);
    await tx.query(`DELETE FROM player_stats`);
    await tx.query(`DELETE FROM player_skills`);
    await tx.query(`DELETE FROM player_proficient_skills`);
    await tx.query(`DELETE FROM player_equipment`);
    await tx.query(`DELETE FROM player_inventory`);
    await tx.query(`DELETE FROM faction_reputation`);
    await tx.query(`DELETE FROM dice_check_cooldowns`);
    await tx.query(
      `DELETE FROM inventory_entries
        WHERE holder_entity_id IN (SELECT entity_id FROM players)`,
    );

    await tx.query(
      `UPDATE runtime_values rv
          SET value = COALESCE(rf.default_value, 'null'::jsonb),
              source = 'reset',
              updated_at = now()
         FROM runtime_fields rf
        WHERE rv.field_id = rf.id
          AND NOT EXISTS (
            SELECT 1 FROM players p WHERE p.entity_id = rf.owner_entity_id
          )`,
    );

    await tx.query(`DELETE FROM sessions`);
    await tx.query(`DELETE FROM players`);
    await tx.query(`DELETE FROM entities WHERE kind = 'player'`);

    const dynamicRows = await tx.query<{id: number}>(
      `SELECT id FROM entities WHERE ${DYNAMIC_ENTITY_WHERE_SQL}`,
    );
    const dynamicIds = dynamicRows.rows.map(row => Number(row.id));
    dynamicEntitiesRemoved = dynamicIds.length;
    if (dynamicIds.length > 0) {
      await tx.query(
        `DELETE FROM transitions WHERE goto_entity_id = ANY($1::bigint[])`,
        [dynamicIds],
      );
      await tx.query(`DELETE FROM entities WHERE id = ANY($1::bigint[])`, [
        dynamicIds,
      ]);
    }

    await tx.query(`UPDATE npc_stats SET current = base WHERE current <> base`);

    for (const seed of inventorySeeds) {
      await tx.query(
        `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count)
         VALUES ($1, $2, $3)
         ON CONFLICT (holder_entity_id, item_entity_id)
           DO UPDATE SET count = EXCLUDED.count`,
        [seed.holder_entity_id, seed.item_entity_id, seed.count],
      );
    }
    for (const ov of runtimeOverrides) {
      await tx.query(
        `UPDATE runtime_values
            SET value = $1::jsonb, source = 'reset', updated_at = now()
          WHERE field_id = $2`,
        [JSON.stringify(ov.value), ov.field_id],
      );
    }
    onTransactionCommit(async () => {
      await deleteTelemetryArtifactFiles(artifactRows);
    });
  });

  try {
    await sessionManager.destroyAll();
  } catch (err) {
    telemetry.record({
      channel: 'gameplay',
      name: 'reset_world.dispose_sessions_failed',
      error: err,
      data: {
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  const preNpcMemoryCounts = await query<ResetWorldCount>(
    `SELECT 'players' AS tablename, COUNT(*)::int AS n FROM players
     UNION ALL SELECT 'chat_messages', COUNT(*)::int FROM chat_messages
     UNION ALL SELECT 'tool_invocations', COUNT(*)::int FROM tool_invocations
     UNION ALL SELECT 'gui_events', COUNT(*)::int FROM gui_events
     UNION ALL SELECT 'turn_ingress_queue', COUNT(*)::int FROM turn_ingress_queue
     UNION ALL SELECT 'adventure_queue', COUNT(*)::int FROM adventure_queue
     UNION ALL SELECT 'adventure_oracle_rolls', COUNT(*)::int FROM adventure_oracle_rolls
     UNION ALL SELECT 'performance_events', COUNT(*)::int FROM performance_events
     UNION ALL SELECT 'telemetry_spans', COUNT(*)::int FROM telemetry_spans
     UNION ALL SELECT 'telemetry_events', COUNT(*)::int FROM telemetry_events
     UNION ALL SELECT 'telemetry_metrics', COUNT(*)::int FROM telemetry_metrics
     UNION ALL SELECT 'telemetry_artifacts', COUNT(*)::int FROM telemetry_artifacts
     UNION ALL SELECT 'telemetry_eval_scores', COUNT(*)::int FROM telemetry_eval_scores`,
  );
  const npcMemoryCountRow = await selectNpcMemoryResetCountRow();
  const postNpcMemoryCounts = await query<ResetWorldCount>(
    `SELECT 'runtime_player_overlay' AS tablename, COUNT(*)::int AS n FROM runtime_player_overlay
     UNION ALL SELECT 'player_inventory', COUNT(*)::int FROM player_inventory
     UNION ALL SELECT 'player_proficient_skills', COUNT(*)::int FROM player_proficient_skills
     UNION ALL SELECT 'save_slots', COUNT(*)::int FROM save_slots
     UNION ALL SELECT 'sessions', COUNT(*)::int FROM sessions
     UNION ALL SELECT 'runtime_fields (player)', COUNT(*)::int FROM runtime_fields
       WHERE owner_entity_id IN (SELECT id FROM entities WHERE kind = 'player')
     UNION ALL SELECT 'runtime_values (player)', COUNT(*)::int FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id IN (SELECT id FROM entities WHERE kind = 'player')
     UNION ALL SELECT 'entities (cartridge)', COUNT(*)::int FROM entities WHERE kind <> 'player'
     UNION ALL SELECT 'entities (dynamic removed)', $1::int`,
    [dynamicEntitiesRemoved],
  );

  const counts: ResetWorldCount[] = [
    ...preNpcMemoryCounts.rows,
    npcMemoryCountRow,
    ...postNpcMemoryCounts.rows,
  ];
  return {counts, dynamicEntitiesRemoved};
}
