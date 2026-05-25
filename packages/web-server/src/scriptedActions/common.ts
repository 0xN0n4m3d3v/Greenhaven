import {query} from '../db.js';
import {
  defaultCombatPosition,
  normalizeCombatPosition,
  type CombatPosition,
} from '../combatTheatre.js';
import {emitGuiEventForSession} from '../guiEventOutbox.js';
import type {Session} from '../sessionManager.js';

const COOLDOWN_HOURS = 24;
const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;

export interface ScriptResult {
  /** Block injected into the user message so the model narrates a resolved mechanic. */
  contextInjection: string;
  /** True if the action was on cooldown and should be refused in-character. */
  onCooldown?: boolean;
}

export async function getPlayerStat(
  playerId: number,
  statKey: string,
): Promise<number> {
  const r = await query<{current: number}>(
    `SELECT current FROM player_stats WHERE player_id = $1 AND stat_key = $2`,
    [playerId, statKey],
  );
  return r.rows[0]?.current ?? 10;
}

export async function checkCooldown(
  playerId: number,
  targetId: number,
  checkKind: string,
): Promise<{
  last_rolled_at: string;
  last_outcome: string | null;
  remainingMs: number;
} | null> {
  const r = await query<{last_rolled_at: string; last_outcome: string | null}>(
    `SELECT last_rolled_at, last_outcome
       FROM dice_check_cooldowns
      WHERE player_id = $1 AND target_entity_id = $2 AND check_kind = $3`,
    [playerId, targetId, checkKind],
  );
  if (r.rows.length === 0) return null;
  const elapsed = Date.now() - new Date(r.rows[0]!.last_rolled_at).getTime();
  if (elapsed >= COOLDOWN_MS) return null;
  return {
    last_rolled_at: r.rows[0]!.last_rolled_at,
    last_outcome: r.rows[0]!.last_outcome,
    remainingMs: COOLDOWN_MS - elapsed,
  };
}

export async function persistCooldown(
  playerId: number,
  targetId: number,
  checkKind: string,
  outcome: string,
): Promise<void> {
  await query(
    `INSERT INTO dice_check_cooldowns
        (player_id, target_entity_id, check_kind, last_rolled_at, last_outcome)
      VALUES ($1, $2, $3, now(), $4)
      ON CONFLICT (player_id, target_entity_id, check_kind)
      DO UPDATE SET last_rolled_at = EXCLUDED.last_rolled_at,
                    last_outcome   = EXCLUDED.last_outcome`,
    [playerId, targetId, checkKind, outcome],
  );
}

export async function recordDicePersistence(
  session: Session,
  playerId: number,
  roller: 'player' | 'npc',
  payload: {
    d: number;
    roll: number;
    modifier: number;
    total: number;
    dc: number | null;
    outcome: string | null;
    label: string;
    combat?: {
      rollerEntityId?: number | null;
      rollerPosition?: CombatPosition;
      targetEntityId?: number | null;
      targetPosition?: CombatPosition;
    };
  },
  turnId: string,
): Promise<void> {
  const combatPayload = payload.combat
    ? {
        rollerEntityId:
          payload.combat.rollerEntityId ??
          (roller === 'player' ? playerId : null),
        rollerPosition: normalizeCombatPosition(
          payload.combat.rollerPosition,
          defaultCombatPosition(roller === 'player' ? 'player' : 'npc'),
        ),
        targetEntityId: payload.combat.targetEntityId ?? null,
        targetPosition:
          payload.combat.targetEntityId == null
            ? null
            : normalizeCombatPosition(
                payload.combat.targetPosition,
                defaultCombatPosition(
                  payload.combat.targetEntityId === playerId ? 'player' : 'npc',
                ),
              ),
      }
    : {};
  await emitGuiEventForSession(
    session.id,
    'dice:rolled',
    {
      turnId,
      d: payload.d,
      roll: payload.roll,
      modifier: payload.modifier,
      total: payload.total,
      dc: payload.dc,
      outcome: payload.outcome,
      label: payload.label,
      roller,
      crit:
        payload.d === 20 && payload.roll === 1
          ? 'natural_one'
          : payload.d === 20 && payload.roll === 20
            ? 'natural_max'
            : null,
      advantage: false,
      disadvantage: false,
      secondary_roll: null,
      position: 'risky',
      effect: 'standard',
      environment_tags: [],
      ...combatPayload,
    },
    {
      playerId,
      turnId,
      lane: 'pre_response',
      phase: 'mutation',
    },
  );
}
