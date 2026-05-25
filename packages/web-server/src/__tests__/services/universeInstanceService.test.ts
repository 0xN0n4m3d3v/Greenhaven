/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-2 (2026-05-17) — UniverseInstanceService
// contract:
//
//   * `getDefaultForCartridge` returns null when no default row
//     exists yet;
//   * `ensureDefaultForCartridge` creates a `local_single_player`
//     default row keyed off the cartridge's content_hash/title and
//     is idempotent across repeated calls;
//   * concurrent ensure calls converge on the same row id.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let UniverseInstanceService:
  typeof import('../../services/UniverseInstanceService.js').UniverseInstanceService;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({UniverseInstanceService} = await import(
    '../../services/UniverseInstanceService.js'
  ));
}, 600_000);

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

const CART_PREFIX = 'cart-uni-svc-';

beforeEach(async () => {
  await queryRows(
    `DELETE FROM universe_instances WHERE cartridge_id LIKE $1`,
    [`${CART_PREFIX}%`],
  );
  await queryRows(
    `DELETE FROM cartridges WHERE id LIKE $1`,
    [`${CART_PREFIX}%`],
  );
});

async function seedCartridge(id: string, title: string, hash: string): Promise<void> {
  await queryRows(
    `INSERT INTO cartridges (id, title, version, schema_version,
                              source_kind, content_hash)
     VALUES ($1, $2, '0.1', '1', 'forge_project', $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, title, hash],
  );
}

describe('UniverseInstanceService (FEAT-HERO-CONTINUITY-2)', () => {
  it('getDefaultForCartridge returns null when no row exists', async () => {
    await seedCartridge(`${CART_PREFIX}empty`, 'Empty', 'sha256:empty');
    const row = await UniverseInstanceService.getDefaultForCartridge(
      `${CART_PREFIX}empty`,
    );
    expect(row).toBeNull();
  });

  it('ensureDefaultForCartridge creates a default row keyed off the cartridge', async () => {
    await seedCartridge(`${CART_PREFIX}new`, 'New Cart', 'sha256:new');
    const created = await UniverseInstanceService.ensureDefaultForCartridge(
      `${CART_PREFIX}new`,
    );
    expect(created.cartridgeId).toBe(`${CART_PREFIX}new`);
    expect(created.mode).toBe('local_single_player');
    expect(created.isDefault).toBe(true);
    expect(created.title).toBe('New Cart');
    expect(created.contentHash).toBe('sha256:new');
    expect(created.status).toBe('active');
    const lookup = await UniverseInstanceService.getDefaultForCartridge(
      `${CART_PREFIX}new`,
    );
    expect(lookup?.id).toBe(created.id);
  });

  it('ensureDefaultForCartridge is idempotent across repeated calls', async () => {
    await seedCartridge(`${CART_PREFIX}idem`, 'Idem Cart', 'sha256:idem');
    const first = await UniverseInstanceService.ensureDefaultForCartridge(
      `${CART_PREFIX}idem`,
    );
    const second = await UniverseInstanceService.ensureDefaultForCartridge(
      `${CART_PREFIX}idem`,
    );
    expect(second.id).toBe(first.id);
    const rows = await queryRows<{id: string}>(
      `SELECT id FROM universe_instances WHERE cartridge_id = $1`,
      [`${CART_PREFIX}idem`],
    );
    expect(rows).toHaveLength(1);
  });

  it('ensureDefaultForCartridge rejects an unknown cartridge id', async () => {
    let caught: unknown = null;
    try {
      await UniverseInstanceService.ensureDefaultForCartridge(
        `${CART_PREFIX}does-not-exist`,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('not found');
  });

  it('concurrent ensureDefaultForCartridge converges on a single row', async () => {
    await seedCartridge(`${CART_PREFIX}race`, 'Race Cart', 'sha256:race');
    const [a, b, c] = await Promise.all([
      UniverseInstanceService.ensureDefaultForCartridge(`${CART_PREFIX}race`),
      UniverseInstanceService.ensureDefaultForCartridge(`${CART_PREFIX}race`),
      UniverseInstanceService.ensureDefaultForCartridge(`${CART_PREFIX}race`),
    ]);
    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
    const rows = await queryRows<{id: string}>(
      `SELECT id FROM universe_instances WHERE cartridge_id = $1`,
      [`${CART_PREFIX}race`],
    );
    expect(rows).toHaveLength(1);
  });
});
