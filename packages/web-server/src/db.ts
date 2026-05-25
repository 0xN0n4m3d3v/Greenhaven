/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Dual-backend DB layer.
//   DATABASE_URL set    → pg.Pool against managed Postgres (production)
//   DATABASE_URL unset  → PGlite (dev / single-user)
//
// query<T>(), execMulti(), withTransaction() unify the API. SQL stays
// identical between backends — both speak Postgres-wire.
//
// Why dual:
//   - PGlite for zero-install local dev (data in ./pgdata).
//   - pg.Pool when DATABASE_URL points at a managed instance (multi-user).
//   - Backend selection is one-shot at first call; restart to switch.

import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { Pool, type PoolConfig } from 'pg';
import { config } from './config.js';

interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

type TxHook = () => void | Promise<void>;

interface TransactionContext {
  client: TxClient;
  commitHooks: TxHook[];
  rollbackHooks: TxHook[];
  /**
   * ARCH-16 — monotonic counter used to mint unique SAVEPOINT
   * identifiers when nested `withTransaction()` calls reuse this
   * outer transaction. Identifiers are always the literal
   * `greenhaven_sp_<n>` so the SQL is never user-controlled.
   */
  savepointCounter: number;
}

const transactionStorage = new AsyncLocalStorage<TransactionContext>();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let pgPool: Pool | null = null;
let pgliteDb: PGlite | null = null;
let backend: 'pg' | 'pglite' | null = null;
let backendPromise: Promise<'pg' | 'pglite'> | null = null;
let connectivity: 'unknown' | 'ok' | 'error' = 'unknown';
let lastError: string | undefined;

function makePoolConfig(connectionString: string): PoolConfig {
  const cfgSource = config();
  const cfg: PoolConfig = {
    connectionString,
    max: cfgSource.pgPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  // Managed providers (Neon, Supabase, RDS) require TLS; the URL itself
  // usually carries `sslmode=require` but some libraries still need an
  // explicit ssl option. Permit a self-signed handshake on dev URLs
  // when the operator opts in via PGSSL_REJECT_UNAUTHORIZED=0.
  if (!cfgSource.pgSslRejectUnauthorized) {
    cfg.ssl = { rejectUnauthorized: false };
  }
  return cfg;
}

async function ensureBackend(): Promise<'pg' | 'pglite'> {
  if (backend) return backend;
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    try {
      const url = config().databaseUrl;
      if (url && url.length > 0) {
        pgPool = new Pool(makePoolConfig(url));
        pgPool.on('error', (err) => {
          connectivity = 'error';
          lastError = err.message;
          console.error('[db] pool error:', err);
        });
        try {
          const client = await pgPool.connect();
          try {
            await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
          } catch (err) {
            // CATCH-WARN-OK: db bootstrap; telemetry sink writes through this very module, so telemetry.record() here would deadlock connection acquisition.
            console.warn(
              `[db] CREATE EXTENSION vector failed (non-fatal): ${err instanceof Error ? err.message : err}`,
            );
          }
          client.release();
          connectivity = 'ok';
        } catch (err) {
          connectivity = 'error';
          lastError = err instanceof Error ? err.message : String(err);
          throw err;
        }
        backend = 'pg';
      } else {
        const dataDir = config().pgliteDataDir || DEFAULT_DATA_DIR;
        pgliteDb = await PGlite.create(dataDir, { extensions: { vector } });
        try {
          await pgliteDb.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
        } catch (err) {
          // CATCH-WARN-OK: db bootstrap; telemetry sink writes through this very module, so telemetry.record() here would deadlock connection acquisition.
          console.warn(
            `[db] CREATE EXTENSION vector failed (non-fatal): ${err instanceof Error ? err.message : err}`,
          );
        }
        connectivity = 'ok';
        backend = 'pglite';
      }
      console.log(`[db] backend=${backend}`);
      return backend;
    } catch (err) {
      connectivity = 'error';
      lastError = err instanceof Error ? err.message : String(err);
      backend = null;
      backendPromise = null;
      if (pgPool) {
        await pgPool.end().catch(() => undefined);
        pgPool = null;
      }
      if (pgliteDb) {
        await pgliteDb.close().catch(() => undefined);
        pgliteDb = null;
      }
      throw err;
    }
  })();
  return backendPromise;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const tx = transactionStorage.getStore();
  if (tx) return tx.client.query<T>(sql, params);

  const b = await ensureBackend();
  try {
    if (b === 'pg') {
      const r = await pgPool!.query(sql, params as unknown[]);
      if (connectivity !== 'ok') connectivity = 'ok';
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    }
    const r = await pgliteDb!.query<T>(sql, params as unknown[] | undefined);
    if (connectivity !== 'ok') connectivity = 'ok';
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  } catch (err) {
    connectivity = 'error';
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/**
 * Run multiple statements in one go (no parameter substitution). Used
 * by the migration runner where each .sql file is a single batch.
 * Both backends accept multi-statement strings via this entry point.
 */
export async function execMulti(sql: string): Promise<void> {
  const b = await ensureBackend();
  try {
    if (b === 'pg') {
      const client = await pgPool!.connect();
      try {
        await client.query(sql);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The batch may have failed outside an open transaction.
        }
        throw err;
      } finally {
        client.release();
      }
    } else {
      try {
        await pgliteDb!.exec(sql);
      } catch (err) {
        try {
          await pgliteDb!.exec('ROLLBACK');
        } catch {
          // The batch may have failed outside an open transaction.
        }
        throw err;
      }
    }
  } catch (err) {
    connectivity = 'error';
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/**
 * Tx-scoped client. Same surface as the top-level `query()` so callers
 * can be agnostic about whether they're inside a transaction.
 */
export interface TxClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export function isInTransaction(): boolean {
  return transactionStorage.getStore() != null;
}

export function onTransactionCommit(fn: TxHook): boolean {
  const tx = transactionStorage.getStore();
  if (!tx) return false;
  tx.commitHooks.push(fn);
  return true;
}

export function onTransactionRollback(fn: TxHook): boolean {
  const tx = transactionStorage.getStore();
  if (!tx) return false;
  tx.rollbackHooks.push(fn);
  return true;
}

async function runTransactionHooks(
  hooks: TxHook[],
  phase: 'commit' | 'rollback',
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      // CATCH-WARN-OK: transaction-hook failure; telemetry.record() would re-enter the same tx machinery (commit/rollback hooks run after the outer tx finishes) and could mask the original error.
      console.warn(`[db] transaction ${phase} hook failed:`, err);
    }
  }
}

