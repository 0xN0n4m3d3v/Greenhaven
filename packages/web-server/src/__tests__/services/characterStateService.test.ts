/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — `CharacterStateService.snapshot` contract.
//
// Pins the typed Character State DTO without booting PGlite. We
// mock `query()` so each `it` plants the rows it cares about
// (players + stats + skills + xp_log + titles + progression +
// wallet + runtime fields) and assert the resulting snapshot.
// The InventoryReadService is also mocked so the equipment
// summary is deterministic without touching the real inventory
// tables. Migration shape + FKs + check constraints live in the
// companion PGlite migration test.

import {beforeEach, describe, expect, it, vi} from 'vitest';

interface QueryRow {
  [key: string]: unknown;
}

interface QueryResult {
  rows: QueryRow[];
  rowCount?: number;
}

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();

vi.mock('../../db.js', () => ({
  query: queryMock,
}));

const inventorySnapshotMock = vi.fn();
vi.mock('../../services/InventoryReadService.js', () => ({
  InventoryReadService: {
    snapshot: inventorySnapshotMock,
  },
}));

const {CharacterStateService} = await import(
  '../../services/CharacterStateService.js'
);

// Default empty inventory snapshot — replace per-test as needed.
function emptyInventory() {
  return {
    playerId: 7,
    currency: {count: 0},
    equipment: [],
    items: [],
    totals: {itemCount: 0, uniqueItems: 0, weightKg: 0, equippedCount: 0},
  };
}

// Queue: player → stats → proficient → ranked → titles → progression
// → wallet → xpLog → runtimeFields → xpFloors → portableArtifacts
// → companionBonds.
// All SELECTs run; Promise.all wraps everything after the player
// lookup so we just queue them in declaration order.
// FEAT-HERO-CONTINUITY-3 — `portableArtifacts` + `companionBonds`
// come last because HeroContinuityLedgerService runs after the rest
// inside the same Promise.all.
function queueRows(rows: Record<string, QueryRow[]>): void {
  // Order matches `snapshot()` SQL emission. The first call is the
  // player lookup; the rest run in Promise.all (deterministic
  // because the implementation passes a literal array to
  // Promise.all, so the mock returns them in the order they were
  // queued).
  const order = [
    'player',
    'stats',
    'proficient',
    'ranked',
    'titles',
    'progression',
    'wallet',
    'xpLog',
    'runtimeFields',
    'xpFloors',
    'portableArtifacts',
    'companionBonds',
  ];
  for (const key of order) {
    queryMock.mockResolvedValueOnce({rows: rows[key] ?? []});
  }
}

