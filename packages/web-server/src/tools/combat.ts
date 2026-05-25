/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Combat — damage / heal that work uniformly on the player AND on
// any NPC entity that has `current_hp` (and optionally `max_hp`)
// declared as runtime_fields. This is the same pattern the prior
// project used: HP is just a runtime field on the entity, the engine
// clamps to [0, max_hp] and reports `defeated` when current drops to 0.
//
// The model decides damage amounts (after rolling dice via dice_check
// and applying its own attack/defence math). These tools just persist
// the result and tell the model "they have N HP left, defeated yes/no".

import {z} from 'zod';
import {
  CombatPositionSchema,
  currentCombatEncounterId,
  defaultCombatPosition,
  emitCombatPositionChanged,
  normalizeCombatPosition,
} from '../combatTheatre.js';
import {query, withTransaction} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {emitFieldChange, emitFieldChangesById} from '../runtimeFieldEvents.js';
import {sessionManager} from '../sessionManager.js';
import {
  registerPreToolValidator,
  registerTool,
  resolveEntityId,
  ToolExecutionError,
  type PreToolValidator,
  type ToolContext,
} from './base.js';
import {isPlayerHolder} from './inventoryCommon.js';
import {applyPatchRaw} from './runtime.js';

interface HpAdjustResult {
  before: number;
  after: number;
  max: number;
  defeated: boolean;
  delta_applied: number;
  /** Where the HP came from: 'player' for `players.current_hp`, 'runtime_field' for an entity-level runtime_field. */
  source: 'player' | 'runtime_field';
}

/**
 * Read & write current_hp / max_hp uniformly across player rows and
 * NPC entities. Players store HP as columns on `players` (cheap, fast,
 * always present). NPCs store it in runtime_fields keyed `current_hp`
 * and `max_hp` on the entity — declared by the cartridge or by a
 * migration. If a target has neither, the tool throws so the model
 * doesn't quietly damage entities the cartridge author never intended
 * to be damageable (a wall, a quest item, etc.).
 */
