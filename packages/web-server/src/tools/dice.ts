/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Dice — server-side dN with modifier, DC comparison, advantage rules,
// and crit detection. Inspired by the prior project's design:
// random source lives in the engine (not in the model), so the player
// can't argue with the math. The model decides MODIFIERS and WHEN to
// roll — the engine just fairly rolls and reports.

import {z} from 'zod';
import {query} from '../db.js';
import {
  CombatPositionSchema,
  defaultCombatPosition,
  normalizeCombatPosition,
} from '../combatTheatre.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {registerTool} from './base.js';
import {rollDie} from './gameplayRng.js';

const COOLDOWN_HOURS = 24;
const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;

/** Blades-in-the-Dark style situational tags. Optional. Default position
 *  is 'risky' (the standard exchange) and default effect is 'standard'.
 *  Broker should set these from the player's prose:
 *    controlled = preparedness, low risk, low reward — failure is recoverable
 *    risky      = standard exchange — failure costs something concrete
 *    desperate  = backed into a corner — failure is catastrophic, success is huge
 *    limited / standard / great — magnitude scaling on success */
const PositionEnum = z.enum(['controlled', 'risky', 'desperate']);
const EffectEnum = z.enum(['limited', 'standard', 'great']);

const DiceArgs = z.object({
  /**
   * Number of sides. Defaults to 20 (D&D-style skill check / attack).
   * Use 4/6/8/10/12 for damage dice, 100 for percentile.
   */
  d: z.number().int().min(2).max(100).default(20),
  /**
   * Flat modifier added to the raw die. Typically (ability_score - 10) / 2
   * + proficiency bonus + situational modifiers — the model computes
   * this from the player snapshot and the situation, then passes it in.
   */
  modifier: z.number().int().default(0),
  /**
   * Difficulty class. If supplied, the result includes
   * outcome=success|failure based on `total >= dc`. If omitted, the
   * call is a pure roll (e.g. damage dice) with no pass/fail.
   */
  dc: z.number().int().optional(),
  /**
   * Short human label so the UI's DiceBubble + the audit log can
   * label the roll ("Charm check vs DC 12", "Mikka attack").
   */
  label: z.string().optional(),
  /**
   * Who's rolling. Drives the DiceBubble colour: 'player' = warm
   * amber/violet (the default), 'npc' = red. Pass 'npc' whenever you
   * are rolling FOR an NPC (their attack against the player, their
   * save against a curse, etc.).
   */
  roller: z.enum(['player', 'npc']).default('player'),
  /** Combat-theatre actor id for tactical UI. Defaults to ctx.playerId
   *  for player rolls; NPC rolls should pass the NPC entity id. */
  roller_entity_id: z.number().int().positive().optional(),
  /** Combat lane for the roller. Distinct from Blades-style `position`. */
  roller_position: CombatPositionSchema.optional(),
  /** Combat lane for target_id when the roll targets an actor. */
  target_position: CombatPositionSchema.optional(),
  /** Optional Blades-in-the-Dark-style situational tags. */
  position: PositionEnum.default('risky'),
  effect: EffectEnum.default('standard'),
  /** First-class advantage flags. When true, roll 2d{d} keep highest
   *  (advantage) or lowest (disadvantage). Used by spec 18 (string-spend
   *  grants +1d on the next social roll), spec 19 (Devil's Bargain grants
   *  +1d on accept), spec 33 (Inspiration spend), and ad-hoc broker
   *  decisions. Mutually exclusive — if both are set, neither applies. */
  advantage: z.boolean().default(false),
  disadvantage: z.boolean().default(false),
  /** Spec 19 — Devil's Bargain reference. When the player has accepted
   *  a bargain offered before this roll, broker passes the bargain id
   *  + text here. Setting this implies advantage=true; the broker
   *  should set both fields together. The bargain effect is applied
   *  via separate state-tool calls regardless of the dice outcome. */
  bargain: z
    .object({
      bargainId: z.string(),
      text: z.string(),
    })
    .optional(),
  /** Environmental tags surfacing the BG3-style "high ground / flanking /
   *  behind-cover / in-water" tactical context. Each tag may grant a
   *  modifier — broker chooses tags from the player's prose or the
   *  scene's runtime state (see spec 33 for surface tags like 'on-fire',
   *  'oil-slicked', 'shocked-water'). Examples:
   *    'high-ground'    → +2 to ranged attack
   *    'flanking'       → +1 advantage flag implied
   *    'behind-cover'   → +2 to defensive rolls
   *    'in-fire'        → automatic -2 to all rolls + condition
   *    'oil-slicked'    → next 'fire' tag triggers explosion (spec 33)
   *  Tags are advisory — broker reads, picks, modifier sums in prose.
   *  Cartridge can ship its own tag list in cartridge_meta.tactical_tags. */
  environment_tags: z.array(z.string().max(40)).default([]),
  /** Spec 27 — D&D 5e canonical skill name (e.g. 'Stealth', 'Persuasion').
   *  When set AND the player has a proficient row in
   *  player_proficient_skills, the proficiency bonus (+2 at lvl 1, see
   *  spec 36 for level scaling) is added to the modifier. Optional —
   *  legacy callers omit and pay no proficiency. */
  skill: z.string().max(40).optional(),
  /**
   * Categorisation. 'combat' rolls (attack, damage, save vs a hit)
   * bypass the per-target cooldown — the player can keep swinging.
   * 'check' rolls (persuade, seduce, shove a crate, pick a lock)
   * are once-per-target-per-24h: the player commits to that attempt
   * and lives with the outcome. Defaults to 'check'.
   */
  category: z.enum(['check', 'combat']).default('check'),
  /**
   * Entity being checked. Required for 'check' rolls — together with
   * `check_kind` it forms the cooldown key. Optional / ignored for
   * 'combat' rolls (no cooldown). Pass the NPC id for social checks,
   * the item id for item-interaction checks.
   */
  target_id: z.number().int().positive().optional(),
  /**
   * Short normalised tag for the cooldown key: 'seduce', 'persuade',
   * 'intimidate', 'STR_shove', 'DEX_pick', etc. Lowercased + trimmed
   * server-side. Optional for combat rolls.
   */
  check_kind: z.string().min(1).max(64).optional(),
});

