/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — natural adventure intent.
//
// Mirrors the previous inline `runTurn` block exactly:
//   1. Try `maybeAcceptReadyAdventureFromText`.  On accept, log
//      `[adventure_intent] accepted ...`.
//   2. If acceptance did NOT happen, try
//      `maybeIgnoreReadyAdventureFromText`.  On ignore, log
//      `[adventure_intent] ignored ...`.
//   3. Either way, run `expireStaleReadyAdventures` so stale ready
//      adventures are cleaned up.
// A failure in any step is non-fatal: the catch logs a warning and
// the default `{accepted: false, reason: 'not_checked'}` /
// `{ignored: false, reason: 'not_checked'}` defaults stay in place.
//
// Results are written onto `TurnContext.state` under the stable keys
// `naturalAdventure` and `ignoredAdventure` so `runTurn` can read
// them when building `brokerToolProfile`, the accepted/ignored
// briefing strings, and the performance-event metadata.

import {
  expireStaleReadyAdventures,
  maybeAcceptReadyAdventureFromText,
  maybeIgnoreReadyAdventureFromText,
  type NaturalAdventureAcceptanceResult,
  type NaturalAdventureIgnoreResult,
} from '../../domain/adventure/index.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const ADVENTURE_INTENT_STATE_KEY = {
  natural: 'naturalAdventure' as const,
  ignored: 'ignoredAdventure' as const,
};

export function readNaturalAdventureFromState(
  context: TurnContext,
): NaturalAdventureAcceptanceResult {
  const raw = context.state[ADVENTURE_INTENT_STATE_KEY.natural];
  return (raw as NaturalAdventureAcceptanceResult | undefined) ?? {
    accepted: false,
    reason: 'not_checked',
  };
}

export function readIgnoredAdventureFromState(
  context: TurnContext,
): NaturalAdventureIgnoreResult {
  const raw = context.state[ADVENTURE_INTENT_STATE_KEY.ignored];
  return (raw as NaturalAdventureIgnoreResult | undefined) ?? {
    ignored: false,
    reason: 'not_checked',
  };
}

export const adventureIntentPhase: Phase = {
  name: 'adventure_intent',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId} = context;
    let naturalAdventure: NaturalAdventureAcceptanceResult = {
      accepted: false,
      reason: 'not_checked',
    };
    let ignoredAdventure: NaturalAdventureIgnoreResult = {
      ignored: false,
      reason: 'not_checked',
    };
    try {
      naturalAdventure = await maybeAcceptReadyAdventureFromText({
        sessionId: session.id,
        playerId: input.playerId,
        turnId,
        text: input.text,
        actionId: input.actionId,
      });
      if (naturalAdventure.accepted) {
        console.log(
          `[adventure_intent] accepted queueId=${naturalAdventure.queueId} ` +
            `score=${naturalAdventure.score?.toFixed(2) ?? 'n/a'}`,
        );
      }
      if (!naturalAdventure.accepted) {
        ignoredAdventure = await maybeIgnoreReadyAdventureFromText({
          sessionId: session.id,
          playerId: input.playerId,
          turnId,
          text: input.text,
          actionId: input.actionId,
        });
        if (ignoredAdventure.ignored) {
          console.log(
            `[adventure_intent] ignored queueId=${ignoredAdventure.queueId} ` +
              `score=${ignoredAdventure.score?.toFixed(2) ?? 'n/a'}`,
          );
        }
      }
      await expireStaleReadyAdventures({
        sessionId: session.id,
        playerId: input.playerId,
        turnId,
      });
    } catch (err) {
      // CATCH-WARN-OK: natural-acceptance/expiry is opportunistic adventure-queue maintenance; the turn pipeline proceeds with the prior queue state, and `acceptPlayerAdventure`/`expireStaleReadyAdventures` already emit their own service-level telemetry on the failure side (AQ-1/AQ-2 channels).
      console.warn(
        '[adventure_intent] natural acceptance/expiry failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    }
    context.state[ADVENTURE_INTENT_STATE_KEY.natural] = naturalAdventure;
    context.state[ADVENTURE_INTENT_STATE_KEY.ignored] = ignoredAdventure;
  },
};
