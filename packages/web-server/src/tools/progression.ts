/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// LitRPG-flavoured progression tools.
//
// award_xp is the headline tool — every quest reward, combat win, and
// social-success ends up here. The DB function `level_for_xp(xp)`
// keeps the curve formula (100 × L²) in one place.
//
// We DO NOT try to derive level on every read; we update players.current_level
// lazily inside award_xp so reads stay cheap and the audit log carries a
// pre-and-post snapshot.

import {z} from 'zod';
import {query, withTransaction} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {sessionManager} from '../sessionManager.js';
import {
  registerTool,
  resolveEntityId,
  resolvePlayerTarget,
  ToolExecutionError,
} from './base.js';
import {getEntityRuntimeContext} from './runtimeContext.js';

// ── award_xp ───────────────────────────────────────────────────────────

function readExitId(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Number((value as Record<string, unknown>)['id']);
  }
  return Number(value);
}

const AwardXpArgs = z.object({
  player_id: z.number().int().positive().optional(),
  /** Legacy string target. Prefer player_id or omit for current player. */
  player: z.string().optional(),
  amount: z.number().int().positive().max(10_000),
  reason: z.string().min(1).max(200),
  /**
   * Spec 47 — when the awarded amount is OUTSIDE the Reward
   * Calibrator's recommended band, set this to a short explanation.
   * Engine emits reward:calibrator_override SSE for audit. Pass the
   * arg ONLY when overriding; omit otherwise.
   */
  calibrator_override_reason: z.string().max(240).optional(),
});

registerTool({
  name: 'award_xp',
  description:
    'Grant a player some XP for a stated reason. amount caps at 10000 to ' +
    'guard against runaway loops. Returns new total + any level-up that fired.',
  paramsSchema: AwardXpArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);

    // Read current state so we can tell the model what changed.
    const before = await query<{current_xp: number; current_level: number}>(
      `SELECT current_xp, current_level FROM players WHERE entity_id = $1`,
      [playerId],
    );
    if (before.rows.length === 0)
      throw new Error(`entity ${playerId} is not a player`);
    const beforeRow = before.rows[0]!;

    const newXp = beforeRow.current_xp + args.amount;
    const newLevel = await query<{level: number}>(
      `SELECT level_for_xp($1::bigint) AS level`,
      [newXp],
    );
    const newLevelValue = newLevel.rows[0]!.level;

    await query(
      `UPDATE players
          SET current_xp = $2, current_level = $3, last_seen = now()
        WHERE entity_id = $1`,
      [playerId, newXp, newLevelValue],
    );

    await query(
      `INSERT INTO player_xp_log (player_id, amount, reason, awarded_by_tool)
       VALUES ($1, $2, $3, 'award_xp')`,
      [playerId, args.amount, args.reason],
    );

    // Spec 32 — fire UI events. xp:awarded for the floating popup;
    // xp:levelup when the level threshold crosses.
    const session = sessionManager.get(ctx.sessionId);
    await emitGuiEvent(ctx, 'xp:awarded', {
      playerId,
      amount: args.amount,
      reason: args.reason,
      total: newXp,
    });
    if (args.calibrator_override_reason) {
      // SSE-OK: emit outside tx (reason: telemetry banner for
      // calibrator override; the canonical XP write above is
      // already committed and SseBridge.emit auto-defers via
      // onTransactionCommit when nested in withTransaction).
      session?.sse.emit('reward:calibrator_override', {
        tool: 'award_xp',
        playerId,
        amount: args.amount,
        reason: args.calibrator_override_reason,
      });
    }
    if (newLevelValue > beforeRow.current_level) {
      await emitGuiEvent(ctx, 'xp:levelup', {
        playerId,
        newLevel: newLevelValue,
        previousLevel: beforeRow.current_level,
      });
    }

    return {
      player_id: playerId,
      xp_before: beforeRow.current_xp,
      xp_after: newXp,
      level_before: beforeRow.current_level,
      level_after: newLevelValue,
      leveled_up: newLevelValue > beforeRow.current_level,
    };
  },
});

