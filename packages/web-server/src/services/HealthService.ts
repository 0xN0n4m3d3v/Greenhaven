/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {dbHealth, getConnectivity, query} from '../db.js';

export class HealthService {
  static async health(): Promise<{
    ok: boolean;
    cwd: string;
    db: Record<string, unknown>;
  }> {
    const status = await dbHealth();
    const conn = getConnectivity();
    return {
      ok: status.ok,
      cwd: process.cwd(),
      db: {...status, connectivity: conn.state, lastError: conn.lastError},
    };
  }

  static async dbStatus(): Promise<Record<string, unknown>> {
    const status = await dbHealth();
    const conn = getConnectivity();
    return {
      ...status,
      connectivity: conn.state,
      lastError: conn.lastError,
    };
  }

  static async tableCounts(): Promise<Record<string, number>> {
    const tables = await query<{tablename: string}>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const counts: Record<string, number> = {};
    for (const t of tables.rows) {
      const tableName = t.tablename;
      const r = await query<{n: number}>(
        `SELECT count(*)::int AS n FROM ${quoteIdent(tableName)}`,
      );
      counts[tableName] = Number(r.rows[0]?.n ?? 0);
    }
    return counts;
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
