/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 137: guarded memory maintenance. Best-effort and fail-open; gameplay
// turns must never block on this path.

import {query} from '../../../db.js';

export interface MemoryMaintenanceResult {
  ran: boolean;
  skipped?: boolean;
  decayed: number;
  repairedFamilies: number;
  error?: string;
}

const META_KEY = 'memory_maintenance';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_DECAY_AFTER_DAYS = 7;
const DEFAULT_DECAY = 0.03;

let inFlight: Promise<MemoryMaintenanceResult> | null = null;

export async function maybeRunMemoryMaintenance(options: {
  force?: boolean;
  nowMs?: number;
} = {}): Promise<MemoryMaintenanceResult> {
  if (inFlight) return inFlight;
  inFlight = runMemoryMaintenance(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function runMemoryMaintenance(options: {
  force?: boolean;
  nowMs?: number;
  intervalMs?: number;
  decayAfterDays?: number;
  decay?: number;
} = {}): Promise<MemoryMaintenanceResult> {
  const nowMs = options.nowMs ?? Date.now();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const meta = await loadMeta();
  const lastRunMs = Number(meta['last_run_ms'] ?? 0);
  if (!options.force && Number.isFinite(lastRunMs) && nowMs - lastRunMs < intervalMs) {
    return {ran: false, skipped: true, decayed: 0, repairedFamilies: 0};
  }

  const repairedFamilies = await repairMissingFamilies();
  const decayed = await decaySalience({
    decayAfterDays: options.decayAfterDays ?? DEFAULT_DECAY_AFTER_DAYS,
    decay: options.decay ?? DEFAULT_DECAY,
  });
  await saveMeta({
    last_run_ms: nowMs,
    last_run_at: new Date(nowMs).toISOString(),
    decayed,
    repaired_families: repairedFamilies,
  });
  return {ran: true, decayed, repairedFamilies};
}

export function runMemoryMaintenanceFailOpen(options: {
  force?: boolean;
  nowMs?: number;
} = {}): void {
  // VOID-FF-OK: Spec 137 fail-open scheduler — gameplay turns must never block on memory maintenance; the explicit `.catch` below is the failure surface.
  void maybeRunMemoryMaintenance(options).catch(err => {
    // CATCH-WARN-OK: top-level fail-open boundary for the Spec 137 memory-maintenance scheduler. No paired telemetry exists today because the scheduler intentionally has no separate telemetry channel — its caller (turn lifecycle) treats it as fire-and-forget and the next scheduled run retries. Adding telemetry here would create the only consumer of a new channel and is recorded in the X-3/X-4 carry-forward as "wire memoryMaintenance into the telemetry facade" rather than a sweep fix.
    console.warn(
      '[memory_maintenance] skipped:',
      err instanceof Error ? err.message : err,
    );
  });
}

async function decaySalience(args: {
  decayAfterDays: number;
  decay: number;
}): Promise<number> {
  const rows = await query(
    `UPDATE npc_memories
        SET salience = GREATEST(
              CASE memory_kind
                WHEN 'trauma_memory' THEN 0.55
                WHEN 'promise' THEN 0.50
                WHEN 'quest_lesson' THEN 0.45
                ELSE 0.05
              END,
              LEAST(1.0, GREATEST(0.0, salience * (1.0 - $2::real)))
            ),
            updated_at = now()
      WHERE COALESCE(last_referenced_at, created_at) < now() - ($1::text || ' days')::interval
        AND salience > CASE memory_kind
              WHEN 'trauma_memory' THEN 0.55
              WHEN 'promise' THEN 0.50
              WHEN 'quest_lesson' THEN 0.45
              ELSE 0.05
            END`,
    [String(args.decayAfterDays), args.decay],
  );
  return rows.rowCount;
}

async function repairMissingFamilies(): Promise<number> {
  const rows = await query(
    `UPDATE npc_memories
        SET memory_family = CASE memory_kind
              WHEN 'bond_memory' THEN 'relationship'
              WHEN 'quest_lesson' THEN 'quest'
              WHEN 'trauma_memory' THEN 'safety'
              WHEN 'promise' THEN 'commitment'
              WHEN 'failure_pattern' THEN 'lesson'
              WHEN 'desire_or_boundary' THEN 'preference'
              ELSE 'world'
            END,
            updated_at = now()
      WHERE memory_family IS NULL
         OR memory_family = ''`,
  );
  return rows.rowCount;
}

async function loadMeta(): Promise<Record<string, unknown>> {
  const rows = await query<{value: Record<string, unknown>}>(
    `SELECT value
       FROM cartridge_meta
      WHERE key = $1
      LIMIT 1`,
    [META_KEY],
  );
  const value = rows.rows[0]?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function saveMeta(value: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO cartridge_meta (key, value, description, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       description = EXCLUDED.description,
       updated_at = now()`,
    [
      META_KEY,
      JSON.stringify(value),
      'Memory Palace maintenance guard and last-run diagnostics.',
    ],
  );
}