// ── change_stat ────────────────────────────────────────────────────────

const ChangeStatArgs = z.object({
  player_id: z.number().int().positive().optional(),
  /** Legacy string target. Prefer player_id or omit for current player. */
  player: z.string().optional(),
  stat_key: z.string().min(1).max(40),
  delta: z.number().int(),
  /** Whether to change `base` (permanent) or `current` (temporary buff). */
  target: z.enum(['base', 'current']).default('current'),
  reason: z.string().min(1).max(200),
});

registerTool({
  name: 'change_stat',
  description:
    "Adjust a player's stat. target='current' for temporary buffs/debuffs, 'base' for permanent gains (e.g. level-up bonus). Creates the row if it's the first reference.",
  paramsSchema: ChangeStatArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);

    // UPSERT then increment via subsequent UPDATE so we get the new value back.
    await query(
      `INSERT INTO player_stats (player_id, stat_key, base, current)
       VALUES ($1, $2, 10, 10)
       ON CONFLICT (player_id, stat_key) DO NOTHING`,
      [playerId, args.stat_key],
    );

    const column = args.target;
    const r = await query<{base: number; current: number}>(
      `UPDATE player_stats
          SET ${column} = ${column} + $3
        WHERE player_id = $1 AND stat_key = $2
        RETURNING base, current`,
      [playerId, args.stat_key, args.delta],
    );
    return {
      player_id: playerId,
      stat_key: args.stat_key,
      ...r.rows[0]!,
      reason: args.reason,
    };
  },
});

// ── unlock_skill ───────────────────────────────────────────────────────

const UnlockSkillArgs = z.object({
  player_id: z.number().int().positive().optional(),
  /** Legacy string target. Prefer player_id or omit for current player. */
  player: z.string().optional(),
  skill: z.string(),
  rank: z.number().int().min(0).default(1),
});

registerTool({
  name: 'unlock_skill',
  description:
    'Add a skill to a player at the given rank, or bump the rank if already known. Returns previous rank for narration ("you advance Bargain from 2 to 3").',
  paramsSchema: UnlockSkillArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    const skillId = await resolveEntityId(args.skill);
    if (skillId == null) throw new Error(`unknown skill: ${args.skill}`);

    const before = await query<{rank: number}>(
      `SELECT rank FROM player_skills WHERE player_id = $1 AND skill_entity_id = $2`,
      [playerId, skillId],
    );
    const previousRank = before.rows[0]?.rank ?? null;

    const newRank = args.rank ?? 1;
    await query(
      `INSERT INTO player_skills (player_id, skill_entity_id, rank)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id, skill_entity_id)
       DO UPDATE SET rank = GREATEST(player_skills.rank, $3)`,
      [playerId, skillId, newRank],
    );

    return {
      player_id: playerId,
      skill_id: skillId,
      previous_rank: previousRank,
      new_rank: Math.max(previousRank ?? 0, newRank),
      newly_unlocked: previousRank === null,
    };
  },
});

// ── equip_item: REMOVED (consolidated with player_inventory in spec 35).
// Migration 0046 backfilled inventory_entries → player_inventory and
// player_equipment → player_inventory.equipped. The canonical equip tool
// now lives in src/tools/inventoryExt.ts (registered as 'equip_item' below).

// ── FEAT-STATE-1 mutation tools ────────────────────────────────────────
//
// Five LitRPG progression mutation tools the Character State
// surface depends on. All five:
//
//   * Resolve the target player through `resolvePlayerTarget`
//     (cross-player mutation is rejected — the broker has to
//     name a player_id the active session owns; the
//     `resolvePlayerTarget` helper looks the current player up
//     from the `ctx.sessionId`).
//   * Run inside `withTransaction` so the read-modify-write on
//     `player_progression_wallets`, `player_progression_tracks`,
//     `player_titles`, `player_stats`, and `player_skills`
//     can't race concurrent tool calls in the same session.
//     `SELECT … FOR UPDATE` locks the wallet / title / track
//     row for the duration of the call.
//   * Emit a replayable `character:*` envelope through
//     `emitGuiEvent` so the Character State hook refreshes
//     without a full reload. `emitGuiEvent` is the canonical
//     gui_events writer and `SseBridge.emit` auto-defers via
//     `onTransactionCommit` so the SSE-OK invariant holds.

