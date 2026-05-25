/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { listAdventureQueue } from './adventureQueue.js';
import {
  type AdventureIgnoreConsequence,
  acceptPlayerAdventure,
  ignorePlayerAdventure,
} from '../AdventureService.js';

export interface NaturalAdventureAcceptanceResult {
  accepted: boolean;
  queueId?: number;
  score?: number;
  reason?: string;
  status?: string;
  questResult?: unknown;
  spawnResults?: unknown[];
}

export interface NaturalAdventureIgnoreResult {
  ignored: boolean;
  queueId?: number;
  score?: number;
  reason?: string;
  status?: string;
  hook?: Record<string, unknown> | null;
  consequence?: AdventureIgnoreConsequence | null;
}

export async function maybeAcceptReadyAdventureFromText(opts: {
  sessionId: string;
  playerId: number;
  turnId: string;
  text: string;
  actionId?: string | null;
}): Promise<NaturalAdventureAcceptanceResult> {
  const requestedQueueId =
    queueIdFromAdventureAcceptAction(opts.actionId) ??
    queueIdFromStructuredTextReference(opts.text);
  if (requestedQueueId == null) {
    return { accepted: false, reason: 'no_explicit_reference' };
  }
  const candidates = await listAdventureQueue({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    statuses: ['ready'],
    limit: 10,
  });
  if (candidates.length === 0) {
    return { accepted: false, reason: 'no_ready_hooks' };
  }

  const best = candidates.find((row) => row.id === requestedQueueId);
  if (!best) return { accepted: false, reason: 'no_match' };

  const accepted = await acceptPlayerAdventure({
    playerId: opts.playerId,
    queueId: best.id,
    sessionId: opts.sessionId,
    turnId: opts.turnId,
  });
  return {
    accepted: accepted.ok,
    queueId: best.id,
    score: 1,
    reason: accepted.ok ? 'accepted' : (accepted.reason ?? 'accept_failed'),
    status: accepted.status,
    questResult: accepted.questResult,
    spawnResults: accepted.spawnResults,
  };
}

export async function maybeIgnoreReadyAdventureFromText(opts: {
  sessionId: string;
  playerId: number;
  turnId: string;
  text: string;
  actionId?: string | null;
}): Promise<NaturalAdventureIgnoreResult> {
  const requestedQueueId =
    queueIdFromAdventureIgnoreAction(opts.actionId) ??
    queueIdFromStructuredIgnoreReference(opts.text);
  if (requestedQueueId == null) {
    return { ignored: false, reason: 'no_explicit_reference' };
  }
  const candidates = await listAdventureQueue({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    statuses: ['ready'],
    limit: 10,
  });
  if (candidates.length === 0) {
    return { ignored: false, reason: 'no_ready_hooks' };
  }

  const best = candidates.find((row) => row.id === requestedQueueId);
  if (!best) return { ignored: false, reason: 'no_match' };

  const ignored = await ignorePlayerAdventure({
    playerId: opts.playerId,
    queueId: best.id,
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    reason: 'player_declined_turn_action',
  });
  return {
    ignored: ignored.ok,
    queueId: best.id,
    score: 1,
    reason: ignored.ok ? 'ignored' : (ignored.reason ?? 'ignore_failed'),
    status: ignored.status,
    hook: ignored.hookPayload ?? null,
    consequence: ignored.consequence ?? null,
  };
}

// LANGUAGE-REGEX-OK: wire-format control marker emitted by the broker prompt as `[[adventure.accept:<queueId>]]` inside narrate text; literal protocol token, not natural-language player intent.
function queueIdFromStructuredTextReference(text: string): number | null {
  const match = text.match(/\[\[adventure\.accept:(\d+)]]/);
  return parsePositiveId(match?.[1]);
}

// LANGUAGE-REGEX-OK: same broker-emitted control marker family as `[[adventure.accept:N]]`, ignore variant. Wire-format protocol token.
function queueIdFromStructuredIgnoreReference(text: string): number | null {
  const match = text.match(/\[\[adventure\.ignore:(\d+)]]/);
  return parsePositiveId(match?.[1]);
}

// LANGUAGE-REGEX-OK: wire-format actionId emitted by the UI when the player taps an adventure-accept affordance (`adventure.accept:<queueId>`); literal protocol token, never read player prose.
function queueIdFromAdventureAcceptAction(
  actionId?: string | null,
): number | null {
  const match = actionId?.match(/^adventure\.accept:(\d+)$/);
  return parsePositiveId(match?.[1]);
}

// LANGUAGE-REGEX-OK: same UI affordance wire-format actionId as `adventure.accept:N`, ignore variant.
function queueIdFromAdventureIgnoreAction(
  actionId?: string | null,
): number | null {
  const match = actionId?.match(/^adventure\.ignore:(\d+)$/);
  return parsePositiveId(match?.[1]);
}

function parsePositiveId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
