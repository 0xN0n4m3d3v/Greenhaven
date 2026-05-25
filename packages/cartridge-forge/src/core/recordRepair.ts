import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {loadProject, replaceRecord} from './projectStore.js';
import {readJsonl, writeJsonl} from './jsonl.js';
import type {IngestRecord} from './types.js';
import {recordFileName} from './recordFiles.js';

export interface SummaryRepairReport {
  ok: true;
  projectSlug: string;
  scanned: number;
  repaired: number;
  storage: StorageRepairReport;
  records: Array<{slug: string; kind: IngestRecord['kind']; summary: string}>;
}

export interface StorageRepairReport {
  moved: number;
  removedDuplicates: number;
}

export async function repairReadableSummaries(projectSlug: string): Promise<SummaryRepairReport> {
  const initialStorage = await repairRecordStorage(projectSlug);
  const loaded = await loadProject(projectSlug);
  const repaired: SummaryRepairReport['records'] = [];
  for (const record of loaded.records) {
    const next = repairRecordSummary(record);
    if (!next) continue;
    await replaceRecord(loaded.root, record, next);
    repaired.push({slug: next.slug, kind: next.kind, summary: next.summary});
  }
  const finalStorage = await repairRecordStorage(projectSlug);
  return {
    ok: true,
    projectSlug,
    scanned: loaded.records.length,
    repaired: repaired.length,
    storage: {
      moved: initialStorage.moved + finalStorage.moved,
      removedDuplicates: initialStorage.removedDuplicates + finalStorage.removedDuplicates,
    },
    records: repaired,
  };
}

export async function repairRecordStorage(projectSlug: string): Promise<StorageRepairReport> {
  const loaded = await loadProject(projectSlug);
  const recordsDir = path.join(loaded.root, 'records');
  const entries = await readdir(recordsDir, {withFileTypes: true});
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => path.join(recordsDir, entry.name));
  const selected = new Map<
    string,
    {record: IngestRecord; sourceFile: string; targetFile: string; score: number}
  >();
  let removedDuplicates = 0;

  for (const file of files) {
    for (const record of await readJsonl<IngestRecord>(file)) {
      const targetFile = path.join(recordsDir, recordFileName(record.kind));
      const score = recordScore(record, file === targetFile);
      const key = record.slug || record.record_id;
      const previous = selected.get(key);
      if (!previous || score > previous.score) {
        if (previous) removedDuplicates += 1;
        selected.set(key, {record, sourceFile: file, targetFile, score});
      } else {
        removedDuplicates += 1;
      }
    }
  }

  const byFile = new Map<string, IngestRecord[]>();
  for (const file of files) byFile.set(file, []);
  for (const item of selected.values()) {
    byFile.set(item.targetFile, [...(byFile.get(item.targetFile) ?? []), item.record]);
  }
  for (const [file, rows] of byFile) await writeJsonl(file, rows);

  return {
    moved: [...selected.values()].filter(item => item.sourceFile !== item.targetFile).length,
    removedDuplicates,
  };
}

export function repairRecordSummary(record: IngestRecord): IngestRecord | null {
  const summaryObject = parseSummaryObject(record.summary);
  const serviceSummary = Boolean(summaryObject || looksLikeServiceSummary(record.summary));

  const profile = parseProfile(record.payload.db_profile_json);
  const source = isRecord(profile?.source) ? profile.source : {};
  const role = isRecord(source.npc_role_in_cartridge)
    ? source.npc_role_in_cartridge
    : summaryObject ?? record.payload.imported_summary_object;
  const roleRecord = isRecord(role) ? role : {};

  const nextSummary = firstText([
    source.summary,
    source.description,
    source.personality_seed,
    source.npc_concept,
    source.relationship,
    source.appearance,
    source.role,
    source.description,
    profile?.narrator_brief,
    profile?.objective,
    profile?.description,
    record.payload.narrator_brief,
    record.payload.objective,
    record.payload.use_contract,
    record.payload.description,
    record.payload.summary,
    roleRecord.primary,
    summaryObject?.primary,
    summaryObject?.summary,
    summaryObject?.description,
    roleRecord.secondary,
    summaryObject?.secondary,
    summaryObject,
    record.canonical_name,
  ]);
  if (!serviceSummary && !shouldReplaceShortSummary(record.summary, nextSummary)) return null;

  const payload = {...record.payload};
  if (!payload.imported_summary_object) {
    if (summaryObject) payload.imported_summary_object = summaryObject;
    else if (isRecord(role)) payload.imported_summary_object = role;
  }

  return {
    ...record,
    summary: normalizeText(nextSummary),
    payload,
  };
}

function parseProfile(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseSummaryObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function looksLikeServiceSummary(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('{');
}

function recordScore(record: IngestRecord, canonicalFile: boolean): number {
  return (
    (canonicalFile ? 10 : 0) +
    (looksLikeServiceSummary(record.summary) ? 0 : 50) +
    (isRecord(record.payload.imported_summary_object) ? 8 : 0) +
    ((record.links?.length ?? 0) * 2) +
    (record.summary?.length ? 1 : 0)
  );
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const text = readableText(value);
    if (text) return text;
  }
  return 'Imported Greenhaven record.';
}

function readableText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(item => readableText(item, depth + 1))
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
  }
  if (!isRecord(value) || depth > 2) return '';

  const priorityKeys = [
    'summary',
    'description',
    'primary',
    'objective',
    'narrator_brief',
    'personality_seed',
    'npc_concept',
    'role',
    'use_contract',
    'class',
  ];
  for (const key of priorityKeys) {
    const text = readableText(value[key], depth + 1);
    if (text) return text;
  }

  const parts: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const text = readableText(child, depth + 1);
    if (!text) continue;
    parts.push(`${titleFromKey(key)}: ${text}`);
    if (parts.length >= 4) break;
  }
  return parts.join('. ');
}

function shouldReplaceShortSummary(current: string, candidate: string): boolean {
  const normalizedCurrent = normalizeText(current);
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedCandidate || normalizedCandidate === 'Imported Greenhaven record.') return false;
  if (!normalizedCurrent) return true;
  if (normalizedCurrent.startsWith('{')) return true;
  if (normalizedCandidate.length <= normalizedCurrent.length + 20) return false;
  const currentPrefix = normalizedCurrent.replace(/\.\.\.$/, '').slice(0, 180);
  return currentPrefix.length > 0 && normalizedCandidate.startsWith(currentPrefix);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function titleFromKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
