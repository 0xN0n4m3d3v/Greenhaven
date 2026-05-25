/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-3 (2026-05-17) — migration 0130 invariants.
//
// After the migration:
//   * `hero_continuity_events`, `hero_portable_artifacts`,
//     `hero_companion_bonds`, `companion_universe_projections`, and
//     `hero_companion_capsules` exist with the expected dedupe and FK
//     contracts;
//   * deleting the bond cascades to projections + capsules;
//   * deleting the source universe cascades to projections.

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

const CART = 'cart-hclmig-x';

beforeEach(async () => {
  await queryRows(
    `DELETE FROM hero_companion_capsules WHERE companion_bond_id IN
       (SELECT id FROM hero_companion_bonds WHERE companion_key LIKE 'hclmig:%')`,
  );
  await queryRows(
    `DELETE FROM companion_universe_projections WHERE companion_bond_id IN
       (SELECT id FROM hero_companion_bonds WHERE companion_key LIKE 'hclmig:%')`,
  );
  await queryRows(
    `DELETE FROM hero_companion_bonds WHERE companion_key LIKE 'hclmig:%'`,
  );
  await queryRows(
    `DELETE FROM hero_portable_artifacts WHERE artifact_key LIKE 'hclmig:%'`,
  );
  await queryRows(
    `DELETE FROM hero_continuity_events WHERE event_type LIKE 'hclmig:%'`,
  );
  await queryRows(`DELETE FROM universe_instances WHERE cartridge_id = $1`, [
    CART,
  ]);
  await queryRows(`DELETE FROM cartridges WHERE id = $1`, [CART]);
});

async function seedCartridgeAndUniverse(): Promise<string> {
  await queryRows(
    `INSERT INTO cartridges (id, title, version, schema_version,
                              source_kind, content_hash)
     VALUES ($1, 'HCLMig', '0.1', '1', 'forge_project', $2)`,
    [CART, `sha256:${CART}`],
  );
  const u = await queryRows<{id: string}>(
    `INSERT INTO universe_instances
       (cartridge_id, content_hash, title, mode, is_default)
     VALUES ($1, $2, 'HCLMig', 'local_single_player', true)
     RETURNING id`,
    [CART, `sha256:${CART}`],
  );
  return u[0]!.id;
}

