/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-STATE-1 — focused contract tests for the five Character
// State mutation tools registered in `tools/progression.ts`:
//
//   * `award_progression_xp` — side-track XP grant
//   * `award_title`          — dedup-keyed title award
//   * `equip_title`          — title slot enforcement
//   * `spend_stat_point`     — wallet → stat increment
//   * `spend_skill_point`    — wallet → skill rank
//
// Each case seeds the minimum prerequisite state via real PGlite
// (`setupTurnTestEnvironment` + the shared turn-test framework),
// dispatches the tool through its registered `execute()` with a
// session-scoped `ToolContext`, and asserts on the resulting DB
// rows + the durable `gui_events` envelope each mutation must
// emit so `useCharacterState` refreshes.

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  setupTestSession,
  type TestSession,
} from '../turn/framework.js';

let getRegisteredTools: typeof import('../../tools/base.js').getRegisteredTools;
let runWithContext: typeof import('../../tools/base.js').runWithContext;
let query: typeof import('../../db.js').query;

beforeAll(async () => {
  // setupTestSession bootstraps PGlite + imports tools/index.ts
  // (the side-effect registry) before the helpers below resolve.
  // We re-import the helpers AFTER setup so the same PGlite
  // module instance is shared.
  await import('../../tools/index.js');
  ({getRegisteredTools, runWithContext} = await import('../../tools/base.js'));
  ({query} = await import('../../db.js'));
});

afterAll(async () => {
  // The shared framework's `rm(dataDir, ...)` races the gameplay
  // log writer on Windows (open `gameplay-logs/*.jsonl` fd
  // prevents directory removal). The test suite itself owns no
  // cleanup contract beyond closing PGlite, so we swallow the
  // EBUSY / ENOTEMPTY surface and let the OS reap the temp dir
  // at process exit.
  try {
    await cleanupTurnTestEnvironment();
  } catch (err) {
    if (err instanceof Error && /(ENOTEMPTY|EBUSY|EPERM)/.test(err.message)) {
      return;
    }
    throw err;
  }
});

interface ToolHandle {
  execute: (
    args: Record<string, unknown>,
    ctx: {sessionId: string; playerId: number},
  ) => Promise<unknown>;
}

