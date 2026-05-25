/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  emitAdventureHook,
  markAdventureFailed,
  markAdventureReady,
  markAdventureRejected,
  type AdventureQueueRow,
} from '../runtime/adventureQueue.js';
import {validateAdventureBlueprint} from '../runtime/adventureArbiter.js';
import {
  projectSituationToAdventureBlueprint,
  validateSituationBlueprint,
} from '../runtime/scenarioIntegrityArbiter.js';
import {
  runSpecialist,
  type PostTurnHook,
  type SpecialistDef,
} from '../../../agents/base.js';
import {adventureMaterializerPrompt} from './prompt.js';
import {buildMaterializerInput} from './input.js';
import {
  MaterializerOutput,
  type AdventureMaterializerInput,
} from './types.js';
import {tryMaterializerFallback} from './fallback.js';
import {claimQueuedAdventureForCurrentTurn} from './queue.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
  POST_TURN_SPECIALIST_WATCHDOG_MS,
} from '../../../postTurnTiming.js';

export const ADVENTURE_MATERIALIZER_SPECIALIST_TIMEOUT_MS =
  POST_TURN_SPECIALIST_WATCHDOG_MS;
export const ADVENTURE_MATERIALIZER_SLOT_DEADLINE_MS =
  POST_TURN_SLOT_WATCHDOG_MS;

const def: SpecialistDef<AdventureMaterializerInput, MaterializerOutput> = {
  name: 'adventure_materializer',
  mode: 'async',
  buildPrompt(input) {
    return {
      system: adventureMaterializerPrompt.system,
      user: adventureMaterializerPrompt.buildUser(input),
    };
  },
  outputSchema: MaterializerOutput,
  coerceInput: coerceMaterializerJson,
  timeoutMs: ADVENTURE_MATERIALIZER_SPECIALIST_TIMEOUT_MS,
  temperature: 0.4,
  maxOutputTokens: 2400,
};

// Clamp LLM output to schema bounds so the materializer succeeds instead of
// fail-opening. Observed mangles: bridgeSummary > 240 chars, tags > 8 items,
// locations with entityId <= 0, secrets with empty knownByEntityIds.
function coerceMaterializerJson(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;

  const qp = obj['questProjection'];
  if (qp && typeof qp === 'object') {
    const q = qp as Record<string, unknown>;
    if (typeof q['bridgeSummary'] === 'string') {
      const s = q['bridgeSummary'] as string;
      if (s.length > 240) q['bridgeSummary'] = s.slice(0, 237).trimEnd() + '…';
    }
    if (Array.isArray(q['tags']) && q['tags'].length > 8) {
      q['tags'] = (q['tags'] as unknown[]).slice(0, 8);
    }
  }

  if (Array.isArray(obj['locations'])) {
    obj['locations'] = (obj['locations'] as Array<Record<string, unknown>>)
      .filter(l => {
        const eid = l && typeof l === 'object' ? l['entityId'] : null;
        return typeof eid !== 'number' || eid > 0;
      });
  }

  if (Array.isArray(obj['secrets'])) {
    obj['secrets'] = (obj['secrets'] as Array<Record<string, unknown>>)
      .filter(sec => {
        const arr = sec && typeof sec === 'object' ? sec['knownByEntityIds'] : null;
        return !Array.isArray(arr) || arr.length > 0;
      });
  }

  return obj;
}

export const adventureMaterializerHook: PostTurnHook = {
  name: 'adventure_materializer',
  presentation: {
    slotKey: 'post.adventure_materializer',
    lane: 'post_response',
    ordinal: 45,
    visible: true,
    barrierMode: 'non_blocking',
    deadlineMs: ADVENTURE_MATERIALIZER_SLOT_DEADLINE_MS,
  },
  async run(ctx) {
    const result = await materializeNextAdventureForSession({
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      signal: ctx.signal,
    });
    if (!result.claimed) {
      await ctx.presentation?.skip('no_queued_adventure');
      return;
    }
    if (result.status === 'ready') {
      if (result.queue) {
        await emitAdventureHook(result.queue, ctx.presentation);
        return;
      }
      await ctx.presentation?.skip('blueprint_ready_missing_queue');
      return;
    }
    if (result.status === 'rejected') {
      await ctx.presentation?.skip(`blueprint_rejected:${result.reason ?? 'unknown'}`);
      return;
    }
    await ctx.presentation?.skip(`blueprint_failed:${result.reason ?? 'unknown'}`);
  },
};

