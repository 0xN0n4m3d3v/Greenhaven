/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — current-location visit recording + first-entry
// event.
//
// Records the visit in the world-memory store and, when the player
// just entered the location and the cartridge supplied an intro
// bubble, emits a `location:first_entry` GUI event. Both side
// effects are non-fatal: the visit record falls back to `null` on
// failure (the runner already tolerated `null`) and the GUI event
// emit logs + records `error.first_entry_location_event` telemetry
// without throwing.
//
// This phase produces only side effects; it does not write to
// `TurnContext.state`. `runTurn` does not consume the visit record
// downstream.

import {emitGuiEvent} from '../../guiEventOutbox.js';
import {query} from '../../db.js';
import {telemetry} from '../../telemetry/index.js';
import {recordCurrentLocationVisit} from '../../domain/memory/index.js';
import {emitEntityMediaScript} from '../../services/CartridgeMediaScriptService.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';
import {readPlayerLangFromState} from './LanguagePhase.js';

export const locationVisitPhase: Phase = {
  name: 'location_visit',
  async run(context: TurnContext): Promise<void> {
    const {session, input, turnId} = context;
    const playerLang = readPlayerLangFromState(context);
    const currentLocationVisit = await recordCurrentLocationVisit({
      playerId: input.playerId,
      sessionId: session.id,
      turnId,
      lang: playerLang,
    }).catch((err) => {
      // CATCH-WARN-OK: visit recording is best-effort observability; the turn continues with `currentLocationVisit = null` and any underlying SQL error is already surfaced by the writer-side telemetry in `recordCurrentLocationVisit`.
      console.warn(
        '[turnV2] location visit record failed (continuing):',
        err instanceof Error ? err.message : err,
      );
      return null;
    });
    if (currentLocationVisit?.firstVisit && currentLocationVisit.introBubble) {
      await emitGuiEvent(
        {sessionId: session.id, playerId: input.playerId, turnId},
        'location:first_entry',
        {
          locationId: currentLocationVisit.locationId,
          locationName: currentLocationVisit.locationName,
          firstVisit: currentLocationVisit.firstVisit,
          visitCount: currentLocationVisit.visitCount,
          introBubble: currentLocationVisit.introBubble,
          locationImageUrl: await loadLocationVisualAssetUrl(
            currentLocationVisit.locationId,
          ),
        },
        {lane: 'pre_response', phase: 'pre_turn'},
      ).catch((err) => {
        console.warn(
          '[turnV2] first-entry location event failed (continuing):',
          err instanceof Error ? err.message : err,
        );
        telemetry.record({
          channel: 'gameplay',
          name: 'error.first_entry_location_event',
          sessionId: session.id,
          playerId: input.playerId,
          turnId,
          data: {error: String(err)},
        });
      });
    }
    if (currentLocationVisit?.firstVisit) {
      await emitEntityMediaScript(
        {sessionId: session.id, playerId: input.playerId, turnId},
        currentLocationVisit.locationId,
        'location',
      ).catch((err) => {
        console.warn(
          '[turnV2] first-entry location media failed (continuing):',
          err instanceof Error ? err.message : err,
        );
      });
    }
  },
};

async function loadLocationVisualAssetUrl(
  locationId: number,
): Promise<string | null> {
  const rows = await query<{profile: Record<string, unknown> | null}>(
    `SELECT profile FROM entities WHERE id = $1`,
    [locationId],
  );
  const raw = rows.rows[0]?.profile?.['visual_asset_urls'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)['location_view'];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
