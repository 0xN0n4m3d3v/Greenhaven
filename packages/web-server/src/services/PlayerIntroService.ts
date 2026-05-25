/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';
import type {PublicPlayer} from '../playerService.js';
import {
  loadIntroBubble,
  recordCurrentLocationVisit,
} from '../domain/memory/index.js';

export interface PlayerBootstrapIntroPatch {
  current_location_name: string | null;
  current_location_first_visit: boolean;
  current_location_visit_count: number;
  current_location_intro_bubble: string;
  current_location_visual_asset_urls: Record<string, string> | null;
}

export class PlayerIntroService {
  static async bootstrapIntroFor(
    player: PublicPlayer,
    language?: string,
  ): Promise<PlayerBootstrapIntroPatch | null> {
    const visit = await recordCurrentLocationVisit({
      playerId: player.entity_id,
      sessionId: null,
      turnId: 'bootstrap',
      lang: language,
    }).catch((err) => {
      // CATCH-WARN-OK: bootstrap-time location intro is best-effort; the HUD continues with no intro patch and `recordCurrentLocationVisit` already surfaces its own SQL failures through writer-side telemetry.
      console.warn(
        '[player/me] current location intro failed:',
        err instanceof Error ? err.message : err,
      );
      return null;
    });
    if (!visit) return null;

    let introBubble: string | null = null;
    if (visit.introBubble) {
      const claimed = await this.claimBootstrapLocationIntro(
        player.entity_id,
        visit.locationId,
      );
      if (claimed) introBubble = visit.introBubble;
    }

    const replayBootstrapIntro =
      !introBubble &&
      visit.visitCount <= 1 &&
      (await this.claimBootstrapLocationIntro(
        player.entity_id,
        visit.locationId,
      ));
    if (replayBootstrapIntro) {
      introBubble = await loadIntroBubble(visit.locationId, language ?? 'en');
    }
    if (!introBubble) return null;

    return {
      current_location_name:
        visit.locationName ?? player.current_location_name,
      current_location_first_visit: visit.firstVisit,
      current_location_visit_count: visit.visitCount,
      current_location_intro_bubble: introBubble,
      current_location_visual_asset_urls: await loadLocationVisualAssetUrls(
        visit.locationId,
      ),
    };
  }

  private static async claimBootstrapLocationIntro(
    playerId: number,
    locationId: number,
  ): Promise<boolean> {
    const key = `bootstrap_location_intro_rendered_v2_${locationId}`;
    const updated = await query<{entity_id: number}>(
      `UPDATE players
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object($2::text, true)
        WHERE entity_id = $1
          AND NOT (COALESCE(metadata, '{}'::jsonb) ? $2::text)
        RETURNING entity_id`,
      [playerId, key],
    );
    return updated.rows.length > 0;
  }
}

async function loadLocationVisualAssetUrls(
  locationId: number,
): Promise<Record<string, string> | null> {
  const rows = await query<{profile: Record<string, unknown> | null}>(
    `SELECT profile FROM entities WHERE id = $1`,
    [locationId],
  );
  const raw = rows.rows[0]?.profile?.['visual_asset_urls'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] => {
      const [key, value] = entry;
      return (
        key.trim().length > 0 &&
        typeof value === 'string' &&
        value.trim().length > 0
      );
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}