export async function materializeNextAdventureForSession(args: {
  sessionId: string;
  playerId: number;
  turnId: string;
  signal: AbortSignal;
}): Promise<{
  claimed: boolean;
  status?: 'ready' | 'rejected' | 'failed';
  queue?: AdventureQueueRow;
  reason?: string;
}> {
  const queue = await claimQueuedAdventureForCurrentTurn({
    sessionId: args.sessionId,
    playerId: args.playerId,
    turnId: args.turnId,
    signal: args.signal,
  });
  if (!queue) return {claimed: false};

  let failureReason: string | null = null;
  const input = await buildMaterializerInput(queue);
  const output = await runSpecialist(
    {
      ...def,
      onFailure: failure => {
        failureReason = failure.reason;
      },
    },
    input,
    {
      sessionId: args.sessionId,
      playerId: args.playerId,
      turnId: args.turnId,
      signal: args.signal,
    },
  );
  if (!output) {
    const fallback = await tryMaterializerFallback({
      queue,
      input,
      playerId: args.playerId,
      reason: failureReason ?? 'specialist_fail_open',
    });
    if (fallback) {
      return {claimed: true, status: 'ready', queue: fallback};
    }
    await markAdventureFailed(
      queue.id,
      failureReason ?? 'specialist_fail_open',
    );
    return {
      claimed: true,
      status: 'failed',
      queue,
      reason: failureReason ?? 'specialist_fail_open',
    };
  }

  console.log(
    `[adventure_materializer] queue=${queue.id} kind=${queue.adventureKind} ` +
      `LLM output: pressure=${(output as {pressureType?: string}).pressureType ?? '?'} ` +
      `causes=${(output as {causeSources?: unknown[]}).causeSources?.length ?? 0} ` +
      `qp.mode=${(output as {questProjection?: {mode?: string}}).questProjection?.mode ?? '?'} ` +
      `qp.existingQuestId=${(output as {questProjection?: {existingQuestId?: number}}).questProjection?.existingQuestId ?? '?'}`,
  );

  // Auto-repair: LLM frequently picks mode=attach_existing /
  // advance_existing with a valid existingQuestId but FORGETS to mirror
  // that quest into causeSources, which the integrity arbiter requires.
  // Patch it in here before validation rather than fail-open every
  // single time. Eight rejections in a single session traced to this.
  const repaired = output as {
    questProjection?: {mode?: string; existingQuestId?: number};
    causeSources?: Array<{kind?: string; id?: unknown}>;
  };
  const qp = repaired.questProjection;
  if (
    qp &&
    (qp.mode === 'attach_existing' || qp.mode === 'advance_existing') &&
    typeof qp.existingQuestId === 'number'
  ) {
    const causes = Array.isArray(repaired.causeSources)
      ? repaired.causeSources
      : (repaired.causeSources = []);
    const alreadyThere = causes.some(
      c => c?.kind === 'quest' && Number(c?.id) === qp.existingQuestId,
    );
    if (!alreadyThere) {
      causes.unshift({
        kind: 'quest',
        id: qp.existingQuestId,
        // claim text is required by Text240; the projection's own bridgeSummary
        // is the right canonical caption when available.
        // @ts-expect-error — runtime patch; schema accepts string here.
        claim:
          ((qp as {bridgeSummary?: unknown}).bridgeSummary as string | undefined)
            ?.toString()
            ?.slice(0, 240) ??
          `continues existing quest #${qp.existingQuestId}`,
      });
      console.warn(
        `[adventure_materializer] queue=${queue.id} auto-repaired ` +
          `causeSources by adding quest=${qp.existingQuestId} ` +
          `(mode=${qp.mode}) — LLM omitted the required mirror`,
      );
    }
  }

  const situationVerdict = await validateSituationBlueprint({
    queue,
    situation: output,
    playerId: args.playerId,
  });
  if (!situationVerdict.ok || !situationVerdict.situation) {
    console.warn(
      `[adventure_materializer] queue=${queue.id} situation rejected: ` +
        `${situationVerdict.reason} — ${situationVerdict.message ?? ''}`,
    );
    const fallback = await tryMaterializerFallback({
      queue,
      input,
      playerId: args.playerId,
      reason: `situation_${situationVerdict.reason ?? 'invalid'}`,
      message: situationVerdict.message,
    });
    if (fallback) {
      return {claimed: true, status: 'ready', queue: fallback};
    }
    await markAdventureRejected(queue.id, situationVerdict.reason ?? 'schema_invalid', {
      message: situationVerdict.message,
      details: situationVerdict.details,
    });
    return {
      claimed: true,
      status: 'rejected',
      queue,
      reason: situationVerdict.reason ?? 'schema_invalid',
    };
  }

  const projected = projectSituationToAdventureBlueprint({
    queue,
    situation: situationVerdict.situation,
  });
  const verdict = await validateAdventureBlueprint({
    queue,
    blueprint: projected,
    playerId: args.playerId,
  });
  if (!verdict.ok || !verdict.blueprint) {
    const fallback = await tryMaterializerFallback({
      queue,
      input,
      playerId: args.playerId,
      reason: `projection_${verdict.reason ?? 'invalid'}`,
      message: verdict.message,
    });
    if (fallback) {
      return {claimed: true, status: 'ready', queue: fallback};
    }
    await markAdventureRejected(queue.id, verdict.reason ?? 'schema_invalid', {
      message: verdict.message,
      details: verdict.details,
    });
    return {
      claimed: true,
      status: 'rejected',
      queue,
      reason: verdict.reason ?? 'schema_invalid',
    };
  }

  const readyQueue = await markAdventureReady(queue.id, verdict.blueprint);
  return {claimed: true, status: 'ready', queue: readyQueue ?? queue};
}
