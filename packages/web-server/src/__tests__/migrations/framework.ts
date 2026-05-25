import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Snapshot {
  tables: Record<string, unknown[]>;
}

export interface TestDb {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  snapshot(): Promise<Snapshot>;
  /**
   * Apply a single migration file by basename (e.g. `0111_turn_ingress_queue_unique_idx.sql`)
   * against the open PGlite database. Used by post-cutoff invariants
   * that seed pre-migration state with `withPristineDb({upToMigration})`
   * and then exercise the migration body directly. Matches the
   * template builder's `BEGIN; ... ; COMMIT;` shape so multi-statement
   * migrations and PL/pgSQL `DO $$ ... END $$` blocks both work.
   */
  applyMigrationFile(name: string): Promise<void>;
}

interface Template {
  dataDir: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// FEAT-ENGINE-BASELINE-3 — `withPristineDb()` and the migration
// invariant suite continue to exercise the historical chain (per-file
// invariants like 0111's queue_index unique index, 0112's advance_on
// normalization, etc.). Those .sql files now live under the prebaseline
// archive; the active migrations dir at `packages/web-server/migrations/`
// holds only post-baseline deltas and the bookkeeping manifest.
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'migrations',
  'archive-prebaseline',
);
const TEMPLATE_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '.tmp',
  'migration-test-templates',
);
const templates = new Map<string, Promise<Template>>();

export async function withPristineDb(
  fn: (db: TestDb) => Promise<void>,
  options: { upToMigration?: string } = {},
): Promise<void> {
  const dataDir = await createPristineDataDir(options);
  const db = await PGlite.create(dataDir, { extensions: { vector } });
  try {
    await fn(makeTestDb(db));
  } finally {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function createPristineDataDir(
  options: { upToMigration?: string } = {},
): Promise<string> {
  const template = await ensureTemplate(options.upToMigration);
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), 'greenhaven-migration-test-'),
  );
  await cp(template.dataDir, dataDir, { recursive: true });
  return dataDir;
}

export async function listMigrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

export async function cleanupMigrationTemplates(): Promise<void> {
  await Promise.allSettled(templates.values());
  templates.clear();
}

function makeTestDb(db: PGlite): TestDb {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const result = await db.query<T>(sql, params);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
    async snapshot(): Promise<Snapshot> {
      const tables = await this.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      );
      const out: Record<string, unknown[]> = {};
      for (const row of tables.rows) {
        const table = row.table_name;
        out[table] = (
          await this.query(`SELECT * FROM ${quoteIdent(table)} ORDER BY 1`)
        ).rows;
      }
      return { tables: out };
    },
    async applyMigrationFile(name: string): Promise<void> {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      try {
        await db.exec(`BEGIN; ${sql}; COMMIT;`);
      } catch (err) {
        throw new Error(
          `migration ${name} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        name,
      ]);
    },
  };
}

async function ensureTemplate(
  upToMigration: string | undefined,
): Promise<Template> {
  const files = selectMigrationFiles(await listMigrationFiles(), upToMigration);
  const key = await hashMigrationSet(files);
  const existing = templates.get(key);
  if (existing) return existing;
  const created = loadOrBuildTemplate(key, files);
  templates.set(key, created);
  return created;
}

async function loadOrBuildTemplate(
  key: string,
  files: string[],
): Promise<Template> {
  await mkdir(TEMPLATE_ROOT, { recursive: true });
  const dataDir = path.join(TEMPLATE_ROOT, key);
  if (await exists(path.join(dataDir, '.greenhaven-template-ready'))) {
    return { dataDir };
  }

  const stagingDir = await mkdtemp(
    path.join(TEMPLATE_ROOT, `${key}-building-`),
  );
  try {
    await buildTemplateAt(stagingDir, files);
    await writeFile(
      path.join(stagingDir, '.greenhaven-template-ready'),
      `${new Date().toISOString()}\n`,
      'utf8',
    );
    await rm(dataDir, { recursive: true, force: true });
    await rename(stagingDir, dataDir);
    return { dataDir };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

async function buildTemplateAt(
  dataDir: string,
  files: string[],
): Promise<void> {
  const db = await PGlite.create(dataDir, { extensions: { vector } });
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await db.exec(`BEGIN; ${sql}; COMMIT;`);
        await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          file,
        ]);
      } catch (err) {
        throw new Error(
          `migration ${file} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } finally {
    await db.close();
  }
}

function selectMigrationFiles(
  files: string[],
  upToMigration: string | undefined,
): string[] {
  if (!upToMigration) return files;
  const cutoff =
    files.find((file) => file === upToMigration) ??
    files.find((file) => file.startsWith(upToMigration));
  if (!cutoff) throw new Error(`unknown migration cutoff: ${upToMigration}`);
  return files.filter((file) => file <= cutoff);
}

function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`unsafe identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function hashMigrationSet(files: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(path.join(MIGRATIONS_DIR, file)));
    hash.update('\0');
  }
  return `all-${hash.digest('hex').slice(0, 16)}`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
