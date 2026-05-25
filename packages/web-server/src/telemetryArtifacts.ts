/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { query } from './db.js';
import {
  recordTelemetryArtifact,
  type TelemetryArtifactInput,
  type TelemetryContext,
  type TelemetryRedactionTier,
} from './telemetryLake.js';

export interface TelemetryArtifactFile {
  artifactType: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
}

export interface WriteTelemetryJsonArtifactInput {
  artifactType: string;
  filenamePrefix: string;
  payload: unknown;
  context?: TelemetryContext;
  redactionTier?: TelemetryRedactionTier;
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface WriteTelemetryTextArtifactInput {
  artifactType: string;
  filenamePrefix: string;
  content: string;
  mimeType: string;
  extension?: string;
  context?: TelemetryContext;
  redactionTier?: TelemetryRedactionTier;
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface TelemetryRetentionOptions {
  safeDays?: number;
  debugDays?: number;
  sensitiveDays?: number;
  metricDays?: number;
  performanceDays?: number;
  artifactDays?: number;
  maxArtifactBytes?: number;
  dryRun?: boolean;
}

export interface TelemetryRetentionResult {
  dryRun: boolean;
  thresholds: Record<string, string>;
  deletedRows: Record<string, number>;
  artifactFiles: {
    candidates: number;
    deleted: number;
    skipped: number;
    bytes: number;
  };
}

export type TelemetryArtifactPathRow = {
  id: number | string;
  path: string;
  size_bytes: number | string | null;
};

const ARTIFACT_SUBDIRS = [
  'bundles',
  'exports',
  'traces',
  'profiles',
  'heap',
  'netlog',
  'replay',
  'screenshots',
  'crashes',
  'logs',
  'misc',
];

export function telemetryDataRoot(): string {
  return (
    config().dataDir ||
    config().pgliteDataDir ||
    path.resolve(process.cwd(), '.tmp', 'greenhaven-data')
  );
}

export function telemetryRoot(): string {
  return path.join(telemetryDataRoot(), 'telemetry');
}

export function telemetryArtifactRoot(): string {
  return path.join(telemetryRoot(), 'artifacts');
}

export async function ensureTelemetryArtifactFolders(): Promise<string> {
  const root = telemetryArtifactRoot();
  await mkdir(root, { recursive: true });
  for (const subdir of ARTIFACT_SUBDIRS) {
    await mkdir(path.join(root, subdir), { recursive: true });
  }
  return root;
}

export async function writeTelemetryJsonArtifact(
  input: WriteTelemetryJsonArtifactInput,
): Promise<TelemetryArtifactFile> {
  await ensureTelemetryArtifactFolders();
  const artifactType = sanitizeArtifactType(input.artifactType);
  const subdir = artifactSubdir(artifactType);
  const filename = `${sanitizeFilename(input.filenamePrefix)}-${timestampForFilename()}-${randomUUID()}.json`;
  const filePath = path.join(telemetryArtifactRoot(), subdir, filename);
  const json = `${JSON.stringify(input.payload, null, 2)}\n`;
  await writeFile(filePath, json, 'utf8');
  const size = Buffer.byteLength(json, 'utf8');
  const sha256 = sha256Buffer(Buffer.from(json, 'utf8'));
  await recordTelemetryArtifact({
    ...(input.context ?? {}),
    artifactType,
    path: filePath,
    sizeBytes: size,
    sha256,
    mimeType: 'application/json',
    redactionTier: input.redactionTier ?? 'tier1_local_debug',
    metadata: input.metadata,
    source: input.source ?? 'greenhaven.telemetry_artifacts',
  });
  return {
    artifactType,
    path: filePath,
    sizeBytes: size,
    sha256,
    mimeType: 'application/json',
  };
}

export async function writeTelemetryTextArtifact(
  input: WriteTelemetryTextArtifactInput,
): Promise<TelemetryArtifactFile> {
  await ensureTelemetryArtifactFolders();
  const artifactType = sanitizeArtifactType(input.artifactType);
  const subdir = artifactSubdir(artifactType);
  const extension = sanitizeExtension(input.extension ?? 'txt');
  const filename = `${sanitizeFilename(input.filenamePrefix)}-${timestampForFilename()}-${randomUUID()}.${extension}`;
  const filePath = path.join(telemetryArtifactRoot(), subdir, filename);
  await writeFile(filePath, input.content, 'utf8');
  const size = Buffer.byteLength(input.content, 'utf8');
  const sha256 = sha256Buffer(Buffer.from(input.content, 'utf8'));
  await recordTelemetryArtifact({
    ...(input.context ?? {}),
    artifactType,
    path: filePath,
    sizeBytes: size,
    sha256,
    mimeType: input.mimeType,
    redactionTier: input.redactionTier ?? 'tier1_local_debug',
    metadata: input.metadata,
    source: input.source ?? 'greenhaven.telemetry_artifacts',
  });
  return {
    artifactType,
    path: filePath,
    sizeBytes: size,
    sha256,
    mimeType: input.mimeType,
  };
}

export async function indexTelemetryArtifactFile(
  input: TelemetryArtifactInput,
): Promise<TelemetryArtifactFile | null> {
  const filePath = path.resolve(input.path);
  let sizeBytes = input.sizeBytes ?? null;
  let sha256 = input.sha256 ?? null;
  try {
    const s = await stat(filePath);
    if (s.isFile()) {
      sizeBytes = s.size;
      sha256 = sha256 ?? (await sha256File(filePath));
    }
  } catch {
    // Some artifacts, especially crash metadata, can be indexed before a
    // platform writer flushes the file. Keep the row but mark missing size/hash.
  }
  await recordTelemetryArtifact({
    ...input,
    path: filePath,
    sizeBytes,
    sha256,
  });
  return {
    artifactType: input.artifactType,
    path: filePath,
    sizeBytes: Number(sizeBytes ?? 0),
    sha256: sha256 ?? '',
    mimeType: input.mimeType ?? 'application/octet-stream',
  };
}

export async function deleteTelemetryArtifactFilesForSession(
  sessionId: string,
): Promise<TelemetryRetentionResult['artifactFiles']> {
  return deleteTelemetryArtifactFiles(
    await listTelemetryArtifactFilesForSession(sessionId),
  );
}

export async function listTelemetryArtifactFilesForSession(
  sessionId: string,
): Promise<TelemetryArtifactPathRow[]> {
  const rows = await query<TelemetryArtifactPathRow>(
    `SELECT id, path, size_bytes
       FROM telemetry_artifacts
      WHERE session_id = $1`,
    [sessionId],
  );
  return rows.rows;
}

export async function deleteAllTelemetryArtifactFiles(): Promise<
  TelemetryRetentionResult['artifactFiles']
> {
  return deleteTelemetryArtifactFiles(await listAllTelemetryArtifactFiles());
}

export async function listAllTelemetryArtifactFiles(): Promise<
  TelemetryArtifactPathRow[]
> {
  const rows = await query<TelemetryArtifactPathRow>(
    `SELECT id, path, size_bytes FROM telemetry_artifacts`,
  );
  return rows.rows;
}

export async function deleteTelemetryArtifactFiles(
  rows: TelemetryArtifactPathRow[],
): Promise<TelemetryRetentionResult['artifactFiles']> {
  return deleteArtifactFiles(rows);
}

export async function applyTelemetryRetention(
  opts: TelemetryRetentionOptions = {},
): Promise<TelemetryRetentionResult> {
  const dryRun = opts.dryRun === true;
  const now = Date.now();
  const thresholds = {
    tier0_safe: cutoffIso(now, opts.safeDays ?? 30),
    tier1_local_debug: cutoffIso(now, opts.debugDays ?? 7),
    tier2_sensitive_local: cutoffIso(now, opts.sensitiveDays ?? 1),
    metric: cutoffIso(now, opts.metricDays ?? opts.safeDays ?? 30),
    performance: cutoffIso(now, opts.performanceDays ?? opts.safeDays ?? 30),
    artifact: cutoffIso(now, opts.artifactDays ?? opts.debugDays ?? 7),
  };
  const deletedRows: Record<string, number> = {};

  const artifactRows = await collectRetentionArtifactRows(
    thresholds,
    opts.maxArtifactBytes,
  );
  const artifactFiles = dryRun
    ? summarizeArtifactRows(artifactRows)
    : await deleteArtifactFiles(artifactRows);

  for (const tier of [
    'tier0_safe',
    'tier1_local_debug',
    'tier2_sensitive_local',
  ] as const) {
    deletedRows[`telemetry_spans.${tier}`] = await deleteOrCount(
      dryRun,
      `telemetry_spans`,
      `redaction_tier = $1 AND recorded_at < $2::timestamptz`,
      [tier, thresholds[tier]],
    );
    deletedRows[`telemetry_events.${tier}`] = await deleteOrCount(
      dryRun,
      `telemetry_events`,
      `redaction_tier = $1 AND occurred_at < $2::timestamptz`,
      [tier, thresholds[tier]],
    );
  }

  deletedRows.telemetry_artifacts = await deleteArtifactRows(
    dryRun,
    artifactRows.map((row) => Number(row.id)),
  );
  deletedRows.telemetry_metrics = await deleteOrCount(
    dryRun,
    'telemetry_metrics',
    `bucket_start < $1::timestamptz`,
    [thresholds.metric],
  );
  deletedRows.telemetry_eval_scores = await deleteOrCount(
    dryRun,
    'telemetry_eval_scores',
    `recorded_at < $1::timestamptz`,
    [thresholds.tier1_local_debug],
  );
  deletedRows.telemetry_sessions = await deleteOrCount(
    dryRun,
    'telemetry_sessions',
    `started_at < $1::timestamptz
     AND COALESCE(ended_at, started_at) < $1::timestamptz`,
    [thresholds.tier0_safe],
  );
  deletedRows.performance_events = await deleteOrCount(
    dryRun,
    'performance_events',
    `recorded_at < $1::timestamptz`,
    [thresholds.performance],
  );

  return { dryRun, thresholds, deletedRows, artifactFiles };
}

async function collectRetentionArtifactRows(
  thresholds: TelemetryRetentionResult['thresholds'],
  maxArtifactBytes: number | undefined,
): Promise<TelemetryArtifactPathRow[]> {
  const ageRows = await query<TelemetryArtifactPathRow>(
    `SELECT id, path, size_bytes
       FROM telemetry_artifacts
      WHERE recorded_at < $1::timestamptz
         OR (redaction_tier = 'tier0_safe'
             AND recorded_at < $2::timestamptz)
         OR (redaction_tier = 'tier1_local_debug'
             AND recorded_at < $3::timestamptz)
         OR (redaction_tier = 'tier2_sensitive_local'
             AND recorded_at < $4::timestamptz)`,
    [
      thresholds.artifact,
      thresholds.tier0_safe,
      thresholds.tier1_local_debug,
      thresholds.tier2_sensitive_local,
    ],
  );
  const selected = new Map<number, TelemetryArtifactPathRow>();
  for (const row of ageRows.rows) selected.set(Number(row.id), row);

  const maxBytes = Number(maxArtifactBytes ?? 0);
  if (Number.isFinite(maxBytes) && maxBytes > 0) {
    const allRows = await query<TelemetryArtifactPathRow>(
      `SELECT id, path, size_bytes
         FROM telemetry_artifacts
        ORDER BY recorded_at DESC, id DESC`,
    );
    let keptBytes = 0;
    for (const row of allRows.rows) {
      const size = Number(row.size_bytes ?? 0);
      keptBytes += Number.isFinite(size) ? Math.max(0, size) : 0;
      if (keptBytes > maxBytes) selected.set(Number(row.id), row);
    }
  }

  return [...selected.values()];
}

async function deleteArtifactRows(
  dryRun: boolean,
  ids: number[],
): Promise<number> {
  const unique = [
    ...new Set(ids.filter((id) => Number.isFinite(id) && id > 0)),
  ];
  if (unique.length === 0) return 0;
  if (dryRun) return unique.length;
  const result = await query(
    `DELETE FROM telemetry_artifacts WHERE id = ANY($1::bigint[])`,
    [unique],
  );
  return result.rowCount ?? unique.length;
}

async function deleteOrCount(
  dryRun: boolean,
  table: string,
  whereSql: string,
  params: unknown[],
): Promise<number> {
  if (dryRun) {
    const result = await query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${whereSql}`,
      params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await query(`DELETE FROM ${table} WHERE ${whereSql}`, params);
  return result.rowCount ?? 0;
}

async function deleteArtifactFiles(
  rows: TelemetryArtifactPathRow[],
): Promise<TelemetryRetentionResult['artifactFiles']> {
  let deleted = 0;
  let skipped = 0;
  let bytes = 0;
  for (const row of rows) {
    const filePath = path.resolve(row.path);
    if (!isManagedTelemetryArtifact(filePath)) {
      skipped += 1;
      continue;
    }
    try {
      const size = Number(row.size_bytes ?? 0);
      await rm(filePath, { force: true });
      deleted += 1;
      bytes += Number.isFinite(size) ? Math.max(0, size) : 0;
    } catch {
      skipped += 1;
    }
  }
  return { candidates: rows.length, deleted, skipped, bytes };
}

function summarizeArtifactRows(
  rows: TelemetryArtifactPathRow[],
): TelemetryRetentionResult['artifactFiles'] {
  return {
    candidates: rows.length,
    deleted: 0,
    skipped: rows.filter(
      (row) => !isManagedTelemetryArtifact(path.resolve(row.path)),
    ).length,
    bytes: rows.reduce((sum, row) => {
      const size = Number(row.size_bytes ?? 0);
      return sum + (Number.isFinite(size) ? Math.max(0, size) : 0);
    }, 0),
  };
}

function isManagedTelemetryArtifact(filePath: string): boolean {
  const root = path.resolve(telemetryArtifactRoot());
  const rel = path.relative(root, path.resolve(filePath));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function sha256File(filePath: string): Promise<string> {
  return sha256Buffer(await readFile(filePath));
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function sanitizeArtifactType(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '_')
      .slice(0, 80) || 'artifact'
  );
}

function artifactSubdir(artifactType: string): string {
  if (artifactType.includes('bundle')) return 'bundles';
  if (artifactType.includes('export')) return 'exports';
  if (artifactType.includes('trace')) return 'traces';
  if (artifactType.includes('profile')) return 'profiles';
  if (artifactType.includes('heap')) return 'heap';
  if (artifactType.includes('netlog')) return 'netlog';
  if (artifactType.includes('replay')) return 'replay';
  if (artifactType.includes('screenshot')) return 'screenshots';
  if (artifactType.includes('crash')) return 'crashes';
  if (artifactType.includes('log')) return 'logs';
  return 'misc';
}

function sanitizeFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .slice(0, 80) || 'artifact'
  );
}

function sanitizeExtension(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 12) || 'txt'
  );
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function cutoffIso(now: number, days: number): string {
  const safeDays = Number.isFinite(days) ? Math.max(0, days) : 0;
  return new Date(now - safeDays * 24 * 60 * 60 * 1000).toISOString();
}
