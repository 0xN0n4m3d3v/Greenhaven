/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let SessionLifecycleService:
  typeof import('../../services/SessionLifecycleService.js').SessionLifecycleService;
let createAnonymousPlayer:
  typeof import('../../playerService.js').createAnonymousPlayer;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({SessionLifecycleService} = await import(
    '../../services/SessionLifecycleService.js'
  ));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

afterEach(async () => {
  await queryRows(`DELETE FROM gui_events WHERE event_type LIKE 'media:%'`);
  await queryRows(`DELETE FROM sessions WHERE id LIKE 'bootstrap-media-%'`);
  await queryRows(
    `DELETE FROM hero_cartridge_states
      WHERE cartridge_id LIKE 'bootstrap-media-cart-%'`,
  );
  await queryRows(
    `UPDATE players
        SET current_location_id = NULL,
            current_scene_id = NULL,
            dialogue_partner_id = NULL
      WHERE current_location_id IN (
              SELECT id FROM entities
               WHERE display_name LIKE 'Bootstrap Media Test %'
            )
         OR current_scene_id IN (
              SELECT id FROM entities
               WHERE display_name LIKE 'Bootstrap Media Test %'
            )
         OR dialogue_partner_id IN (
              SELECT id FROM entities
               WHERE display_name LIKE 'Bootstrap Media Test %'
            )`,
  );
  await queryRows(
    `DELETE FROM entities WHERE display_name LIKE 'Bootstrap Media Test %'`,
  );
  await queryRows(
    `DELETE FROM cartridges WHERE id LIKE 'bootstrap-media-cart-%'`,
  );
});

describe('SessionLifecycleService bootstrap media', () => {
  it('emits current-location music before the player moves again', async () => {
    const player = await createAnonymousPlayer('Bootstrap Media Test Hero');
    const cartridgeId = `bootstrap-media-cart-${player.entity_id}-${Date.now()}`;
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, 'Bootstrap Media Cartridge', '0.1', '1',
               'forge_project', 'sha256:bootstrap-media')`,
      [cartridgeId],
    );
    const location = await queryRows<{id: number}>(
      `INSERT INTO entities
         (kind, display_name, summary, profile, tags, cartridge_id)
       VALUES ('location', 'Bootstrap Media Test Port', '', $1::jsonb,
               ARRAY['location'], $2)
       RETURNING id`,
      [
        JSON.stringify({
          visual_asset_urls: {
            music_bootstrap_media_port:
              '/api/assets/cartridges/bootstrap-media-cart/world/location/bootstrap-media-test-port/music_bootstrap_media_port.mp3',
            media_bootstrap_card:
              '/api/assets/cartridges/bootstrap-media-cart/world/location/bootstrap-media-test-port/media_bootstrap_card.png',
          },
          media_script: [
            {
              action: 'switch',
              asset_role: 'music_bootstrap_media_port',
              label: 'Bootstrap Media Port',
              loop: true,
              volume: 0.55,
            },
            {
              action: 'show',
              asset_role: 'media_bootstrap_card',
              title: 'Should not replay on bootstrap',
            },
          ],
        }),
        cartridgeId,
      ],
    );
    const locationId = Number(location[0]!.id);
    await queryRows(
      `UPDATE players
          SET current_location_id = $2
        WHERE entity_id = $1`,
      [player.entity_id, locationId],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states
         (player_id, cartridge_id, status, current_location_id, last_session_id)
       VALUES ($1, $2, 'active', $3, NULL)`,
      [player.entity_id, cartridgeId, locationId],
    );

    const boot = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId: player.entity_id,
    });

    const events = await queryRows<{
      event_type: string;
      phase: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, phase, payload
         FROM gui_events
        WHERE session_id = $1
        ORDER BY id ASC`,
      [boot.resolvedSessionId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'media:music',
      phase: 'support',
    });
    expect(events[0]!.payload).toMatchObject({
      action: 'switch',
      sourceKind: 'location',
      sourceEntityId: locationId,
      sourceName: 'Bootstrap Media Test Port',
      label: 'Bootstrap Media Port',
      volume: 0.55,
    });
    expect(events[0]!.payload['url']).toContain(
      'music_bootstrap_media_port.mp3',
    );
  });
});
