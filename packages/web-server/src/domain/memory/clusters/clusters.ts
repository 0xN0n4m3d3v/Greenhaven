/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 137: deterministic memory clusters as story arcs. First pass avoids
// model calls and stores summaries in cluster metadata, never by rewriting
// member memories.

import {createHash} from 'node:crypto';
import {query} from '../../../db.js';

interface MemoryRow {
  id: number;
  owner_entity_id: number;
  about_entity_id: number | null;
  memory_family: string | null;
  memory_kind: string | null;
  tags: string[];
  salience: number;
  reference_count: number;
}

interface ClusterMemberRow {
  id: number;
  salience: number;
  reference_count: number;
}

export async function assignMemoryCluster(
  memoryId: number,
): Promise<string | null> {
  const row = await loadMemory(memoryId);
  if (!row) return null;
  const clusterId = deterministicClusterId(row);
  const title = clusterTitle(row);
  await query(
    `INSERT INTO memory_clusters
       (id, owner_entity_id, about_entity_id, memory_family, title, summary,
        tags, memory_ids, salience, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb, $9, $10::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       memory_family = EXCLUDED.memory_family,
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       tags = EXCLUDED.tags,
       metadata = memory_clusters.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      clusterId,
      row.owner_entity_id,
      row.about_entity_id,
      row.memory_family ?? 'world',
      title,
      clusterSummary(row),
      (row.tags ?? []).slice(0, 12),
      JSON.stringify([row.id]),
      row.salience,
      JSON.stringify({
        family: row.memory_family,
        kind: row.memory_kind,
        deterministic: true,
      }),
    ],
  );
  await query(
    `UPDATE npc_memories
        SET cluster_id = $2,
            updated_at = now()
      WHERE id = $1`,
    [row.id, clusterId],
  );
  await recomputeClusterSalience(clusterId);
  return clusterId;
}

export async function recomputeClusterSalience(
  clusterId: string,
): Promise<number> {
  const rows = await query<ClusterMemberRow>(
    `SELECT id, salience, reference_count
       FROM npc_memories
      WHERE cluster_id = $1`,
    [clusterId],
  );
  if (rows.rows.length === 0) return 0;
  const salience =
    rows.rows.reduce(
      (sum, row) =>
        sum + Number(row.salience ?? 0) * (1 + Math.min(5, Number(row.reference_count ?? 0)) * 0.05),
      0,
    ) / rows.rows.length;
  const bounded = Math.max(0, Math.min(1, salience));
  await query(
    `UPDATE memory_clusters
        SET salience = $2,
            memory_ids = $3::jsonb,
            metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [
      clusterId,
      bounded,
      JSON.stringify(rows.rows.map(row => row.id)),
      JSON.stringify({member_count: rows.rows.length, recomputed_at: new Date().toISOString()}),
    ],
  );
  return bounded;
}

async function loadMemory(memoryId: number): Promise<MemoryRow | null> {
  const rows = await query<MemoryRow>(
    `SELECT id, owner_entity_id, about_entity_id, memory_family, memory_kind,
            tags, salience, reference_count
       FROM npc_memories
      WHERE id = $1
      LIMIT 1`,
    [memoryId],
  );
  return rows.rows[0] ?? null;
}

function deterministicClusterId(row: MemoryRow): string {
  const keyTags = (row.tags ?? [])
    .filter(tag => !tag.startsWith('source:'))
    .slice()
    .sort()
    .slice(0, 4)
    .join(',');
  const raw = [
    row.owner_entity_id,
    row.about_entity_id ?? 'ambient',
    row.memory_family ?? 'world',
    row.memory_kind ?? 'world_fact',
    keyTags,
  ].join('|');
  return `memcl_${createHash('sha1').update(raw).digest('hex').slice(0, 16)}`;
}

function clusterTitle(row: MemoryRow): string {
  const family = row.memory_family ?? 'world';
  const subject = row.about_entity_id != null ? `entity ${row.about_entity_id}` : 'ambient';
  const tagHint = (row.tags ?? []).filter(Boolean).slice(0, 2).join(', ');
  return `${capitalize(family)} thread: ${subject}${tagHint ? ` (${tagHint})` : ''}`;
}

function clusterSummary(row: MemoryRow): string {
  const kind = row.memory_kind ?? 'world_fact';
  const family = row.memory_family ?? 'world';
  const subject = row.about_entity_id != null ? `entity ${row.about_entity_id}` : 'ambient context';
  return `${family}/${kind} memories for ${subject}.`;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
