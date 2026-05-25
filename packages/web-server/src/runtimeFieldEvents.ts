/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 30 — broadcast every runtime_field mutation over SSE so the
// UI's useRuntimeFields hook can update without polling. Tools that
// mutate runtime_values call emitFieldChange; the SessionManager
// looks up the live session and pushes a `runtime:field` event.

import {query} from './db.js';
import {sessionManager} from './sessionManager.js';

export interface RuntimeFieldChange {
  owner_entity_id: number;
  field_key: string;
  value: unknown;
  source: string;
}

export interface RuntimeFieldChangeById {
  field_id: number;
  source: string;
  value?: unknown;
}

interface RuntimeFieldEventRow {
  id: number;
  owner_entity_id: number;
  field_key: string;
  current_value: unknown;
}

export function emitFieldChange(
  sessionId: string,
  change: RuntimeFieldChange,
): void {
  const session = sessionManager.get(sessionId);
  // SSE-OK: emit outside tx (reason: SseBridge.emit auto-defers
  // via onTransactionCommit when the caller wrote the
  // runtime_values row inside withTransaction(...); outside a tx
  // the emit fires immediately because no row was written).
  session?.sse.emit('runtime:field', change);
}

export function emitFieldChanges(
  sessionId: string,
  changes: RuntimeFieldChange[],
): void {
  const session = sessionManager.get(sessionId);
  if (!session) return;
  // SSE-OK: emit outside tx (reason: same as emitFieldChange —
  // SseBridge.emit auto-defers each event via onTransactionCommit
  // when called inside withTransaction).
  for (const c of changes) session.sse.emit('runtime:field', c);
}

export async function emitFieldChangesById(
  sessionId: string,
  changes: RuntimeFieldChangeById[],
): Promise<void> {
  const session = sessionManager.get(sessionId);
  if (!session || changes.length === 0) return;

  const ids = [...new Set(changes.map(change => change.field_id))];
  const rows = await query<RuntimeFieldEventRow>(
    `SELECT f.id,
            f.owner_entity_id,
            f.field_key,
            COALESCE(v.value, f.default_value) AS current_value
       FROM runtime_fields f
       LEFT JOIN runtime_values v ON v.field_id = f.id
      WHERE f.id = ANY($1::bigint[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map(row => [Number(row.id), row]));

  for (const change of changes) {
    const row = byId.get(change.field_id);
    if (!row) continue;
    const hasExplicitValue = Object.prototype.hasOwnProperty.call(
      change,
      'value',
    );
    // SSE-OK: emit outside tx (reason: SseBridge.emit auto-defers
    // via onTransactionCommit when the runtime_values write
    // happened inside withTransaction).
    session.sse.emit('runtime:field', {
      owner_entity_id: Number(row.owner_entity_id),
      field_key: row.field_key,
      value: hasExplicitValue ? change.value : row.current_value,
      source: change.source,
    });
  }
}
