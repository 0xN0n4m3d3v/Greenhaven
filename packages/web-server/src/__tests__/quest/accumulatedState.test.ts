/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-3 — `patchAccumulatedState` JSONB merge helper.
//
// The contract: never replace `accumulated_state` wholesale; merge
// the supplied patch with `||`, then drop any keys listed in
// `removeKeys`. Concurrent writers patching disjoint keys must each
// see their key preserved instead of being clobbered by a
// read-modify-write pattern.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';
import {patchAccumulatedState} from '../../quest/accumulatedState.js';

let withTransaction: typeof import('../../db.js').withTransaction;

let playerId = 0;
let questId = 0;

async function seedPlayerAndQuest(): Promise<void> {
  const playerService = await import('../../playerService.js');
  const created = await playerService.createAnonymousPlayer(
    `QE-3 Patch Player ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  playerId = created.entity_id;
  const questRows = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES ('quest', 'QE-3 Patch Quest', '', '{}'::jsonb, ARRAY['qe3'], 'quickgrin-lane')
     RETURNING id`,
  );
  questId = questRows[0]!.id;
  await queryRows(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase, accumulated_state)
     VALUES ($1, $2, 'active', 0, '{}'::jsonb)`,
    [playerId, questId],
  );
}

async function readState(): Promise<Record<string, unknown>> {
  const rows = await queryRows<{accumulated_state: Record<string, unknown>}>(
    `SELECT accumulated_state FROM player_quests
      WHERE player_id = $1 AND quest_entity_id = $2`,
    [playerId, questId],
  );
  return rows[0]?.accumulated_state ?? {};
}

beforeAll(async () => {
  await setupTurnTestEnvironment();
  const db = await import('../../db.js');
  withTransaction = db.withTransaction;
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  await seedPlayerAndQuest();
});

describe('patchAccumulatedState (QE-3)', () => {
  test('seeds {a,b} from an empty accumulated_state', async () => {
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {a: 1, b: 2});
    });
    expect(await readState()).toEqual({a: 1, b: 2});
  });

  test('independent {c} and {d} patches preserve earlier {a,b} keys', async () => {
    // Three independent calls — together they should leave the row
    // with all four keys, proving the patch never replaces the
    // unrelated state from a concurrent writer.
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {a: 1, b: 2});
    });
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {c: 3});
    });
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {d: 4});
    });
    expect(await readState()).toEqual({a: 1, b: 2, c: 3, d: 4});
  });

  test('removeKeys drops only the named keys; merge happens first', async () => {
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {
        a: 1,
        b: 2,
        pending_choice: 'door-A',
      });
    });
    // `awaiting_choice: false` merges in, `pending_choice` is removed
    // (parameterized `- $key::text`). Untouched keys (`a`, `b`)
    // survive. The merge result and the removal happen in a single
    // SQL statement so the patch is atomic.
    await withTransaction(async tx => {
      await patchAccumulatedState(
        tx,
        playerId,
        questId,
        {awaiting_choice: false},
        ['pending_choice'],
      );
    });
    expect(await readState()).toEqual({
      a: 1,
      b: 2,
      awaiting_choice: false,
    });
  });

  test('merge overwrites a value for an existing key without touching siblings', async () => {
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {
        turns_remaining: 5,
        awaiting_choice: true,
      });
    });
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {
        turns_remaining: 4,
      });
    });
    expect(await readState()).toEqual({
      turns_remaining: 4,
      awaiting_choice: true,
    });
  });

  test('multiple removeKeys in one call all drop', async () => {
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {
        a: 1,
        pending_choice: 'door-A',
        timeout_failure: true,
      });
    });
    await withTransaction(async tx => {
      await patchAccumulatedState(
        tx,
        playerId,
        questId,
        {awaiting_choice: false},
        ['pending_choice', 'timeout_failure'],
      );
    });
    expect(await readState()).toEqual({a: 1, awaiting_choice: false});
  });

  test('rollback discards the patch — the row keeps its prior state', async () => {
    await withTransaction(async tx => {
      await patchAccumulatedState(tx, playerId, questId, {keep: 'me'});
    });
    await expect(
      withTransaction(async tx => {
        await patchAccumulatedState(tx, playerId, questId, {
          would_be_dropped: true,
        });
        throw new Error('rollback please');
      }),
    ).rejects.toThrow(/rollback please/);
    expect(await readState()).toEqual({keep: 'me'});
  });
});
