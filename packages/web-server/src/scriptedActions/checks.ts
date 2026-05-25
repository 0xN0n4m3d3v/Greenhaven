import {query} from '../db.js';
import type {Session} from '../sessionManager.js';
import {abilityMod, rollD20} from './dice.js';
import {
  checkCooldown,
  getPlayerStat,
  persistCooldown,
  recordDicePersistence,
  type ScriptResult,
} from './common.js';
/** social:200:seduce → run a single CHA-vs-DC check for that NPC. */
export async function scriptSocialCheck(
  session: Session,
  playerId: number,
  npcId: number,
  socialKind: string,
  turnId: string,
): Promise<ScriptResult | null> {
  const npc = await query<{display_name: string; profile: Record<string, unknown> | null}>(
    `SELECT display_name, profile FROM entities WHERE id = $1`,
    [npcId],
  );
  if (npc.rows.length === 0) return null;
  const profile = npc.rows[0]!.profile;
  const social = (profile as {social_dcs?: Record<string, unknown>} | null)?.social_dcs;
  const def = social?.[socialKind] as {ability?: string; dc?: number} | undefined;
  if (!def?.ability || typeof def.dc !== 'number') return null;

  const cd = await checkCooldown(playerId, npcId, socialKind);
  if (cd) {
    const hours = Math.ceil(cd.remainingMs / 1000 / 60 / 60);
    return {
      onCooldown: true,
      contextInjection:
        `[Pre-computed action: scripted social check]\n` +
        `Action: ${socialKind} ${npc.rows[0]!.display_name}\n` +
        `Cooldown: ACTIVE — last attempt was ${cd.last_outcome ?? '?'}, ~${hours}h remaining.\n` +
        `Instruction: Narrate the in-character refusal — the NPC remembers the same play and brushes it off. Do not roll. Use only narrate(done=true).`,
    };
  }

  const score = await getPlayerStat(playerId, def.ability);
  const mod = abilityMod(score);
  const roll = rollD20();
  const total = roll + mod;
  const outcome = total >= def.dc ? 'success' : 'failure';
  const label = `${socialKind} (${def.ability})`;

  await recordDicePersistence(
    session,
    playerId,
    'player',
    {d: 20, roll, modifier: mod, total, dc: def.dc, outcome, label},
    turnId,
  );
  await persistCooldown(playerId, npcId, socialKind, outcome);

  return {
    contextInjection:
      `[Pre-computed action: scripted social check]\n` +
      `Action: ${socialKind} ${npc.rows[0]!.display_name} (${def.ability} vs DC ${def.dc})\n` +
      `Roll: d20 = ${roll}, modifier = ${mod >= 0 ? '+' : ''}${mod}, total = ${total}\n` +
      `Outcome: ${outcome.toUpperCase()}\n` +
      `Instruction: The mechanic is RESOLVED. Do NOT call dice_check, dice_check, set_runtime_field, or any other tool — just narrate the consequence in-character. Use only narrate(done=true).`,
  };
}

/** item-check:302:str_shove → run an item interaction check. */
export async function scriptItemCheck(
  session: Session,
  playerId: number,
  itemId: number,
  checkKindRaw: string,
  turnId: string,
): Promise<ScriptResult | null> {
  const item = await query<{display_name: string; profile: Record<string, unknown> | null}>(
    `SELECT display_name, profile FROM entities WHERE id = $1`,
    [itemId],
  );
  if (item.rows.length === 0) return null;
  const profile = item.rows[0]!.profile;
  const c = (profile as {check?: {ability?: string; dc?: number; action?: string; on_success?: string; on_failure?: string}} | null)?.check;
  if (!c?.ability || typeof c.dc !== 'number') return null;

  const cd = await checkCooldown(playerId, itemId, checkKindRaw);
  if (cd) {
    const hours = Math.ceil(cd.remainingMs / 1000 / 60 / 60);
    return {
      onCooldown: true,
      contextInjection:
        `[Pre-computed action: scripted item check]\n` +
        `Item: ${item.rows[0]!.display_name}, action: ${c.action ?? checkKindRaw}\n` +
        `Cooldown: ACTIVE — last attempt was ${cd.last_outcome ?? '?'}, ~${hours}h remaining.\n` +
        `Instruction: Narrate the player walking up but giving up — the previous attempt is too recent. Do not roll. Use only narrate(done=true).`,
    };
  }

  const score = await getPlayerStat(playerId, c.ability);
  const mod = abilityMod(score);
  const roll = rollD20();
  const total = roll + mod;
  const outcome = total >= c.dc ? 'success' : 'failure';

  await recordDicePersistence(
    session,
    playerId,
    'player',
    {
      d: 20,
      roll,
      modifier: mod,
      total,
      dc: c.dc,
      outcome,
      label: `${c.ability} ${c.action ?? 'check'}`,
    },
    turnId,
  );
  await persistCooldown(playerId, itemId, checkKindRaw, outcome);

  const cartridgeOutcome =
    outcome === 'success' ? c.on_success ?? 'the action succeeds' : c.on_failure ?? 'the action fails';

  return {
    contextInjection:
      `[Pre-computed action: scripted item check]\n` +
      `Item: ${item.rows[0]!.display_name}, action: ${c.action ?? checkKindRaw} (${c.ability} vs DC ${c.dc})\n` +
      `Roll: d20 = ${roll}, modifier = ${mod >= 0 ? '+' : ''}${mod}, total = ${total}\n` +
      `Outcome: ${outcome.toUpperCase()} — cartridge says: "${cartridgeOutcome}"\n` +
      `Instruction: The mechanic is RESOLVED. Narrate the cartridge outcome in-character with sensory detail. Do NOT call dice_check or any other tool — only narrate(done=true).`,
  };
}

