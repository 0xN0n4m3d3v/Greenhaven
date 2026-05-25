/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-HERO-CONTINUITY-1 (2026-05-17) — read-only continuity preview.
//
// Drives `HeroContinuityService.previewTransfer(playerId,
// targetCartridgeId)` against real PGlite so the taxonomy / policy
// fallback / no-mutation contract is exercised against the actual
// schema. The service must:
//
//   * return the documented default policy when scoped meta has no
//     `hero_continuity_policy` row;
//   * read a custom policy when it exists, including the
//     companions `portable_contracts` carry hint;
//   * classify `players.current_xp/current_level`,
//     `player_stats`, `player_proficient_skills`, `player_skills`,
//     `player_titles`, `player_progression_tracks`, and
//     `player_progression_wallets` as carrying with the hero
//     (`hero_core`);
//   * classify `player_inventory`, `player_quests`,
//     `player_journal_entries`, `npc_memories(owner=player)`,
//     relationship-string `gui_events`, and
//     `players.metadata.companions[]` as `universe_local` that
//     stays in the source world;
//   * never mutate rows.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let HeroContinuityService:
  typeof import('../../services/HeroContinuityService.js').HeroContinuityService;
let HeroContinuityServiceError:
  typeof import('../../services/HeroContinuityService.js').HeroContinuityServiceError;
let HeroContinuityLedgerService:
  typeof import('../../services/HeroContinuityLedgerService.js').HeroContinuityLedgerService;
let createAnonymousPlayer:
  typeof import('../../playerService.js').createAnonymousPlayer;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({HeroContinuityService, HeroContinuityServiceError} = await import(
    '../../services/HeroContinuityService.js'
  ));
  ({HeroContinuityLedgerService} = await import(
    '../../services/HeroContinuityLedgerService.js'
  ));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
}, 600_000);

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

const CART_A = 'cart-cont-a';
const CART_B = 'cart-cont-b';

beforeEach(async () => {
  // FEAT-HERO-CONTINUITY-3 — wipe any ledger rows left by prior runs
  // so the additive `portableArtifacts`/`companionCandidates` fields
  // start empty for every test.
  await queryRows(
    `DELETE FROM hero_companion_capsules WHERE companion_bond_id IN
       (SELECT id FROM hero_companion_bonds WHERE companion_key LIKE 'hctest:%')`,
  );
  await queryRows(
    `DELETE FROM companion_universe_projections WHERE companion_bond_id IN
       (SELECT id FROM hero_companion_bonds WHERE companion_key LIKE 'hctest:%')`,
  );
  await queryRows(
    `DELETE FROM hero_companion_bonds WHERE companion_key LIKE 'hctest:%'`,
  );
  await queryRows(
    `DELETE FROM hero_portable_artifacts WHERE artifact_key LIKE 'hctest:%'`,
  );
  await queryRows(
    `DELETE FROM cartridge_meta_scoped WHERE cartridge_id IN ($1, $2)`,
    [CART_A, CART_B],
  );
  await queryRows(`DELETE FROM cartridges WHERE id IN ($1, $2)`, [
    CART_A,
    CART_B,
  ]);
});

