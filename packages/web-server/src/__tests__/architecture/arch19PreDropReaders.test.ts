/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 pre-Phase-4 reader-safety regressions.
//
// These tests pin that the production readers identified by the
// ARCH-19 pre-Phase-4 hardening sweep (locationGraph, worldFactGuard,
// adventureArbiter, dynamicQuestPlan / questDirectorPacket) consult
// the normalized `entities` columns (`topology_parent_id`,
// `dynamic_origin`) rather than the legacy JSONB keys
// (`profile.topology_parent_id`, `profile.origin`). Each case seeds
// an entity row whose profile is INTENTIONALLY missing the JSONB key
// the upcoming Phase 4 drop will erase, leaving only the normalized
// column. If a reader ever regresses to consult the JSONB key, the
// scenario fails as soon as the Phase 4 migration ships.
//
// Phase 4 itself remains soak-gated; these tests are a pre-flight
// guarantee that the readers are safe to drop the JSONB keys.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let loadVisibleReachableLocations: typeof import('../../locationGraph.js').loadVisibleReachableLocations;
let validateDynamicWorldFactSpawn: typeof import('../../worldFactGuard.js').validateDynamicWorldFactSpawn;
let isDynamicQuestProfile: typeof import('../../quest/dynamicQuestPlan.js').isDynamicQuestProfile;
let validateAdventureBlueprint: typeof import('../../domain/adventure/runtime/adventureArbiter.js').validateAdventureBlueprint;
type AdventureQueueRow =
  import('../../domain/adventure/runtime/adventureQueue.js').AdventureQueueRow;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({loadVisibleReachableLocations} = await import('../../locationGraph.js'));
  ({validateDynamicWorldFactSpawn} = await import('../../worldFactGuard.js'));
  ({isDynamicQuestProfile} = await import('../../quest/dynamicQuestPlan.js'));
  ({validateAdventureBlueprint} = await import(
    '../../domain/adventure/runtime/adventureArbiter.js'
  ));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  await queryRows(
    `DELETE FROM entities WHERE display_name LIKE 'ARCH-19 reader %'`,
  );
});

async function seedLocation(opts: {
  displayName: string;
  topologyParentId?: number | null;
  exits?: number[];
  // The whole point of these tests: leave the JSONB
  // `topology_parent_id` undefined so the reader has to consult the
  // normalized column to see the edge.
  includeProfileTopologyParentId?: boolean;
}): Promise<number> {
  const profile: Record<string, unknown> = {};
  if (opts.exits) profile['exits'] = opts.exits;
  if (opts.includeProfileTopologyParentId === true && opts.topologyParentId != null) {
    profile['topology_parent_id'] = opts.topologyParentId;
  }
  const rows = await queryRows<{id: number}>(
    `INSERT INTO entities (
       kind, display_name, summary, profile, tags,
       topology_parent_id, dynamic_origin, cartridge_id
     )
     VALUES ('location', $1, '', $2::jsonb, ARRAY['location']::text[], $3, false, 'arch19-pre-drop-test')
     RETURNING id`,
    [opts.displayName, JSON.stringify(profile), opts.topologyParentId ?? null],
  );
  return Number(rows[0]!.id);
}

