/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-3 (2026-05-17) — HeroContinuityLedgerService
// exercised against real PGlite.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let HeroContinuityLedgerService:
  typeof import('../../services/HeroContinuityLedgerService.js').HeroContinuityLedgerService;
let HeroContinuityLedgerServiceError:
  typeof import('../../services/HeroContinuityLedgerService.js').HeroContinuityLedgerServiceError;
let createAnonymousPlayer:
  typeof import('../../playerService.js').createAnonymousPlayer;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({HeroContinuityLedgerService, HeroContinuityLedgerServiceError} =
    await import('../../services/HeroContinuityLedgerService.js'));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
}, 600_000);

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

const CART = 'cart-hcl-svc';
const KEY_PREFIX = 'hclsvc:';

beforeEach(async () => {
  // Stable cleanup keyed on our own prefix so we never trample
  // unrelated rows.
  await queryRows(
    `DELETE FROM hero_companion_capsules WHERE companion_bond_id IN
       (SELECT id FROM hero_companion_bonds WHERE companion_key LIKE $1)`,
    [`${KEY_PREFIX}%`],
  );
  await queryRows(
    `DELETE FROM companion_universe_projections WHERE companion_bond_id IN
       (SELECT id FROM hero_companion_bonds WHERE companion_key LIKE $1)`,
    [`${KEY_PREFIX}%`],
  );
  await queryRows(
    `DELETE FROM hero_companion_bonds WHERE companion_key LIKE $1`,
    [`${KEY_PREFIX}%`],
  );
  await queryRows(
    `DELETE FROM hero_portable_artifacts WHERE artifact_key LIKE $1`,
    [`${KEY_PREFIX}%`],
  );
  await queryRows(
    `DELETE FROM hero_continuity_events WHERE event_type LIKE $1`,
    [`${KEY_PREFIX}%`],
  );
  await queryRows(`DELETE FROM universe_instances WHERE cartridge_id = $1`, [
    CART,
  ]);
  await queryRows(`DELETE FROM cartridges WHERE id = $1`, [CART]);
});

async function seedCartridgeAndUniverse(): Promise<string> {
  await queryRows(
    `INSERT INTO cartridges (id, title, version, schema_version,
                              source_kind, content_hash)
     VALUES ($1, 'HCL Svc', '0.1', '1', 'forge_project', $2)
     ON CONFLICT (id) DO NOTHING`,
    [CART, `sha256:${CART}`],
  );
  const u = await queryRows<{id: string}>(
    `INSERT INTO universe_instances
       (cartridge_id, content_hash, title, mode, is_default)
     VALUES ($1, $2, 'HCL Svc', 'local_single_player', true)
     RETURNING id`,
    [CART, `sha256:${CART}`],
  );
  return u[0]!.id;
}

