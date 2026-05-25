/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-17 — `buildAffordances(...)` emits travel actions for every
// visible reachable place (`location` / `district`) referenced by the
// current location's `profile.exits`. Non-place exit ids are filtered
// out by `loadVisibleReachableLocations`'s `kind IN ('location',
// 'district')` clause, so they must NOT produce a travel affordance.
// The wire shape (id / kind / entity_id / label_key / message_key /
// message_vars.name, plus the absence of a raw English `message`
// field) is what the UI binds to via `localizedAffordanceMessage` and
// `buildMentionTargetsFromAffordances`, so the regression locks the
// whole contract — not just the count.

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTestSession,
  setupTurnTestEnvironment,
} from './turn/framework.js';
import type {TestSession} from './turn/framework.js';

let buildAffordances: typeof import('../affordances.js').buildAffordances;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({buildAffordances} = await import('../affordances.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

describe('buildAffordances — ARCH-17 travel contract', () => {
  let test: TestSession;
  let currentLocationId: number;
  let validExitId: number;
  let nonPlaceExitId: number;

  beforeAll(async () => {
    test = await setupTestSession();

    const here = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, summary, profile, tags)
       VALUES ('location', 'Test Crossroads', 'A wide stone crossroads.',
               '{}'::jsonb, ARRAY['arch17'])
       RETURNING id`,
    );
    currentLocationId = here[0]!.id;

    const exitRows = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, summary, profile, tags)
       VALUES ('location', 'Test Northgate', 'A studded oak gate.',
               '{}'::jsonb, ARRAY['arch17'])
       RETURNING id`,
    );
    validExitId = exitRows[0]!.id;

    const nonPlace = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, summary, profile, tags)
       VALUES ('item', 'Test Lantern', 'Oil-fed brass lantern.',
               '{}'::jsonb, ARRAY['arch17'])
       RETURNING id`,
    );
    nonPlaceExitId = nonPlace[0]!.id;

    await queryRows(
      `UPDATE entities
          SET profile = jsonb_set(profile, '{exits}', $1::jsonb, true)
        WHERE id = $2`,
      [JSON.stringify([validExitId, nonPlaceExitId]), currentLocationId],
    );

    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [currentLocationId, test.playerId],
    );
  });

  afterAll(async () => {
    await test.cleanup();
  });

  it('emits exactly one travel action for the reachable location exit', async () => {
    const actions = await buildAffordances(test.playerId);
    const travel = actions.filter(a => a.kind === 'travel');
    expect(travel).toHaveLength(1);
    expect(travel[0]?.id).toBe(`travel:${validExitId}`);
    expect(travel[0]?.entity_id).toBe(validExitId);
  });

  it('travel action carries the i18n contract — label_key, message_key, message_vars.name, no raw prose', async () => {
    const actions = await buildAffordances(test.playerId);
    const travel = actions.find(a => a.kind === 'travel');
    expect(travel).toBeDefined();
    expect(travel!.label_key).toBe('ui.actions.travel');
    expect(travel!.label_vars).toEqual({name: 'Test Northgate'});
    expect(travel!.message_key).toBe('travel.location');
    expect(travel!.message_vars).toEqual({name: 'Test Northgate'});
    expect(travel!.label).toBe('@Test Northgate');
    expect(travel!.primary).toBe(false);
    // The `message` field is reserved for non-prose protocol payloads;
    // player-facing travel actions must use message_key + message_vars
    // so the UI's localizer can render the right language at click time.
    expect(travel!.message).toBeUndefined();
  });

  it('does not emit a travel action for a non-place exit id', async () => {
    const actions = await buildAffordances(test.playerId);
    const travelToNonPlace = actions.find(
      a => a.kind === 'travel' && a.entity_id === nonPlaceExitId,
    );
    expect(travelToNonPlace).toBeUndefined();
    expect(actions.find(a => a.id === `travel:${nonPlaceExitId}`)).toBeUndefined();
  });
});