async function seedCartridge(id: string): Promise<void> {
  await queryRows(
    `INSERT INTO cartridges (id, title, version, schema_version,
                              source_kind, content_hash)
     VALUES ($1, $2, '0.1', '1', 'forge_project', $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, `Cart ${id}`, `sha256:${id}`],
  );
}

async function setHeroCore(
  playerId: number,
  opts: {level: number; xp: number},
): Promise<void> {
  await queryRows(
    `UPDATE players SET current_level = $1, current_xp = $2 WHERE entity_id = $3`,
    [opts.level, opts.xp, playerId],
  );
}

describe('HeroContinuityService.previewTransfer (FEAT-HERO-CONTINUITY-1)', () => {
  it('throws unknown_player on a non-positive playerId', async () => {
    await seedCartridge(CART_A);
    let caught: unknown = null;
    try {
      await HeroContinuityService.previewTransfer(0, CART_A);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HeroContinuityServiceError);
    expect((caught as InstanceType<typeof HeroContinuityServiceError>).code).toBe(
      'unknown_player',
    );
  });

  it('throws unknown_cartridge when the target id is unknown', async () => {
    const player = await createAnonymousPlayer(
      `FEAT-HERO-CONTINUITY-1 unknown-cart ${Date.now()}`,
    );
    let caught: unknown = null;
    try {
      await HeroContinuityService.previewTransfer(
        player.entity_id,
        'cart-does-not-exist',
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HeroContinuityServiceError);
    expect((caught as InstanceType<typeof HeroContinuityServiceError>).code).toBe(
      'unknown_cartridge',
    );
  });

  it('returns the documented default policy when scoped meta is empty', async () => {
    await seedCartridge(CART_A);
    const player = await createAnonymousPlayer(
      `FEAT-HERO-CONTINUITY-1 default-policy ${Date.now()}`,
    );
    await setHeroCore(player.entity_id, {level: 3, xp: 250});

    const preview = await HeroContinuityService.previewTransfer(
      player.entity_id,
      CART_A,
    );

    expect(preview.targetCartridgeId).toBe(CART_A);
    expect(preview.schemaVersion).toBe(
      'greenhaven.hero_continuity.preview.v1',
    );
    expect(preview.policy.isDefault).toBe(true);
    expect(preview.policy.carry).toEqual({
      xpLevel: 'visible',
      titles: 'visible',
      inventory: 'local_only',
      quests: 'local_only',
      relationships: 'local_only',
      memories: 'summary_only',
      companions: 'local_only',
    });
    expect(preview.hero.level).toBe(3);
    expect(preview.hero.xp).toBe(250);
    expect(preview.hero.playerId).toBe(player.entity_id);
    expect(preview.audit.mutatesRows).toBe(false);
    expect(preview.audit.readsFrom).toContain('player_stats');
    expect(preview.audit.readsFrom).toContain('cartridge_meta_scoped');

    const codes = preview.carriesWithHero.map(row => row.code);
    expect(codes).toEqual([
      'level_xp',
      'stats',
      'skills',
      'titles',
      'progression',
      'wallet',
    ]);
    for (const row of preview.carriesWithHero) {
      expect(row.classification).toBe('hero_core');
    }
    const localCodes = preview.staysInSourceWorld.map(row => row.code);
    expect(localCodes).toContain('inventory');
    expect(localCodes).toContain('quests');
    expect(localCodes).toContain('relationship_strings');
    expect(localCodes).toContain('companions_roster');
    // FEAT-HERO-CONTINUITY-2 — preview also reports current
    // location/scene as universe-local summary entries (counts only,
    // no raw payload). The seeded hero has no
    // `players.current_location_id` yet, so both surface as
    // count=0 / nonEmpty=false.
    expect(localCodes).toContain('current_location');
    expect(localCodes).toContain('current_scene');
    for (const row of preview.staysInSourceWorld) {
      expect(row.classification).toBe('universe_local');
    }

    // FEAT-HERO-CONTINUITY-3 — ledger is empty on a fresh hero, so
    // both additive arrays surface as []. The audit listing also
    // records the two new ledger tables as read sources.
    expect(preview.portableArtifacts).toEqual([]);
    expect(preview.companionCandidates).toEqual([]);
    expect(preview.audit.readsFrom).toContain('hero_portable_artifacts');
    expect(preview.audit.readsFrom).toContain('hero_companion_bonds');
  });

  it('reads cartridge_meta_scoped.hero_continuity_policy when present', async () => {
    await seedCartridge(CART_B);
    await queryRows(
      `INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
       VALUES ($1, 'hero_continuity_policy', $2::jsonb, 'test')
       ON CONFLICT (cartridge_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        CART_B,
        JSON.stringify({
          schema_version: 'greenhaven.hero_continuity_policy.v1',
          carry: {
            xp_level: 'visible',
            titles: 'hidden',
            memories: 'local_only',
            companions: 'portable_contracts',
          },
        }),
      ],
    );
    const player = await createAnonymousPlayer(
      `FEAT-HERO-CONTINUITY-1 custom-policy ${Date.now()}`,
    );
    const preview = await HeroContinuityService.previewTransfer(
      player.entity_id,
      CART_B,
    );
    expect(preview.policy.isDefault).toBe(false);
    expect(preview.policy.carry.titles).toBe('hidden');
    expect(preview.policy.carry.memories).toBe('local_only');
    expect(preview.policy.carry.companions).toBe('portable_contracts');
    expect(preview.policy.raw).not.toBeNull();
  });

  it('classifies universe_local state with counts and warnings', async () => {
    await seedCartridge(CART_A);
    const player = await createAnonymousPlayer(
      `FEAT-HERO-CONTINUITY-1 local-state ${Date.now()}`,
    );
    // Seed two companion ids and one journal entry so the local
    // summary surfaces real counts. We do not need real entity rows
    // for the companion ids because the resolver tolerates missing
    // rows and returns `'?'` as the display name.
    await queryRows(
      `UPDATE players
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('companions', $1::jsonb)
        WHERE entity_id = $2`,
      [JSON.stringify([88881, 88882]), player.entity_id],
    );
    await queryRows(
      `INSERT INTO player_journal_entries
         (player_id, entry_type, event_type, title)
       VALUES ($1, 'world', 'world:beat', 'A small note')`,
      [player.entity_id],
    );
    // FEAT-HERO-CONTINUITY-2 — seed a current location entity so the
    // continuity preview surfaces a non-zero current_location count.
    // A real cartridge id is not needed: the preview only counts the
    // player row's `current_location_id`, not the entity's cartridge.
    const locRow = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, cartridge_id, dynamic_origin)
       VALUES ('location', 'Continuity Test Hearth', $1, false)
       RETURNING id`,
      [CART_A],
    );
    const locId = Number(locRow[0]!.id);
    await queryRows(
      `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
      [locId, player.entity_id],
    );

    const preview = await HeroContinuityService.previewTransfer(
      player.entity_id,
      CART_A,
    );
    const byCode = new Map(
      preview.staysInSourceWorld.map(row => [row.code, row]),
    );
    expect(byCode.get('companions_roster')?.count).toBe(2);
    expect(byCode.get('companions_roster')?.nonEmpty).toBe(true);
    expect(byCode.get('notices')?.count).toBe(1);
    expect(byCode.get('notices')?.nonEmpty).toBe(true);
    expect(byCode.get('current_location')?.count).toBe(1);
    expect(byCode.get('current_location')?.nonEmpty).toBe(true);

    expect(preview.companions).toHaveLength(2);
    for (const entry of preview.companions) {
      expect(entry.status).toBe('native_local');
      expect(entry.reason).toBe('no_bond_contract');
    }

    const warningCodes = preview.warnings.map(w => w.code);
    expect(warningCodes).toContain('companions_local_only');
    expect(warningCodes).toContain('current_location_local_only');
  });

  it('surfaces portable artifacts + bonded companion classification (FEAT-HERO-CONTINUITY-3)', async () => {
    await seedCartridge(CART_A);
    const player = await createAnonymousPlayer(
      `FEAT-HERO-CONTINUITY-3 ledger ${Date.now()}`,
    );
    // Seed a roster companion (no bond yet, stays native_local) and a
    // separate bonded companion that will surface as portable_companion.
    const rosterCompanion = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, dynamic_origin)
       VALUES ('person', 'Roster Pal', true)
       RETURNING id`,
    );
    const rosterId = Number(rosterCompanion[0]!.id);
    const bondedCompanion = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, dynamic_origin)
       VALUES ('person', 'Sworn Ally', true)
       RETURNING id`,
    );
    const bondedId = Number(bondedCompanion[0]!.id);
    await queryRows(
      `UPDATE players
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('companions', $1::jsonb)
        WHERE entity_id = $2`,
      [JSON.stringify([rosterId, bondedId]), player.entity_id],
    );
    await HeroContinuityLedgerService.upsertCompanionBond({
      playerId: player.entity_id,
      companionKey: 'hctest:sworn',
      sourceEntityId: bondedId,
      portability: 'portable',
      status: 'traveling',
      publicSummary: 'travels with the hero',
    });
    // A dangling bond (no roster entry, world-bound) — should appear in
    // companionCandidates as a separate "stays behind" entry.
    const worldBoundCompanion = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, dynamic_origin)
       VALUES ('person', 'Hearth Keeper', true)
       RETURNING id`,
    );
    const worldBoundId = Number(worldBoundCompanion[0]!.id);
    await HeroContinuityLedgerService.upsertCompanionBond({
      playerId: player.entity_id,
      companionKey: 'hctest:hearthkeeper',
      sourceEntityId: worldBoundId,
      portability: 'local_locked',
      status: 'world_bound',
    });
    // One portable artifact so the preview ships a non-empty array.
    await HeroContinuityLedgerService.upsertPortableArtifact({
      playerId: player.entity_id,
      artifactKey: 'hctest:gold-feather',
      kind: 'relic',
      portability: 'portable',
      powerRating: 4,
      payload: {summary: 'a feather of pact'},
    });

    const preview = await HeroContinuityService.previewTransfer(
      player.entity_id,
      CART_A,
    );

    // Artifact surfaced as additive ledger summary.
    expect(preview.portableArtifacts).toHaveLength(1);
    expect(preview.portableArtifacts[0]!.artifactKey).toBe(
      'hctest:gold-feather',
    );
    expect(preview.portableArtifacts[0]!.kind).toBe('relic');

    // Companion classification: roster-only stays native_local, bonded
    // becomes portable_companion, world-bound bond appears in
    // companionCandidates as a separate entry.
    const byId = new Map(
      preview.companions.map(row => [row.sourceEntityId, row]),
    );
    expect(byId.get(rosterId)?.status).toBe('native_local');
    expect(byId.get(rosterId)?.reason).toBe('no_bond_contract');
    expect(byId.get(bondedId)?.status).toBe('portable_companion');
    expect(byId.get(bondedId)?.reason).toBe('portable_contract');

    const candidateByEntityId = new Map(
      preview.companionCandidates.map(row => [row.sourceEntityId, row]),
    );
    expect(candidateByEntityId.get(rosterId)?.hasBond).toBe(false);
    expect(candidateByEntityId.get(bondedId)?.hasBond).toBe(true);
    expect(candidateByEntityId.get(bondedId)?.companionKey).toBe(
      'hctest:sworn',
    );
    expect(candidateByEntityId.get(worldBoundId)?.status).toBe('world_bound');
    expect(candidateByEntityId.get(worldBoundId)?.hasBond).toBe(true);

    // Roster + bond reads must not have written anything new.
    expect(preview.audit.mutatesRows).toBe(false);
  });

  it('does not mutate rows', async () => {
    await seedCartridge(CART_A);
    const player = await createAnonymousPlayer(
      `FEAT-HERO-CONTINUITY-1 no-mutation ${Date.now()}`,
    );
    await setHeroCore(player.entity_id, {level: 4, xp: 444});
    const beforeXp = await queryRows<{xp: number | string}>(
      `SELECT current_xp AS xp FROM players WHERE entity_id = $1`,
      [player.entity_id],
    );
    await HeroContinuityService.previewTransfer(player.entity_id, CART_A);
    const afterXp = await queryRows<{xp: number | string}>(
      `SELECT current_xp AS xp FROM players WHERE entity_id = $1`,
      [player.entity_id],
    );
    expect(Number(afterXp[0]?.xp)).toBe(Number(beforeXp[0]?.xp));
    // hero_cartridge_states must still be empty for this (player,
    // cartridge) pair — preview must never create a row.
    const states = await queryRows<{cartridge_id: string}>(
      `SELECT cartridge_id FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [player.entity_id, CART_A],
    );
    expect(states).toEqual([]);
    // FEAT-HERO-CONTINUITY-3 — preview must never write to the new
    // ledger tables either.
    const artifactRows = await queryRows<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM hero_portable_artifacts WHERE player_id = $1`,
      [player.entity_id],
    );
    expect(Number(artifactRows[0]?.n ?? 0)).toBe(0);
    const bondRows = await queryRows<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM hero_companion_bonds WHERE player_id = $1`,
      [player.entity_id],
    );
    expect(Number(bondRows[0]?.n ?? 0)).toBe(0);
    const eventRows = await queryRows<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM hero_continuity_events WHERE player_id = $1`,
      [player.entity_id],
    );
    expect(Number(eventRows[0]?.n ?? 0)).toBe(0);
  });
});
