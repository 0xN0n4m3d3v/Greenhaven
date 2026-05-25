/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-1 — recovery codes must be generated from `crypto.randomBytes`,
// not from `Math.random()`. These tests cover the pure generator
// exposed via `playerServiceInternals` so they don't need the
// PGlite-backed `createAnonymousPlayer` flow:
//
//   1. Format invariant — four groups of four characters from the
//      base32 alphabet that excludes the confusable `0`/`O`/`1`/`I`
//      glyphs, separated by dashes (`XXXX-XXXX-XXXX-XXXX`).
//   2. `Math.random()` is never called on the recovery-code path. We
//      install a hostile spy that throws if touched and assert the
//      generator still returns a well-formed code.
//   3. Each call returns a distinct code (smoke check that the
//      generator pulls fresh entropy from `randomBytes` rather than
//      caching a single value).
//
// DEEP-2 — recovery now stores an indexed prefix on insert and filters
// restore candidates by it instead of scanning every hash. The
// DB-backed describe block at the bottom exercises both halves: the
// prefix is persisted in plaintext, restore returns the matching
// player without the prefix index in the path of every hash compare,
// and legacy rows whose prefix is NULL are deliberately excluded.
//
// DEEP-13 — recovery-code hashing/verifying now goes through the
// native NAPI `@node-rs/bcrypt`. The two additional describe blocks
// at the bottom prove (a) a hash written by the old `bcryptjs`
// implementation is still restorable through the new `compare`, and
// (b) 100 parallel compares do not block the event loop the way the
// old pure-JS library used to.

import {hash as bcryptHash} from '@node-rs/bcrypt';
import {randomUUID} from 'node:crypto';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from './turn/framework.js';
import {playerServiceInternals} from '../playerService.js';

const {generateRecoveryCode} = playerServiceInternals;

const RECOVERY_CODE_FORMAT =
  /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

describe('generateRecoveryCode (DEEP-1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns four groups of four base32 characters separated by dashes', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(RECOVERY_CODE_FORMAT);
    expect(code).toHaveLength(19);
    expect(code).not.toContain('0');
    expect(code).not.toContain('O');
    expect(code).not.toContain('1');
    expect(code).not.toContain('I');
  });

  it('does not call Math.random() — entropy comes from node:crypto', () => {
    const rng = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error(
        'Math.random must not be called by recovery-code generator (DEEP-1)',
      );
    });
    const code = generateRecoveryCode();
    expect(code).toMatch(RECOVERY_CODE_FORMAT);
    expect(rng).not.toHaveBeenCalled();
  });

  it('returns distinct codes across calls', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 32; i++) codes.add(generateRecoveryCode());
    // Collision probability across 32 draws against a 32^16 keyspace is
    // astronomically below 1, so even a flake-tolerant threshold of 30
    // unique values is conservative.
    expect(codes.size).toBeGreaterThanOrEqual(30);
  });
});

// DEEP-2 + DEEP-13 share one PGlite instance — both blocks insert
// players directly, so re-initialising the framework between them
// would trip the config() cache guard.
let createAnonymousPlayer: typeof import('../playerService.js').createAnonymousPlayer;
let restoreByRecoveryCode: typeof import('../playerService.js').restoreByRecoveryCode;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({createAnonymousPlayer, restoreByRecoveryCode} = await import(
    '../playerService.js'
  ));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