function pickLevelFromCurve(
  curve: unknown,
  xp: number,
  maxLevel: number,
): number {
  // The `progression_tracks.xp_curve` JSONB column is opaque —
  // donor implementations differ in shape. We support two
  // conservative shapes today:
  //
  //   {xpPerLevel: [100, 250, 500, ...]}  → cumulative
  //   thresholds. level N requires sum(xpPerLevel[0..N-2]) XP.
  //
  //   {kind:'linear', step: 100}          → level = floor(xp/step) + 1
  //
  // Anything else falls back to a linear curve with step 100 so
  // we always return *some* level instead of crashing the call.
  const safeMax = Math.max(1, Math.floor(maxLevel) || 1);
  if (curve && typeof curve === 'object') {
    const arr = (curve as Record<string, unknown>)['xpPerLevel'];
    if (Array.isArray(arr) && arr.every((v) => typeof v === 'number')) {
      let acc = 0;
      let level = 1;
      for (const cost of arr as number[]) {
        if (xp >= acc + cost) {
          acc += cost;
          level += 1;
        } else {
          break;
        }
      }
      return Math.min(safeMax, level);
    }
    const step = (curve as Record<string, unknown>)['step'];
    if (typeof step === 'number' && step > 0) {
      return Math.min(safeMax, 1 + Math.floor(xp / step));
    }
  }
  return Math.min(safeMax, 1 + Math.floor(xp / 100));
}

const AwardProgressionXpArgs = z.object({
  player_id: z.number().int().positive().optional(),
  player: z.string().optional(),
  track_key: z.string().min(1).max(80),
  amount: z.number().int().positive().max(100_000),
  reason: z.string().min(1).max(200),
});

