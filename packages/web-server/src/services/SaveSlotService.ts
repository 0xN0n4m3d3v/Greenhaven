/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 36 §4 — save slots.
//
// Snapshot semantics: a single JSONB blob covering everything the UI
// shows + the broker reads on the next turn. Stored against
// save_slots(player_id, slot_name). Five named slots + one
// 'quicksave' (auto on combat_state='dead', spec 35).
//
// Snapshot fields:
//   - runtime_values: every (field_id, player_id, value) for this player
//   - NPC memory rows about the player (stored under the JSON key
//     owned by `SAVE_SLOT_NPC_MEMORIES_KEY` in the memory domain pack
//     so existing save slots stay readable byte-for-byte)
//   - player_inventory: rows where player_id = player
//   - player_quests: rows where player_id = player
//   - player_stats: rows where player_id = player
//   - player_proficient_skills: rows where player_id = player
//   - chat_message_watermark: max chat_messages.id at snapshot time;
//                             on restore, chat messages newer than the
//                             watermark are deleted to rewind the
//                             conversation
//
// We deliberately DO NOT snapshot entire chat_messages history — the
// table can be huge. We restore by truncating future messages.
//
// Schema-version compatibility: snapshots are forward-incompatible
// only. Loading a save from before a migration that drops a referenced
// table will fail loudly.

import {query, withTransaction} from '../db.js';
import {
  SAVE_SLOT_NPC_MEMORIES_KEY,
  deleteSaveSlotNpcMemoriesForPlayer,
  restoreSaveSlotNpcMemoryRows,
  selectSaveSlotNpcMemoryRows,
} from '../domain/memory/index.js';

export type Snapshot = {
  schema_version: number;
  player_id: number;
  taken_at: string;
  runtime_values: Array<{field_id: number; value: unknown}>;
  player_inventory: unknown[];
  player_quests: unknown[];
  player_stats: unknown[];
  player_proficient_skills: unknown[];
  chat_message_watermark: number;
} & Record<string, unknown>;

export interface SaveSlot {
  id: number;
  slot_name: string;
  is_auto: boolean;
  size_bytes: number;
  created_at: string;
}

export interface CreatedSaveSlot {
  id: number | undefined;
  size_bytes: number;
}

const SNAPSHOT_SCHEMA_VERSION = 1;

export class SaveSlotService {
  static async list(playerId: number): Promise<SaveSlot[]> {
    const rows = await query<SaveSlot>(
      `SELECT id, slot_name, is_auto, size_bytes, created_at
         FROM save_slots WHERE player_id = $1
        ORDER BY created_at DESC`,
      [playerId],
    );
    return rows.rows;
  }

  static async create(
    playerId: number,
    slotName: string,
    isAuto: boolean,
  ): Promise<CreatedSaveSlot> {
    const snap = await this.buildSnapshot(playerId);
    const sizeBytes = JSON.stringify(snap).length;
    const r = await query<{id: number}>(
      `INSERT INTO save_slots (player_id, slot_name, is_auto, snapshot, size_bytes)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (player_id, slot_name) DO UPDATE
         SET snapshot = EXCLUDED.snapshot,
             size_bytes = EXCLUDED.size_bytes,
             is_auto = EXCLUDED.is_auto,
             created_at = now()
       RETURNING id`,
      [playerId, slotName, isAuto, JSON.stringify(snap), sizeBytes],
    );
    return {id: r.rows[0]?.id, size_bytes: sizeBytes};
  }

  static async restore(playerId: number, slotId: number): Promise<boolean> {
    const r = await query<{snapshot: Snapshot}>(
      `SELECT snapshot FROM save_slots WHERE id = $1 AND player_id = $2`,
      [slotId, playerId],
    );
    if (r.rows.length === 0) return false;
    await this.applySnapshot(playerId, r.rows[0]!.snapshot);
    return true;
  }

  static async delete(playerId: number, slotId: number): Promise<void> {
    await query(`DELETE FROM save_slots WHERE id = $1 AND player_id = $2`, [
      slotId,
      playerId,
    ]);
  }

  static async quicksaveOnDeath(playerId: number): Promise<void> {
    const snap = await this.buildSnapshot(playerId);
    const sizeBytes = JSON.stringify(snap).length;
    await query(
      `INSERT INTO save_slots (player_id, slot_name, is_auto, snapshot, size_bytes)
       VALUES ($1, 'quicksave', true, $2::jsonb, $3)
       ON CONFLICT (player_id, slot_name) DO UPDATE
         SET snapshot = EXCLUDED.snapshot,
             size_bytes = EXCLUDED.size_bytes,
             is_auto = true,
             created_at = now()`,
      [playerId, JSON.stringify(snap), sizeBytes],
    );
  }

