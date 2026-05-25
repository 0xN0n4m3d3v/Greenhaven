/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-turn quest evaluation pass. Called from turnRunnerV2 after the
// per-turn condition decrement (and before the model fires).
//
// For every active player_quest:
//   1. Read the quest entity's profile.
//   2. Find current stage by id.
//   3. Evaluate failure_conditions first — any match → mark failed.
//   4. Evaluate stage objectives — if `advance_on='all'` AND all
//      satisfied (or 'any' AND any satisfied), advance to next_stage.
//   5. If next_stage is null → auto-complete (calls applyQuestRewards).

import {query, withTransaction} from '../db.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import {telemetry} from '../telemetry/index.js';
import {applyMaterializersForTrigger} from '../tools/materializer.js';
import {applyQuestRewards} from '../tools/quest.js';
import {patchAccumulatedState} from './accumulatedState.js';
import {resolveAdvanceMode} from './advanceOn.js';
import {evaluateObjective} from './objectiveEvaluators.js';
import {cappedPathTakenExpr} from './pathTaken.js';
import {isLegalQuestStageTransition} from './questTransitionArbiter.js';

interface ActiveQuestRow {
  player_id: number;
  quest_entity_id: number;
  current_stage_id: string | null;
  accumulated_state: unknown;
  profile: unknown;
  display_name: string;
  source_slug: string | null;
}

interface ActiveQuest {
  player_id: number;
  quest_entity_id: number;
  current_stage_id: string | null;
  /** Normalized JSON object; mutated in place by `tickQuestTimers`. */
  accState: Record<string, unknown>;
  /** Normalized JSON object from the joined `entities.profile`. */
  profile: Record<string, unknown>;
  display_name: string;
  sourceSlug: string | null;
}

function normalizeJsonbObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return {...(v as Record<string, unknown>)};
}

// QE-7 — single funnel for quest-engine gameplay telemetry. Replaces
// the previous `console.log` / `console.warn` lines so every branch
// records a structured event with session/player/turn correlation
// and quest identity. State-change success names
// (`quest.failed`, `quest.advanced`, `quest.completed`,
// `quest.choice_required`) are emitted only after the surrounding
// `withTransaction(...)` resolves, so a rolled-back mutation cannot
// leave behind a misleading "succeeded" telemetry record.
function recordQuestEvent(
  name: string,
  aq: ActiveQuest,
  sessionId: string,
  playerId: number,
  turnId: string,
  extra: Record<string, unknown>,
  error?: unknown,
): void {
  telemetry.record({
    channel: 'gameplay',
    name,
    sessionId,
    playerId,
    turnId,
    ...(error !== undefined ? {error} : {}),
    data: {
      quest_id: aq.quest_entity_id,
      quest_title: aq.display_name,
      current_stage_id: aq.current_stage_id,
      ...extra,
    },
  });
}

async function applyQuestStageMaterializers(
  aq: ActiveQuest,
  sessionId: string,
  turnId: string,
): Promise<void> {
  if (!aq.sourceSlug) return;
  await applyMaterializersForTrigger(
    {sessionId, playerId: aq.player_id, turnId},
    'quest_stage',
    {sourceSlug: aq.sourceSlug},
  );
}