describe('HeroContinuityLedgerService (FEAT-HERO-CONTINUITY-3)', () => {
  it('records and lists continuity events newest first', async () => {
    const hero = await createAnonymousPlayer(
      `HCL-SVC events ${Date.now()}`,
    );
    await HeroContinuityLedgerService.recordContinuityEvent({
      playerId: hero.entity_id,
      eventType: `${KEY_PREFIX}awarded_title`,
      payload: {title: 'rumormonger'},
    });
    await HeroContinuityLedgerService.recordContinuityEvent({
      playerId: hero.entity_id,
      eventType: `${KEY_PREFIX}entered_world`,
      payload: {cartridge: CART},
    });
    const timeline =
      await HeroContinuityLedgerService.listHeroUniverseTimeline(
        hero.entity_id,
      );
    expect(timeline).toHaveLength(2);
    expect(timeline[0]!.eventType).toBe(`${KEY_PREFIX}entered_world`);
    expect(timeline[1]!.eventType).toBe(`${KEY_PREFIX}awarded_title`);
    expect(timeline[1]!.payload).toEqual({title: 'rumormonger'});
  });

  it('rejects events without an event_type', async () => {
    const hero = await createAnonymousPlayer(`HCL-SVC reject ${Date.now()}`);
    let caught: unknown = null;
    try {
      await HeroContinuityLedgerService.recordContinuityEvent({
        playerId: hero.entity_id,
        eventType: '',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HeroContinuityLedgerServiceError);
    expect((caught as InstanceType<typeof HeroContinuityLedgerServiceError>).code).toBe(
      'invalid_input',
    );
  });

  it('upsertPortableArtifact is idempotent on the dedupe key', async () => {
    const hero = await createAnonymousPlayer(
      `HCL-SVC artifact ${Date.now()}`,
    );
    const first = await HeroContinuityLedgerService.upsertPortableArtifact({
      playerId: hero.entity_id,
      artifactKey: `${KEY_PREFIX}relic-1`,
      kind: 'relic',
      powerRating: 3,
      payload: {summary: 'a chipped coin'},
    });
    const second = await HeroContinuityLedgerService.upsertPortableArtifact({
      playerId: hero.entity_id,
      artifactKey: `${KEY_PREFIX}relic-1`,
      kind: 'relic',
      powerRating: 5,
      payload: {summary: 'a tarnished coin'},
    });
    expect(second.id).toBe(first.id);
    expect(second.powerRating).toBe(5);
    const list = await HeroContinuityLedgerService.listPortableArtifacts(
      hero.entity_id,
    );
    const ours = list.filter(row =>
      row.artifactKey.startsWith(KEY_PREFIX),
    );
    expect(ours).toHaveLength(1);
    expect(ours[0]!.payload).toEqual({summary: 'a tarnished coin'});
  });

  it('upsertCompanionBond is idempotent on the dedupe key', async () => {
    const hero = await createAnonymousPlayer(
      `HCL-SVC bond ${Date.now()}`,
    );
    const first = await HeroContinuityLedgerService.upsertCompanionBond({
      playerId: hero.entity_id,
      companionKey: `${KEY_PREFIX}cmp-1`,
      portability: 'portable',
      publicSummary: 'fellow traveler',
    });
    const second = await HeroContinuityLedgerService.upsertCompanionBond({
      playerId: hero.entity_id,
      companionKey: `${KEY_PREFIX}cmp-1`,
      portability: 'portable',
      status: 'traveling',
      publicSummary: 'fellow traveler, sworn',
    });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('traveling');
    expect(second.publicSummary).toBe('fellow traveler, sworn');
  });

  it('listCompanionCarryoverCandidates does not mutate the roster or bonds', async () => {
    const hero = await createAnonymousPlayer(
      `HCL-SVC candidates ${Date.now()}`,
    );
    // Seed a roster entry with a real companion entity so the resolver
    // returns the display name. No bond yet.
    const companion = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, dynamic_origin)
       VALUES ('person', 'Roster Friend', true)
       RETURNING id`,
    );
    const companionId = Number(companion[0]!.id);
    await queryRows(
      `UPDATE players
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('companions', $1::jsonb)
        WHERE entity_id = $2`,
      [JSON.stringify([companionId]), hero.entity_id],
    );
    const before = await queryRows<{companions: unknown}>(
      `SELECT metadata->'companions' AS companions
         FROM players WHERE entity_id = $1`,
      [hero.entity_id],
    );

    const candidates =
      await HeroContinuityLedgerService.listCompanionCarryoverCandidates(
        hero.entity_id,
      );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceEntityId).toBe(companionId);
    expect(candidates[0]!.displayName).toBe('Roster Friend');
    expect(candidates[0]!.bond).toBeNull();

    const after = await queryRows<{companions: unknown}>(
      `SELECT metadata->'companions' AS companions
         FROM players WHERE entity_id = $1`,
      [hero.entity_id],
    );
    expect(JSON.stringify(after[0])).toBe(JSON.stringify(before[0]));

    // Bonds table untouched by the listing.
    const bondRows = await queryRows<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM hero_companion_bonds WHERE player_id = $1`,
      [hero.entity_id],
    );
    expect(Number(bondRows[0]!.n)).toBe(0);
  });

  it('buildCompanionCapsule snapshots only companion-owned state', async () => {
    const universeId = await seedCartridgeAndUniverse();
    const hero = await createAnonymousPlayer(
      `HCL-SVC capsule ${Date.now()}`,
    );
    const heroId = hero.entity_id;

    // Companion entity (the contracted NPC). persona_slug stays NULL
    // so the entities_persona_slug_fkey is satisfied without seeding
    // the persona registry.
    const cmp = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, summary, profile, i18n, cartridge_id)
       VALUES ('person', 'Capsule Friend', 'a sworn ally',
               $1::jsonb, $2::jsonb, $3)
       RETURNING id`,
      [
        JSON.stringify({oath: 'never break trust'}),
        JSON.stringify({display_name: {ru: 'Капсульный Друг'}}),
        CART,
      ],
    );
    const cmpId = Number(cmp[0]!.id);

    // An unrelated NPC whose state must NOT leak into the capsule.
    const stranger = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, cartridge_id)
       VALUES ('person', 'Stranger', $1)
       RETURNING id`,
      [CART],
    );
    const strangerId = Number(stranger[0]!.id);

    // Item that the companion holds.
    const item = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, cartridge_id)
       VALUES ('item', 'Polished Coin', $1)
       RETURNING id`,
      [CART],
    );
    const itemId = Number(item[0]!.id);

    // Stats + statuses + inventory owned by the companion.
    await queryRows(
      `INSERT INTO npc_stats (npc_entity_id, stat_key, base, current)
       VALUES ($1, 'STR', 5, 5),
              ($1, 'DEX', 4, 3)`,
      [cmpId],
    );
    await queryRows(
      `INSERT INTO actor_statuses
         (player_id, actor_entity_id, status_kind, status_value, intensity, source)
       VALUES ($1, $2, 'companion', 'following', 1.0, 'test')`,
      [heroId, cmpId],
    );
    await queryRows(
      `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count, metadata)
       VALUES ($1, $2, 3, $3::jsonb)`,
      [cmpId, itemId, JSON.stringify({polished: true})],
    );

    // Runtime field with companion's relationship string toward the hero.
    const rfRow = await queryRows<{id: number}>(
      `INSERT INTO runtime_fields (owner_entity_id, field_key, value_type)
       VALUES ($1, 'strings', 'json') RETURNING id`,
      [cmpId],
    );
    const rfId = Number(rfRow[0]!.id);
    await queryRows(
      `INSERT INTO runtime_values (field_id, value)
       VALUES ($1, $2::jsonb)`,
      [rfId, JSON.stringify({[String(heroId)]: 6, [String(strangerId)]: -2})],
    );

    // Memories: one about the hero (carries verbatim), one about the
    // stranger (counted but text NOT lifted into aboutHero), one
    // memory owned by the unrelated stranger (NEVER appears).
    await queryRows(
      `INSERT INTO npc_memories (owner_entity_id, about_entity_id, text, importance)
       VALUES ($1, $2, 'the hero shielded me at the gate', 0.8),
              ($1, $3, 'the stranger looked at me oddly', 0.2),
              ($3, $1, 'i resent the hero', 0.9)`,
      [cmpId, heroId, strangerId],
    );

    // Bond row pointing the capsule at the companion.
    const bond = await HeroContinuityLedgerService.upsertCompanionBond({
      playerId: heroId,
      companionKey: `${KEY_PREFIX}cmp-capsule`,
      sourceEntityId: cmpId,
      sourceUniverseInstanceId: universeId,
      sourceCartridgeId: CART,
      portability: 'portable',
      status: 'traveling',
      publicSummary: 'sworn ally',
    });

    const capsule = await HeroContinuityLedgerService.buildCompanionCapsule(
      bond.id,
      {sourceUniverseInstanceId: universeId},
    );
    expect(capsule.capsuleVersion).toBe(1);
    expect(capsule.stateHash.length).toBeGreaterThan(0);

    const payload = capsule.payload;
    expect(payload.schemaVersion).toBe('greenhaven.companion_capsule.v1');
    expect(payload.companionEntityId).toBe(cmpId);
    expect(payload.identity.displayName).toBe('Capsule Friend');
    expect(payload.identity.profile).toEqual({oath: 'never break trust'});
    expect(payload.identity.i18n).toEqual({
      display_name: {ru: 'Капсульный Друг'},
    });
    expect(payload.stats).toEqual([
      {statKey: 'DEX', base: 4, current: 3},
      {statKey: 'STR', base: 5, current: 5},
    ]);
    expect(payload.statuses).toHaveLength(1);
    expect(payload.statuses[0]!.statusKind).toBe('companion');
    // FEAT-HERO-CONTINUITY-4-FOLLOWUP — inventory entries now carry
    // identity metadata so the launch carryover can resolve items
    // in the target cartridge without trusting source-world ids.
    expect(payload.inventory).toHaveLength(1);
    expect(payload.inventory[0]!.itemEntityId).toBe(itemId);
    expect(payload.inventory[0]!.count).toBe(3);
    expect(payload.inventory[0]!.metadata).toEqual({polished: true});
    expect(payload.inventory[0]!.item.displayName).toBe('Polished Coin');
    expect(payload.inventory[0]!.item.kind).toBe('item');
    // The seeded item has no `profile.source_slug`, so the
    // capsule reports `null` here.
    expect(payload.inventory[0]!.item.sourceSlug).toBeNull();
    // FEAT-HERO-CONTINUITY-3 corrective — `strings` runtime field
    // must keep only the hero entry; the seeded `strangerId: -2`
    // value must never reach the capsule. The canonical hero
    // relationship still rides on `payload.stringTowardHero`.
    const stringsField = payload.runtimeFields.find(
      f => f.fieldKey === 'strings',
    );
    expect(stringsField).toBeTruthy();
    expect(stringsField!.value).toEqual({[String(heroId)]: 6});
    expect(payload.stringTowardHero).toBe(6);

    // Memories: ONLY the about-hero entry is verbatim; the about-
    // stranger memory contributes to otherCount but is not lifted.
    expect(payload.memories.aboutHero).toHaveLength(1);
    expect(payload.memories.aboutHero[0]!.text).toContain('shielded me');
    expect(payload.memories.otherCount).toBe(1);
    // The stranger-owned memory is excluded entirely; the stranger
    // id from the `strings` map must also not appear anywhere in
    // the serialized payload.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('i resent the hero');
    expect(serialized).not.toContain('looked at me oddly');
    expect(serialized).not.toContain(String(strangerId));
    // Sanity-check: the hero id IS present (it's the dedupe key
    // for several payload slices), so the negation above is
    // exercising the leak guard, not a missing serialization.
    expect(serialized).toContain(String(heroId));

    // Second capsule build bumps the version.
    const v2 = await HeroContinuityLedgerService.buildCompanionCapsule(bond.id);
    expect(v2.capsuleVersion).toBe(2);
    const latest = await HeroContinuityLedgerService.getLatestCapsule(bond.id);
    expect(latest?.capsuleVersion).toBe(2);
  });

  it('buildCompanionCapsule rejects an unknown bond id', async () => {
    let caught: unknown = null;
    try {
      await HeroContinuityLedgerService.buildCompanionCapsule(99_999_999);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HeroContinuityLedgerServiceError);
    expect(
      (caught as InstanceType<typeof HeroContinuityLedgerServiceError>).code,
    ).toBe('unknown_bond');
  });
});
