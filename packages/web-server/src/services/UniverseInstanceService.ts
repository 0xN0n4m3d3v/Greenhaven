/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-2 (2026-05-17) — universe-instance lookup +
// idempotent default creation.
//
// `universe_instances` is the live-world identity layer that sits
// between `cartridges` (read-only template) and
// `hero_cartridge_states` (per-(player, cartridge) playthrough row).
// Today every installed cartridge gets exactly one
// `mode = 'local_single_player'` default instance; future passes can
// add `local_party` / `network_shard` rows without changing this
// helper's contract.
//
// This service is the single home for "find or create the default
// universe for this cartridge" so cartridge import-apply, playthrough
// launch, and new-game all converge on the same row. Migration 0129
// did the historical backfill; this helper handles every future
// install / launch / new-game write so the column never drifts.

import {query} from '../db.js';

export interface UniverseInstance {
  id: string;
  cartridgeId: string;
  contentHash: string;
  title: string | null;
  mode: 'local_single_player' | 'local_party' | 'network_shard';
  ownerPlayerId: number | null;
  status: 'active' | 'paused' | 'archived' | 'incompatible';
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UniverseInstanceRow {
  id: string;
  cartridge_id: string;
  content_hash: string;
  title: string | null;
  mode: string;
  owner_player_id: number | string | null;
  status: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

function rowToUniverseInstance(row: UniverseInstanceRow): UniverseInstance {
  return {
    id: row.id,
    cartridgeId: row.cartridge_id,
    contentHash: row.content_hash,
    title: row.title,
    mode: row.mode as UniverseInstance['mode'],
    ownerPlayerId:
      row.owner_player_id == null ? null : Number(row.owner_player_id),
    status: row.status as UniverseInstance['status'],
    isDefault: row.is_default === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UniverseInstanceService {
  /**
   * Return the default `local_single_player` universe instance for
   * the given cartridge if one exists. Read-only — does NOT create.
   * Returns `null` when the cartridge id is unknown or has no
   * default instance yet.
   */
  static async getDefaultForCartridge(
    cartridgeId: string,
  ): Promise<UniverseInstance | null> {
    if (!cartridgeId) return null;
    const r = await query<UniverseInstanceRow>(
      `SELECT id, cartridge_id, content_hash, title, mode,
              owner_player_id, status, is_default,
              created_at::text AS created_at,
              updated_at::text AS updated_at
         FROM universe_instances
        WHERE cartridge_id = $1
          AND is_default = true
        LIMIT 1`,
      [cartridgeId],
    );
    const row = r.rows[0];
    return row ? rowToUniverseInstance(row) : null;
  }

  /**
   * Ensure a default `local_single_player` universe instance exists
   * for the given cartridge and return it. Idempotent — safe to call
   * from cartridge import-apply, playthrough launch, and new-game
   * without coordinating between them. The `idx_universe_instances_
   * cartridge_default` partial unique index from migration 0129
   * enforces "at most one default per cartridge"; this helper
   * inserts under that index and retries the lookup on collision.
   */
  static async ensureDefaultForCartridge(
    cartridgeId: string,
  ): Promise<UniverseInstance> {
    if (!cartridgeId) {
      throw new Error(
        'UniverseInstanceService.ensureDefaultForCartridge: cartridgeId is required',
      );
    }
    const existing = await UniverseInstanceService.getDefaultForCartridge(
      cartridgeId,
    );
    if (existing) return existing;
    // Pull the cartridge's content_hash + title for the new instance
    // so the row reflects the install at the moment of creation. The
    // FK to `cartridges` ensures the cartridge exists; we still
    // surface a clean error when it does not.
    const cartRows = await query<{title: string; content_hash: string}>(
      `SELECT title, content_hash FROM cartridges WHERE id = $1 LIMIT 1`,
      [cartridgeId],
    );
    const cart = cartRows.rows[0];
    if (!cart) {
      throw new Error(
        `UniverseInstanceService.ensureDefaultForCartridge: cartridge ${cartridgeId} not found`,
      );
    }
    // `ON CONFLICT DO NOTHING` against the partial unique index
    // (`is_default = true`). PGlite supports the partial-index
    // conflict target via the table predicate. If a concurrent
    // ensure() landed first, the INSERT is a no-op and we re-read.
    await query(
      `INSERT INTO universe_instances
         (cartridge_id, content_hash, title, mode, is_default)
       VALUES ($1, $2, $3, 'local_single_player', true)
       ON CONFLICT (cartridge_id) WHERE is_default DO NOTHING`,
      [cartridgeId, cart.content_hash, cart.title],
    );
    const after = await UniverseInstanceService.getDefaultForCartridge(
      cartridgeId,
    );
    if (!after) {
      throw new Error(
        `UniverseInstanceService.ensureDefaultForCartridge: default universe failed to materialize for ${cartridgeId}`,
      );
    }
    return after;
  }
}
