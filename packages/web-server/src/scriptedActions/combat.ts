import {withTransaction, type TxClient} from '../db.js';
import type {Session} from '../sessionManager.js';
import {
  UNARMED_ATTACK_SOURCE,
  describeAttackSource,
  loadNpcAttackSource,
  loadPlayerAttackSource,
  unarmedAttackSource,
} from './combatSources.js';
import {abilityMod, rollD20, rollDamage} from './dice.js';
import {
  getPlayerStat,
  recordDicePersistence,
  type ScriptResult,
} from './common.js';
/**
 * attack:200 — full combat round, three phases:
 *   1. PLAYER — swing roll + damage if hit, applied to NPC HP.
 *   2. NPC REACTION — short event triggered by phase 1 (e.g. crit
 *      stun, dodge bonus). Implemented as flavor for v1; future
 *      cartridge data will drive per-NPC reaction lists.
 *   3. NPC TURN — NPC takes its own action (counter-attack), but
 *      ONLY if alive AND not stunned. Skipped otherwise; the model
 *      narrates the NPC reeling instead.
 *
 * All rolls are pre-computed server-side and persisted; the model
 * receives the resolved beat-by-beat structure and only writes the
 * prose narration with no further tool calls.
 */
export async function scriptAttack(
  session: Session,
  playerId: number,
  npcId: number,
  turnId: string,
): Promise<ScriptResult | null> {
  // Wrap the entire combat round in a transaction with an advisory
  // lock keyed on the NPC. Two players attacking the same NPC at the
  // same instant serialise their phase-1 swings instead of racing on
  // currentHp. PGlite ignores `pg_advisory_xact_lock` (single-thread
  // anyway); managed Postgres enforces. Pattern C+lock from
  // plans/multi-user-scaling/03-shared-state-and-races.md.
  return withTransaction(async client => {
    try {
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [npcId]);
    } catch (err) {
      // CATCH-WARN-OK: PGlite-compat probe. `pg_advisory_xact_lock` is a managed-Postgres-only feature; PGlite silently no-ops the same statement on production runs but raises here under the bundled dev driver. The outer `withTransaction` already serialises per-NPC writes on PGlite (single-thread), so the lock is purely a managed-Postgres serialisation; this warn records the driver-specific fallback for operators inspecting test logs, no paired telemetry channel exists for driver-feature probes.
      console.warn(
        `[scriptAttack] advisory lock unsupported (likely PGlite): ${err instanceof Error ? err.message : err}`,
      );
    }
    return scriptAttackInTx(client, session, playerId, npcId, turnId);
  });
}

