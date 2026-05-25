/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// S-11 / ID-2 — auditable gameplay RNG.
//
// Production tool rolls (`dice_check`, `death_save`, `use_item` heal
// dice) used the unsalted browser-style PRNG directly, which gave us
// no replay seed, no audit log, and no defense against "the engine
// cheated me" reports from players. This helper centralizes the
// gameplay roll path so every die also records its entropy and (when
// context is available) a `gameplay.dice.roll` telemetry event.
//
// Adventure scripting has its own deterministic RNG in
// `src/adventure/adventureRng.ts` keyed by a stable seed string for
// reproducibility — that one stays as-is. This helper is for live
// gameplay rolls where the entropy must come from the system but
// must still be visible after the fact.

import {randomBytes} from 'node:crypto';
import {telemetry} from '../telemetry/index.js';

export interface RollContext {
  /** Short label for the roll (e.g. `'dice_check'`, `'death_save'`,
   *  `'use_item_heal'`). Recorded in telemetry so the audit log can
   *  distinguish skill checks from death saves from item heals. */
  purpose: string;
  sessionId?: string;
  playerId?: number;
  turnId?: string;
}

export interface RollResult {
  /** Die face value in `[1, sides]`. */
  value: number;
  sides: number;
  /** 32-bit entropy expressed as 8 hex characters. Combined with
   *  `sides` and the roll formula, the same `value` can be
   *  reproduced for audit by callers that store the seed. */
  seed: string;
}

const U32_RANGE = 0x1_0000_0000; // 2 ** 32

function ensureValidSides(sides: number): void {
  if (!Number.isInteger(sides) || sides < 1) {
    throw new Error(`gameplayRng.rollDie: invalid sides=${sides}`);
  }
}

/**
 * Roll one d{sides}. Uses 32 bits of `node:crypto` entropy mapped to
 * `[1, sides]` via `floor(u32 / 2^32 * sides) + 1`, which is bounded
 * (the highest representable u32 is `2^32 - 1`, so the multiplication
 * never reaches `sides`). When a non-empty context is supplied,
 * records a `gameplay.dice.roll` telemetry event so the roll can be
 * replayed from logs.
 */
export function rollDie(sides: number, ctx?: RollContext): RollResult {
  ensureValidSides(sides);
  const buf = randomBytes(4);
  const u32 = buf.readUInt32BE(0);
  const value = Math.floor((u32 / U32_RANGE) * sides) + 1;
  const seed = buf.toString('hex');
  const result: RollResult = {value, sides, seed};
  if (ctx && (ctx.sessionId || ctx.playerId != null || ctx.turnId)) {
    telemetry.record({
      channel: 'gameplay',
      name: 'gameplay.dice.roll',
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      data: {purpose: ctx.purpose, sides, value, seed},
    });
  }
  return result;
}