  private static async buildSnapshot(playerId: number): Promise<Snapshot> {
    const rv = await query<{field_id: number; value: unknown}>(
      `SELECT rv.field_id, rv.value
         FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1`,
      [playerId],
    );
    const npcMemoryRows = await selectSaveSlotNpcMemoryRows(playerId);
    const inv = await query(
      `SELECT * FROM player_inventory WHERE player_id = $1`,
      [playerId],
    );
    const quests = await query(
      `SELECT * FROM player_quests WHERE player_id = $1`,
      [playerId],
    );
    const stats = await query(
      `SELECT * FROM player_stats WHERE player_id = $1`,
      [playerId],
    );
    const profSkills = await query(
      `SELECT * FROM player_proficient_skills WHERE player_id = $1`,
      [playerId],
    );
    const watermark = await query<{m: number | null}>(
      `SELECT MAX(id) AS m FROM chat_messages`,
    );
    return {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      player_id: playerId,
      taken_at: new Date().toISOString(),
      runtime_values: rv.rows,
      [SAVE_SLOT_NPC_MEMORIES_KEY]: npcMemoryRows,
      player_inventory: inv.rows,
      player_quests: quests.rows,
      player_stats: stats.rows,
      player_proficient_skills: profSkills.rows,
      chat_message_watermark: Number(watermark.rows[0]?.m ?? 0),
    };
  }

  private static async applySnapshot(
    playerId: number,
    snap: Snapshot,
  ): Promise<void> {
    if (snap.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `incompatible snapshot schema_version ${snap.schema_version} (expected ${SNAPSHOT_SCHEMA_VERSION})`,
      );
    }
    if (snap.player_id !== playerId) {
      throw new Error(
        `snapshot belongs to player ${snap.player_id}, not ${playerId}`,
      );
    }
    await withTransaction(async tx => {
      // Wipe player-scoped tables.
      await tx.query(
        `DELETE FROM runtime_values
           WHERE field_id IN (SELECT id FROM runtime_fields WHERE owner_entity_id = $1)`,
        [playerId],
      );
      await deleteSaveSlotNpcMemoriesForPlayer(playerId);
      await tx.query(`DELETE FROM player_inventory WHERE player_id = $1`, [
        playerId,
      ]);
      await tx.query(`DELETE FROM player_quests WHERE player_id = $1`, [
        playerId,
      ]);
      await tx.query(`DELETE FROM player_stats WHERE player_id = $1`, [
        playerId,
      ]);
      await tx.query(
        `DELETE FROM player_proficient_skills WHERE player_id = $1`,
        [playerId],
      );

      for (const rv of snap.runtime_values) {
        await tx.query(
          `INSERT INTO runtime_values (field_id, value, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (field_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [rv.field_id, JSON.stringify(rv.value)],
        );
      }
      const savedNpcMemoryRows = (snap[SAVE_SLOT_NPC_MEMORIES_KEY] ?? []) as Array<
        Record<string, unknown>
      >;
      await restoreSaveSlotNpcMemoryRows(savedNpcMemoryRows);
      for (const i of snap.player_inventory as Array<Record<string, unknown>>) {
        await tx.query(
          `INSERT INTO player_inventory
           SELECT * FROM jsonb_populate_record(NULL::player_inventory, $1::jsonb)`,
          [JSON.stringify(i)],
        );
      }
      for (const q of snap.player_quests as Array<Record<string, unknown>>) {
        await tx.query(
          `INSERT INTO player_quests
           SELECT * FROM jsonb_populate_record(NULL::player_quests, $1::jsonb)`,
          [JSON.stringify(q)],
        );
      }
      for (const s of snap.player_stats as Array<Record<string, unknown>>) {
        await tx.query(
          `INSERT INTO player_stats
           SELECT * FROM jsonb_populate_record(NULL::player_stats, $1::jsonb)`,
          [JSON.stringify(s)],
        );
      }
      for (const ps of snap.player_proficient_skills as Array<
        Record<string, unknown>
      >) {
        await tx.query(
          `INSERT INTO player_proficient_skills
           SELECT * FROM jsonb_populate_record(NULL::player_proficient_skills, $1::jsonb)`,
          [JSON.stringify(ps)],
        );
      }
      // Rewind chat history to the snapshot watermark.
      await tx.query(`DELETE FROM chat_messages WHERE id > $1`, [
        snap.chat_message_watermark,
      ]);
    });
  }
}

export async function quicksaveOnDeath(playerId: number): Promise<void> {
  return SaveSlotService.quicksaveOnDeath(playerId);
}
