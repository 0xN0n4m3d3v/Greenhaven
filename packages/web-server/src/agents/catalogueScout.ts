/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 42 — Catalogue Scout.
//
// Async post-turn observer. Reads turnRecord.toolHistory for
// create_entity / create_quest tool calls, fuzzy-matches each new
// entity's display_name against existing entities of the same kind,
// and emits an `entity:duplicate_warning` SSE for the frontend to
// render an informational EventCard.
//
// Hybrid approach:
//   - 0.0 .. 0.7  : unique, no action
//   - 0.7 .. 0.89 : ambiguous → call LLM for verdict
//   - 0.9 .. 1.0  : near-certain duplicate, emit warning directly
//                   without LLM call
//
// MVP is advisory-only — never mutates DB. Auto-merge with FK
// updates is a future follow-up.
//
// Fail-open: any error inside the hook is caught at the
// turnRunnerV2 level (fire-and-forget); the turn is unaffected.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import {
  runSpecialist,
  type PostTurnHook,
  type SpecialistContext,
  type SpecialistDef,
} from './base.js';
import {catalogueScoutPrompt} from './catalogueScoutPrompt.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
  POST_TURN_SPECIALIST_WATCHDOG_MS,
} from '../postTurnTiming.js';

// ── Public hook ────────────────────────────────────────────────────────