registerTool({
  name: 'award_progression_xp',
  description:
    'Grant XP to a side-track ladder. Track must exist in ' +
    '`progression_tracks`. Returns the new xp/level and emits ' +
    '`character:skill_progressed`. Used for hand-curated tracks ' +
    'like Survival / Diplomacy / Combat that progress separately ' +
    'from the main XP curve.',
  paramsSchema: AwardProgressionXpArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    return await withTransaction(async (tx) => {
      const trackRow = await tx.query<{
        track_key: string;
        xp_curve: unknown;
        max_level: number;
      }>(
        `SELECT track_key, xp_curve, max_level
           FROM progression_tracks WHERE track_key = $1`,
        [args.track_key],
      );
      if (trackRow.rows.length === 0) {
        throw new ToolExecutionError(
          `unknown progression track: ${args.track_key}`,
          {rejected: true},
        );
      }
      const track = trackRow.rows[0]!;

      // FEAT-STATE-1 hardening: the previous implementation read
      // the per-player progression row with `SELECT … FOR UPDATE`
      // and then ran an overwriting upsert that set xp to the
      // newly-computed value. That had two race windows:
      //
      //   1. `FOR UPDATE` locks zero rows on a first-time grant
      //      (no row exists), so two concurrent calls both read
      //      `prev_xp = 0` and compute the same new total.
      //   2. The overwrite-style DO UPDATE branch (the second
      //      call's recomputed total replaces the first call's
      //      committed total) drops one grant's XP entirely.
      //
      // The atomic fix is a single statement that
      //   (a) captures the existing row's xp/level inside a CTE,
      //   (b) inserts-or-upserts with the additive form below
      //       (so the DO UPDATE branch sums instead of replacing),
      //       and
      //   (c) returns both the prior and new xp.
      //
      // PostgreSQL's `INSERT … ON CONFLICT … DO UPDATE` holds the
      // row lock from the failed insert attempt through the
      // DO UPDATE branch — concurrent first-time inserts on the
      // same `(player_id, track_key)` serialize on that lock, so
      // the second call's additive form sees the first call's
      // xp before adding its own. The `RETURNING xp` captures
      // the post-update value in the same statement, with no
      // visibility gap. The level update that follows is a pure
      // function of the new xp + curve; concurrent recomputes
      // converge on the same answer.
      const upsert = await tx.query<{
        prev_xp: string | number;
        prev_level: number;
        new_xp: string | number;
      }>(
        `WITH existing AS (
           SELECT xp AS prev_xp, level AS prev_level
             FROM player_progression_tracks
            WHERE player_id = $1 AND track_key = $2
         ), upsert AS (
           INSERT INTO player_progression_tracks
             (player_id, track_key, xp, level, updated_at)
           VALUES ($1, $2, $3, 1, now())
           ON CONFLICT (player_id, track_key) DO UPDATE
             SET xp = player_progression_tracks.xp + EXCLUDED.xp,
                 updated_at = now()
           RETURNING xp AS new_xp
         )
         SELECT COALESCE((SELECT prev_xp FROM existing), 0) AS prev_xp,
                COALESCE((SELECT prev_level FROM existing), 1) AS prev_level,
                (SELECT new_xp FROM upsert) AS new_xp`,
        [playerId, args.track_key, args.amount],
      );
      const row = upsert.rows[0]!;
      const prevXp = Number(row.prev_xp);
      const prevLevel = Number(row.prev_level);
      const newXp = Number(row.new_xp);
      const newLevel = pickLevelFromCurve(
        track.xp_curve,
        newXp,
        Number(track.max_level),
      );
      if (newLevel !== prevLevel || prevXp === 0) {
        // Persist the recomputed level. Concurrent grants
        // converge on the same `newLevel` for a given `newXp`,
        // so this UPDATE is idempotent under contention.
        await tx.query(
          `UPDATE player_progression_tracks
              SET level = $3, updated_at = now()
            WHERE player_id = $1 AND track_key = $2`,
          [playerId, args.track_key, newLevel],
        );
      }
      await emitGuiEvent(ctx, 'character:skill_progressed', {
        playerId,
        trackKey: args.track_key,
        xp: newXp,
        level: newLevel,
        previousLevel: prevLevel,
        reason: args.reason,
      });
      return {
        player_id: playerId,
        track_key: args.track_key,
        xp_before: prevXp,
        xp_after: newXp,
        level_before: prevLevel,
        level_after: newLevel,
        leveled_up: newLevel > prevLevel,
      };
    });
  },
});

const AwardTitleArgs = z.object({
  player_id: z.number().int().positive().optional(),
  player: z.string().optional(),
  title_key: z.string().min(1).max(120),
  display_name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  source: z.string().max(120).optional(),
  metadata: z.record(z.unknown()).optional(),
});

registerTool({
  name: 'award_title',
  description:
    'Award a title to a player. Deduped by (player_id, title_key); ' +
    'subsequent calls with the same key are no-ops. Returns ' +
    '`newly_awarded:true` only on the first grant. Emits ' +
    '`character:title_awarded` on a fresh grant.',
  paramsSchema: AwardTitleArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    return await withTransaction(async (tx) => {
      const inserted = await tx.query<{id: number}>(
        `INSERT INTO player_titles
           (player_id, title_key, display_name, description, source, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (player_id, title_key) DO NOTHING
         RETURNING id`,
        [
          playerId,
          args.title_key,
          args.display_name,
          args.description ?? null,
          args.source ?? null,
          JSON.stringify(args.metadata ?? {}),
        ],
      );
      const newlyAwarded = inserted.rows.length > 0;
      if (newlyAwarded) {
        await emitGuiEvent(ctx, 'character:title_awarded', {
          playerId,
          titleKey: args.title_key,
          displayName: args.display_name,
          source: args.source ?? null,
        });
      }
      const row = newlyAwarded
        ? inserted.rows[0]!
        : (
            await tx.query<{id: number}>(
              `SELECT id FROM player_titles
                WHERE player_id = $1 AND title_key = $2`,
              [playerId, args.title_key],
            )
          ).rows[0]!;
      return {
        player_id: playerId,
        title_id: Number(row.id),
        title_key: args.title_key,
        newly_awarded: newlyAwarded,
      };
    });
  },
});