async function adjustHp(
  entityId: number,
  delta: number,
  source: string,
): Promise<HpAdjustResult> {
  // Wrap in a transaction with row-level locks. The previous read-then-
  // write pattern raced under concurrent attacks (two players hitting
  // the same NPC could both compute `after = before - 5` and overwrite
  // each other's update, losing 5 HP of damage). Pattern A from
  // plans/multi-user-scaling/03-shared-state-and-races.md.
  return withTransaction(async client => {
    // Path 1: player row.
    const p = await client.query<{current_hp: number; max_hp: number}>(
      `SELECT current_hp, max_hp FROM players WHERE entity_id = $1 FOR UPDATE`,
      [entityId],
    );
    if (p.rows.length > 0) {
      const before = p.rows[0]!.current_hp;
      const max = p.rows[0]!.max_hp;
      const after = Math.max(0, Math.min(max, before + delta));
      if (after !== before) {
        await client.query(
          `UPDATE players SET current_hp = $1 WHERE entity_id = $2`,
          [after, entityId],
        );
      }
      return {
        before,
        after,
        max,
        defeated: after === 0,
        delta_applied: after - before,
        source: 'player',
      };
    }

    // Path 2: runtime_fields on the entity. Lock the row so a parallel
    // damage call serialises behind us.
    const fields = await client.query<{
      field_id: number;
      field_key: string;
      default_value: unknown;
      current_value: unknown;
    }>(
      `SELECT f.id AS field_id, f.field_key, f.default_value,
              (SELECT value FROM runtime_values WHERE field_id = f.id FOR UPDATE) AS current_value
         FROM runtime_fields f
        WHERE f.owner_entity_id = $1
          AND f.field_key IN ('current_hp', 'max_hp')`,
      [entityId],
    );
    const cur = fields.rows.find(r => r.field_key === 'current_hp');
    const mx = fields.rows.find(r => r.field_key === 'max_hp');
    if (!cur) {
      throw new Error(
        `entity ${entityId} has no current_hp runtime field — cannot damage/heal something the cartridge didn't tag as HP-bearing`,
      );
    }
    const beforeRaw = cur.current_value ?? cur.default_value;
    const before = readFiniteHpValue(entityId, cur.field_id, 'current_hp', beforeRaw);
    const maxRaw = mx ? (mx.current_value ?? mx.default_value) : before;
    const max = readFiniteHpValue(
      entityId,
      mx?.field_id ?? cur.field_id,
      'max_hp',
      maxRaw,
    );
    const after = Math.max(0, Math.min(max, before + delta));

    if (after !== before) {
      await client.query(
        `INSERT INTO runtime_values (field_id, value, source, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (field_id) DO UPDATE
           SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
        [cur.field_id, JSON.stringify(after), source],
      );
    }
    return {
      before,
      after,
      max,
      defeated: after === 0,
      delta_applied: after - before,
      source: 'runtime_field',
    };
  });
}

function readFiniteHpValue(
  entityId: number,
  fieldId: number,
  fieldKey: string,
  value: unknown,
): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ToolExecutionError(
      `entity ${entityId} has invalid ${fieldKey} runtime value ${JSON.stringify(value)}; refusing to write NaN/null HP`,
      {
        rejected: true,
        suggestion: {
          error: 'invalid_hp_runtime_value',
          entity_id: entityId,
          field_id: fieldId,
          field_key: fieldKey,
          received_value: value,
          retry: {
            tool: 'set_runtime_field',
            field_id: fieldId,
            reason: 'repair the HP field to a finite number before applying damage/heal',
          },
        },
      },
    );
  }
  return n;
}

// Spec 17 conditions vocabulary. Each tag is a short kinetic effect
// the broker reads from the player's prose ("hamstring" → prone,
// "skull crack" → stunned, "blade stays in" → bleeding, etc.).
const ConditionTag = z.enum([
  'bleeding',
  'stunned',
  'off-balance',
  'disarmed',
  'prone',
]);
const ConditionArg = z.object({
  tag: ConditionTag,
  duration_turns: z.number().int().min(1).max(10).default(2),
  severity: z.number().int().min(1).max(3).default(1),
});

const DamageArgs = z
  .object({
  /** Legacy display_name or numeric id as string. Prefer target_id. */
  target: z.string().optional(),
  /** Preferred target entity id. Use ctx.playerId for the active player. */
  target_id: z.number().int().positive().optional(),
  /** Positive integer damage. Use `heal` for healing. */
  amount: z.number().int().positive(),
  /** Canonical damage type key such as slashing/piercing/bludgeoning/fire. */
  type: z.string().optional(),
  /** Canonical source key: item slug/display_name, runtime surface type, or unarmed_strike. */
  source: z.string().optional(),
  /** Preferred attacker entity id. Required for NPC weapon checks when the active player is the target. */
  attacker_id: z.number().int().positive().optional(),
  /** Legacy attacker display name; prefer attacker_id. */
  attacker: z.string().optional(),
  /** Combat lane for the attacker. */
  attacker_position: CombatPositionSchema.optional(),
  /** Combat lane for the target before this damage. */
  target_position: CombatPositionSchema.optional(),
  /** Combat lane for the target after forced movement, shove, knockback, etc. */
  target_position_after: CombatPositionSchema.optional(),
  /** Short canonical reason for target_position_after. */
  position_reason: z.string().max(80).optional(),
  /** Optional condition to apply alongside the damage. Player prose like
   *  "I sever the tendon" → bleeding+disarmed; "I crush the skull" → stunned;
   *  "I sweep the legs" → prone. Broker chooses from the prose. */
  condition: ConditionArg.optional(),
})
  .refine(d => d.target_id != null || d.target != null, {
    message: 'target_id or target is required',
  });

async function resolveDamageTarget(args: {
  target?: string;
  target_id?: number;
}): Promise<number | null> {
  if (args.target_id != null) return args.target_id;
  if (args.target != null) return resolveEntityId(args.target);
  return null;
}

const requireD20BeforeDamage: PreToolValidator = async (toolName, rawArgs, ctx) => {
  if (toolName !== 'damage' || !ctx.turnId) return {ok: true};
  const args = DamageArgs.parse(rawArgs);
  const targetId = await resolveDamageTarget(args);
  if (targetId == null) return {ok: true};
  const rootTurnId = ctx.batchId ?? ctx.turnId;
  const duplicate = await findDuplicateDamageInTurn(
    ctx.sessionId,
    rootTurnId,
    targetId,
    args.amount,
    args.type ?? '',
    args.source ?? '',
  );
  if (duplicate) return {ok: true};

  const counts = await query<{successful_d20_count: number; damage_count: number}>(
    `SELECT
       (SELECT COUNT(*)::int
          FROM tool_invocations
         WHERE session_id = $1
           AND (turn_id = $2 OR turn_id LIKE ($2 || ':%'))
           AND tool_name = 'dice_check'
           AND error IS NULL
           AND result->>'ok' = 'true'
           AND COALESCE((result->>'d')::int, 20) = 20
           AND result->>'outcome' = 'success') AS successful_d20_count,
       (SELECT COUNT(*)::int
          FROM tool_invocations
         WHERE session_id = $1
           AND (turn_id = $2 OR turn_id LIKE ($2 || ':%'))
           AND tool_name = 'damage'
           AND error IS NULL
           AND COALESCE((result->>'damage_dealt')::int, 0) > 0) AS damage_count`,
    [ctx.sessionId, rootTurnId],
  );
  const row = counts.rows[0];
  const successfulD20Count = Number(row?.successful_d20_count ?? 0);
  const priorDamageCount = Number(row?.damage_count ?? 0);
  if (successfulD20Count > priorDamageCount) return {ok: true};

  const roller = targetId === ctx.playerId ? 'npc' : 'player';
  const dc = await loadArmorClass(targetId);
  return {
    ok: false,
    reason:
      'damage requires a successful visible d20 dice_check earlier in the same turn; player prose is intent, the die decides hit or miss',
    suggestion: {
      action:
        'Call dice_check(d=20, dc=<target AC>, category="combat") before damage. Treat player wording as intended action and style, not canonical impact. If the d20 fails, narrate the miss/failed consequence and do not call damage.',
      retry_first: {
        tool: 'dice_check',
        args: {
          d: 20,
          dc,
          category: 'combat',
          roller,
          roller_entity_id: roller === 'player' ? ctx.playerId : args.attacker_id,
          roller_position:
            roller === 'player'
              ? (args.attacker_position ?? 'mid')
              : (args.attacker_position ?? 'front'),
          target_id: targetId,
          target_position:
            args.target_position ?? (targetId === ctx.playerId ? 'mid' : 'front'),
          label: `${args.target ?? `entity ${targetId}`} attack roll`,
          position: 'risky',
          effect: 'standard',
        },
      },
      retry_after_roll: {
        tool: 'damage',
        args,
      },
    },
  };
};

registerPreToolValidator('damage', requireD20BeforeDamage);

const WEAPON_DAMAGE_TYPES = new Set(['slashing', 'piercing']);
const UNARMED_SOURCE_ID = 'unarmed_strike';

const validateDamageSourceGrounding: PreToolValidator = async (
  toolName,
  rawArgs,
  ctx,
) => {
  if (toolName !== 'damage') return {ok: true};
  const args = DamageArgs.parse(rawArgs);
  const targetId = await resolveDamageTarget(args);
  if (targetId == null) return {ok: true};

  const source = args.source?.trim() ?? '';
  if (!source) {
    if (isWeaponDamageType(args.type)) {
      return rejectDamageSource(args, ctx, targetId, null, 'weapon damage needs a grounded source item');
    }
    return {ok: true};
  }

  const normalizedSource = normalizeCombatSource(source);
  if (isUnarmedSource(normalizedSource)) return {ok: true};

  const attackerId = await resolveDamageAttacker(args, targetId, ctx);
  if (attackerId != null) {
    const actorOnly = await sourceIsActorOnly(attackerId, normalizedSource);
    if (actorOnly) {
      if (isWeaponDamageType(args.type)) {
        return rejectDamageSource(
          args,
          ctx,
          targetId,
          attackerId,
          'actor-only source cannot justify slashing/piercing damage',
        );
      }
      return {ok: true};
    }
    if (await holderHasCombatSource(attackerId, normalizedSource)) {
      return {ok: true};
    }
  }

  if (await currentLocationHasCombatSource(ctx.playerId, normalizedSource)) {
    return {ok: true};
  }

  return rejectDamageSource(
    args,
    ctx,
    targetId,
    attackerId,
    'damage source is not held by the attacker and is not present in the current environment',
  );
};

registerPreToolValidator('damage', validateDamageSourceGrounding);

function isWeaponDamageType(type: string | undefined): boolean {
  return WEAPON_DAMAGE_TYPES.has(normalizeCombatSource(type ?? ''));
}

function isUnarmedSource(source: string): boolean {
  return source === normalizeCombatSource(UNARMED_SOURCE_ID);
}

function normalizeCombatSource(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/^@/, '')
    .replace(/["'`]/g, '')
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}

async function resolveDamageAttacker(
  args: z.input<typeof DamageArgs>,
  targetId: number,
  ctx: ToolContext,
): Promise<number | null> {
  if (args.attacker_id != null) return args.attacker_id;
  if (args.attacker) return resolveEntityId(args.attacker, {playerId: ctx.playerId});
  if (targetId !== ctx.playerId) return ctx.playerId;

  const source = args.source?.trim();
  if (source) {
    const visible = await visibleNpcCandidates(ctx.playerId);
    const normalized = normalizeCombatSource(source);
    const bySource = visible.find(npc =>
      normalized.includes(normalizeCombatSource(npc.display_name)),
    );
    if (bySource) return bySource.id;
  }

  const player = await query<{dialogue_partner_id: number | null}>(
    `SELECT dialogue_partner_id FROM players WHERE entity_id = $1`,
    [ctx.playerId],
  );
  return player.rows[0]?.dialogue_partner_id ?? null;
}

async function visibleNpcCandidates(
  playerId: number,
): Promise<Array<{id: number; display_name: string}>> {
  const rows = await query<{id: number; display_name: string}>(
    `SELECT e.id, e.display_name
       FROM players p
       JOIN entities e ON e.kind = 'person'
      WHERE p.entity_id = $1
        AND (
          e.id = p.dialogue_partner_id
          OR e.profile->>'current_location_id' = p.current_location_id::text
          OR e.profile->>'home_id' = p.current_location_id::text
          OR e.profile->>'location_id' = p.current_location_id::text
        )
        AND NOT EXISTS (
          SELECT 1 FROM actor_statuses s
           WHERE s.player_id = p.entity_id
             AND s.actor_entity_id = e.id
             AND s.intensity > 0
             AND s.status_kind IN ('dead', 'missing')
        )`,
    [playerId],
  );
  return rows.rows.map(row => ({id: Number(row.id), display_name: row.display_name}));
}

async function sourceIsActorOnly(
  attackerId: number,
  normalizedSource: string,
): Promise<boolean> {
  const row = await query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [attackerId],
  );
  const name = normalizeCombatSource(row.rows[0]?.display_name ?? '');
  if (!name) return false;
  return normalizedSource === name;
}

async function holderHasCombatSource(
  holderId: number,
  normalizedSource: string,
): Promise<boolean> {
  if (await isPlayerHolder(holderId)) {
    const rows = await query<{slug: string; item_name: string; category: string}>(
      `SELECT i.slug,
              COALESCE(e.display_name, i.slug) AS item_name,
              i.category
         FROM player_inventory pi
         JOIN items i ON i.id = pi.item_id
         LEFT JOIN entities e ON e.id = i.legacy_entity_id
        WHERE pi.player_id = $1
          AND pi.quantity > 0
          AND i.category IN ('weapon', 'tool')`,
      [holderId],
    );
    return rows.rows.some(row =>
      combatSourceMatches(normalizedSource, row.slug) ||
      combatSourceMatches(normalizedSource, row.item_name),
    );
  }

  const rows = await query<{
    display_name: string;
    slug: string | null;
    category: string | null;
    tags: string[] | null;
  }>(
    `SELECT e.display_name,
            i.slug,
            i.category,
            e.tags
       FROM inventory_entries ie
       JOIN entities e ON e.id = ie.item_entity_id
       LEFT JOIN items i ON i.legacy_entity_id = e.id
      WHERE ie.holder_entity_id = $1
        AND ie.count > 0`,
    [holderId],
  );
  return rows.rows.some(row => {
    const tags = row.tags ?? [];
    const category = row.category ?? '';
    const combatRelevant =
      category === 'weapon' ||
      category === 'tool' ||
      tags.includes('weapon') ||
      tags.includes('tool');
    if (!combatRelevant) return false;
    return (
      combatSourceMatches(normalizedSource, row.display_name) ||
      combatSourceMatches(normalizedSource, row.slug ?? '')
    );
  });
}

async function currentLocationHasCombatSource(
  playerId: number,
  normalizedSource: string,
): Promise<boolean> {
  const player = await query<{current_location_id: number | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const locationId = player.rows[0]?.current_location_id;
  if (locationId == null) return false;

  const items = await query<{
    display_name: string;
    slug: string | null;
    category: string | null;
    tags: string[] | null;
  }>(
    `SELECT e.display_name,
            i.slug,
            i.category,
            e.tags
       FROM inventory_entries ie
       JOIN entities e ON e.id = ie.item_entity_id
       LEFT JOIN items i ON i.legacy_entity_id = e.id
      WHERE ie.holder_entity_id = $1
        AND ie.count > 0`,
    [locationId],
  );
  if (
    items.rows.some(row =>
      combatSourceMatches(normalizedSource, row.display_name) ||
      combatSourceMatches(normalizedSource, row.slug ?? ''),
    )
  ) {
    return true;
  }

  const surfaces = await query<{value: unknown}>(
    `SELECT COALESCE(rv.value, rf.default_value) AS value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = $1
        AND rf.field_key = 'active_surfaces'
      LIMIT 1`,
    [locationId],
  );
  const value = surfaces.rows[0]?.value;
  if (!Array.isArray(value)) return false;
  return value.some(surface => {
    if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
      return false;
    }
    const type = (surface as Record<string, unknown>)['type'];
    return typeof type === 'string' && normalizeCombatSource(type) === normalizedSource;
  });
}

function combatSourceMatches(source: string, candidate: string): boolean {
  const normalized = normalizeCombatSource(candidate);
  if (normalized.length < 3) return false;
  return source === normalized;
}

function rejectDamageSource(
  args: z.input<typeof DamageArgs>,
  ctx: ToolContext,
  targetId: number,
  attackerId: number | null,
  reason: string,
): {ok: false; reason: string; suggestion: Record<string, unknown>} {
  return {
    ok: false,
    reason: `damage_source_ungrounded: ${reason}`,
    suggestion: {
      guard: 'combat_source_grounding',
      attacker_id: attackerId,
      target_id: targetId,
      source: args.source ?? null,
      damage_type: args.type ?? null,
      retry:
        'Use source="unarmed_strike" for an unarmed hit, or pass attacker_id and source as an exact weapon/tool slug or visible environment item. NPCs and the active player may only deal weapon damage with items they actually hold.',
      example:
        targetId === ctx.playerId
          ? {tool: 'damage', args: {...args, attacker_id: attackerId ?? '<npc id>', source: 'unarmed_strike', type: 'bludgeoning'}}
          : {tool: 'damage', args: {...args, attacker_id: ctx.playerId, source: 'unarmed_strike', type: 'bludgeoning'}},
    },
  };
}

async function loadArmorClass(entityId: number): Promise<number> {
  const playerRow = await query<{current_hp: number}>(
    `SELECT current_hp FROM players WHERE entity_id = $1`,
    [entityId],
  );
  if (playerRow.rows.length > 0) return 10;
  const r = await query<{value: unknown}>(
    `SELECT COALESCE(rv.value, rf.default_value) AS value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'armor_class'
      LIMIT 1`,
    [entityId],
  );
  const ac = Number(r.rows[0]?.value ?? 10);
  return Number.isFinite(ac) && ac > 0 ? ac : 10;
}

registerTool({
  name: 'damage',
  description:
    'Apply damage to a player or NPC (NPCs need current_hp runtime field). ' +
    'Returns hp before/after, defeated flag. Optional `condition` tags a body-part ' +
    'effect: bleeding/stunned/off-balance/disarmed/prone with duration + severity. ' +
    'Use attacker_position/target_position/target_position_after for combat lane changes. ' +
    'Weapon damage must include attacker_id/attacker and source grounded in that attacker inventory; use source="unarmed_strike" for unarmed hits.',
  paramsSchema: DamageArgs,
  async execute(args, ctx) {
    const targetId = await resolveDamageTarget(args);
    if (targetId == null) throw new Error(`unknown target: ${args.target ?? args.target_id}`);
    const duplicate = await findDuplicateDamageInTurn(
      ctx.sessionId,
      ctx.batchId ?? ctx.turnId,
      targetId,
      args.amount,
      args.type ?? '',
      args.source ?? '',
    );
    if (duplicate) {
      return {
        target_id: targetId,
        attacker_id: args.attacker_id ?? null,
        attacker: args.attacker ?? null,
        damage_requested: args.amount,
        damage_dealt: 0,
        damage_type: args.type ?? null,
        damage_source: args.source ?? null,
        hp_before: duplicate.hp_after,
        hp_after: duplicate.hp_after,
        hp_max: duplicate.hp_max,
        defeated: duplicate.defeated,
        condition_applied: null,
        duplicate_ignored: true,
        duplicate_of_invocation_id: duplicate.id,
      };
    }
    // Apply condition BEFORE HP adjustment (GH-BUG-088).
    // If condition append fails, the damage is never applied — avoids
    // the partial-update where HP is decremented but condition is lost.
    let conditionApplied: {tag: string; expires_turn: number} | null = null;
    if (args.condition) {
      const condField = await query<{id: number}>(
        `SELECT id FROM runtime_fields
          WHERE owner_entity_id = $1 AND field_key = 'conditions'`,
        [targetId],
      );
      const fieldId = condField.rows[0]?.id;
      if (fieldId != null) {
        const turnRow = await query<{turn_no: number}>(
          `SELECT COALESCE(MAX(turn_index), 0) AS turn_no
             FROM chat_messages WHERE session_id = $1`,
          [ctx.sessionId],
        );
        const currentTurn = Number(turnRow.rows[0]?.turn_no ?? 0);
        const duration = args.condition.duration_turns ?? 2;
        const severity = args.condition.severity ?? 1;
        const newCond = {
          tag: args.condition.tag,
          applied_turn: currentTurn,
          expires_turn: currentTurn + duration,
          severity,
          source: args.source ?? null,
        };
        await applyPatchRaw(fieldId, newCond, 'append', 'damage_condition');
        await emitFieldChangesById(ctx.sessionId, [
          {field_id: fieldId, source: 'damage_condition'},
        ]);
        conditionApplied = {
          tag: newCond.tag,
          expires_turn: newCond.expires_turn,
        };
      }
    }

    const result = await adjustHp(targetId, -args.amount, args.source ?? 'damage');

    // Spec 30 — runtime:field SSE for HP UI updates.
    emitFieldChange(ctx.sessionId, {
      owner_entity_id: targetId,
      field_key: 'current_hp',
      value: result.after,
      source: 'damage',
    });

    const attackerId = await resolveDamageAttacker(args, targetId, ctx);
    const session = sessionManager.get(ctx.sessionId) ?? null;
    const encounterId = currentCombatEncounterId({
      session,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId ?? null,
    });
    const attackerPosition = normalizeCombatPosition(
      args.attacker_position,
      defaultCombatPosition(attackerId === ctx.playerId ? 'player' : 'npc'),
    );
    const targetPosition = normalizeCombatPosition(
      args.target_position,
      defaultCombatPosition(targetId === ctx.playerId ? 'player' : 'npc'),
    );
    const targetPositionAfter = args.target_position_after
      ? normalizeCombatPosition(args.target_position_after, targetPosition)
      : targetPosition;

    // Card-friendly event for the system feed.
    const targetRow = await query<{display_name: string; kind: string}>(
      `SELECT display_name, kind FROM entities WHERE id = $1`,
      [targetId],
    );
    await emitGuiEvent(ctx, 'damage:dealt', {
      targetId,
      targetName: targetRow.rows[0]?.display_name ?? args.target ?? String(targetId),
      targetKind: targetRow.rows[0]?.kind ?? null,
      attackerId: attackerId ?? null,
      attacker: args.attacker ?? null,
      attackerPosition,
      targetPosition,
      targetPositionAfter,
      encounterId,
      amount: -result.delta_applied,
      hpBefore: result.before,
      hpAfter: result.after,
      hpMax: result.max,
      defeated: result.defeated,
      damageType: args.type ?? null,
      source: args.source ?? null,
      condition: conditionApplied,
    });
    await emitCombatPositionChanged({
      session,
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId ?? null,
      entityId: targetId,
      from: targetPosition,
      to: targetPositionAfter,
      reason: args.position_reason ?? args.condition?.tag ?? 'forced_movement',
    });

    return {
      target_id: targetId,
      attacker_id: attackerId ?? null,
      attacker: args.attacker ?? null,
      attacker_position: attackerPosition,
      target_position: targetPosition,
      target_position_after: targetPositionAfter,
      encounter_id: encounterId,
      damage_requested: args.amount,
      damage_dealt: -result.delta_applied,
      damage_type: args.type ?? null,
      damage_source: args.source ?? null,
      hp_before: result.before,
      hp_after: result.after,
      hp_max: result.max,
      defeated: result.defeated,
      condition_applied: conditionApplied,
    };
  },
});

async function findDuplicateDamageInTurn(
  sessionId: string,
  turnId: string | undefined,
  targetId: number,
  amount: number,
  type: string,
  source: string,
): Promise<{
  id: number;
  hp_after: number;
  hp_max: number;
  defeated: boolean;
} | null> {
  if (!turnId) return null;
  const r = await query<{
    id: number;
    hp_after: unknown;
    hp_max: unknown;
    defeated: unknown;
    damage_dealt: unknown;
  }>(
    `SELECT id,
            result->>'hp_after' AS hp_after,
            result->>'hp_max' AS hp_max,
            result->>'defeated' AS defeated,
            result->>'damage_dealt' AS damage_dealt
       FROM tool_invocations
      WHERE session_id = $1
        AND (turn_id = $2 OR turn_id LIKE ($2 || ':%'))
        AND tool_name = 'damage'
        AND error IS NULL
        AND result->>'target_id' = $3
        AND args->>'amount' = $4
        AND COALESCE(args->>'type', '') = $5
        AND COALESCE(args->>'source', '') = $6
      ORDER BY invoked_at DESC
      LIMIT 1`,
    [sessionId, turnId, String(targetId), String(amount), type, source],
  );
  const row = r.rows[0];
  if (!row || Number(row.damage_dealt) <= 0) return null;
  return {
    id: row.id,
    hp_after: Number(row.hp_after),
    hp_max: Number(row.hp_max),
    defeated: row.defeated === true || row.defeated === 'true',
  };
}

const HealArgs = z
  .object({
  target: z.string().optional(),
  target_id: z.number().int().positive().optional(),
  amount: z.number().int().positive(),
  source: z.string().optional(),
})
  .refine(d => d.target_id != null || d.target != null, {
    message: 'target_id or target is required',
  });

registerTool({
  name: 'heal',
  description: 'Restore HP. Cannot exceed max_hp. Returns hp before/after.',
  paramsSchema: HealArgs,
  async execute(args, ctx) {
    const targetId =
      args.target_id != null ? args.target_id : await resolveEntityId(args.target!);
    if (targetId == null) throw new Error(`unknown target: ${args.target ?? args.target_id}`);
    const result = await adjustHp(targetId, args.amount, args.source ?? 'heal');
    emitFieldChange(ctx.sessionId, {
      owner_entity_id: targetId,
      field_key: 'current_hp',
      value: result.after,
      source: 'heal',
    });
    return {
      target_id: targetId,
      heal_requested: args.amount,
      heal_applied: result.delta_applied,
      heal_source: args.source ?? null,
      hp_before: result.before,
      hp_after: result.after,
      hp_max: result.max,
    };
  },
});
