/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-PRESENCE-1 — server-canonical presence enrichment for
// `/api/session/:id/locations` `nearby[]`.
//
// `buildPresenceEnrichment(playerId, npcIds)` returns two maps:
//   * relationships — keyed by NPC id → relationship band (`hostile`
//     / `wary` / `neutral` / `friendly` / `trusted` / `bonded`) +
//     clamped count, sourced from `runtime_fields.field_key='strings'`
//     / `runtime_values` for the active player.
//   * statuses — keyed by NPC id → up to 3 public actor-status badges
//     (kind, value, intensity) sourced from `actor_statuses`. Private
//     NPC status kinds (emotion, mood, intent, etc.) must NEVER appear
//     in the read model.
//
// The contract is covered through three concrete cases:
//   1. an NPC with a positive string count and a public status →
//      relationship `friendly`/`trusted` band, status entry with the
//      whitelisted kind.
//   2. an NPC with a hostile string count and zero-intensity status →
//      `hostile` band, no status entry (intensity must be > 0).
//   3. an NPC with a private status kind (`emotion`) that the spec
//      bans from the read model — must NOT appear in `statuses`.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let buildPresenceEnrichment:
  typeof import('../../presenceEnrichment.js').buildPresenceEnrichment;
let createAnonymousPlayer:
  typeof import('../../playerService.js').createAnonymousPlayer;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({buildPresenceEnrichment} = await import('../../presenceEnrichment.js'));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

async function newPlayer(label: string): Promise<number> {
  const p = await createAnonymousPlayer(`FEAT-PRESENCE-1 ${label} ${Date.now()}`);
  return p.entity_id;
}