const EquipTitleArgs = z.object({
  player_id: z.number().int().positive().optional(),
  player: z.string().optional(),
  title_key: z.string().min(1).max(120),
  equip: z.boolean().default(true),
});

registerTool({
  name: 'equip_title',
  description:
    'Equip or unequip a title the player already owns. Locks the ' +
    'wallet row to enforce `title_slots`. Returns the updated ' +
    'equip state and emits `character:title_equipped`.',
  paramsSchema: EquipTitleArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    return await withTransaction(async (tx) => {
      // Lock the wallet first (creating a default row if missing)
      // so concurrent equip calls in the same session can't both
      // see "1 slot free" and equip two titles past the cap.
      await tx.query(
        `INSERT INTO player_progression_wallets (player_id)
         VALUES ($1)
         ON CONFLICT (player_id) DO NOTHING`,
        [playerId],
      );
      const wallet = await tx.query<{title_slots: number}>(
        `SELECT title_slots
           FROM player_progression_wallets
          WHERE player_id = $1
          FOR UPDATE`,
        [playerId],
      );
      const titleSlots = Number(wallet.rows[0]?.title_slots ?? 1);

      const titleRow = await tx.query<{id: number; is_equipped: boolean}>(
        `SELECT id, is_equipped FROM player_titles
          WHERE player_id = $1 AND title_key = $2
          FOR UPDATE`,
        [playerId, args.title_key],
      );
      if (titleRow.rows.length === 0) {
        throw new ToolExecutionError(
          `player has not earned title: ${args.title_key}`,
          {rejected: true},
        );
      }
      const titleId = Number(titleRow.rows[0]!.id);
      const wasEquipped = Boolean(titleRow.rows[0]!.is_equipped);

      if (args.equip && !wasEquipped) {
        const equippedCount = await tx.query<{count: string | number}>(
          `SELECT COUNT(*)::int AS count FROM player_titles
            WHERE player_id = $1 AND is_equipped = TRUE`,
          [playerId],
        );
        const currentlyEquipped = Number(
          equippedCount.rows[0]?.count ?? 0,
        );
        if (currentlyEquipped >= titleSlots) {
          throw new ToolExecutionError(
            `title_slots exhausted: ${currentlyEquipped}/${titleSlots} equipped`,
            {rejected: true},
          );
        }
      }
      await tx.query(
        `UPDATE player_titles
            SET is_equipped = $3
          WHERE id = $1 AND player_id = $2`,
        [titleId, playerId, args.equip],
      );
      await emitGuiEvent(ctx, 'character:title_equipped', {
        playerId,
        titleKey: args.title_key,
        equipped: args.equip,
        previousState: wasEquipped,
      });
      return {
        player_id: playerId,
        title_key: args.title_key,
        equipped: args.equip,
        changed: args.equip !== wasEquipped,
      };
    });
  },
});

const SpendStatPointArgs = z.object({
  player_id: z.number().int().positive().optional(),
  player: z.string().optional(),
  stat_key: z.string().min(1).max(40),
  reason: z.string().min(1).max(200).optional(),
});