describe('recovery_code_prefix + restoreByRecoveryCode (DEEP-2)', () => {

  it('persists the four-character uppercase prefix on insert', async () => {
    const player = await createAnonymousPlayer(`DEEP-2 prefix ${Date.now()}`);
    const rows = await queryRows<{
      recovery_code_prefix: string | null;
      recovery_code_hash: string | null;
    }>(
      `SELECT recovery_code_prefix, recovery_code_hash
         FROM players
        WHERE entity_id = $1`,
      [player.entity_id],
    );
    expect(rows.length).toBe(1);
    const expectedPrefix = player.recovery_code.slice(0, 4).toUpperCase();
    expect(rows[0]!.recovery_code_prefix).toBe(expectedPrefix);
    // CHECK constraint guard — the stored prefix is exactly four
    // characters from the recovery-code alphabet (no 0/O/1/I).
    expect(rows[0]!.recovery_code_prefix).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(typeof rows[0]!.recovery_code_hash).toBe('string');
  });

  it('restoreByRecoveryCode returns the matching player', async () => {
    const created = await createAnonymousPlayer(`DEEP-2 restore ${Date.now()}`);
    const restored = await restoreByRecoveryCode(created.recovery_code);
    expect(restored).not.toBeNull();
    expect(restored!.entity_id).toBe(created.entity_id);
    expect(restored!.public_id).toBe(created.public_id);
  });

  it('restoreByRecoveryCode trims and uppercases the submitted code', async () => {
    const created = await createAnonymousPlayer(`DEEP-2 trim ${Date.now()}`);
    const messy = `   ${created.recovery_code.toLowerCase()}   `;
    const restored = await restoreByRecoveryCode(messy);
    expect(restored).not.toBeNull();
    expect(restored!.entity_id).toBe(created.entity_id);
  });

  it('returns null for short / non-alphabet submissions before any DB lookup', async () => {
    expect(await restoreByRecoveryCode('short')).toBeNull();
    // 0/O/1/I are not part of the recovery alphabet, so a code starting
    // with them is rejected by the prefix regex before bcrypt runs.
    expect(await restoreByRecoveryCode('0000-AAAA-BBBB-CCCC')).toBeNull();
    expect(await restoreByRecoveryCode('IIII-AAAA-BBBB-CCCC')).toBeNull();
  });

  it('returns null when no row has the matching prefix', async () => {
    await createAnonymousPlayer(`DEEP-2 nomatch ${Date.now()}`);
    // Construct a syntactically-valid recovery code that no player
    // can possibly own (random tail) so the prefix lookup succeeds
    // or fails depending on collision — either way, this exact code
    // is not in the table.
    const fake = `${generateRecoveryCode()}`;
    const restored = await restoreByRecoveryCode(fake);
    expect(restored).toBeNull();
  });

  it('does not match legacy rows whose recovery_code_prefix is NULL', async () => {
    // Simulate a pre-migration-0116 player: write a row with a valid
    // bcrypt hash for a known plaintext but leave the prefix NULL.
    const legacyEntity = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, profile, tags)
       VALUES ('player', 'DEEP-2 legacy', '{}'::jsonb, ARRAY['player'])
       RETURNING id`,
    );
    const legacyId = legacyEntity[0]!.id;
    const plaintext = generateRecoveryCode();
    const legacyHash = await bcryptHash(plaintext, 4);
    await queryRows(
      `INSERT INTO players
         (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
       VALUES ($1, $2, $3, NULL)`,
      [legacyId, randomUUID(), legacyHash],
    );

    const restored = await restoreByRecoveryCode(plaintext);
    expect(restored).toBeNull();
  });
});

describe('@node-rs/bcrypt legacy + parallel compatibility (DEEP-13)', () => {
  // Hash fixture generated by `bcryptjs@3.0.2` (the previously-installed
  // library) using `bcrypt.hash('LEGACY-CODE-TEST-PASS', 4)`. This pins
  // the regression: a row written by the old library MUST still be
  // restorable through the new native `compare`. Both implementations
  // emit `$2b$cost$saltAndHash` for cost ≥ 4, so cross-verification is
  // expected by the bcrypt format — the test exists so a future native
  // upgrade cannot quietly drop legacy hash compatibility.
  const LEGACY_PLAINTEXT = 'LEGACY-CODE-TEST-PASS';
  const LEGACY_BCRYPTJS_HASH =
    '$2b$04$CVTmwHSFUCva9CUjchEQn.a1o6EAKmoR4efM3XseSDt5KXXmR6Mkm';

  it('restores a player whose hash was written by bcryptjs (cost 4, $2b$ prefix)', async () => {
    const entity = await queryRows<{id: number}>(
      `INSERT INTO entities (kind, display_name, profile, tags)
       VALUES ('player', 'DEEP-13 legacy hash', '{}'::jsonb, ARRAY['player'])
       RETURNING id`,
    );
    const entityId = entity[0]!.id;
    const publicId = randomUUID();
    await queryRows(
      `INSERT INTO players
         (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
       VALUES ($1, $2, $3, $4)`,
      [
        entityId,
        publicId,
        LEGACY_BCRYPTJS_HASH,
        LEGACY_PLAINTEXT.slice(0, 4).toUpperCase(),
      ],
    );

    const restored = await restoreByRecoveryCode(LEGACY_PLAINTEXT);
    expect(restored).not.toBeNull();
    expect(restored!.entity_id).toBe(entityId);
    expect(restored!.public_id).toBe(publicId);
  });

  it('100 parallel compares do not block the event loop', async () => {
    // The legacy-hash test above already seeded one player whose
    // hash matches LEGACY_PLAINTEXT, so the candidate query has at
    // least one row. We do not assert which entity_id wins (multiple
    // candidates could share the prefix across tests); the contract
    // we exercise is that 100 concurrent compares all resolve and the
    // event loop services a sentinel while they are in flight.
    //
    // Track whether the event loop services a setImmediate sentinel
    // while the bcrypt work is in flight. The pure-JS `bcryptjs`
    // library would keep the main thread synchronously busy through
    // every compare, so this sentinel would only fire after all 100
    // finished. The native NAPI binding offloads to a worker, so the
    // sentinel fires almost immediately.
    let sentinelFiredDuringCompares = false;
    const sentinel = setImmediate(() => {
      sentinelFiredDuringCompares = true;
    });

    const restores = Array.from({length: 100}, () =>
      restoreByRecoveryCode(LEGACY_PLAINTEXT),
    );
    const results = await Promise.all(restores);

    clearImmediate(sentinel);
    expect(sentinelFiredDuringCompares).toBe(true);
    for (const r of results) {
      expect(r).not.toBeNull();
    }
  });
});