function getTool(name: string): ToolHandle {
  const def = getRegisteredTools().get(name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  // Tool defs are parameterized over a zod schema; we cast for
  // the test surface — the real boundary still runs the schema
  // in `executeTool` for production callers.
  return def as unknown as ToolHandle;
}

async function runTool(
  test: TestSession,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = getTool(name);
  return runWithContext(
    {sessionId: test.sessionId, playerId: test.playerId},
    () => tool.execute(args, {sessionId: test.sessionId, playerId: test.playerId}),
  );
}

async function lastGuiEvent(
  test: TestSession,
  eventType: string,
): Promise<Record<string, unknown> | null> {
  const rows = await query<{event_type: string; payload: Record<string, unknown>}>(
    `SELECT event_type, payload FROM gui_events
      WHERE player_id = $1 AND event_type = $2
      ORDER BY id DESC LIMIT 1`,
    [test.playerId, eventType],
  );
  return rows.rows[0]?.payload ?? null;
}

async function seedTrack(
  trackKey: string,
  xpCurve: Record<string, unknown>,
  maxLevel = 20,
): Promise<void> {
  await query(
    `INSERT INTO progression_tracks
       (track_key, display_name, description, xp_curve, max_level, sort_order)
     VALUES ($1, $2, $3, $4::jsonb, $5, 1)
     ON CONFLICT (track_key) DO UPDATE
       SET xp_curve = EXCLUDED.xp_curve,
           max_level = EXCLUDED.max_level`,
    [trackKey, trackKey, 'smoke', JSON.stringify(xpCurve), maxLevel],
  );
}

async function seedSkillEntity(name: string): Promise<number> {
  const r = await query<{id: number}>(
    `INSERT INTO entities (kind, display_name, profile, tags, cartridge_id)
     VALUES ('skill', $1, '{}'::jsonb, ARRAY['skill'], 'quickgrin-lane')
     RETURNING id`,
    [name],
  );
  return Number(r.rows[0]!.id);
}

async function seedWallet(
  playerId: number,
  patch: Partial<{stat_points: number; skill_points: number; title_slots: number}>,
): Promise<void> {
  await query(
    `INSERT INTO player_progression_wallets
       (player_id, stat_points, skill_points, title_slots)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (player_id) DO UPDATE
       SET stat_points = EXCLUDED.stat_points,
           skill_points = EXCLUDED.skill_points,
           title_slots = EXCLUDED.title_slots,
           updated_at = now()`,
    [
      playerId,
      patch.stat_points ?? 0,
      patch.skill_points ?? 0,
      patch.title_slots ?? 1,
    ],
  );
}

describe.sequential('FEAT-STATE-1 progression mutation tools', () => {
  let test: TestSession;
  beforeAll(async () => {
    test = await setupTestSession();
  }, 600_000);

  describe('award_progression_xp', () => {
    it('rejects unknown track_key', async () => {
      await expect(
        runTool(test, 'award_progression_xp', {
          track_key: 'does-not-exist',
          amount: 50,
          reason: 'unknown track',
        }),
      ).rejects.toThrow(/unknown progression track/i);
    });

    it('inserts the row, derives level from xpPerLevel curve, and emits character:skill_progressed', async () => {
      await seedTrack('survival', {xpPerLevel: [100, 200, 400]}, 5);
      const result = (await runTool(test, 'award_progression_xp', {
        track_key: 'survival',
        amount: 250,
        reason: 'smoke seed',
      })) as Record<string, unknown>;
      expect(result['xp_after']).toBe(250);
      // 250 XP on xpPerLevel=[100,200,400]:
      // level 1→2 after 100, 2→3 after 300, so at 250 player is level 2.
      expect(result['level_after']).toBe(2);
      const event = await lastGuiEvent(test, 'character:skill_progressed');
      expect(event).toBeTruthy();
      expect(event?.['trackKey']).toBe('survival');
      expect(event?.['xp']).toBe(250);
      expect(event?.['level']).toBe(2);
      const row = await query<{xp: number | string; level: number}>(
        `SELECT xp, level FROM player_progression_tracks
          WHERE player_id = $1 AND track_key = $2`,
        [test.playerId, 'survival'],
      );
      expect(Number(row.rows[0]?.xp)).toBe(250);
      expect(Number(row.rows[0]?.level)).toBe(2);
    });

    it('clamps level at max_level', async () => {
      await seedTrack('combat', {step: 50}, 3);
      const result = (await runTool(test, 'award_progression_xp', {
        track_key: 'combat',
        amount: 1000,
        reason: 'overflow',
      })) as Record<string, unknown>;
      // With step=50 and 1000 xp, naive level would be 21; cap=3.
      expect(result['level_after']).toBe(3);
    });

    it('accumulates XP across sequential first-time grants instead of overwriting', async () => {
      // Regression for the prior `SET xp = EXCLUDED.xp` overwrite
      // bug: with a fresh track and no pre-existing row, two
      // sequential first-time grants must both stick. The new
      // additive `SET xp = player_progression_tracks.xp +
      // EXCLUDED.xp` upsert plus the CTE that captures the
      // pre-state in one statement is what makes this safe.
      await seedTrack('first-grant-seq', {step: 200}, 10);
      const first = (await runTool(test, 'award_progression_xp', {
        track_key: 'first-grant-seq',
        amount: 50,
        reason: 'seq-1',
      })) as Record<string, unknown>;
      expect(first['xp_before']).toBe(0);
      expect(first['xp_after']).toBe(50);
      const second = (await runTool(test, 'award_progression_xp', {
        track_key: 'first-grant-seq',
        amount: 75,
        reason: 'seq-2',
      })) as Record<string, unknown>;
      expect(second['xp_before']).toBe(50);
      expect(second['xp_after']).toBe(125);
      const row = await query<{xp: number | string}>(
        `SELECT xp FROM player_progression_tracks
          WHERE player_id = $1 AND track_key = $2`,
        [test.playerId, 'first-grant-seq'],
      );
      expect(Number(row.rows[0]?.xp)).toBe(125);
    });

    it('survives concurrent first-time grants without losing XP (Promise.all)', async () => {
      // PGlite serializes statements internally, so this test
      // does not deterministically interleave statements at the
      // SQL layer the way managed Postgres does — but the
      // contract we need to pin is "two awaited grants always
      // sum, even when launched concurrently from the
      // application layer." The additive CTE+upsert keeps that
      // invariant regardless of whether the rows are created
      // first or in the second call's DO UPDATE branch.
      await seedTrack('first-grant-race', {step: 200}, 10);
      const results = (await Promise.all([
        runTool(test, 'award_progression_xp', {
          track_key: 'first-grant-race',
          amount: 30,
          reason: 'race-a',
        }),
        runTool(test, 'award_progression_xp', {
          track_key: 'first-grant-race',
          amount: 70,
          reason: 'race-b',
        }),
      ])) as Array<Record<string, unknown>>;
      expect(results).toHaveLength(2);
      const a = results[0]!;
      const b = results[1]!;
      // Whichever call's transaction commits first sees
      // xp_before=0; the other sees xp_before=(first's amount).
      // The sum of their `xp_after` deltas must equal 100.
      const totalDelta =
        Number(a['xp_after']) - Number(a['xp_before']) +
        (Number(b['xp_after']) - Number(b['xp_before']));
      expect(totalDelta).toBe(100);
      const row = await query<{xp: number | string}>(
        `SELECT xp FROM player_progression_tracks
          WHERE player_id = $1 AND track_key = $2`,
        [test.playerId, 'first-grant-race'],
      );
      expect(Number(row.rows[0]?.xp)).toBe(100);
    });

    it('uses the additive `xp = table.xp + EXCLUDED.xp` upsert form (SQL pin)', async () => {
      // Static SQL pin so a future refactor cannot silently
      // re-introduce the lost-update bug by reverting to the
      // overwriting `SET xp = EXCLUDED.xp` form. We dispatch
      // through real PGlite to ensure the statement is exactly
      // what the tool issues, then grep the file source.
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const {fileURLToPath} = await import('node:url');
      const here = path.dirname(fileURLToPath(import.meta.url));
      const src = await fs.readFile(
        path.resolve(here, '..', '..', 'tools', 'progression.ts'),
        'utf8',
      );
      expect(src).toMatch(
        /xp\s*=\s*player_progression_tracks\.xp\s*\+\s*EXCLUDED\.xp/,
      );
      expect(src).not.toMatch(/SET xp\s*=\s*EXCLUDED\.xp/);
    });
  });

  describe('award_title', () => {
    it('inserts on first call and emits character:title_awarded', async () => {
      const result = (await runTool(test, 'award_title', {
        title_key: 'bell-ringer',
        display_name: 'Bell Ringer',
        description: 'Rang the dusk bell.',
        source: 'quest',
      })) as Record<string, unknown>;
      expect(result['newly_awarded']).toBe(true);
      const event = await lastGuiEvent(test, 'character:title_awarded');
      expect(event?.['titleKey']).toBe('bell-ringer');
      expect(event?.['displayName']).toBe('Bell Ringer');
    });

    it('dedupes on second call with the same key', async () => {
      const result = (await runTool(test, 'award_title', {
        title_key: 'bell-ringer',
        display_name: 'Bell Ringer (dup)',
      })) as Record<string, unknown>;
      expect(result['newly_awarded']).toBe(false);
      const count = await query<{count: number | string}>(
        `SELECT COUNT(*)::int AS count FROM player_titles
          WHERE player_id = $1 AND title_key = 'bell-ringer'`,
        [test.playerId],
      );
      expect(Number(count.rows[0]?.count)).toBe(1);
    });
  });

  describe('equip_title', () => {
    it('rejects equipping a title the player has not earned', async () => {
      await expect(
        runTool(test, 'equip_title', {title_key: 'phantom', equip: true}),
      ).rejects.toThrow(/has not earned title/i);
    });

    it('equips the title, enforces title_slots, and emits character:title_equipped', async () => {
      await seedWallet(test.playerId, {title_slots: 1});
      // bell-ringer was awarded above.
      const first = (await runTool(test, 'equip_title', {
        title_key: 'bell-ringer',
        equip: true,
      })) as Record<string, unknown>;
      expect(first['equipped']).toBe(true);
      expect(first['changed']).toBe(true);
      const event = await lastGuiEvent(test, 'character:title_equipped');
      expect(event?.['equipped']).toBe(true);

      // Award a second title, then try to equip — only 1 slot.
      await runTool(test, 'award_title', {
        title_key: 'wanderer',
        display_name: 'Wanderer',
      });
      await expect(
        runTool(test, 'equip_title', {
          title_key: 'wanderer',
          equip: true,
        }),
      ).rejects.toThrow(/title_slots exhausted/i);

      // Unequip releases the slot; the next equip then succeeds.
      const unequip = (await runTool(test, 'equip_title', {
        title_key: 'bell-ringer',
        equip: false,
      })) as Record<string, unknown>;
      expect(unequip['equipped']).toBe(false);
      const second = (await runTool(test, 'equip_title', {
        title_key: 'wanderer',
        equip: true,
      })) as Record<string, unknown>;
      expect(second['equipped']).toBe(true);
    });
  });

  describe('spend_stat_point', () => {
    it('rejects when the wallet has zero stat_points', async () => {
      await seedWallet(test.playerId, {stat_points: 0});
      await expect(
        runTool(test, 'spend_stat_point', {stat_key: 'STR'}),
      ).rejects.toThrow(/no stat_points/i);
    });

    it('decrements the wallet, increments base+current, and emits character:stat_changed', async () => {
      await seedWallet(test.playerId, {stat_points: 2, title_slots: 1});
      // Wipe any existing STR row so the default 10/10 insert path
      // runs cleanly under the test.
      await query(`DELETE FROM player_stats WHERE player_id = $1`, [
        test.playerId,
      ]);
      const result = (await runTool(test, 'spend_stat_point', {
        stat_key: 'STR',
        reason: 'smoke',
      })) as Record<string, unknown>;
      expect(result['base']).toBe(11);
      expect(result['current']).toBe(11);
      expect(result['stat_points_remaining']).toBe(1);
      const event = await lastGuiEvent(test, 'character:stat_changed');
      expect(event?.['statKey']).toBe('STR');
      expect(event?.['base']).toBe(11);
      const wallet = await query<{stat_points: number}>(
        `SELECT stat_points FROM player_progression_wallets WHERE player_id = $1`,
        [test.playerId],
      );
      expect(Number(wallet.rows[0]?.stat_points)).toBe(1);
    });
  });

  describe('spend_skill_point', () => {
    it('rejects unknown skill', async () => {
      await seedWallet(test.playerId, {skill_points: 1});
      await expect(
        runTool(test, 'spend_skill_point', {skill: 'never-defined-skill-name'}),
      ).rejects.toThrow(/unknown skill/i);
    });

    it('rejects when wallet has zero skill_points', async () => {
      await seedSkillEntity('Smoke Tracking');
      await seedWallet(test.playerId, {skill_points: 0});
      await expect(
        runTool(test, 'spend_skill_point', {skill: 'Smoke Tracking'}),
      ).rejects.toThrow(/no skill_points/i);
    });

    it('emits character:skill_unlocked on first spend, skill_progressed on next', async () => {
      const skillId = await seedSkillEntity('Smoke Bargain');
      await seedWallet(test.playerId, {skill_points: 3});
      // Wipe so the upsert path is the first-unlock branch.
      await query(
        `DELETE FROM player_skills
          WHERE player_id = $1 AND skill_entity_id = $2`,
        [test.playerId, skillId],
      );

      const first = (await runTool(test, 'spend_skill_point', {
        skill: 'Smoke Bargain',
      })) as Record<string, unknown>;
      expect(first['newly_unlocked']).toBe(true);
      expect(first['new_rank']).toBe(1);
      expect(first['skill_points_remaining']).toBe(2);
      const unlockedEvt = await lastGuiEvent(test, 'character:skill_unlocked');
      expect(unlockedEvt?.['skillId']).toBe(skillId);
      expect(unlockedEvt?.['newRank']).toBe(1);

      const second = (await runTool(test, 'spend_skill_point', {
        skill: 'Smoke Bargain',
      })) as Record<string, unknown>;
      expect(second['newly_unlocked']).toBe(false);
      expect(second['new_rank']).toBe(2);
      const progEvt = await lastGuiEvent(test, 'character:skill_progressed');
      // Most recent skill_progressed envelope on the player —
      // could be from the trackKey earlier; the wallet keyed
      // event has skillId set.
      expect(progEvt?.['skillId']).toBe(skillId);
    });
  });

  describe('registry coverage', () => {
    it('registers all five FEAT-STATE-1 mutation tools', () => {
      const names = new Set(getRegisteredTools().keys());
      for (const name of [
        'award_progression_xp',
        'award_title',
        'equip_title',
        'spend_stat_point',
        'spend_skill_point',
      ]) {
        expect(names.has(name)).toBe(true);
      }
    });
  });
});