export async function evaluateActiveQuests(
  sessionId: string,
  playerId: number,
  recentToolCalls: Array<{name: string; args: Record<string, unknown>}>,
  turnId: string,
): Promise<void> {
  // QE-1 — one joined read replaces the per-quest profile / state /
  // timer SELECTs. Active quests + their entity profile +
  // accumulated_state come back in one round trip; everything else
  // in this pass uses the in-memory copy.
  const active = await query<ActiveQuestRow>(
    `SELECT pq.player_id, pq.quest_entity_id, pq.current_stage_id,
            pq.accumulated_state, e.profile, e.display_name,
            e.profile->>'source_slug' AS source_slug
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1 AND pq.status = 'active'`,
    [playerId],
  );
  const quests: ActiveQuest[] = active.rows.map((r) => ({
    player_id: r.player_id,
    quest_entity_id: r.quest_entity_id,
    current_stage_id: r.current_stage_id,
    accState: normalizeJsonbObject(r.accumulated_state),
    profile: normalizeJsonbObject(r.profile),
    display_name: r.display_name,
    sourceSlug: typeof r.source_slug === 'string' ? r.source_slug : null,
  }));

  // Spec 25 — turn-tick before objective evaluation. Decrements any
  // stage-level `turns_remaining` counter on accumulated_state and
  // sets a `timeout_failure` flag (or pending_choice for advance_to)
  // so the failure / branch path picks it up below. The tick mutates
  // each quest's in-memory `accState` so the same evaluation pass
  // sees the new keys without a re-read.
  await tickQuestTimers(quests);

  for (const aq of quests) {
    if (!aq.current_stage_id) continue;
    const profile = aq.profile;
    const stages = Array.isArray(profile['stages'])
      ? (profile['stages'] as Array<Record<string, unknown>>)
      : [];
    if (stages.length === 0) continue;
    const stage = stages.find(s => s['id'] === aq.current_stage_id);
    if (!stage) continue;

    const ctx = {playerId: aq.player_id, sessionId, recentToolCalls};

    // 1. Failure short-circuit. Spec 25 also honours timeout_failure
    // set by tickQuestTimers when on_timeout.action='fail' fires.
    const failConds = Array.isArray(profile['failure_conditions'])
      ? (profile['failure_conditions'] as Array<Record<string, unknown>>)
      : [];
    const accState = aq.accState;
    let failed = accState['timeout_failure'] === true;
    let failureKind = failed ? 'timeout' : null;
    if (!failed) {
      for (const fc of failConds) {
        const r = await evaluateObjective(fc, ctx);
        if (r.satisfied) {
          failed = true;
          failureKind = String(fc['kind']);
          break;
        }
      }
    }
    if (failed) {
      // QE-2 — failed status, failure consequences, and the
      // `quest:changed` GUI event share one transaction. Rollback
      // drops both the DB write and the deferred SSE.
      await withTransaction(async () => {
        await query(
          `UPDATE player_quests SET status = 'failed', completed_at = now()
            WHERE player_id = $1 AND quest_entity_id = $2`,
          [aq.player_id, aq.quest_entity_id],
        );
        await applyFailureConsequence(
          aq.player_id,
          profile,
          stage,
        );
        await emitGuiEventForSession(sessionId, 'quest:changed', {
          questId: aq.quest_entity_id,
          status: 'failed',
        }, {
          playerId,
          turnId,
          phase: 'mutation',
        });
      });
      recordQuestEvent('quest.failed', aq, sessionId, playerId, turnId, {
        failure_kind: failureKind,
      });
      await applyQuestStageMaterializers(aq, sessionId, turnId);
      continue;
    }

    // 2. Objective evaluation.
    const objectives = Array.isArray(stage['objectives'])
      ? (stage['objectives'] as Array<Record<string, unknown>>)
      : [];
    if (objectives.length === 0) {
      const ns = stage['next_stage'] as string | Record<string, unknown> | undefined;
      if (
        ns != null &&
        typeof ns === 'object' &&
        !Array.isArray(ns) &&
        (ns as Record<string, unknown>)['kind'] === 'choice'
      ) {
        const options = Array.isArray(ns['options'])
          ? (ns['options'] as Array<Record<string, unknown>>)
          : [];
        if (!accState['awaiting_choice']) {
          await withTransaction(async tx => {
            await patchAccumulatedState(
              tx,
              aq.player_id,
              aq.quest_entity_id,
              {awaiting_choice: true},
            );
            await emitGuiEventForSession(sessionId, 'quest:choice_required', {
              questId: aq.quest_entity_id,
              questTitle: aq.display_name ?? null,
              options: options.map(o => ({
                label: String(o['label'] ?? ''),
                target_stage_id: String(o['target_stage_id'] ?? ''),
              })),
            }, {
              playerId,
              turnId,
              phase: 'mutation',
            });
          });
          recordQuestEvent(
            'quest.choice_required',
            aq,
            sessionId,
            playerId,
            turnId,
            {
              options: options.map(o => ({
                label: String(o['label'] ?? ''),
                target_stage_id: String(o['target_stage_id'] ?? ''),
              })),
            },
          );
        }
        continue;
      }
      // Auto-complete terminal stages even without objectives (GH-BUG-096).
      // Previously, `continue` skipped stages with zero objectives,
      // permanently locking quests whose last stage had no objectives.
      const stageIsTerminal =
        ns == null ||
        (typeof ns === 'string' && ns.trim() === '');
      if (stageIsTerminal) {
        // QE-2 — completed status, reward application, and the
        // `quest:changed` GUI event share one transaction. `query`
        // calls inside `applyQuestRewards` (XP, strings, memory,
        // permanent field patches, condition removals) all land
        // on the active tx client and roll back as a unit.
        await withTransaction(async () => {
          await query(
            `UPDATE player_quests SET status = 'completed', completed_at = now()
              WHERE player_id = $1 AND quest_entity_id = $2`,
            [aq.player_id, aq.quest_entity_id],
          );
          await applyQuestRewards(aq.player_id, aq.quest_entity_id);
          await emitGuiEventForSession(sessionId, 'quest:changed', {
            questId: aq.quest_entity_id,
            status: 'completed',
          }, {
            playerId,
            turnId,
            phase: 'mutation',
          });
        });
        await applyQuestStageMaterializers(aq, sessionId, turnId);
      }
      continue;
    }
    const results = await Promise.all(
      objectives.map(o => evaluateObjective(o, ctx)),
    );
    // QE-6 — share the four allowed `advance_on` aliases with the
    // cartridge validator. Unknown non-null values throw loudly
    // instead of silently degrading to AND semantics.
    let advanceMode: 'any' | 'all';
    try {
      advanceMode = resolveAdvanceMode(stage['advance_on']);
    } catch (err) {
      recordQuestEvent(
        'quest.advance_on_invalid',
        aq,
        sessionId,
        playerId,
        turnId,
        {raw_advance_on: stage['advance_on']},
        err,
      );
      continue;
    }
    const advance =
      advanceMode === 'any'
        ? results.some(r => r.satisfied)
        : results.every(r => r.satisfied);
    if (!advance) continue;

    // 3. Advance / auto-complete. Spec 25 — branching: if next_stage
    // is `{kind:'choice', options:[...]}` we either honour a pending
    // pick from accumulated_state or stash awaiting_choice + emit SSE.
    const nextStage = stage['next_stage'];
    if (
      nextStage != null &&
      typeof nextStage === 'object' &&
      !Array.isArray(nextStage) &&
      (nextStage as Record<string, unknown>)['kind'] === 'choice'
    ) {
      const ns = nextStage as Record<string, unknown>;
      const options = Array.isArray(ns['options'])
        ? (ns['options'] as Array<Record<string, unknown>>)
        : [];
      const picked = accState['pending_choice'];
      if (typeof picked === 'string' && picked.length > 0) {
        const opt = options.find(o => o['target_stage_id'] === picked);
        if (!opt) {
          recordQuestEvent(
            'quest.choice.invalid_pick',
            aq,
            sessionId,
            playerId,
            turnId,
            {picked_stage_id: picked},
          );
          continue;
        }
        if (!isLegalQuestStageTransition(profile, aq.current_stage_id, picked)) {
          recordQuestEvent(
            'quest.choice.illegal_transition',
            aq,
            sessionId,
            playerId,
            turnId,
            {picked_stage_id: picked, next_stage_id: picked},
          );
          continue;
        }
        // QE-2/QE-3 — branch-advance stage update + JSONB patch on
        // `accumulated_state` + `quest:changed` GUI event share one
        // transaction. The JSONB patch drops `pending_choice` and
        // sets `awaiting_choice: false` without touching unrelated
        // scratchpad keys (`turns_remaining`, `timeout_failure`,
        // future authors' keys).
        await withTransaction(async tx => {
          await tx.query(
            `UPDATE player_quests
                SET current_stage_id = $1,
                    path_taken = ${cappedPathTakenExpr(
                      "jsonb_build_object('at', now()::text, 'stage', $1, 'branch', $1)",
                    )}
              WHERE player_id = $2 AND quest_entity_id = $3`,
            [picked, aq.player_id, aq.quest_entity_id],
          );
          await patchAccumulatedState(
            tx,
            aq.player_id,
            aq.quest_entity_id,
            {awaiting_choice: false},
            ['pending_choice'],
          );
          await emitGuiEventForSession(sessionId, 'quest:changed', {
            questId: aq.quest_entity_id,
            status: 'advanced',
            stage: picked,
          }, {
            playerId,
            turnId,
            phase: 'mutation',
          });
        });
        await applyQuestStageMaterializers(aq, sessionId, turnId);
        continue;
      }
      // No pick yet — stash awaiting_choice + emit SSE so UI surfaces
      // the affordance buttons. Quest stays at current_stage_id.
      if (!accState['awaiting_choice']) {
        // QE-2/QE-3 — JSONB patch on `accumulated_state`
        // (`awaiting_choice: true`) + `quest:choice_required` GUI
        // event share one transaction. The patch leaves every other
        // scratchpad key untouched.
        await withTransaction(async tx => {
          await patchAccumulatedState(
            tx,
            aq.player_id,
            aq.quest_entity_id,
            {awaiting_choice: true},
          );
          await emitGuiEventForSession(sessionId, 'quest:choice_required', {
            questId: aq.quest_entity_id,
            questTitle: aq.display_name ?? null,
            options: options.map(o => ({
              label: String(o['label'] ?? ''),
              target_stage_id: String(o['target_stage_id'] ?? ''),
            })),
          }, {
            playerId,
            turnId,
            phase: 'mutation',
          });
        });
        recordQuestEvent(
          'quest.choice_required',
          aq,
          sessionId,
          playerId,
          turnId,
          {
            options: options.map(o => ({
              label: String(o['label'] ?? ''),
              target_stage_id: String(o['target_stage_id'] ?? ''),
            })),
          },
        );
      }
      continue;
    }

    if (typeof nextStage === 'string' && nextStage.length > 0) {
      // Spec 24 — stage prerequisites gate entry. If the next stage
      // declares any, ALL must satisfy before we advance. Logged as
      // gated; quest stays at current stage until prereqs hold.
      const next = stages.find(s => s['id'] === nextStage);
      const prereqs = Array.isArray(next?.['prerequisites'])
        ? (next!['prerequisites'] as Array<Record<string, unknown>>)
        : [];
      if (prereqs.length > 0) {
        const checks = await Promise.all(
          prereqs.map(p => evaluateObjective(p, ctx)),
        );
        const blocked = checks.find(r => !r.satisfied);
        if (blocked) {
          recordQuestEvent(
            'quest.stage.prerequisite_blocked',
            aq,
            sessionId,
            playerId,
            turnId,
            {
              next_stage_id: nextStage,
              detail: blocked.detail ?? 'prereq failed',
            },
          );
          continue;
        }
      }
      if (!isLegalQuestStageTransition(profile, aq.current_stage_id, nextStage)) {
        recordQuestEvent(
          'quest.stage.illegal_transition',
          aq,
          sessionId,
          playerId,
          turnId,
          {from: aq.current_stage_id, to: nextStage},
        );
        continue;
      }

      // QE-2 — normal stage advance + `quest:changed` GUI event share
      // one transaction. Rollback drops both.
      await withTransaction(async () => {
        await query(
          `UPDATE player_quests
              SET current_stage_id = $1,
                  path_taken = ${cappedPathTakenExpr(
                    "jsonb_build_object('at', now()::text, 'stage', $1)",
                  )}
            WHERE player_id = $2 AND quest_entity_id = $3`,
          [nextStage, aq.player_id, aq.quest_entity_id],
        );
        await emitGuiEventForSession(sessionId, 'quest:changed', {
          questId: aq.quest_entity_id,
          status: 'advanced',
          stage: nextStage,
        }, {
          playerId,
          turnId,
          phase: 'mutation',
        });
      });
      recordQuestEvent('quest.advanced', aq, sessionId, playerId, turnId, {
        next_stage_id: nextStage,
      });
      await applyQuestStageMaterializers(aq, sessionId, turnId);
    } else {
      // QE-2 — completion status update, reward application, and
      // `quest:changed` GUI event share one transaction. Rollback
      // drops the player_quests UPDATE plus every write inside
      // `applyQuestRewards` (XP, strings, memory, permanent field
      // patches, condition removals) as a single unit.
      await withTransaction(async () => {
        await query(
          `UPDATE player_quests SET status = 'completed', completed_at = now()
            WHERE player_id = $1 AND quest_entity_id = $2`,
          [aq.player_id, aq.quest_entity_id],
        );
        await applyQuestRewards(aq.player_id, aq.quest_entity_id);
        await emitGuiEventForSession(sessionId, 'quest:changed', {
          questId: aq.quest_entity_id,
          status: 'completed',
        }, {
          playerId,
          turnId,
          phase: 'mutation',
        });
      });
      recordQuestEvent('quest.completed', aq, sessionId, playerId, turnId, {});
      await applyQuestStageMaterializers(aq, sessionId, turnId);
    }
  }
}