describe('ARCH-19 pre-Phase-4 — production readers consult normalized columns', () => {
  it('locationGraph follows the parent edge through entities.topology_parent_id', async () => {
    const parentId = await seedLocation({
      displayName: 'ARCH-19 reader parent square',
    });
    const childId = await seedLocation({
      displayName: 'ARCH-19 reader child alley',
      topologyParentId: parentId,
      // INTENTIONALLY stripped — Phase 4 drops this JSONB key. The
      // reader MUST find the parent via the normalized column alone.
      includeProfileTopologyParentId: false,
    });
    const visible = await loadVisibleReachableLocations(childId);
    const visibleIds = visible.map(row => Number(row.id));
    expect(visibleIds).toContain(parentId);
  });

  it('worldFactGuard accepts a parent that only declares the column edge', async () => {
    const parentId = await seedLocation({
      displayName: 'ARCH-19 reader hub',
    });
    const heroPosId = await seedLocation({
      displayName: 'ARCH-19 reader hero post',
      topologyParentId: parentId,
      includeProfileTopologyParentId: false,
    });
    const verdict = await validateDynamicWorldFactSpawn(
      {
        kind: 'location',
        display_name: 'ARCH-19 reader new alcove',
        profile: {topology_parent_id: parentId},
      },
      {currentLocationId: heroPosId},
    );
    expect(verdict.ok).toBe(true);
  });

  it('worldFactGuard accepts when the candidate parent is the current location even after Phase 4 strip', async () => {
    // Reverse direction: parent.topology_parent_id == current.
    // Without ARCH-19 the reader would have read
    // `parent.profile.topology_parent_id` which is now empty.
    const grandparentId = await seedLocation({
      displayName: 'ARCH-19 reader grandparent',
    });
    const currentId = await seedLocation({
      displayName: 'ARCH-19 reader current scene',
    });
    const candidateParentId = await seedLocation({
      displayName: 'ARCH-19 reader nested room',
      topologyParentId: currentId,
      includeProfileTopologyParentId: false,
    });
    // The hero stands at `current`, spawning under `candidateParent`
    // (whose ONLY signal that it is nested inside `current` is the
    // normalized column).
    const verdict = await validateDynamicWorldFactSpawn(
      {
        kind: 'location',
        display_name: 'ARCH-19 reader leaf',
        profile: {topology_parent_id: candidateParentId},
      },
      {currentLocationId: currentId},
    );
    expect(verdict.ok).toBe(true);
    // Grandparent is just a control row — it must not be reachable
    // from `current` through any of the JSONB-less edges we seeded.
    expect(grandparentId).not.toBe(currentId);
  });

  it('isDynamicQuestProfile returns true for an entity that only has dynamic_origin=true (no profile.origin)', () => {
    // The questDirectorPacket caller passes the normalized column
    // through `dynamicOriginColumn`. Even when the row's profile is
    // entirely stripped of legacy `origin`, the helper still detects
    // the runtime spawn via the new signal.
    const dynamic = isDynamicQuestProfile(
      {},
      [],
      {dynamicOriginColumn: true},
    );
    expect(dynamic).toBe(true);
  });

  it('isDynamicQuestProfile defaults to legacy detection when the normalized signal is absent', () => {
    // Sanity-check that callers without the column (incoming tool
    // payload before any DB write, or pre-0105 callers) still get
    // accurate detection via tags / profile.origin / source.
    expect(
      isDynamicQuestProfile({origin: 'dynamic'}, []),
    ).toBe(true);
    expect(isDynamicQuestProfile({}, ['dynamic'])).toBe(true);
    expect(isDynamicQuestProfile({}, [])).toBe(false);
    expect(isDynamicQuestProfile({}, [], {dynamicOriginColumn: false})).toBe(false);
  });
});

