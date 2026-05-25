/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-5 — `player_quests.path_taken` cap at 100 entries.
//
// Three runtime call sites — questEngine branch-choice advancement,
// questEngine normal stage advancement, and the `advance_quest`
// tool — share the same `cappedPathTakenExpr(...)` SQL helper. The
// tests below exercise the helper directly against real PGlite so
// the SQL shape and the JSONB semantics are both proven. Because
// every call site uses the same helper, covering it once covers all
// three.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';
import {
  cappedPathTakenExpr,
  PATH_TAKEN_CAP,
} from '../../quest/pathTaken.js';

let playerId = 0;
let questId = 0;

async function seedPlayerAndQuest(initialPath: unknown): Promise<void> {
  const playerService = await import('../../playerService.js');
  const created = await playerService.createAnonymousPlayer(
    `QE-5 Path Player ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  playerId = created.entity_id;
  const questRows = await queryRows<{id: number}>(
    `INSERT INTO entities (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES ('quest', 'QE-5 Path Quest', '', '{}'::jsonb, ARRAY['qe5'], 'quickgrin-lane')
     RETURNING id`,
  );
  questId = questRows[0]!.id;
  await queryRows(
    `INSERT INTO player_quests
       (player_id, quest_entity_id, status, current_phase, accumulated_state,
        current_stage_id, path_taken)
     VALUES ($1, $2, 'active', 0, '{}'::jsonb, 'stage-1', $3::jsonb)`,
    [playerId, questId, JSON.stringify(initialPath)],
  );
}

async function readPath(): Promise<unknown[]> {
  const rows = await queryRows<{path_taken: unknown[] | null}>(
    `SELECT path_taken FROM player_quests
      WHERE player_id = $1 AND quest_entity_id = $2`,
    [playerId, questId],
  );
  return rows[0]?.path_taken ?? [];
}

async function runAppend(entryStage: string): Promise<void> {
  // Mirrors questEngine's normal advancement shape: parameter $1 is
  // the next stage id, used both in `current_stage_id` and inside
  // the appended entry. This is also the shape the
  // `cappedPathTakenExpr` helper expects callers to assemble.
  // PGlite cannot always infer `$1`'s type inside `jsonb_build_object`,
  // so cast it explicitly. The production call sites pass through a
  // typed column context (`current_stage_id = $1::text` is implicit
  // when the value already came from a typed SQL column), but the
  // synthetic test driver makes the cast explicit for portability.
  await queryRows(
    `UPDATE player_quests
        SET current_stage_id = $1::text,
            path_taken = ${cappedPathTakenExpr(
              "jsonb_build_object('at', now()::text, 'stage', $1::text)",
            )}
      WHERE player_id = $2 AND quest_entity_id = $3`,
    [entryStage, playerId, questId],
  );
}

beforeAll(async () => {
  await setupTurnTestEnvironment();
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

beforeEach(async () => {
  playerId = 0;
  questId = 0;
});

describe('cappedPathTakenExpr (QE-5)', () => {
  test('emits a CASE/safe_jsonb_array/jsonb_build_array shape with the cap inlined', () => {
    const sql = cappedPathTakenExpr(
      "jsonb_build_object('at', now()::text, 'stage', $1)",
    );
    expect(sql).toContain('jsonb_array_length(safe_jsonb_array(path_taken))');
    expect(sql).toContain(`>= ${PATH_TAKEN_CAP}`);
    expect(sql).toContain('safe_jsonb_array(path_taken)');
    expect(sql).toContain(
      "jsonb_build_array(jsonb_build_object('at', now()::text, 'stage', $1))",
    );
    expect(sql).toMatch(/CASE WHEN[\s\S]+THEN[\s\S]+ELSE[\s\S]+END/);
  });

  test('mirrors the branch-choice entry shape with both `stage` and `branch`', () => {
    const sql = cappedPathTakenExpr(
      "jsonb_build_object('at', now()::text, 'stage', $1, 'branch', $1)",
    );
    expect(sql).toContain(
      "jsonb_build_array(jsonb_build_object('at', now()::text, 'stage', $1, 'branch', $1))",
    );
  });

  test('mirrors the advance_quest tool entry shape with COALESCE($4, current_stage_id)', () => {
    const sql = cappedPathTakenExpr(
      "jsonb_build_object('at', now()::text, 'stage', COALESCE($4, current_stage_id))",
    );
    expect(sql).toContain(
      "jsonb_build_array(jsonb_build_object('at', now()::text, 'stage', COALESCE($4, current_stage_id)))",
    );
  });
});

describe('cappedPathTakenExpr — runtime behaviour against PGlite', () => {
  test('appends a new entry when path_taken is below the cap', async () => {
    const existing = Array.from({length: 5}, (_, i) => ({
      at: `2026-05-15T00:00:0${i}.000Z`,
      stage: `stage-${i}`,
    }));
    await seedPlayerAndQuest(existing);
    await runAppend('stage-99');
    const path = await readPath();
    expect(path).toHaveLength(existing.length + 1);
    const last = path[path.length - 1] as Record<string, unknown>;
    expect(last['stage']).toBe('stage-99');
    expect(typeof last['at']).toBe('string');
  });

  test('grows to exactly the cap on the 100th append', async () => {
    const existing = Array.from({length: PATH_TAKEN_CAP - 1}, (_, i) => ({
      at: `2026-05-15T00:00:00.${String(i).padStart(3, '0')}Z`,
      stage: `stage-${i}`,
    }));
    await seedPlayerAndQuest(existing);
    await runAppend('stage-final');
    const path = await readPath();
    expect(path).toHaveLength(PATH_TAKEN_CAP);
    const last = path[path.length - 1] as Record<string, unknown>;
    expect(last['stage']).toBe('stage-final');
  });

  test('no-ops the append once path_taken is already at the cap', async () => {
    const existing = Array.from({length: PATH_TAKEN_CAP}, (_, i) => ({
      at: `2026-05-15T00:00:00.${String(i).padStart(3, '0')}Z`,
      stage: `stage-${i}`,
    }));
    await seedPlayerAndQuest(existing);
    await runAppend('stage-overflow');
    const path = await readPath();
    expect(path).toHaveLength(PATH_TAKEN_CAP);
    // The breadcrumb stops growing — last entry remains the seeded
    // one, NOT `stage-overflow`. The quest itself still advances
    // (current_stage_id is updated in the same UPDATE above).
    const last = path[path.length - 1] as Record<string, unknown>;
    expect(last['stage']).toBe(`stage-${PATH_TAKEN_CAP - 1}`);
  });

  test('refuses to grow past the cap on a row already over the limit', async () => {
    const oversized = Array.from({length: PATH_TAKEN_CAP + 25}, (_, i) => ({
      at: `2026-05-15T00:00:00.${String(i).padStart(3, '0')}Z`,
      stage: `stage-${i}`,
    }));
    await seedPlayerAndQuest(oversized);
    await runAppend('stage-extra');
    const path = await readPath();
    // The append is suppressed; the original length is preserved
    // exactly. (The CASE branch returns `safe_jsonb_array(path_taken)`,
    // which for a valid jsonb array is the array itself.)
    expect(path).toHaveLength(oversized.length);
  });

  test('safe_jsonb_array sanitizes a malformed path_taken so the append still succeeds', async () => {
    // A non-array JSONB value (number) would normally crash
    // `jsonb_array_length(...)` and `||`. `safe_jsonb_array(...)`
    // coerces it to `[]::jsonb` first so the cap check evaluates to
    // false and the new entry lands as a one-element array.
    await seedPlayerAndQuest(0);
    await runAppend('stage-recovered');
    const path = await readPath();
    expect(path).toHaveLength(1);
    const last = path[0] as Record<string, unknown>;
    expect(last['stage']).toBe('stage-recovered');
  });
});
