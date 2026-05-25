/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-16 — nested `withTransaction()` semantics.
//
// Before ARCH-16, a nested call silently reused the outer client and
// had no rollback boundary: an inner throw caught by the outer
// transaction did not undo any of the inner block's writes. The new
// contract issues a per-nested SAVEPOINT, rolls back to it on inner
// throw, and scopes commit/rollback hooks accordingly. Outer
// transaction semantics are unchanged.

import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

let dbQuery: <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<QueryResult<T>>;
let withTransaction: <T>(
  fn: (client: {
    query: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>;
  }) => Promise<T>,
) => Promise<T>;
let onTransactionCommit: (fn: () => void | Promise<void>) => boolean;
let onTransactionRollback: (fn: () => void | Promise<void>) => boolean;
let isInTransaction: () => boolean;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  const db = await import('../../db.js');
  dbQuery = db.query as typeof dbQuery;
  withTransaction = db.withTransaction as typeof withTransaction;
  onTransactionCommit = db.onTransactionCommit;
  onTransactionRollback = db.onTransactionRollback;
  isInTransaction = db.isInTransaction;
  await dbQuery(
    `CREATE TABLE IF NOT EXISTS tx_nesting_test (
       id SERIAL PRIMARY KEY,
       label TEXT NOT NULL UNIQUE
     )`,
  );
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  await dbQuery('DELETE FROM tx_nesting_test');
});

async function readLabels(): Promise<string[]> {
  const r = await dbQuery<{label: string}>(
    `SELECT label FROM tx_nesting_test ORDER BY label ASC`,
  );
  return r.rows.map(row => row.label);
}

describe('ARCH-16: nested withTransaction savepoints', () => {
  test('nested success commits with the outer transaction', async () => {
    await withTransaction(async tx => {
      await tx.query(
        `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
        ['outer-before'],
      );
      await withTransaction(async () => {
        await dbQuery(
          `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
          ['inner'],
        );
      });
      await tx.query(
        `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
        ['outer-after'],
      );
    });
    expect(await readLabels()).toEqual(['inner', 'outer-after', 'outer-before']);
  });

  test('caught nested throw rolls back to savepoint while outer still commits siblings', async () => {
    await withTransaction(async tx => {
      await tx.query(
        `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
        ['outer-before'],
      );
      try {
        await withTransaction(async () => {
          await dbQuery(
            `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
            ['inner-doomed'],
          );
          throw new Error('inner-boom');
        });
      } catch (err) {
        expect((err as Error).message).toBe('inner-boom');
      }
      await tx.query(
        `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
        ['outer-after'],
      );
    });
    expect(await readLabels()).toEqual(['outer-after', 'outer-before']);
  });

  test('escaping nested throw rolls back the outer transaction', async () => {
    await expect(
      withTransaction(async tx => {
        await tx.query(
          `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
          ['outer-before'],
        );
        await withTransaction(async () => {
          await dbQuery(
            `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
            ['inner-doomed'],
          );
          throw new Error('inner-escape');
        });
      }),
    ).rejects.toThrow('inner-escape');
    expect(await readLabels()).toEqual([]);
  });

  test('commit hooks registered inside a successful nested fire only after outer commit', async () => {
    const events: string[] = [];
    await withTransaction(async () => {
      await withTransaction(async () => {
        onTransactionCommit(() => {
          events.push('inner-commit-hook');
        });
      });
      expect(events).toEqual([]); // hook does not fire on RELEASE.
    });
    expect(events).toEqual(['inner-commit-hook']);
  });

  test('commit hooks registered inside a failed nested are discarded', async () => {
    const events: string[] = [];
    await withTransaction(async () => {
      onTransactionCommit(() => {
        events.push('outer-commit-hook');
      });
      try {
        await withTransaction(async () => {
          onTransactionCommit(() => {
            events.push('inner-commit-hook');
          });
          throw new Error('inner-boom');
        });
      } catch {
        /* swallow */
      }
    });
    expect(events).toEqual(['outer-commit-hook']);
  });

  test('rollback hooks registered inside a failed nested run once and are removed from outer', async () => {
    const events: string[] = [];
    try {
      await withTransaction(async () => {
        onTransactionRollback(() => {
          events.push('outer-rollback-hook');
        });
        try {
          await withTransaction(async () => {
            onTransactionRollback(() => {
              events.push('inner-rollback-hook');
            });
            throw new Error('inner-boom');
          });
        } catch {
          /* swallow inside outer */
        }
        // The inner rollback hook fires synchronously during the
        // ROLLBACK TO SAVEPOINT path, before this point.
        expect(events).toEqual(['inner-rollback-hook']);
        // Force the outer to roll back too, to assert that the
        // already-fired inner hook is NOT run a second time.
        throw new Error('outer-boom');
      });
    } catch (err) {
      expect((err as Error).message).toBe('outer-boom');
    }
    expect(events).toEqual(['inner-rollback-hook', 'outer-rollback-hook']);
  });

  test('rollback hooks registered inside a successful nested still fire if outer rolls back', async () => {
    const events: string[] = [];
    try {
      await withTransaction(async () => {
        await withTransaction(async () => {
          onTransactionRollback(() => {
            events.push('inner-rollback-hook');
          });
        });
        // Nested released successfully — the rollback hook stays
        // attached to the outer context.
        expect(events).toEqual([]);
        throw new Error('outer-boom');
      });
    } catch (err) {
      expect((err as Error).message).toBe('outer-boom');
    }
    expect(events).toEqual(['inner-rollback-hook']);
  });

  test('isInTransaction is true inside both outer and nested', async () => {
    expect(isInTransaction()).toBe(false);
    await withTransaction(async () => {
      expect(isInTransaction()).toBe(true);
      await withTransaction(async () => {
        expect(isInTransaction()).toBe(true);
      });
      expect(isInTransaction()).toBe(true);
    });
    expect(isInTransaction()).toBe(false);
  });

  test('successive nested siblings get unique savepoint identifiers', async () => {
    // Two sibling nested transactions in the same outer block. Both
    // should be releasable independently and their writes should
    // survive into the outer commit.
    await withTransaction(async () => {
      await withTransaction(async () => {
        await dbQuery(
          `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
          ['sibling-1'],
        );
      });
      await withTransaction(async () => {
        await dbQuery(
          `INSERT INTO tx_nesting_test (label) VALUES ($1)`,
          ['sibling-2'],
        );
      });
    });
    expect(await readLabels()).toEqual(['sibling-1', 'sibling-2']);
  });
});