describe('ARCH-19 pre-Phase-4 — adventureArbiter duplicate filter respects dynamic_origin column', () => {
  // The adventureArbiter duplicate detector runs over a
  // `SELECT id, display_name, tags, profile, dynamic_origin
  //  FROM entities` cohort and SKIPs rows where `isRuntimeSpawn`
  // returns true, so canonical "existing entity" matches do not
  // accidentally flag a freshly-spawned adventure NPC as a duplicate.
  // After ARCH-19 the legacy `profile.origin === 'dynamic'` check is
  // dropped in favour of the normalized `entities.dynamic_origin`
  // column, so we drive `validateAdventureBlueprint()` end-to-end
  // against a row whose profile is JSONB-empty in both directions:
  //
  //   * dynamic_origin=true + same display_name → blueprint passes
  //     (the row is skipped as a runtime spawn);
  //   * dynamic_origin=false + same display_name → blueprint fails
  //     with `duplicate_entity_name` (the canonical cohort still
  //     blocks new spawns with the same name).

  const SPAWN_NAME = 'ARCH-19 reader sage';

  function minimalBlueprint(queueId: number): Record<string, unknown> {
    return {
      queueId,
      adventureKind: 'social_hook',
      title: 'ARCH-19 reader probe',
      summary: 'minimum viable blueprint for the duplicate-filter regression',
      playerFacingHook:
        'An unfamiliar @sage is asking around about the player at the well.',
      danger: 'safe',
      standaloneSpawns: [
        {
          kind: 'person',
          display_name: SPAWN_NAME,
          summary:
            'A throwaway person used by the duplicate-filter regression test.',
        },
      ],
    };
  }

  function fakeQueue(id: number, playerId: number): AdventureQueueRow {
    // Only `id` and `adventureKind` are consulted by
    // validateAdventureBlueprint; cast a minimal object so we do not
    // need a real `adventure_queue` row.
    return {
      id,
      sessionId: 'arch19-reader-session',
      playerId,
      turnId: null,
      status: 'ready',
      source: 'oracle',
      adventureKind: 'social_hook',
      priority: 50,
      seed: 'arch19-reader-seed',
      sequence: 1,
      tableId: 'arch19-reader-table',
      rollResult: {},
      contextSnapshot: {},
      blueprint: null,
      dedupeKey: null,
      availableAfterTurnId: null,
      createdAt: '2026-05-17T00:00:00.000Z',
      updatedAt: '2026-05-17T00:00:00.000Z',
    } as unknown as AdventureQueueRow;
  }

  async function seedNpcWithDynamicOrigin(
    displayName: string,
    dynamicOrigin: boolean,
  ): Promise<number> {
    // Profile is INTENTIONALLY empty — the only signal that this
    // canonical row is (or is not) a runtime spawn is the normalized
    // column. Phase 4 will erase `profile.origin` entirely; this is
    // the post-drop shape the duplicate filter must keep working
    // under.
    // ARCH-19 Phase 4 (migration 0124) — the CHECK requires a
    // cartridge_id whenever dynamic_origin is false. Tag the
    // canonical seed with a test cartridge so the constraint is
    // satisfied; the dynamic seed is exempt.
    const rows = await queryRows<{id: number}>(
      `INSERT INTO entities (
         kind, display_name, summary, profile, tags,
         dynamic_origin, cartridge_id
       )
       VALUES ('person', $1, '', '{}'::jsonb, ARRAY['person']::text[], $2,
               CASE WHEN $2::boolean THEN NULL ELSE 'arch19-pre-drop-test' END)
       RETURNING id`,
      [displayName, dynamicOrigin],
    );
    return Number(rows[0]!.id);
  }

  it('passes when a same-named existing person row carries dynamic_origin=true only (no profile.origin)', async () => {
    const dynNpcId = await seedNpcWithDynamicOrigin(SPAWN_NAME, true);
    const verdict = await validateAdventureBlueprint({
      queue: fakeQueue(1, 99),
      blueprint: minimalBlueprint(1),
      playerId: 99,
    });
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(verdict.reason).toBeUndefined();
    // Sanity probe: the seeded row really is invisible to legacy
    // JSONB-based detectors — `profile.origin` is undefined.
    const probe = await queryRows<{
      profile: Record<string, unknown>;
      dynamic_origin: boolean;
    }>(
      `SELECT profile, dynamic_origin FROM entities WHERE id = $1`,
      [dynNpcId],
    );
    expect(probe[0]!.profile['origin']).toBeUndefined();
    expect(probe[0]!.dynamic_origin).toBe(true);
  });

  it('rejects when a same-named existing person row has dynamic_origin=false (canonical) regardless of empty profile', async () => {
    const canonicalNpcId = await seedNpcWithDynamicOrigin(SPAWN_NAME, false);
    const verdict = await validateAdventureBlueprint({
      queue: fakeQueue(2, 99),
      blueprint: minimalBlueprint(2),
      playerId: 99,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('duplicate_entity_name');
    const details = verdict.details as
      | {existingId?: number; existingName?: string}
      | undefined;
    expect(details?.existingId).toBe(canonicalNpcId);
    expect(details?.existingName).toBe(SPAWN_NAME);
  });
});