/**
 * Run fn inside a transaction. Auto-commits on success, rolls back on
 * throw. Used by spec 12 for atomic multi-row mutations (combat
 * resolution, inventory transfer, multi-field patches).
 *
 * On PGlite the transaction is real but serialised at the runtime
 * level — there's only one process. On managed Postgres the pool
 * grants a dedicated client for the duration.
 *
 * ARCH-16 — nested calls (`withTransaction` invoked while another
 * `withTransaction` is already on the stack) participate in the
 * outer transaction via a `SAVEPOINT`. A nested failure rolls back
 * to the savepoint, drops commit hooks registered inside the failed
 * block, and runs the rollback hooks registered inside that block
 * exactly once. A nested success releases the savepoint and lets its
 * commit hooks fire only after the outermost `COMMIT`. See
 * `docs/backend/transactions.md` for the full contract.
 */
export async function withTransaction<T>(
  fn: (client: TxClient) => Promise<T>,
): Promise<T> {
  const active = transactionStorage.getStore();
  if (active) {
    return runNestedSavepoint(active, fn);
  }

  const b = await ensureBackend();
  if (b === 'pg') {
    const client = await pgPool!.connect();
    let txContext: TransactionContext | null = null;
    try {
      await client.query('BEGIN');
      const wrap: TxClient = {
        query: async <U>(sql: string, params: unknown[] = []) => {
          const r = await client.query(sql, params);
          return { rows: r.rows as U[], rowCount: r.rowCount ?? r.rows.length };
        },
      };
      txContext = {
        client: wrap,
        commitHooks: [],
        rollbackHooks: [],
        savepointCounter: 0,
      };
      const result = await transactionStorage.run(txContext, () => fn(wrap));
      await client.query('COMMIT');
      await runTransactionHooks(txContext.commitHooks, 'commit');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* swallow */
      }
      if (txContext) {
        await runTransactionHooks(txContext.rollbackHooks, 'rollback');
      }
      throw err;
    } finally {
      client.release();
    }
  }
  await pgliteDb!.exec('BEGIN');
  let txContext: TransactionContext | null = null;
  const wrap: TxClient = {
    query: async <U>(sql: string, params: unknown[] = []) => {
      const r = await pgliteDb!.query<U>(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  try {
    txContext = {
      client: wrap,
      commitHooks: [],
      rollbackHooks: [],
      savepointCounter: 0,
    };
    const result = await transactionStorage.run(txContext, () => fn(wrap));
    await pgliteDb!.exec('COMMIT');
    await runTransactionHooks(txContext.commitHooks, 'commit');
    return result;
  } catch (err) {
    try {
      await pgliteDb!.exec('ROLLBACK');
    } catch {
      /* swallow */
    }
    if (txContext) {
      await runTransactionHooks(txContext.rollbackHooks, 'rollback');
    }
    throw err;
  }
}

/**
 * ARCH-16 — nested `withTransaction()` body. Issues a SAVEPOINT
 * through the existing transaction's client, scopes commit/rollback
 * hooks added inside, and bridges between RELEASE (on success) and
 * ROLLBACK TO + RELEASE (on failure). The savepoint identifier is
 * `greenhaven_sp_<n>` where `<n>` is a monotonic counter local to
 * the outer transaction — never user-controlled, safe to inline in
 * the SQL.
 */
async function runNestedSavepoint<T>(
  active: TransactionContext,
  fn: (client: TxClient) => Promise<T>,
): Promise<T> {
  active.savepointCounter += 1;
  const sp = `greenhaven_sp_${active.savepointCounter}`;
  const commitHookBaseline = active.commitHooks.length;
  const rollbackHookBaseline = active.rollbackHooks.length;
  await active.client.query(`SAVEPOINT ${sp}`);
  try {
    const result = await fn(active.client);
    await active.client.query(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    try {
      await active.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      // RELEASE after ROLLBACK TO so the savepoint name is freed
      // and subsequent siblings cannot accidentally re-target it.
      await active.client.query(`RELEASE SAVEPOINT ${sp}`);
    } catch (rbErr) {
      // CATCH-WARN-OK: SAVEPOINT rollback failure inside the very tx the telemetry sink would write through; recording here would re-enter the broken tx.
      console.warn(
        `[db] ROLLBACK TO SAVEPOINT ${sp} failed:`,
        rbErr instanceof Error ? rbErr.message : rbErr,
      );
    }
    // Commit hooks registered inside the failed nested block are
    // dropped — the writes they would have signalled rolled back.
    active.commitHooks.length = commitHookBaseline;
    // Rollback hooks registered inside the failed nested block run
    // once now and are removed from the outer context so the outer
    // `ROLLBACK` will not double-fire them.
    const innerRollbackHooks = active.rollbackHooks.splice(
      rollbackHookBaseline,
    );
    await runTransactionHooks(innerRollbackHooks, 'rollback');
    throw err;
  }
}

export async function dbHealth(): Promise<{
  ok: boolean;
  pgVersion?: string;
  pgvector?: boolean;
  database?: string;
  backend?: string;
  dataDir?: string;
  error?: string;
}> {
  try {
    const b = await ensureBackend();
    const ver = await query<{
      server_version: string;
      current_database: string;
    }>(
      `SELECT current_setting('server_version') AS server_version,
              current_database() AS current_database`,
    );
    const ext = await query<{ installed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_extension WHERE extname = 'vector'
       ) AS installed`,
    );
    return {
      ok: true,
      pgVersion: ver.rows[0]?.server_version,
      database: ver.rows[0]?.current_database,
      pgvector: ext.rows[0]?.installed === true,
      backend: b,
      dataDir:
        b === 'pglite' ? config().pgliteDataDir || DEFAULT_DATA_DIR : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function closeDb(): Promise<void> {
  if (backend === 'pg' && pgPool) {
    await pgPool.end();
    pgPool = null;
  } else if (backend === 'pglite' && pgliteDb) {
    await pgliteDb.close();
    pgliteDb = null;
  }
  backend = null;
  backendPromise = null;
}

export function getConnectivity(): {
  state: typeof connectivity;
  lastError?: string;
} {
  return { state: connectivity, lastError };
}