/**
 * Spec 25 — turn-tick the `accumulated_state.turns_remaining` counter
 * on every active quest. On expiry, sets `timeout_failure` (if the
 * stage's on_timeout.action='fail') OR `pending_choice` (if
 * action='advance_to'). The objective evaluation pass below picks
 * those flags up.
 *
 * QE-1 — operates on the joined rows from `evaluateActiveQuests(...)`
 * (no per-quest profile / state SELECT). Each row's in-memory
 * `accState` is mutated with the same keys we persist via
 * `patchAccumulatedState(...)`, so the main loop's failure /
 * branch logic reads the post-tick state directly.
 */
async function tickQuestTimers(rows: ActiveQuest[]): Promise<void> {
  for (const aq of rows) {
    if (!aq.current_stage_id) continue;
    if (typeof aq.accState['turns_remaining'] !== 'number') continue;

    // QE-3 — compute only the keys that changed and patch them onto
    // `accumulated_state`. Concurrent writers touching unrelated keys
    // (`awaiting_choice`, future scratchpad keys) are no longer
    // clobbered by a full-object write.
    const remaining = (aq.accState['turns_remaining'] as number) - 1;
    const patch: Record<string, unknown> = {turns_remaining: remaining};
    if (remaining <= 0) {
      const stages = Array.isArray(aq.profile['stages'])
        ? (aq.profile['stages'] as Array<Record<string, unknown>>)
        : [];
      const stage = stages.find(s => s['id'] === aq.current_stage_id);
      const onTimeout = (stage?.['on_timeout'] ?? {}) as Record<string, unknown>;
      if (onTimeout['action'] === 'fail') {
        patch['timeout_failure'] = true;
      } else if (
        onTimeout['action'] === 'advance_to' &&
        typeof onTimeout['target_stage_id'] === 'string'
      ) {
        patch['pending_choice'] = onTimeout['target_stage_id'];
      }
    }
    await withTransaction(async tx => {
      await patchAccumulatedState(
        tx,
        aq.player_id,
        aq.quest_entity_id,
        patch,
      );
    });
    Object.assign(aq.accState, patch);
  }
}