registerTool({
  name: 'spend_stat_point',
  description:
    'Spend one stat point from the wallet on the named stat. ' +
    'Rejects if the wallet has zero stat_points. Locks the wallet ' +
    'and stat row, increments both base and current by 1, and ' +
    'emits `character:stat_changed`.',
  paramsSchema: SpendStatPointArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    return await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO player_progression_wallets (player_id)
         VALUES ($1)
         ON CONFLICT (player_id) DO NOTHING`,
        [playerId],
      );
      const wallet = await tx.query<{stat_points: number}>(
        `SELECT stat_points
           FROM player_progression_wallets
          WHERE player_id = $1
          FOR UPDATE`,
        [playerId],
      );
      const available = Number(wallet.rows[0]?.stat_points ?? 0);
      if (available <= 0) {
        throw new ToolExecutionError(
          'no stat_points available to spend',
          {rejected: true},
        );
      }

      await tx.query(
        `INSERT INTO player_stats (player_id, stat_key, base, current)
         VALUES ($1, $2, 10, 10)
         ON CONFLICT (player_id, stat_key) DO NOTHING`,
        [playerId, args.stat_key],
      );
      const updated = await tx.query<{base: number; current: number}>(
        `UPDATE player_stats
            SET base = base + 1,
                current = current + 1
          WHERE player_id = $1 AND stat_key = $2
          RETURNING base, current`,
        [playerId, args.stat_key],
      );
      await tx.query(
        `UPDATE player_progression_wallets
            SET stat_points = stat_points - 1,
                updated_at = now()
          WHERE player_id = $1`,
        [playerId],
      );

      const after = updated.rows[0]!;
      await emitGuiEvent(ctx, 'character:stat_changed', {
        playerId,
        statKey: args.stat_key,
        base: Number(after.base),
        current: Number(after.current),
        reason: args.reason ?? 'spend_stat_point',
        statPointsRemaining: available - 1,
      });
      return {
        player_id: playerId,
        stat_key: args.stat_key,
        base: Number(after.base),
        current: Number(after.current),
        stat_points_remaining: available - 1,
      };
    });
  },
});

const SpendSkillPointArgs = z.object({
  player_id: z.number().int().positive().optional(),
  player: z.string().optional(),
  skill: z.string().min(1).max(200),
});

registerTool({
  name: 'spend_skill_point',
  description:
    'Spend one skill point from the wallet on the named skill. ' +
    'Rejects on insufficient points or unknown skill entity. ' +
    'Upserts `player_skills` with `rank = GREATEST(existing, 1)` ' +
    'on first unlock then increments rank on subsequent calls. ' +
    'Emits `character:skill_unlocked` on first unlock, ' +
    '`character:skill_progressed` on rank-up.',
  paramsSchema: SpendSkillPointArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);
    const skillId = await resolveEntityId(args.skill);
    if (skillId == null) {
      throw new ToolExecutionError(`unknown skill: ${args.skill}`, {
        rejected: true,
      });
    }
    return await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO player_progression_wallets (player_id)
         VALUES ($1)
         ON CONFLICT (player_id) DO NOTHING`,
        [playerId],
      );
      const wallet = await tx.query<{skill_points: number}>(
        `SELECT skill_points
           FROM player_progression_wallets
          WHERE player_id = $1
          FOR UPDATE`,
        [playerId],
      );
      const available = Number(wallet.rows[0]?.skill_points ?? 0);
      if (available <= 0) {
        throw new ToolExecutionError(
          'no skill_points available to spend',
          {rejected: true},
        );
      }

      const before = await tx.query<{rank: number}>(
        `SELECT rank FROM player_skills
          WHERE player_id = $1 AND skill_entity_id = $2
          FOR UPDATE`,
        [playerId, skillId],
      );
      const previousRank = before.rows[0] ? Number(before.rows[0].rank) : null;
      const newRank = (previousRank ?? 0) + 1;
      await tx.query(
        `INSERT INTO player_skills (player_id, skill_entity_id, rank)
         VALUES ($1, $2, $3)
         ON CONFLICT (player_id, skill_entity_id)
         DO UPDATE SET rank = $3`,
        [playerId, skillId, newRank],
      );
      await tx.query(
        `UPDATE player_progression_wallets
            SET skill_points = skill_points - 1,
                updated_at = now()
          WHERE player_id = $1`,
        [playerId],
      );

      const eventType =
        previousRank === null
          ? 'character:skill_unlocked'
          : 'character:skill_progressed';
      await emitGuiEvent(ctx, eventType, {
        playerId,
        skillId,
        skillName: args.skill,
        previousRank,
        newRank,
        skillPointsRemaining: available - 1,
      });
      return {
        player_id: playerId,
        skill_id: skillId,
        previous_rank: previousRank,
        new_rank: newRank,
        newly_unlocked: previousRank === null,
        skill_points_remaining: available - 1,
      };
    });
  },
});

