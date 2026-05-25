/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-2 (2026-05-17) — migration 0129 invariants.
//
// After the migration:
//   * `universe_instances` exists with the expected columns and
//     check constraints;
//   * every installed cartridge has exactly one default
//     `local_single_player` row;
//   * `hero_cartridge_states.universe_instance_id` is populated for
//     every existing row that pre-dated the migration.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

beforeAll(async () => {
  await setupTurnTestEnvironment();
}, 600_000);

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

const CART_PREFIX = 'cart-uni-mig-';

beforeEach(async () => {
  await queryRows(
    `DELETE FROM universe_instances WHERE cartridge_id LIKE $1`,
    [`${CART_PREFIX}%`],
  );
  await queryRows(
    `DELETE FROM hero_cartridge_states WHERE cartridge_id LIKE $1`,
    [`${CART_PREFIX}%`],
  );
  await queryRows(
    `DELETE FROM cartridges WHERE id LIKE $1`,
    [`${CART_PREFIX}%`],
  );
});

describe('migration 0129_hero_universe_instances (FEAT-HERO-CONTINUITY-2)', () => {
  it('universe_instances table accepts a default local_single_player row', async () => {
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, $2, '0.1', '1', 'forge_project', $3)`,
      [`${CART_PREFIX}accept`, 'Cart Accept', 'sha256:accept'],
    );
    await queryRows(
      `INSERT INTO universe_instances
         (cartridge_id, content_hash, title, mode, is_default)
       VALUES ($1, $2, $3, 'local_single_player', true)`,
      [`${CART_PREFIX}accept`, 'sha256:accept', 'Cart Accept'],
    );
    const rows = await queryRows<{
      cartridge_id: string;
      mode: string;
      is_default: boolean;
      status: string;
    }>(
      `SELECT cartridge_id, mode, is_default, status
         FROM universe_instances
        WHERE cartridge_id = $1`,
      [`${CART_PREFIX}accept`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe('local_single_player');
    expect(rows[0]?.is_default).toBe(true);
    expect(rows[0]?.status).toBe('active');
  });

  it('rejects an invalid mode via the CHECK constraint', async () => {
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, $2, '0.1', '1', 'forge_project', $3)`,
      [`${CART_PREFIX}mode`, 'Cart Mode', 'sha256:mode'],
    );
    let caught: unknown = null;
    try {
      await queryRows(
        `INSERT INTO universe_instances
           (cartridge_id, content_hash, mode, is_default)
         VALUES ($1, $2, 'not_a_real_mode', false)`,
        [`${CART_PREFIX}mode`, 'sha256:mode'],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.toLowerCase()).toMatch(/check/);
  });

  it('rejects a second default row per cartridge via the partial unique index', async () => {
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, $2, '0.1', '1', 'forge_project', $3)`,
      [`${CART_PREFIX}dup`, 'Cart Dup', 'sha256:dup'],
    );
    await queryRows(
      `INSERT INTO universe_instances
         (cartridge_id, content_hash, mode, is_default)
       VALUES ($1, $2, 'local_single_player', true)`,
      [`${CART_PREFIX}dup`, 'sha256:dup'],
    );
    let caught: unknown = null;
    try {
      await queryRows(
        `INSERT INTO universe_instances
           (cartridge_id, content_hash, mode, is_default)
         VALUES ($1, $2, 'local_single_player', true)`,
        [`${CART_PREFIX}dup`, 'sha256:dup-2'],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.toLowerCase()).toMatch(/unique/);
    // A non-default second row is still allowed (future modes).
    await queryRows(
      `INSERT INTO universe_instances
         (cartridge_id, content_hash, mode, is_default)
       VALUES ($1, $2, 'local_party', false)`,
      [`${CART_PREFIX}dup`, 'sha256:dup-3'],
    );
    const rows = await queryRows<{cartridge_id: string}>(
      `SELECT cartridge_id FROM universe_instances
        WHERE cartridge_id = $1`,
      [`${CART_PREFIX}dup`],
    );
    expect(rows).toHaveLength(2);
  });

  it('hero_cartridge_states.universe_instance_id FK cascades on instance delete', async () => {
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, $2, '0.1', '1', 'forge_project', $3)`,
      [`${CART_PREFIX}fk`, 'Cart FK', 'sha256:fk'],
    );
    const universeRow = await queryRows<{id: string}>(
      `INSERT INTO universe_instances
         (cartridge_id, content_hash, mode, is_default)
       VALUES ($1, $2, 'local_single_player', true)
       RETURNING id`,
      [`${CART_PREFIX}fk`, 'sha256:fk'],
    );
    const universeId = universeRow[0]?.id;
    // Seed a player by hand: create the entity row and the
    // matching `players` row. The test framework's
    // createAnonymousPlayer helper is the production path; this
    // direct insert keeps the test scoped.
    const playerRow = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, cartridge_id)
       VALUES ('player', 'FK Hero', $1)
       RETURNING id`,
      [`${CART_PREFIX}fk`],
    );
    const playerId = Number(playerRow[0]?.id);
    await queryRows(
      `INSERT INTO players (entity_id, public_id)
       VALUES ($1, gen_random_uuid())
       ON CONFLICT (entity_id) DO NOTHING`,
      [playerId],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states
         (player_id, cartridge_id, status, universe_instance_id)
       VALUES ($1, $2, 'available', $3::uuid)`,
      [playerId, `${CART_PREFIX}fk`, universeId],
    );
    // Deleting the universe row cascades to the hero state row.
    await queryRows(
      `DELETE FROM universe_instances WHERE id = $1::uuid`,
      [universeId],
    );
    const remaining = await queryRows<{cartridge_id: string}>(
      `SELECT cartridge_id FROM hero_cartridge_states
        WHERE player_id = $1`,
      [playerId],
    );
    expect(remaining).toEqual([]);
  });
});