/**
 * Spec 25 — apply a failure_consequence block on the current stage
 * (or the quest profile root). Trauma awards land on the player's
 * runtime_field 'trauma' (spec 20 layout); field_patches are SET on
 * the named runtime_value. Best-effort; partial failure shapes are
 * silently skipped. Emits a quest:failed SSE with the optional
 * narrate_hint the cartridge author may have written.
 */
async function applyFailureConsequence(
  playerId: number,
  profile: Record<string, unknown>,
  stage: Record<string, unknown>,
): Promise<void> {
  const block =
    (stage['failure_consequence'] ?? profile['failure_consequence']) as
      | Record<string, unknown>
      | undefined;
  if (!block) return;

  if (Array.isArray(block['trauma_awards'])) {
    for (const tw of block['trauma_awards'] as Array<Record<string, unknown>>) {
      const tag = tw['tag'];
      if (typeof tag !== 'string') continue;
      const fieldRow = await query<{id: number}>(
        `SELECT id FROM runtime_fields
          WHERE owner_entity_id = $1 AND field_key = 'trauma'`,
        [playerId],
      );
      const fieldId = fieldRow.rows[0]?.id;
      if (fieldId == null) continue;
      await query(
        `INSERT INTO runtime_values (field_id, value, source, updated_at)
         VALUES ($1, jsonb_build_array(to_jsonb($2::text)), 'quest_failure', now())
         ON CONFLICT (field_id)
         -- M-6: safe_jsonb_array hardens the concat so a corrupted
         -- non-array runtime value cannot produce a malformed result.
         DO UPDATE SET value = safe_jsonb_array(runtime_values.value)
                               || jsonb_build_array(to_jsonb($2::text)),
                       source = 'quest_failure',
                       updated_at = now()`,
        [fieldId, tag],
      );
    }
  }
  if (Array.isArray(block['field_patches'])) {
    for (const fp of block['field_patches'] as Array<Record<string, unknown>>) {
      const ownerId = Number(fp['owner_entity_id']);
      const fieldKey = fp['field_key'];
      if (!Number.isInteger(ownerId) || typeof fieldKey !== 'string') continue;
      await query(
        `UPDATE runtime_values rv
            SET value = $1::jsonb,
                source = 'quest_failure',
                updated_at = now()
           FROM runtime_fields rf
          WHERE rv.field_id = rf.id
            AND rf.owner_entity_id = $2
            AND rf.field_key = $3`,
        [JSON.stringify(fp['value']), ownerId, fieldKey],
      );
    }
  }
}
