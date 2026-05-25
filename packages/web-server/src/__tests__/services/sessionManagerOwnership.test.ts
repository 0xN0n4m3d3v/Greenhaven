/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-11 — session adoption guard.
//
// Before DEEP-11 `SessionManager.assertStoredSessionAdoptable`
// only checked `chat_messages` and `tool_invocations` for
// foreign-owner traces. A foreign-owned `sessions` row with no
// chat or tool history was therefore adoptable through any flow
// that fed `assertStoredSessionAdoptable` directly. The fix
// pushes the `sessions.player_id` non-null mismatch check into
// the guard itself so the adoption flow has a single canonical
// gate: a foreign-owned row is rejected even when the session
// has no messages.
//
// These tests drive the live `SessionManager.getOrCreate(...)` flow
// against the real PGlite test harness so the SQL gate is
// exercised end-to-end.

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let SessionOwnershipError: typeof import('../../sessionManager.js').SessionOwnershipError;
let sessionManager: typeof import('../../sessionManager.js').sessionManager;
let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({SessionOwnershipError, sessionManager} = await import(
    '../../sessionManager.js'
  ));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

async function newPlayer(label: string): Promise<number> {
  const p = await createAnonymousPlayer(`DEEP-11 ${label} ${Date.now()}`);
  return p.entity_id;
}

async function seedSession(opts: {
  sessionId: string;
  ownerId: number | null;
}): Promise<void> {
  await queryRows(
    `INSERT INTO sessions (id, metadata, player_id)
     VALUES ($1, '{}'::jsonb, $2)`,
    [opts.sessionId, opts.ownerId],
  );
}

async function readStoredOwner(sessionId: string): Promise<number | null> {
  const rows = await queryRows<{player_id: number | string | null}>(
    `SELECT player_id FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const raw = rows[0]?.player_id ?? null;
  if (raw === null) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

async function dropSession(sessionId: string): Promise<void> {
  try {
    await sessionManager.destroy(sessionId);
  } catch {
    // The live cache may not hold this id when the foreign-adopt
    // attempt rejected before `bootSession` could install the
    // session — fine, the DB row is dropped below either way.
  }
  await queryRows(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

describe('SessionManager adoption guard (DEEP-11)', () => {
  it('rejects a foreign-owned session with NO chat/tool history', async () => {
    const owner = await newPlayer('owner');
    const intruder = await newPlayer('intruder');
    const sessionId = `deep11-foreign-empty-${owner}-${intruder}`;
    await seedSession({sessionId, ownerId: owner});
    try {
      await expect(
        sessionManager.getOrCreate(sessionId, intruder),
      ).rejects.toBeInstanceOf(SessionOwnershipError);
      // The stored owner must not have been overwritten.
      expect(await readStoredOwner(sessionId)).toBe(owner);
    } finally {
      await dropSession(sessionId);
    }
  });

  it('allows the rightful owner to resume their session', async () => {
    const owner = await newPlayer('owner');
    const sessionId = `deep11-same-owner-${owner}`;
    await seedSession({sessionId, ownerId: owner});
    try {
      const session = await sessionManager.getOrCreate(sessionId, owner);
      expect(session.id).toBe(sessionId);
      expect(session.playerId).toBe(owner);
      expect(await readStoredOwner(sessionId)).toBe(owner);
    } finally {
      await dropSession(sessionId);
    }
  });

  it('allows adoption of a null-owner session with no foreign history', async () => {
    const adopter = await newPlayer('adopter');
    const sessionId = `deep11-null-owner-empty-${adopter}`;
    await seedSession({sessionId, ownerId: null});
    try {
      const session = await sessionManager.getOrCreate(sessionId, adopter);
      expect(session.playerId).toBe(adopter);
      // claimStoredSession should have written the new owner.
      expect(await readStoredOwner(sessionId)).toBe(adopter);
    } finally {
      await dropSession(sessionId);
    }
  });

  it('rejects a null-owner session whose chat_messages history points to a foreign player', async () => {
    const ghostOwner = await newPlayer('ghost');
    const adopter = await newPlayer('adopter');
    const sessionId = `deep11-null-owner-foreign-history-${ghostOwner}-${adopter}`;
    await seedSession({sessionId, ownerId: null});
    // Plant a chat message that points back to a different
    // player — the pre-DEEP-11 guard already rejected this case,
    // so the test pins that the new stronger guard still
    // refuses it.
    await queryRows(
      `INSERT INTO chat_messages (session_id, player_id, text, tone, turn_index)
       VALUES ($1, $2, 'stale', 'spoken', 0)`,
      [sessionId, ghostOwner],
    );
    try {
      await expect(
        sessionManager.getOrCreate(sessionId, adopter),
      ).rejects.toBeInstanceOf(SessionOwnershipError);
      // The null owner stays null — claimStoredSession must not
      // have run.
      expect(await readStoredOwner(sessionId)).toBeNull();
    } finally {
      await queryRows(`DELETE FROM chat_messages WHERE session_id = $1`, [
        sessionId,
      ]);
      await dropSession(sessionId);
    }
  });
});