async function scriptAttackInTx(
  client: TxClient,
  session: Session,
  playerId: number,
  npcId: number,
  turnId: string,
): Promise<ScriptResult | null> {
  const npc = await client.query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [npcId],
  );
  if (npc.rows.length === 0) return null;
  const npcName = npc.rows[0]!.display_name;

  // Read NPC combat vitals + status from runtime fields.
  const fields = await client.query<{
    field_id: number;
    field_key: string;
    value: unknown;
  }>(
    `SELECT f.id AS field_id, f.field_key,
            COALESCE(rv.value, f.default_value) AS value
       FROM runtime_fields f
       LEFT JOIN runtime_values rv ON rv.field_id = f.id
      WHERE f.owner_entity_id = $1
        AND f.field_key IN ('current_hp', 'max_hp', 'armor_class', 'stunned')`,
    [npcId],
  );
  const ac = Number(fields.rows.find(r => r.field_key === 'armor_class')?.value ?? 10);
  const hpField = fields.rows.find(r => r.field_key === 'current_hp');
  const currentHp = hpField ? Number(hpField.value) : 0;
  if (!hpField) return null;
  const stunnedField = fields.rows.find(r => r.field_key === 'stunned');
  const stunned = stunnedField?.value === true || stunnedField?.value === 'true';

  // Read player's stun flag (from PREVIOUS round, if any).
  const playerRow = await client.query<{is_stunned: boolean}>(
    `SELECT is_stunned FROM players WHERE entity_id = $1 FOR UPDATE`,
    [playerId],
  );
  const playerStunned = playerRow.rows[0]?.is_stunned === true;
  const playerAttackSource = await loadPlayerAttackSource(client, playerId);

  // ─── PHASE 1: Player swing ──────────────────────────────────
  // Skipped if the player is stunned. Stun auto-clears so it lasts
  // exactly one round.
  let attackRoll = 0;
  let attackTotal = 0;
  let strMod = 0;
  let hit = false;
  let crit = false;
  let fumble = false;
  let damage = 0;
  let hpAfter = currentHp;
  let defeated = false;
  if (!playerStunned) {
    const strScore = await getPlayerStat(playerId, 'STR');
    strMod = abilityMod(strScore);
    const profBonus = 2;
    attackRoll = rollD20();
    attackTotal = attackRoll + strMod + profBonus;
    hit = attackTotal >= ac;
    crit = attackRoll === 20;
    fumble = attackRoll === 1;

    await recordDicePersistence(
      session,
      playerId,
      'player',
      {
        d: 20,
        roll: attackRoll,
        modifier: strMod + profBonus,
        total: attackTotal,
        dc: ac,
        outcome: hit && !fumble ? 'success' : 'failure',
        label: `Player attack vs ${npcName}`,
        combat: {
          rollerEntityId: playerId,
          rollerPosition: 'mid',
          targetEntityId: npcId,
          targetPosition: 'front',
        },
      },
      turnId,
    );

    if (hit && !fumble) {
      const damageRoll = rollDamage(playerAttackSource.damageSides);
      damage = damageRoll + strMod + (crit ? damageRoll : 0);
      if (damage < 1) damage = 1;
      await recordDicePersistence(
        session,
        playerId,
        'player',
        {
          d: playerAttackSource.damageSides,
          roll: damageRoll,
          modifier: strMod,
          total: damage,
          dc: null,
          outcome: null,
          label: crit
            ? `Player damage with ${playerAttackSource.source} (CRIT, doubled)`
            : `Player damage with ${playerAttackSource.source}`,
          combat: {
            rollerEntityId: playerId,
            rollerPosition: 'mid',
            targetEntityId: npcId,
            targetPosition: 'front',
          },
        },
        turnId,
      );
      hpAfter = Math.max(0, currentHp - damage);
      defeated = hpAfter === 0;
      await client.query(
        `INSERT INTO runtime_values (field_id, value, source, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (field_id) DO UPDATE
           SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
        [hpField.field_id, JSON.stringify(hpAfter), 'scripted_attack'],
      );
    }
  } else {
    // Player is stunned — clear the flag so next round they act normally.
    await client.query(
      `UPDATE players SET is_stunned = false WHERE entity_id = $1`,
      [playerId],
    );
  }

  // ─── PHASE 2: Reaction (flavor only for v1) ─────────────────
  let reactionNote: string | null = null;
  if (!playerStunned) {
    if (crit && hit) {
      reactionNote = `${npcName} reels from the impact — the crit lands hard.`;
    } else if (fumble) {
      reactionNote = `${npcName} grins, gaining the upper hand for the moment.`;
    }
  }

  // ─── PHASE 3: NPC turn ──────────────────────────────────────
  // Skipped if defeated, or NPC is stunned (carry-over from a
  // previous round). Stun auto-clears one round.
  let npcTurn:
    | {kind: 'attack'; roll: number; total: number; dc: number; hit: boolean; damage: number}
    | {kind: 'skipped'; reason: 'defeated' | 'stunned'}
    | null = null;
  let npcAttackSource = unarmedAttackSource();
  if (defeated) {
    npcTurn = {kind: 'skipped', reason: 'defeated'};
  } else if (stunned) {
    npcTurn = {kind: 'skipped', reason: 'stunned'};
    // Auto-clear NPC stun for next round.
    if (stunnedField) {
      await client.query(
        `INSERT INTO runtime_values (field_id, value, source, updated_at)
         VALUES ($1, 'false'::jsonb, 'scripted_attack_stun_clear', now())
         ON CONFLICT (field_id) DO UPDATE
           SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
        [stunnedField.field_id],
      );
    }
  } else {
    // NPC's attack uses cartridge stats — fetch them properly now.
    npcAttackSource = await loadNpcAttackSource(client, npcId);
    const npcStats = await client.query<{stat_key: string; current: number}>(
      `SELECT stat_key, current FROM npc_stats
        WHERE npc_entity_id = $1 AND stat_key IN ('STR', 'DEX')`,
      [npcId],
    );
    const npcDex = npcStats.rows.find(r => r.stat_key === 'DEX')?.current ?? 10;
    const npcDexMod = abilityMod(npcDex);
    const npcProf = 2;
    const npcAttackMod = npcDexMod + npcProf;

    const playerStats = await client.query<{stat_key: string; current: number}>(
      `SELECT stat_key, current FROM player_stats
        WHERE player_id = $1 AND stat_key = 'DEX'`,
      [playerId],
    );
    const playerDex = playerStats.rows[0]?.current ?? 10;
    const playerAc = 10 + abilityMod(playerDex);

    const cRoll = rollD20();
    const cTotal = cRoll + npcAttackMod;
    const cHit = cTotal >= playerAc;
    let cDamage = 0;
    let cDamageRoll = 0;
    if (cHit) {
      cDamageRoll = rollDamage(npcAttackSource.damageSides);
      cDamage = Math.max(1, cDamageRoll + npcDexMod);
      const p = await client.query<{current_hp: number; max_hp: number}>(
        `SELECT current_hp, max_hp FROM players WHERE entity_id = $1 FOR UPDATE`,
        [playerId],
      );
      const before = p.rows[0]?.current_hp ?? 0;
      const after = Math.max(0, before - cDamage);
      await client.query(
        `UPDATE players SET current_hp = $1 WHERE entity_id = $2`,
        [after, playerId],
      );
    }
    await recordDicePersistence(
      session,
      playerId,
      'npc',
      {
        d: 20,
        roll: cRoll,
        modifier: npcAttackMod,
        total: cTotal,
        dc: playerAc,
        outcome: cHit ? 'success' : 'failure',
        label: `${npcName} attack`,
        combat: {
          rollerEntityId: npcId,
          rollerPosition: 'front',
          targetEntityId: playerId,
          targetPosition: 'mid',
        },
      },
      turnId,
    );
    if (cHit) {
      await recordDicePersistence(
        session,
        playerId,
        'npc',
        {
          d: npcAttackSource.damageSides,
          roll: cDamageRoll,
          modifier: npcDexMod,
          total: cDamage,
          dc: null,
          outcome: null,
          label: `${npcName} damage with ${npcAttackSource.source}`,
          combat: {
            rollerEntityId: npcId,
            rollerPosition: 'front',
            targetEntityId: playerId,
            targetPosition: 'mid',
          },
        },
        turnId,
      );
    }
    npcTurn = {kind: 'attack', roll: cRoll, total: cTotal, dc: playerAc, hit: cHit, damage: cDamage};
  }

  // ─── Build the structured injection ─────────────────────────
  const profBonus = 2;
  const lines: string[] = [
    `[Pre-computed combat round: three phases, all dice resolved server-side]`,
    ``,
    `## Phase 1 — Player attacks ${npcName}`,
    `  Source: ${describeAttackSource(playerAttackSource)}; damage_type=${playerAttackSource.damageType}`,
  ];
  if (playerStunned) {
    lines.push(
      `  SKIPPED. Player is stunned (carry-over from previous round). Their swing falters and they shake the daze off this round — narrate the failed attempt and the stun clearing. The stun flag has been auto-reset, so next round they act normally.`,
    );
  } else {
    lines.push(
      `  Attack: d20=${attackRoll}+${strMod + profBonus} = ${attackTotal} vs AC ${ac} → ${hit && !fumble ? 'HIT' : 'MISS'}${crit ? ' (CRIT — doubled damage)' : ''}${fumble ? ' (FUMBLE — d20 = 1)' : ''}`,
    );
    if (hit && !fumble) {
      lines.push(
        `  Damage: ${damage} (source=${playerAttackSource.source}, type=${playerAttackSource.damageType}) → ${npcName} HP: ${currentHp} → ${hpAfter}${defeated ? ' (DEFEATED — drops at 0 HP)' : ''}`,
      );
    }
  }
  lines.push(``);
  lines.push(`## Phase 2 — Reaction`);
  lines.push(`  ${reactionNote ?? '(no special reaction)'}`);
  lines.push(``);
  lines.push(`## Phase 3 — ${npcName}'s turn`);
  if (!npcTurn || npcTurn.kind === 'skipped') {
    const reason =
      npcTurn?.reason === 'defeated'
        ? `${npcName} is at 0 HP — turn skipped, narrate them dropping/unconscious.`
        : `${npcName} is stunned (carry-over from previous round) — turn skipped, narrate the daze. Stun flag has been auto-cleared for next round.`;
    lines.push(`  SKIPPED. ${reason}`);
  } else {
    lines.push(
      `  Source: ${describeAttackSource(npcAttackSource)}; damage_type=${npcAttackSource.damageType}`,
    );
    lines.push(
      `  Attack: d20=${npcTurn.roll} vs your AC ${npcTurn.dc} → ${npcTurn.hit ? `HIT for ${npcTurn.damage} dmg` : 'MISS'}`,
    );
  }
  lines.push(``);
  lines.push(
    `Instruction: Narrate ALL THREE phases as one in-character bubble. Use only the listed canonical source keys for weapons/attack sources; if source=${UNARMED_ATTACK_SOURCE}, render an unarmed body attack in the selected language. Voice = location ambient OR ${npcName} first-person depending on what feels right. Do NOT call any tool other than narrate(done=true) — every dice roll, hit, miss, damage and HP change is already resolved.`,
  );

  return {contextInjection: lines.join('\n')};
}