// ── query_player_state ─────────────────────────────────────────────────

const QueryPlayerArgs = z.object({
  player_id: z.number().int().positive().optional(),
  player: z.string().optional(),
});

registerTool({
  name: 'query_player_state',
  description:
    'Snapshot a player: XP, level, HP, location, stats, skills, equipment, ' +
    'PLUS the runtime context of where they are right now — current scene & location with ' +
    'their runtime_fields (current values per-player, including any cartridge state slots like ' +
    "payment_confirmed, service_tier, quest_phase) and applicable entity_instructions, plus the " +
    "list of active quests with their own runtime contexts. This is the one-call snapshot for " +
    'starting a turn — read it first, then narrate. Defaults to the current session player.',
    // Runtime write guard: use only returned field_id values and obey value_type/allowed_values; if a field is absent, do not invent it.
  paramsSchema: QueryPlayerArgs,
  async execute(args, ctx) {
    const playerId = await resolvePlayerTarget(args.player_id ?? args.player, ctx);

    const meta = await query<{
      current_xp: number;
      current_level: number;
      current_hp: number;
      max_hp: number;
      current_location_id: number | null;
      current_scene_id: number | null;
    }>(
      `SELECT current_xp, current_level, current_hp, max_hp,
              current_location_id, current_scene_id
         FROM players WHERE entity_id = $1`,
      [playerId],
    );
    if (meta.rows.length === 0)
      throw new Error(`entity ${playerId} is not a player`);

    const stats = await query<{stat_key: string; base: number; current: number}>(
      `SELECT stat_key, base, current FROM player_stats WHERE player_id = $1`,
      [playerId],
    );
    const skills = await query<{skill_entity_id: number; rank: number}>(
      `SELECT skill_entity_id, rank FROM player_skills WHERE player_id = $1`,
      [playerId],
    );
    const equipment = await query<{slot: string; item_entity_id: number}>(
      `SELECT slot, item_entity_id FROM player_equipment WHERE player_id = $1`,
      [playerId],
    );
    const xpToNext = await query<{required: number}>(
      `SELECT xp_required_for_level($1::int + 1)::int AS required`,
      [meta.rows[0]!.current_level],
    );

    const m = meta.rows[0]!;

    // Pull runtime context for the entities the player is anchored to
    // right now, plus any active quest. This avoids forcing the model
    // to chain query_entity on each id every turn — it gets the live
    // state machine for free here.
    const sceneCtx = m.current_scene_id != null
      ? await getEntityRuntimeContext(m.current_scene_id, playerId)
      : null;
    const locationCtx = m.current_location_id != null
      ? await getEntityRuntimeContext(m.current_location_id, playerId)
      : null;

    // GM affordances — concrete cartridge entities the player can interact
    // with right now. The model needs these as STRUCTURED data, otherwise
    // it falls back on inventing generic ambient crowds.
    interface NeighborRow {
      id: number;
      kind: string;
      display_name: string;
      summary: string | null;
    }
    let people_here: NeighborRow[] = [];
    let items_here: NeighborRow[] = [];
    let exits: NeighborRow[] = [];
    if (m.current_location_id != null) {
      // NPCs physically present at the current location. home_id is their
      // default anchor; current_location_id lets living-world movement override it.
      const npcs = await query<NeighborRow>(
        `SELECT id, kind, display_name, summary
           FROM entities
          WHERE kind = 'person'
            AND (
              profile->>'home_id' = $1::text
              OR profile->>'current_location_id' = $1::text
              OR profile->>'location_id' = $1::text
            )
            AND NOT EXISTS (
              SELECT 1 FROM actor_statuses s
               WHERE s.player_id = $2
                 AND s.actor_entity_id = entities.id
                 AND s.intensity > 0
                 AND s.status_kind IN ('dead', 'missing')
            )`,
        [m.current_location_id, playerId],
      );
      people_here = npcs.rows;

      // Items physically present in the current location's inventory
      // bag (location is the holder). Lets the model name @ItemX as
      // something the player can examine without inventing it.
      const itemsAtLoc = await query<NeighborRow>(
        `SELECT e.id, e.kind, e.display_name, e.summary
           FROM inventory_entries i
           JOIN entities e ON e.id = i.item_entity_id
          WHERE i.holder_entity_id = $1
            AND i.count > 0`,
        [m.current_location_id],
      );
      items_here = itemsAtLoc.rows;

      // Adjacent locations declared in the location's profile.exits
      // array (entity ids). Resolve to entity rows so the model can
      // @-mention them as travel options.
      const locRow = await query<{exits: number[] | null}>(
        `SELECT (profile->'exits')::jsonb AS exits
           FROM entities WHERE id = $1`,
        [m.current_location_id],
      );
      const exitIds = Array.isArray(locRow.rows[0]?.exits)
        ? (locRow.rows[0]!.exits as unknown[])
            .map(readExitId)
            .filter(n => Number.isInteger(n) && n > 0)
        : [];
      if (exitIds.length > 0) {
        const exitRows = await query<NeighborRow>(
          `SELECT id, kind, display_name, summary
             FROM entities WHERE id = ANY($1::bigint[])`,
          [exitIds],
        );
        exits = exitRows.rows;
      }
    }

    interface ActiveQuestRow {
      quest_entity_id: number;
      display_name: string;
      status: string;
      current_phase: number | null;
    }
    const activeQuests = await query<ActiveQuestRow>(
      `SELECT pq.quest_entity_id, e.display_name, pq.status, pq.current_phase
         FROM player_quests pq
         JOIN entities e ON e.id = pq.quest_entity_id
        WHERE pq.player_id = $1 AND pq.status = 'active'
        ORDER BY pq.started_at`,
      [playerId],
    );
    const activeQuestsContext: Array<
      ActiveQuestRow & {
        runtime_fields: Awaited<ReturnType<typeof getEntityRuntimeContext>>['runtime_fields'];
        instructions: Awaited<ReturnType<typeof getEntityRuntimeContext>>['instructions'];
      }
    > = [];
    for (const q of activeQuests.rows) {
      const qCtx = await getEntityRuntimeContext(q.quest_entity_id, playerId);
      activeQuestsContext.push({...q, ...qCtx});
    }

    return {
      player_id: playerId,
      ...m,
      xp_to_next_level: xpToNext.rows[0]!.required,
      stats: stats.rows,
      skills: skills.rows,
      equipment: equipment.rows,
      scene_context: sceneCtx,
      location_context: locationCtx,
      active_quests: activeQuestsContext,
      // GM-affordance arrays: actual entities in the player's
      // immediate vicinity. The model MUST narrate these by name
      // instead of inventing generic crowd flavour.
      people_here,
      items_here,
      exits,
    };
  },
});

// ── query_player_profile ──────────────────────────────────────────────
// Spec 27 — broker can pull the full player profile (identity / physical
// / background) when an NPC needs to react to facts the preamble didn't
// surface this turn. Cheap; resolves to entities.profile JSONB on the
// player entity.

const QueryPlayerProfileArgs = z.object({});

registerTool({
  name: 'query_player_profile',
  description:
    "Read the player's full identity profile (pronouns, body, anatomy, " +
    'background, motivation). Use when an NPC needs to react to the ' +
    "player's body or history beyond what the preamble surfaced — e.g. a " +
    'moment of intimate scrutiny, a proper introduction, a flashback.',
  paramsSchema: QueryPlayerProfileArgs,
  async execute(_args, ctx) {
    const r = await query<{display_name: string; profile: unknown}>(
      `SELECT display_name, profile FROM entities
        WHERE id = $1 AND kind = 'player'`,
      [ctx.playerId],
    );
    return r.rows[0] ?? null;
  },
});