export const catalogueScoutHook: PostTurnHook = {
  name: 'catalogue_scout',
  presentation: {
    slotKey: 'post.catalogue_scout',
    lane: 'rail',
    ordinal: 60,
    visible: false,
    barrierMode: 'non_blocking',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, turnRecord) {
    const newEntities = await extractNewEntities(turnRecord.toolHistory);
    if (newEntities.length === 0) return;

    for (const entity of newEntities) {
      try {
        const candidates = await findFuzzyCandidates(
          entity.kind,
          entity.display_name,
          entity.id,
          5,
        );
        if (candidates.length === 0) continue;

        const top = candidates[0]!;

        if (top.score >= 0.9) {
          // Near-certain duplicate — emit warning directly.
          await emitWarning(ctx, {
            new_entity_id: entity.id,
            new_name: entity.display_name,
            kind: entity.kind,
            verdict: 'merge',
            best_match_id: top.id,
            best_match_name: top.display_name,
            score: top.score,
            reason: `Near-identical name to existing @${top.display_name} (score=${top.score.toFixed(2)}). Likely duplicate.`,
            candidates: candidates.map(c => ({
              id: c.id,
              display_name: c.display_name,
              score: c.score,
            })),
          });
          continue;
        }

        if (top.score >= 0.7) {
          // Ambiguous band — defer to LLM verdict.
          const verdict = await runSpecialist(
            scoutDef,
            {
              new_entity: {
                kind: entity.kind,
                display_name: entity.display_name,
              },
              candidates,
            },
            ctx,
          );
          if (!verdict) continue;
          if (verdict.verdict === 'unique' || verdict.verdict === 'keep_both') {
            // No warning — Scout is conservative on the ambiguous band.
            continue;
          }
          await emitWarning(ctx, {
            new_entity_id: entity.id,
            new_name: entity.display_name,
            kind: entity.kind,
            verdict: verdict.verdict,
            best_match_id: verdict.best_match_id ?? top.id,
            best_match_name:
              candidates.find(c => c.id === verdict.best_match_id)
                ?.display_name ?? top.display_name,
            score: top.score,
            reason: verdict.reasoning,
            candidates: candidates.map(c => ({
              id: c.id,
              display_name: c.display_name,
              score: c.score,
            })),
          });
        }
        // score < 0.7 → unique; no further action.
      } catch (err) {
        // CATCH-WARN-OK: per-entity scout iteration; the specialist's outer `runSpecialist` wrapper records the run's `ok` / failureReason through `recordAgentTelemetry` in base.ts, so individual entity failures are already aggregated into the agent's telemetry summary on its way out.
        console.warn(
          `[agent:catalogue_scout] entity ${entity.id} (${entity.display_name}) failed (continuing):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  },
};

// ── Specialist definition (LLM call for ambiguous band only) ──────────

const ScoutOutput = z.object({
  verdict: z.enum(['merge', 'rename', 'keep_both', 'unique']),
  best_match_id: z.number().int().nullable(),
  reasoning: z.string().min(1).max(400),
  recommended_action: z.enum(['use_existing', 'rename', 'keep_both']),
});

interface ScoutInput {
  new_entity: {kind: string; display_name: string};
  candidates: Array<{
    id: number;
    display_name: string;
    summary: string | null;
    score: number;
  }>;
}

const scoutDef: SpecialistDef<ScoutInput, z.infer<typeof ScoutOutput>> = {
  name: 'catalogue_scout',
  mode: 'async',
  buildPrompt(input) {
    return {
      system: catalogueScoutPrompt.system,
      user: catalogueScoutPrompt.buildUser(input),
    };
  },
  outputSchema: ScoutOutput,
  timeoutMs: POST_TURN_SPECIALIST_WATCHDOG_MS,
  temperature: 0.2,
  maxOutputTokens: 400,
};

// ── Helpers ────────────────────────────────────────────────────────────

interface NewEntity {
  id: number;
  kind: string;
  display_name: string;
}

interface ToolHistoryEntryLike {
  name: string;
  args: unknown;
  result?: unknown;
  ok?: boolean;
}

/**
 * Pull newly-created entities from the turn's tool history. Looks at:
 *   - create_entity: result has {id, kind, display_name}
 *   - create_quest with spawn_entities[]: result has the current
 *     spawned name -> id map. Legacy spawned_entity_ids[] is still
 *     accepted for old audit rows.
 */
export async function extractNewEntities(
  toolHistory: ToolHistoryEntryLike[],
): Promise<NewEntity[]> {
  const out: NewEntity[] = [];
  const seenIds = new Set<number>();

  const push = async (candidate: Partial<NewEntity>) => {
    if (typeof candidate.id !== 'number' || seenIds.has(candidate.id)) return;
    const hydrated = await hydrateEntity(candidate);
    if (!hydrated) return;
    if (!hydrated.kind || !hydrated.display_name) return;
    seenIds.add(hydrated.id);
    out.push(hydrated);
  };

  for (const call of toolHistory) {
    if (call.ok === false) continue;
    if (call.name === 'create_entity') {
      const r = asRecord(call.result);
      const args = asRecord(call.args);
      if (r && typeof r['id'] === 'number') {
        await push({
          id: r['id'] as number,
          kind: asString(r['kind']) ?? asString(args?.['kind']) ?? '',
          display_name:
            asString(r['display_name']) ??
            asString(args?.['display_name']) ??
            '',
        });
      }
    } else if (call.name === 'create_quest') {
      const args = asRecord(call.args);
      const spawnArr = asRecordArray(args?.['spawn_entities']);
      const r = asRecord(call.result);
      const spawnedMap = asRecord(r?.['spawned']);
      const spawnedIds = Array.isArray(r?.['spawned_entity_ids'])
        ? (r?.['spawned_entity_ids'] as unknown[])
        : [];

      if (spawnedMap) {
        for (const spec of spawnArr) {
          const displayName = asString(spec['display_name']);
          if (!displayName) continue;
          const id = asNumber(spawnedMap[displayName]);
          if (id == null) continue;
          await push({
            id,
            kind: asString(spec['kind']) ?? '',
            display_name: displayName,
          });
        }

        for (const [displayName, rawId] of Object.entries(spawnedMap)) {
          const id = asNumber(rawId);
          if (id == null) continue;
          await push({id, display_name: displayName});
        }
      }

      for (let i = 0; i < spawnArr.length; i++) {
        const s = spawnArr[i]!;
        const id = asNumber(spawnedIds[i]);
        if (id == null) continue;
        await push({
          id,
          kind: asString(s['kind']) ?? '',
          display_name: asString(s['display_name']) ?? '',
        });
      }
    }
  }
  return out;
}

async function hydrateEntity(
  candidate: Partial<NewEntity>,
): Promise<NewEntity | null> {
  if (typeof candidate.id !== 'number') return null;
  if (candidate.kind && candidate.display_name) {
    return {
      id: candidate.id,
      kind: candidate.kind,
      display_name: candidate.display_name,
    };
  }
  const row = await query<{kind: string; display_name: string}>(
    `SELECT kind, display_name FROM entities WHERE id = $1`,
    [candidate.id],
  );
  const found = row.rows[0];
  if (!found) return null;
  return {
    id: candidate.id,
    kind: candidate.kind || found.kind,
    display_name: candidate.display_name || found.display_name,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      item != null && typeof item === 'object' && !Array.isArray(item),
  );
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Score a name pair via 50/50 normalized Levenshtein + Jaccard token
 * overlap. Returns 0..1.
 */
export function similarityScore(a: string, b: string): number {
  const lev = 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) /
    Math.max(a.length, b.length, 1);
  const jac = jaccard(tokenize(a), tokenize(b));
  return 0.5 * lev + 0.5 * jac;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Two-row DP — O(m) memory.
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

interface Candidate {
  id: number;
  display_name: string;
  summary: string | null;
  score: number;
}

async function findFuzzyCandidates(
  kind: string,
  newName: string,
  excludeId: number,
  limit: number,
): Promise<Candidate[]> {
  const r = await query<{
    id: number;
    display_name: string;
    summary: string | null;
  }>(
    `SELECT id, display_name, summary FROM entities
      WHERE kind = $1 AND id <> $2`,
    [kind, excludeId],
  );
  const scored: Candidate[] = r.rows.map(row => ({
    id: row.id,
    display_name: row.display_name,
    summary: row.summary,
    score: similarityScore(newName, row.display_name),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(c => c.score >= 0.5).slice(0, limit);
}

interface WarningPayload extends Record<string, unknown> {
  new_entity_id: number;
  new_name: string;
  kind: string;
  verdict: string;
  best_match_id: number;
  best_match_name: string;
  score: number;
  reason: string;
  candidates: Array<{id: number; display_name: string; score: number}>;
}

async function emitWarning(
  ctx: SpecialistContext,
  payload: WarningPayload,
): Promise<void> {
  await (ctx.presentation?.emit(
    'entity:duplicate_warning',
    payload,
    {
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      lane: 'post_response',
      phase: 'post_turn',
    },
  ) ?? emitGuiEventForSession(
    ctx.sessionId,
    'entity:duplicate_warning',
    payload,
    {
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      lane: 'post_response',
      phase: 'post_turn',
      displayPolicy: {lane: 'post_response', anchor: 'none'},
    },
  ));
}
