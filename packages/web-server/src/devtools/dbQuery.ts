/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';

export interface DbQueryOptions {
  sql: string;
  params?: unknown[];
  limit?: number;
}

export interface DbQueryResult {
  ok: true;
  readonly: true;
  limit: number;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MUTATING_TOKENS = /\b(update|delete|insert|alter|drop|truncate|create|grant|revoke|copy|call|do|merge|replace|vacuum|analyze|comment|lock)\b/i;
const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|cookie|recovery|hash|authorization)/i;

export async function runReadOnlyQuery(
  options: DbQueryOptions,
): Promise<DbQueryResult> {
  const sql = normalizeSql(options.sql);
  assertReadOnlySql(sql);
  const limit = clampLimit(options.limit);
  const wrapped = `SELECT * FROM (${sql}) AS greenhaven_db_query LIMIT ${limit}`;
  const result = await query<Record<string, unknown>>(
    wrapped,
    options.params ?? [],
  );
  return {
    ok: true,
    readonly: true,
    limit,
    rowCount: result.rows.length,
    rows: result.rows.map(row => redactRecord(row) as Record<string, unknown>),
  };
}

export function assertReadOnlySql(sqlInput: string): void {
  const sql = normalizeSql(sqlInput);
  const lowered = stripSqlStringsAndComments(sql).toLowerCase();
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('db_query only allows SELECT or WITH queries');
  }
  if (containsStatementSeparator(sql)) {
    throw new Error('db_query rejects multi-statement SQL');
  }
  if (MUTATING_TOKENS.test(lowered)) {
    throw new Error('db_query rejects mutating or administrative SQL');
  }
}

export function normalizeSql(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error('SQL is empty');
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
}

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return Math.min(limit, MAX_LIMIT);
}

function containsStatementSeparator(sql: string): boolean {
  let single = false;
  let double = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (single) {
      if (ch === "'" && next === "'") {
        i += 1;
      } else if (ch === "'") {
        single = false;
      }
      continue;
    }
    if (double) {
      if (ch === '"' && next === '"') {
        i += 1;
      } else if (ch === '"') {
        double = false;
      }
      continue;
    }
    if (ch === "'") {
      single = true;
      continue;
    }
    if (ch === '"') {
      double = true;
      continue;
    }
    if (ch === ';') return true;
  }
  return false;
}

function stripSqlStringsAndComments(sql: string): string {
  let out = '';
  let single = false;
  let double = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (single) {
      if (ch === "'" && next === "'") {
        i += 1;
      } else if (ch === "'") {
        single = false;
      }
      out += ' ';
      continue;
    }
    if (double) {
      if (ch === '"' && next === '"') {
        i += 1;
      } else if (ch === '"') {
        double = false;
      }
      out += ' ';
      continue;
    }
    if (ch === '-' && next === '-') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      single = true;
      out += ' ';
      continue;
    }
    if (ch === '"') {
      double = true;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

export function redactRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRecord);
  if (value instanceof Date) return value.toISOString();
  if (value == null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactRecord(child);
  }
  return out;
}
