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

let emitEntityMediaScript: typeof import('../../services/CartridgeMediaScriptService.js').emitEntityMediaScript;
let ASSET_MANIFEST_META_KEY: typeof import('../../services/CartridgeAssetManifestService.js').ASSET_MANIFEST_META_KEY;
let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({emitEntityMediaScript} = await import(
    '../../services/CartridgeMediaScriptService.js'
  ));
  ({ASSET_MANIFEST_META_KEY} = await import(
    '../../services/CartridgeAssetManifestService.js'
  ));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

afterEach(async () => {
  await queryRows(`DELETE FROM gui_events WHERE event_type LIKE 'media:%'`);
  await queryRows(`DELETE FROM sessions WHERE id LIKE 'media-script-test-%'`);
  await queryRows(`DELETE FROM entities WHERE display_name LIKE 'Media Script Test %'`);
  await queryRows(`DELETE FROM cartridge_meta_scoped WHERE cartridge_id = 'media-script-test'`);
  await queryRows(`DELETE FROM cartridges WHERE id = 'media-script-test'`);
});

async function seedPlayerSession(): Promise<{playerId: number; sessionId: string}> {
  const player = await createAnonymousPlayer(`Media Script Test Hero ${Date.now()}`);
  const sessionId = `media-script-test-${player.entity_id}`;
  await queryRows(
    `INSERT INTO sessions (id, player_id) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [sessionId, player.entity_id],
  );
  return {playerId: player.entity_id, sessionId};
}

async function seedAssetManifest(): Promise<void> {
  await queryRows(
    `INSERT INTO cartridges
       (id, title, version, schema_version, source_kind, content_hash, manifest)
     VALUES ('media-script-test', 'Media Script Test', '0.0.0', 'test',
             'builtin', 'media-script-test', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
  await queryRows(
    `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
     VALUES ($1, $2, $3::jsonb, 'media script test manifest')
     ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [
      'media-script-test',
      ASSET_MANIFEST_META_KEY,
      JSON.stringify({
        schema_version: 'greenhaven.cartridge_assets.v1',
        rows: [
          {
            status: 'available',
            kind: 'scene',
            slug: 'media-script-test-scene',
            role: 'media_ledger_closeup',
            extension: '.png',
            content_type: 'image/png',
            cache_path: 'ledger.png',
          },
        ],
      }),
    ],
  );
}

async function seedSceneWithMediaScript(): Promise<number> {
  const url =
    '/api/assets/cartridges/media-script-test/world/scene/media-script-test-scene/media_ledger_closeup';
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES ('scene', 'Media Script Test Scene', '', $1::jsonb,
             ARRAY['scene'], 'media-script-test')
     RETURNING id`,
    [
      JSON.stringify({
        source_slug: 'media-script-test-scene',
        visual_asset_urls: {media_ledger_closeup: url},
        media_script: [
          {
            action: 'show',
            asset_role: 'media_ledger_closeup',
            title: 'The torn ledger',
            caption: 'Wax, blue thread, and a fresh knife mark.',
            alt: 'A torn ledger page with a blue wax seal.',
          },
        ],
      }),
    ],
  );
  return Number(rows[0]!.id);
}

describe('CartridgeMediaScriptService', () => {
  it('emits chat-visible media cards from show_media commands', async () => {
    const {playerId, sessionId} = await seedPlayerSession();
    await seedAssetManifest();
    const sceneId = await seedSceneWithMediaScript();

    await emitEntityMediaScript(
      {sessionId, playerId, turnId: 'media-script-turn'},
      sceneId,
      'scene',
    );

    const events = await queryRows<{
      event_type: string;
      lane: string;
      phase: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, lane, phase, payload
         FROM gui_events
        WHERE session_id = $1
        ORDER BY id ASC`,
      [sessionId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'media:shown',
      lane: 'chat',
      phase: 'mutation',
    });
    expect(events[0]!.payload).toMatchObject({
      action: 'show',
      role: 'media_ledger_closeup',
      title: 'The torn ledger',
      caption: 'Wax, blue thread, and a fresh knife mark.',
      alt: 'A torn ledger page with a blue wax seal.',
      format: 'png',
      contentType: 'image/png',
      sourceKind: 'scene',
      sourceEntityId: sceneId,
      sourceName: 'Media Script Test Scene',
    });
    expect(events[0]!.payload['url']).toBe(
      '/api/assets/cartridges/media-script-test/world/scene/media-script-test-scene/media_ledger_closeup',
    );
  });
});