async function seedHero(): Promise<number> {
  const e = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name) VALUES ('player', 'HCLMig Hero') RETURNING id`,
  );
  const playerId = Number(e[0]!.id);
  await queryRows(
    `INSERT INTO players (entity_id, public_id) VALUES ($1, gen_random_uuid())
     ON CONFLICT (entity_id) DO NOTHING`,
    [playerId],
  );
  return playerId;
}

describe('migration 0130_hero_continuity_ledger (FEAT-HERO-CONTINUITY-3)', () => {
  it('hero_portable_artifacts dedupes by (player_id, artifact_key)', async () => {
    const playerId = await seedHero();
    await queryRows(
      `INSERT INTO hero_portable_artifacts (player_id, artifact_key, kind)
       VALUES ($1, 'hclmig:art-1', 'title')`,
      [playerId],
    );
    let caught: unknown = null;
    try {
      await queryRows(
        `INSERT INTO hero_portable_artifacts (player_id, artifact_key, kind)
         VALUES ($1, 'hclmig:art-1', 'scar')`,
        [playerId],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.toLowerCase()).toMatch(/unique/);
  });

  it('hero_portable_artifacts rejects unknown kind via CHECK', async () => {
    const playerId = await seedHero();
    let caught: unknown = null;
    try {
      await queryRows(
        `INSERT INTO hero_portable_artifacts (player_id, artifact_key, kind)
         VALUES ($1, 'hclmig:art-2', 'not_a_real_kind')`,
        [playerId],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.toLowerCase()).toMatch(/check/);
  });

  it('hero_companion_bonds dedupes by (player_id, companion_key)', async () => {
    const playerId = await seedHero();
    await queryRows(
      `INSERT INTO hero_companion_bonds (player_id, companion_key)
       VALUES ($1, 'hclmig:bond-1')`,
      [playerId],
    );
    let caught: unknown = null;
    try {
      await queryRows(
        `INSERT INTO hero_companion_bonds (player_id, companion_key)
         VALUES ($1, 'hclmig:bond-1')`,
        [playerId],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.toLowerCase()).toMatch(/unique/);
  });

  it('companion_universe_projections cascade on bond delete', async () => {
    const universeId = await seedCartridgeAndUniverse();
    const playerId = await seedHero();
    const bondRow = await queryRows<{id: number}>(
      `INSERT INTO hero_companion_bonds (player_id, companion_key)
       VALUES ($1, 'hclmig:bond-cascade')
       RETURNING id`,
      [playerId],
    );
    const bondId = Number(bondRow[0]!.id);
    await queryRows(
      `INSERT INTO companion_universe_projections
         (companion_bond_id, universe_instance_id)
       VALUES ($1, $2::uuid)`,
      [bondId, universeId],
    );
    await queryRows(`DELETE FROM hero_companion_bonds WHERE id = $1`, [bondId]);
    const remaining = await queryRows<{id: number}>(
      `SELECT id FROM companion_universe_projections WHERE companion_bond_id = $1`,
      [bondId],
    );
    expect(remaining).toEqual([]);
  });

  it('companion_universe_projections cascade on universe delete', async () => {
    const universeId = await seedCartridgeAndUniverse();
    const playerId = await seedHero();
    const bondRow = await queryRows<{id: number}>(
      `INSERT INTO hero_companion_bonds (player_id, companion_key)
       VALUES ($1, 'hclmig:bond-cascade-2')
       RETURNING id`,
      [playerId],
    );
    const bondId = Number(bondRow[0]!.id);
    await queryRows(
      `INSERT INTO companion_universe_projections
         (companion_bond_id, universe_instance_id)
       VALUES ($1, $2::uuid)`,
      [bondId, universeId],
    );
    await queryRows(`DELETE FROM universe_instances WHERE id = $1::uuid`, [
      universeId,
    ]);
    const remaining = await queryRows<{id: number}>(
      `SELECT id FROM companion_universe_projections WHERE companion_bond_id = $1`,
      [bondId],
    );
    expect(remaining).toEqual([]);
  });

  it('hero_companion_capsules dedupe by (companion_bond_id, capsule_version)', async () => {
    const playerId = await seedHero();
    const bondRow = await queryRows<{id: number}>(
      `INSERT INTO hero_companion_bonds (player_id, companion_key)
       VALUES ($1, 'hclmig:bond-capsules')
       RETURNING id`,
      [playerId],
    );
    const bondId = Number(bondRow[0]!.id);
    await queryRows(
      `INSERT INTO hero_companion_capsules
         (companion_bond_id, capsule_version, state_hash)
       VALUES ($1, 1, 'hash-1')`,
      [bondId],
    );
    let caught: unknown = null;
    try {
      await queryRows(
        `INSERT INTO hero_companion_capsules
           (companion_bond_id, capsule_version, state_hash)
         VALUES ($1, 1, 'hash-2')`,
        [bondId],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.toLowerCase()).toMatch(/unique/);

    // Version 2 succeeds.
    await queryRows(
      `INSERT INTO hero_companion_capsules
         (companion_bond_id, capsule_version, state_hash)
       VALUES ($1, 2, 'hash-3')`,
      [bondId],
    );
    const rows = await queryRows<{capsule_version: number}>(
      `SELECT capsule_version FROM hero_companion_capsules
        WHERE companion_bond_id = $1 ORDER BY capsule_version`,
      [bondId],
    );
    expect(rows.map(r => Number(r.capsule_version))).toEqual([1, 2]);
  });

  it('hero_continuity_events FK cascades on player delete', async () => {
    const playerId = await seedHero();
    await queryRows(
      `INSERT INTO hero_continuity_events (player_id, event_type)
       VALUES ($1, 'hclmig:probe')`,
      [playerId],
    );
    await queryRows(`DELETE FROM players WHERE entity_id = $1`, [playerId]);
    await queryRows(`DELETE FROM entities WHERE id = $1`, [playerId]);
    const remaining = await queryRows<{id: number}>(
      `SELECT id FROM hero_continuity_events WHERE player_id = $1`,
      [playerId],
    );
    expect(remaining).toEqual([]);
  });
});