async function makeNpc(displayName: string): Promise<number> {
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name, profile, tags,
                           cartridge_id, dynamic_origin)
     VALUES ('person', $1, '{}'::jsonb, ARRAY['person']::text[],
             'feat-presence-test', false)
     RETURNING id`,
    [displayName],
  );
  return Number(rows[0]!.id);
}

async function seedStrings(
  npcId: number,
  byPlayerId: Record<string, number>,
): Promise<void> {
  const fieldRows = await queryRows<{id: number}>(
    `INSERT INTO runtime_fields (owner_entity_id, field_key, value_type,
                                 default_value)
     VALUES ($1, 'strings', 'json', '{}'::jsonb)
     RETURNING id`,
    [npcId],
  );
  const fieldId = Number(fieldRows[0]!.id);
  await queryRows(
    `INSERT INTO runtime_values (field_id, value, source)
     VALUES ($1, $2::jsonb, 'test')`,
    [fieldId, JSON.stringify(byPlayerId)],
  );
}

async function seedStatus(
  playerId: number,
  npcId: number,
  status: {kind: string; value: string; intensity: number},
): Promise<void> {
  await queryRows(
    `INSERT INTO actor_statuses (player_id, actor_entity_id, status_kind,
                                  status_value, intensity, source)
     VALUES ($1, $2, $3, $4, $5, 'test')
     ON CONFLICT (player_id, actor_entity_id, status_kind)
     DO UPDATE SET status_value = EXCLUDED.status_value,
                   intensity = EXCLUDED.intensity`,
    [playerId, npcId, status.kind, status.value, status.intensity],
  );
}

describe('buildPresenceEnrichment (FEAT-PRESENCE-1)', () => {
  beforeEach(async () => {
    await queryRows(
      `DELETE FROM runtime_values
        WHERE field_id IN (
          SELECT id FROM runtime_fields WHERE field_key = 'strings'
        )`,
    );
    await queryRows(
      `DELETE FROM runtime_fields WHERE field_key = 'strings'`,
    );
    await queryRows(`DELETE FROM actor_statuses`);
    await queryRows(
      `DELETE FROM entities WHERE cartridge_id = 'feat-presence-test'`,
    );
  });

  it('returns empty maps when given no NPC ids (avoids a wasted round-trip)', async () => {
    const playerId = await newPlayer('empty');
    const result = await buildPresenceEnrichment(playerId, []);
    expect(result.relationships.size).toBe(0);
    expect(result.statuses.size).toBe(0);
  });

  it('returns a friendly band + public status badge for an NPC with positive strings and a public actor status', async () => {
    const playerId = await newPlayer('friendly');
    const npcId = await makeNpc('Friendly Smith');
    await seedStrings(npcId, {[String(playerId)]: 5});
    await seedStatus(playerId, npcId, {
      kind: 'tired',
      value: 'long-shift',
      intensity: 0.6,
    });

    const result = await buildPresenceEnrichment(playerId, [npcId]);
    const rel = result.relationships.get(npcId);
    expect(rel).toBeDefined();
    expect(rel?.band).toBe('trusted');
    expect(rel?.count).toBe(5);

    const statuses = result.statuses.get(npcId);
    expect(statuses).toBeDefined();
    expect(statuses).toHaveLength(1);
    expect(statuses?.[0]).toEqual({
      kind: 'tired',
      value: 'long-shift',
      intensity: 0.6,
    });
  });

  it('returns the hostile band when the count is deeply negative and skips zero-intensity statuses', async () => {
    const playerId = await newPlayer('hostile');
    const npcId = await makeNpc('Hostile Boss');
    await seedStrings(npcId, {[String(playerId)]: -8});
    // intensity = 0 means the status is dormant; the SQL filter
    // requires `intensity > 0` so this row must not surface.
    await seedStatus(playerId, npcId, {
      kind: 'wary',
      value: 'dormant',
      intensity: 0,
    });

    const result = await buildPresenceEnrichment(playerId, [npcId]);
    const rel = result.relationships.get(npcId);
    expect(rel?.band).toBe('hostile');
    expect(rel?.count).toBe(-8);
    expect(result.statuses.get(npcId) ?? []).toEqual([]);
  });

  it('omits private NPC status kinds (e.g. `emotion`, `mood`) from the read model', async () => {
    const playerId = await newPlayer('private-leak');
    const npcId = await makeNpc('Private Thinker');
    await seedStatus(playerId, npcId, {
      kind: 'emotion',
      value: 'jealous',
      intensity: 0.9,
    });
    await seedStatus(playerId, npcId, {
      kind: 'mood',
      value: 'sullen',
      intensity: 0.7,
    });
    await seedStatus(playerId, npcId, {
      kind: 'injured',
      value: 'cut-lip',
      intensity: 0.4,
    });

    const result = await buildPresenceEnrichment(playerId, [npcId]);
    const statuses = result.statuses.get(npcId) ?? [];
    // Only the public `injured` kind survives the whitelist. The
    // private `emotion` / `mood` thoughts stay inside the broker
    // prompt path and never appear on the wire to the rail.
    expect(statuses.map((s) => s.kind)).toEqual(['injured']);
  });

  it('omits NPCs that have no `strings` field at all but keeps their status entries (relationship is optional)', async () => {
    const playerId = await newPlayer('no-strings');
    const npcId = await makeNpc('Stranger');
    await seedStatus(playerId, npcId, {
      kind: 'busy',
      value: 'on-shift',
      intensity: 0.5,
    });

    const result = await buildPresenceEnrichment(playerId, [npcId]);
    expect(result.relationships.get(npcId)).toBeUndefined();
    expect(result.statuses.get(npcId)).toEqual([
      {kind: 'busy', value: 'on-shift', intensity: 0.5},
    ]);
  });

  it('caps statuses at three per NPC, ordered by intensity descending', async () => {
    const playerId = await newPlayer('cap');
    const npcId = await makeNpc('Multi Status');
    await seedStatus(playerId, npcId, {
      kind: 'busy',
      value: 'low',
      intensity: 0.2,
    });
    await seedStatus(playerId, npcId, {
      kind: 'injured',
      value: 'mid',
      intensity: 0.5,
    });
    await seedStatus(playerId, npcId, {
      kind: 'tired',
      value: 'high',
      intensity: 0.8,
    });
    await seedStatus(playerId, npcId, {
      kind: 'drunk',
      value: 'highest',
      intensity: 0.95,
    });

    const result = await buildPresenceEnrichment(playerId, [npcId]);
    const statuses = result.statuses.get(npcId) ?? [];
    expect(statuses).toHaveLength(3);
    // Highest intensities first.
    expect(statuses.map((s) => s.kind)).toEqual(['drunk', 'tired', 'injured']);
    expect(statuses[0]!.intensity).toBeGreaterThan(statuses[1]!.intensity);
    expect(statuses[1]!.intensity).toBeGreaterThan(statuses[2]!.intensity);
  });
});