registerTool({
  name: 'dice_check',
  description:
    'Roll dN; server is the source of randomness. Pass modifier + optional dc for pass/fail. ' +
    'Crit flags on d20. category="check" (default) requires target_id + check_kind and is gated ' +
    '24h per (player,target,kind); on cooldown returns {ok:false,cooldown:true} — narrate refusal, do not retry. ' +
    'category="combat" bypasses cooldown (attacks, damage, saves). ' +
    'roller="player"/"npc" picks bubble colour.',
  paramsSchema: DiceArgs,
  async execute(args, ctx) {
    const sides = args.d ?? 20;
    const modifier = args.modifier ?? 0;
    const roller = args.roller ?? 'player';
    const category = args.category ?? 'check';
    const checkKind = args.check_kind?.trim().toLowerCase() || null;

    // Cooldown gate: 'check'-category rolls with a target are
    // once-per-(player, target, kind) per 24h. Combat is exempt
    // — punches keep landing.
    //
    // Pattern B from plans/multi-user-scaling/03-shared-state-and-races.md:
    // claim the cooldown slot atomically via INSERT ... ON CONFLICT
    // DO UPDATE WHERE expired RETURNING. If the row exists and is
    // still within 24h the conditional UPDATE doesn't fire and the
    // RETURNING set is empty — that's our "cooldown active" signal.
    // Eliminates the TOCTOU between the old SELECT-then-INSERT.
    let cooldownClaimed = false;
    if (category === 'check' && args.target_id != null && checkKind) {
      const claim = await query<{last_rolled_at: string}>(
        `INSERT INTO dice_check_cooldowns
            (player_id, target_entity_id, check_kind, last_rolled_at, last_outcome)
         VALUES ($1, $2, $3, now(), NULL)
         ON CONFLICT (player_id, target_entity_id, check_kind)
         DO UPDATE SET last_rolled_at = EXCLUDED.last_rolled_at,
                       last_outcome   = NULL
           WHERE dice_check_cooldowns.last_rolled_at < (now() - interval '24 hours')
         RETURNING last_rolled_at`,
        [ctx.playerId, args.target_id, checkKind],
      );
      if (claim.rows.length === 0) {
        const r = await query<{last_rolled_at: string; last_outcome: string | null}>(
          `SELECT last_rolled_at, last_outcome
             FROM dice_check_cooldowns
            WHERE player_id = $1 AND target_entity_id = $2 AND check_kind = $3`,
          [ctx.playerId, args.target_id, checkKind],
        );
        const last = r.rows[0]?.last_rolled_at;
        const elapsed = last ? Date.now() - new Date(last).getTime() : 0;
        const remainingMs = Math.max(0, COOLDOWN_MS - elapsed);
        return {
          ok: false,
          cooldown: true,
          target_id: args.target_id,
          check_kind: checkKind,
          last_rolled_at: last ?? null,
          last_outcome: r.rows[0]?.last_outcome ?? null,
          next_attempt_allowed_at: new Date(Date.now() + remainingMs).toISOString(),
          remaining_hours: Math.ceil(remainingMs / 1000 / 60 / 60),
          message:
            `Cooldown active: this player tried "${checkKind}" on entity ${args.target_id} ` +
            `${Math.floor(elapsed / 1000 / 60 / 60)}h ago — outcome was "${r.rows[0]?.last_outcome ?? '?'}". ` +
            `Wait ~${Math.ceil(remainingMs / 1000 / 60 / 60)}h before they can try this exact check again. ` +
            `Narrate the refusal in-character (the target sees the same player making the same play and brushes it off).`,
        };
      }
      cooldownClaimed = true;
    }

    // Spec 27 — proficiency-aware modifier. When skill arg is set AND
    // the player has the proficiency, add the level-1 prof bonus.
    // Spec 36 will replace the +2 with an xp-tier lookup.
    let resolvedModifier = modifier;
    if (args.skill && roller === 'player') {
      const profRow = await query<{proficient: boolean}>(
        `SELECT EXISTS(
           SELECT 1 FROM player_proficient_skills
            WHERE player_id = $1 AND skill_name = $2
         ) AS proficient`,
        [ctx.playerId, args.skill],
      );
      if (profRow.rows[0]?.proficient) {
        resolvedModifier += 2;
      }
    }

    // S-11 / ID-2 — auditable rolls via `gameplayRng`. Each die value
    // is paired with the entropy hex the engine consumed, so the audit
    // log can replay the same outcome from the seed.
    const rollCtx = {
      purpose: 'dice_check',
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
    };
    const primary = rollDie(sides, rollCtx);
    const r1 = primary.value;
    const primarySeed = primary.seed;
    let roll = r1;
    let secondaryRoll: number | undefined;
    let secondarySeed: string | undefined;
    if (args.advantage && !args.disadvantage) {
      const r2 = rollDie(sides, rollCtx);
      secondaryRoll = r2.value;
      secondarySeed = r2.seed;
      roll = Math.max(r1, r2.value);
    } else if (args.disadvantage && !args.advantage) {
      const r2 = rollDie(sides, rollCtx);
      secondaryRoll = r2.value;
      secondarySeed = r2.seed;
      roll = Math.min(r1, r2.value);
    }
    const total = roll + resolvedModifier;
    let outcome: 'success' | 'failure' | undefined;
    if (typeof args.dc === 'number') {
      outcome = total >= args.dc ? 'success' : 'failure';
    }
    let crit: 'natural_one' | 'natural_max' | undefined;
    if (sides === 20) {
      if (roll === 1) crit = 'natural_one';
      else if (roll === 20) crit = 'natural_max';
    }
    const includeCombatPayload =
      category === 'combat' ||
      args.roller_entity_id != null ||
      args.roller_position != null ||
      args.target_position != null;
    const combatPayload = includeCombatPayload
      ? {
          rollerEntityId:
            args.roller_entity_id ?? (roller === 'player' ? ctx.playerId : null),
          rollerPosition: normalizeCombatPosition(
            args.roller_position,
            defaultCombatPosition(roller === 'player' ? 'player' : 'npc'),
          ),
          targetEntityId: args.target_id ?? null,
          targetPosition:
            args.target_id == null
              ? null
              : normalizeCombatPosition(
                  args.target_position,
                  defaultCombatPosition(
                    args.target_id === ctx.playerId ? 'player' : 'npc',
                  ),
                ),
        }
      : {};

    // Cooldown row was already claimed atomically above. Patch in the
    // outcome now that we've rolled. If anything between claim and here
    // threw, release the cooldown so the player isn't locked out for 24h
    // by a transient error (GH-BUG-089).
    try {
      if (cooldownClaimed) {
        await query(
          `UPDATE dice_check_cooldowns
              SET last_outcome = $4
            WHERE player_id = $1 AND target_entity_id = $2 AND check_kind = $3`,
          [ctx.playerId, args.target_id, checkKind, outcome ?? null],
        );
      }

      const result = {
      ok: true,
      d: sides,
      roll,
      modifier: resolvedModifier,
      total,
      skill: args.skill ?? null,
      dc: args.dc ?? null,
      outcome: outcome ?? null,
      crit: crit ?? null,
      advantage: args.advantage,
      disadvantage: args.disadvantage,
      secondary_roll: secondaryRoll ?? null,
      // S-11 / ID-2 — auditable entropy hex per die.
      seed: primarySeed,
      secondary_seed: secondarySeed ?? null,
      label: args.label ?? null,
      roller,
      category,
      position: args.position,
      effect: args.effect,
      environment_tags: args.environment_tags,
      bargain: args.bargain ?? null,
      ...combatPayload,
    };

    // Surface to the UI: the existing DiceBubble component listens for
    // 'dice:rolled' on the runtime bus. Server emits over SSE; bridge
    // re-fires as a runtime event for the bubble to render.
    await emitGuiEvent(ctx, 'dice:rolled', {
      turnId: ctx.turnId,
      ...result,
    }, {lane: 'pre_response', phase: 'mutation'});

      return result;
    } catch (err) {
      // Release cooldown on any failure after claim — prevents 24h
      // lockout from transient DB errors (GH-BUG-089).
      if (cooldownClaimed) {
        void query(
          `DELETE FROM dice_check_cooldowns
            WHERE player_id = $1 AND target_entity_id = $2 AND check_kind = $3`,
          [ctx.playerId, args.target_id, checkKind],
        ).catch(() => {/* best-effort */});
      }
      throw err;
    }
  },
});