describe('CharacterStateService.snapshot (FEAT-STATE-1)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    inventorySnapshotMock.mockReset();
    inventorySnapshotMock.mockResolvedValue(emptyInventory());
  });

  it('returns null when the player row is missing', async () => {
    queryMock.mockResolvedValueOnce({rows: []});
    const snap = await CharacterStateService.snapshot(42);
    expect(snap).toBeNull();
    // No follow-up queries beyond the player lookup.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(inventorySnapshotMock).not.toHaveBeenCalled();
  });

  it('returns a typed snapshot with empty collections for a fresh player', async () => {
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'Codex Smoke',
          class_id: 600,
          class_name: 'Fighter',
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: 'en',
          profile: {created: true},
        },
      ],
      stats: [],
      proficient: [],
      ranked: [],
      titles: [],
      progression: [],
      wallet: [],
      xpLog: [],
      runtimeFields: [],
      // Level 1 fresh player: floor 0 (level 1 = [0, 400) on the
      // canonical curve `level_for_xp(xp) = floor(sqrt(xp/100))`),
      // next threshold 400 = xp_required_for_level(2).
      xpFloors: [{this_floor: 0, next_xp: 400}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap).not.toBeNull();
    expect(snap!.playerId).toBe(7);
    expect(snap!.identity).toEqual({
      publicId: 'pub-7',
      displayName: 'Codex Smoke',
      profileCreated: true,
      classId: 600,
      className: 'Fighter',
      preferredLanguage: 'en',
    });
    expect(snap!.vitals.hp).toEqual({current: 10, max: 10});
    expect(snap!.vitals.xp.total).toBe(0);
    expect(snap!.vitals.xp.level).toBe(1);
    expect(snap!.vitals.xp.thisLevelFloor).toBe(0);
    expect(snap!.vitals.xp.nextLevelXp).toBe(400);
    expect(snap!.vitals.xp.progress).toBe(0);
    expect(snap!.stats).toEqual([]);
    expect(snap!.proficientSkills).toEqual([]);
    expect(snap!.rankedSkills).toEqual([]);
    expect(snap!.titles).toEqual([]);
    expect(snap!.progression.tracks).toEqual([]);
    expect(snap!.progression.wallet.statPoints).toBe(0);
    expect(snap!.progression.wallet.titleSlots).toBe(1);
    expect(snap!.recentXpLog).toEqual([]);
    expect(snap!.conditions).toEqual([]);
    expect(snap!.trauma).toEqual([]);
    expect(snap!.equipment).toEqual({equippedCount: 0, items: []});
    // FEAT-HERO-CONTINUITY-3 — empty ledger surfaces empty arrays.
    expect(snap!.continuity).toEqual({
      schemaVersion: 'greenhaven.character_state_continuity.v1',
      portableArtifacts: [],
      travelingCompanions: [],
      worldBoundCompanions: [],
    });
  });

  it('exposes portable artifacts + traveling/world-bound bonds (FEAT-HERO-CONTINUITY-3)', async () => {
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'Continuity Hero',
          class_id: null,
          class_name: null,
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      xpFloors: [{this_floor: 0, next_xp: 400}],
      portableArtifacts: [
        {
          id: 1,
          player_id: 7,
          artifact_key: 'gold-feather',
          kind: 'relic',
          portability: 'portable',
          source_universe_instance_id: null,
          source_cartridge_id: 'cart-a',
          power_rating: 4,
          payload: {summary: 'a feather of pact'},
          created_at: '2026-05-17T00:00:00Z',
          updated_at: '2026-05-17T00:00:00Z',
        },
      ],
      companionBonds: [
        {
          id: 11,
          player_id: 7,
          companion_key: 'sworn',
          source_entity_id: 42,
          source_universe_instance_id: null,
          source_cartridge_id: 'cart-a',
          status: 'traveling',
          portability: 'portable',
          public_summary: 'sworn ally',
          private_summary: null,
          bond_payload: {},
          created_at: '2026-05-17T00:00:00Z',
          updated_at: '2026-05-17T00:00:00Z',
        },
        {
          id: 12,
          player_id: 7,
          companion_key: 'hearthkeeper',
          source_entity_id: 43,
          source_universe_instance_id: null,
          source_cartridge_id: 'cart-a',
          status: 'world_bound',
          portability: 'local_locked',
          public_summary: null,
          private_summary: null,
          bond_payload: {},
          created_at: '2026-05-17T00:00:00Z',
          updated_at: '2026-05-17T00:00:00Z',
        },
      ],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.continuity.portableArtifacts).toHaveLength(1);
    expect(snap!.continuity.portableArtifacts[0]!.artifactKey).toBe(
      'gold-feather',
    );
    expect(snap!.continuity.travelingCompanions).toHaveLength(1);
    expect(snap!.continuity.travelingCompanions[0]!.companionKey).toBe('sworn');
    expect(snap!.continuity.worldBoundCompanions).toHaveLength(1);
    expect(snap!.continuity.worldBoundCompanions[0]!.companionKey).toBe(
      'hearthkeeper',
    );
  });

  it('derives XP progress from xp_required_for_level floors (level >= 2)', async () => {
    // Level 2 spans [400, 900) on the canonical curve. The
    // service SQL is `xp_required_for_level($1)::bigint` for
    // levels >= 2, which for level 2 returns 400 — that agrees
    // with the inverse `level_for_xp(400) = 2`.
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 600,
          current_level: 2,
          current_hp: 18,
          max_hp: 22,
          preferred_language: null,
          profile: null,
        },
      ],
      xpFloors: [{this_floor: 400, next_xp: 900}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.vitals.xp.total).toBe(600);
    expect(snap!.vitals.xp.level).toBe(2);
    expect(snap!.vitals.xp.thisLevelFloor).toBe(400);
    expect(snap!.vitals.xp.nextLevelXp).toBe(900);
    expect(snap!.vitals.xp.progress).toBeCloseTo(0.4, 5);
  });

  it('reports progress=1 only when SQL itself returns null nextLevelXp', async () => {
    // The service no longer caps `nextLevelXp` unilaterally at
    // level 20 — that would silently disagree with `award_xp`
    // writes the broker still issues past the threshold. The
    // bar only shows full when SQL itself returns null (e.g.
    // a future schema adds a hard `max_level` rule downstream).
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 40000,
          current_level: 20,
          current_hp: 100,
          max_hp: 100,
          preferred_language: null,
          profile: null,
        },
      ],
      xpFloors: [{this_floor: 36100, next_xp: null}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.vitals.xp.nextLevelXp).toBeNull();
    expect(snap!.vitals.xp.progress).toBe(1);
  });

  it('drops the service-only level-20 cap and computes progress at high levels', async () => {
    // At level 20 on the canonical quadratic curve:
    //   thisLevelFloor = xp_required_for_level(20) = 40000
    //   nextLevelXp    = xp_required_for_level(21) = 44100
    // A player at xp 40000 has just reached level 20 → progress 0.
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 40000,
          current_level: 20,
          current_hp: 100,
          max_hp: 100,
          preferred_language: null,
          profile: null,
        },
      ],
      xpFloors: [{this_floor: 40000, next_xp: 44100}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.vitals.xp.thisLevelFloor).toBe(40000);
    expect(snap!.vitals.xp.nextLevelXp).toBe(44100);
    expect(snap!.vitals.xp.progress).toBeCloseTo(0, 5);
    // Confirm the service's SQL does NOT special-case level 20.
    const xpSql = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('xp_required_for_level'),
    )?.[0] as string;
    expect(xpSql).not.toMatch(/>=\s*20/);
  });

  it('treats level 1 floor as 0 and level N floor as xp_required_for_level(N)', async () => {
    // The canonical inverse `level_for_xp(xp) = floor(sqrt(xp/100))`
    // clamps to 1, so level 1 spans xp [0, 400) — floor 0, not
    // the literal `xp_required_for_level(1) = 100`. For level N
    // >= 2, `level_for_xp(xp_required_for_level(N)) = N`, so the
    // floor is `xp_required_for_level(N)` (NOT `(N - 1)` as an
    // earlier draft assumed). Pin both in the SQL the service
    // issues so future rewrites can't silently re-introduce the
    // 0..99 dead zone at level 1 or the half-level shift at
    // level >= 2.
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 250,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      xpFloors: [{this_floor: 0, next_xp: 400}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.vitals.xp.thisLevelFloor).toBe(0);
    expect(snap!.vitals.xp.nextLevelXp).toBe(400);
    expect(snap!.vitals.xp.progress).toBeCloseTo(0.625, 5);
    const xpSql = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('xp_required_for_level'),
    )?.[0] as string;
    // Level 1 special case: WHEN $1 <= 1 THEN 0::bigint
    expect(xpSql).toMatch(/\$1 <= 1/);
    expect(xpSql).toMatch(/0::bigint/);
    // Level N >= 2: ELSE xp_required_for_level($1)::bigint
    // (NOT `xp_required_for_level($1 - 1)`).
    expect(xpSql).toMatch(/ELSE xp_required_for_level\(\$1\)::bigint/);
    expect(xpSql).not.toMatch(/xp_required_for_level\(\$1 - 1\)/);
    // Next-level threshold always reads xp_required_for_level($1 + 1).
    expect(xpSql).toMatch(/xp_required_for_level\(\$1 \+ 1\)::bigint/);
  });

  it('orders stats, proficient skills, and ranked skills deterministically', async () => {
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      stats: [
        {stat_key: 'STR', base: 14, current: 16},
        {stat_key: 'DEX', base: 12, current: 12},
      ],
      proficient: [
        {skill_name: 'Athletics', proficiency_level: 1},
        {skill_name: 'Insight', proficiency_level: 2},
      ],
      ranked: [
        {
          skill_entity_id: 101,
          display_name: 'Stealth',
          rank: 3,
          unlocked_at: '2026-05-16T19:00:00.000Z',
          metadata: {note: 'expert'},
        },
      ],
      xpFloors: [{this_floor: 100, next_xp: 400}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.stats).toEqual([
      {key: 'STR', base: 14, current: 16},
      {key: 'DEX', base: 12, current: 12},
    ]);
    expect(snap!.proficientSkills).toEqual([
      {skillName: 'Athletics', proficiencyLevel: 1},
      {skillName: 'Insight', proficiencyLevel: 2},
    ]);
    expect(snap!.rankedSkills[0]).toEqual({
      skillEntityId: 101,
      name: 'Stealth',
      rank: 3,
      unlockedAt: '2026-05-16T19:00:00.000Z',
      metadata: {note: 'expert'},
    });
    // Spot-check the SQL the implementation used so we catch
    // accidental rewrites of the ORDER BY clauses the UI relies
    // on.
    const skillsSql = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('FROM player_skills'),
    )?.[0] as string;
    expect(skillsSql).toMatch(/ORDER BY ps\.rank DESC/);
    const titlesSql = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('FROM player_titles'),
    )?.[0] as string;
    expect(titlesSql).toMatch(/ORDER BY is_equipped DESC/);
  });

  it('reads titles with is_equipped first and dedup-key projection', async () => {
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      titles: [
        {
          id: 11,
          title_key: 'bell-ringer',
          display_name: 'Bell Ringer',
          description: 'Rang the dusk bell.',
          source: 'quest',
          awarded_at: '2026-05-16T18:00:00.000Z',
          is_equipped: true,
          metadata: {},
        },
        {
          id: 12,
          title_key: 'wanderer',
          display_name: 'Wanderer',
          description: null,
          source: null,
          awarded_at: '2026-05-15T11:00:00.000Z',
          is_equipped: false,
          metadata: {region: 'Greenhaven'},
        },
      ],
      xpFloors: [{this_floor: 100, next_xp: 400}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.titles.length).toBe(2);
    expect(snap!.titles[0]?.isEquipped).toBe(true);
    expect(snap!.titles[0]?.titleKey).toBe('bell-ringer');
    expect(snap!.titles[1]?.metadata).toEqual({region: 'Greenhaven'});
  });

  it('reads progression tracks joined with the catalog + wallet defaults', async () => {
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      progression: [
        {
          track_key: 'survival',
          display_name: 'Survival',
          description: 'Wilderness ladder.',
          xp: 350,
          level: 3,
          max_level: 10,
          sort_order: 1,
          metadata: {tier: 'bronze'},
          updated_at: '2026-05-16T18:00:00.000Z',
        },
      ],
      wallet: [
        {
          stat_points: 4,
          skill_points: 2,
          title_slots: 3,
          updated_at: '2026-05-16T18:00:00.000Z',
        },
      ],
      xpFloors: [{this_floor: 100, next_xp: 400}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.progression.tracks[0]).toEqual({
      trackKey: 'survival',
      displayName: 'Survival',
      description: 'Wilderness ladder.',
      xp: 350,
      level: 3,
      maxLevel: 10,
      sortOrder: 1,
      metadata: {tier: 'bronze'},
      updatedAt: '2026-05-16T18:00:00.000Z',
    });
    expect(snap!.progression.wallet).toEqual({
      statPoints: 4,
      skillPoints: 2,
      titleSlots: 3,
      updatedAt: '2026-05-16T18:00:00.000Z',
    });
  });

  it('limits recent XP log to 20 rows and preserves order', async () => {
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      xpLog: [
        {
          id: 99,
          amount: 25,
          reason: 'Lit the bell',
          awarded_by_tool: 'grant_xp',
          awarded_at: '2026-05-16T19:00:00.000Z',
          metadata: {questId: 1},
        },
      ],
      xpFloors: [{this_floor: 100, next_xp: 400}],
    });
    await CharacterStateService.snapshot(7);
    const xpSql = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('FROM player_xp_log'),
    );
    expect(xpSql).toBeDefined();
    expect(String(xpSql![0])).toMatch(/LIMIT \$2/);
    expect(xpSql![1]).toEqual([7, 20]);
  });

  it('flattens conditions/trauma runtime arrays into typed entries', async () => {
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      runtimeFields: [
        {
          field_key: 'conditions',
          value: [
            {tag: 'bleeding', severity: 2},
            {tag: 'concussed', severity: 1},
          ],
        },
        {
          field_key: 'trauma',
          value: ['betrayed', 'abandoned'],
        },
      ],
      xpFloors: [{this_floor: 100, next_xp: 400}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.conditions.map((c) => c.key)).toEqual([
      'bleeding',
      'concussed',
    ]);
    expect(snap!.trauma.map((t) => t.key)).toEqual([
      'betrayed',
      'abandoned',
    ]);
  });

  it('summarizes equipment from InventoryReadService output', async () => {
    inventorySnapshotMock.mockResolvedValue({
      ...emptyInventory(),
      equipment: [
        {
          id: 'pi:42',
          rowId: 42,
          source: 'player_inventory',
          slug: 'codex_blade',
          name: 'Codex Blade',
          summary: null,
          category: 'weapon',
          quantity: 1,
          stackable: false,
          weightKg: 1.2,
          rarity: 'rare',
          iconKey: 'sword',
          equipped: true,
          equippedSlot: 'main_hand',
          attributes: {},
        },
      ],
      totals: {itemCount: 0, uniqueItems: 0, weightKg: 0, equippedCount: 1},
    });
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      xpFloors: [{this_floor: 100, next_xp: 400}],
    });
    const snap = await CharacterStateService.snapshot(7);
    expect(snap!.equipment.equippedCount).toBe(1);
    expect(snap!.equipment.items[0]).toEqual({
      id: 'pi:42',
      name: 'Codex Blade',
      slug: 'codex_blade',
      slot: 'main_hand',
      rarity: 'rare',
      iconKey: 'sword',
    });
  });

  it('does not parse rail status / state strings anywhere', async () => {
    // Static guarantee — the SQL the implementation runs never
    // references the rail status / state strings or chat prose.
    // We grep the accumulated mock-call SQL strings.
    queueRows({
      player: [
        {
          entity_id: 7,
          public_id: 'pub-7',
          display_name: 'P',
          class_id: null,
          class_name: null,
          current_xp: 0,
          current_level: 1,
          current_hp: 10,
          max_hp: 10,
          preferred_language: null,
          profile: null,
        },
      ],
      xpFloors: [{this_floor: 100, next_xp: 400}],
    });
    await CharacterStateService.snapshot(7);
    const allSql = queryMock.mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(allSql).not.toMatch(/hero\.statuses/);
    expect(allSql).not.toMatch(/hero\.states/);
    expect(allSql).not.toMatch(/chat_messages/);
  });
});
