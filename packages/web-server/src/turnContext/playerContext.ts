import {query} from '../db.js';

export interface PlayerSnapshot {
  entity_id: number;
  display_name: string;
  current_xp: number;
  current_level: number;
  current_hp: number;
  max_hp: number;
  current_location_id: number | null;
  current_scene_id: number | null;
  dialogue_partner_id: number | null;
}

interface InventoryRow {
  display_name: string;
  count: number;
}

interface HeroStatusRow {
  status_kind: string;
  status_value: string;
  intensity: number | string | null;
}

export async function renderPlayerSnapshot(
  player: PlayerSnapshot,
): Promise<string> {
  const inv = await query<InventoryRow>(
    `SELECT e.display_name, i.count
       FROM inventory_entries i
       JOIN entities e ON e.id = i.item_entity_id
      WHERE i.holder_entity_id = $1 AND i.count > 0`,
    [player.entity_id],
  );
  const stats = await query<{stat_key: string; current: number}>(
    `SELECT stat_key, current FROM player_stats WHERE player_id = $1
      ORDER BY CASE stat_key
        WHEN 'STR' THEN 1 WHEN 'DEX' THEN 2 WHEN 'CON' THEN 3
        WHEN 'INT' THEN 4 WHEN 'WIS' THEN 5 WHEN 'CHA' THEN 6 ELSE 7 END`,
    [player.entity_id],
  );
  const statsList = stats.rows.map(s => ({
    stat: s.stat_key,
    cur: s.current,
    mod: Math.floor((s.current - 10) / 2),
  }));
  const dex = statsList.find(s => s.stat === 'DEX');
  const ac = dex ? 10 + dex.mod : 10;
  const profBonus = 2 + Math.floor(Math.max(0, player.current_level - 1) / 4);

  const profileEnt = await query<{profile: unknown}>(
    `SELECT profile FROM entities WHERE id = $1`,
    [player.entity_id],
  );
  const playerProfile = (profileEnt.rows[0]?.profile ?? {}) as Record<
    string,
    unknown
  >;
  const idProf = (playerProfile['identity'] ?? {}) as Record<string, unknown>;
  const phProf = (playerProfile['physical'] ?? {}) as Record<string, unknown>;
  const bgProf = (playerProfile['background'] ?? {}) as Record<string, unknown>;

  const lines: string[] = [
    '## PLAYER',
    `**${player.display_name}** (id ${player.entity_id})  ` +
      `lvl ${player.current_level}, ${player.current_xp} XP, hp ${player.current_hp}/${player.max_hp}, AC ${ac}, prof +${profBonus}`,
  ];
  if (typeof idProf['pronouns'] === 'string')
    lines.push(`- Pronouns: ${idProf['pronouns']}`);
  if (typeof idProf['race'] === 'string')
    lines.push(`- Race/species: ${idProf['race']}`);
  if (typeof idProf['gender_expression'] === 'string')
    lines.push(`- Gender expression: ${idProf['gender_expression']}`);
  if (typeof idProf['anatomy'] === 'string')
    lines.push(`- Anatomy: ${idProf['anatomy']}`);
  if (typeof idProf['attractions'] === 'string')
    lines.push(`- Attractions: ${idProf['attractions']}`);
  if (typeof idProf['age'] === 'number')
    lines.push(`- Age: ${idProf['age']}`);
  const physBits = [
    phProf['build'],
    phProf['skin'],
    phProf['hair'],
    phProf['eyes'],
    phProf['distinguishing_marks'],
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (physBits.length > 0) lines.push(`- Body: ${physBits.join('; ')}`);
  if (typeof phProf['voice'] === 'string')
    lines.push(`- Voice: ${phProf['voice']}`);
  if (typeof bgProf['origin_paragraph'] === 'string') {
    const t = bgProf['origin_paragraph'] as string;
    lines.push(`- Background: ${t.length > 320 ? t.slice(0, 317) + '...' : t}`);
  }
  if (typeof bgProf['cartridge_prompt'] === 'string') {
    const t = bgProf['cartridge_prompt'] as string;
    lines.push(
      `- Cartridge backstory directive: ${t.length > 500 ? t.slice(0, 497) + '...' : t}`,
    );
  }
  if (typeof bgProf['motivation'] === 'string')
    lines.push(`- Motivation: ${bgProf['motivation']}`);
  if (typeof bgProf['temperament'] === 'string')
    lines.push(`- Temperament: ${bgProf['temperament']}`);
  if (Array.isArray(bgProf['notable_skills'])) {
    const skills = (bgProf['notable_skills'] as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    );
    if (skills.length > 0) lines.push(`- Notable: ${skills.join(', ')}`);
  }

  const profSkillRows = await query<{skill_name: string}>(
    `SELECT skill_name FROM player_proficient_skills WHERE player_id = $1`,
    [player.entity_id],
  );
  if (profSkillRows.rows.length > 0) {
    const names = profSkillRows.rows.map(r => r.skill_name).join(', ');
    lines.push(`- Skills (proficient, +2 prof): ${names}`);
  }

  const inspRow = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'inspiration'`,
    [player.entity_id],
  );
  const inspiration = Number(inspRow.rows[0]?.value ?? 0);
  if (inspiration > 0) {
    lines.push(`- INSPIRATION: ${inspiration}/3`);
  }
  if (statsList.length > 0) {
    lines.push(
      'Stats: ' +
        statsList
          .map(s => `${s.stat} ${s.cur} (${s.mod >= 0 ? '+' : ''}${s.mod})`)
          .join(', '),
    );
  }
  const heroStatuses = await query<HeroStatusRow>(
    `SELECT status_kind, status_value, intensity
       FROM actor_statuses
      WHERE player_id = $1
        AND actor_entity_id = $1
      ORDER BY updated_at DESC, status_kind ASC
      LIMIT 8`,
    [player.entity_id],
  );
  if (heroStatuses.rows.length > 0) {
    lines.push(
      'Hero statuses: ' +
        heroStatuses.rows
          .map(row => {
            const intensity = Number(row.intensity ?? 0);
            const suffix = Number.isFinite(intensity)
              ? ` (${intensity.toFixed(2)})`
              : '';
            return `${row.status_kind}=${row.status_value}${suffix}`;
          })
          .join(', '),
    );
  }
  const cartridgeDirectives = Array.isArray(playerProfile['cartridge_directives'])
    ? (playerProfile['cartridge_directives'] as unknown[])
    : [];
  if (cartridgeDirectives.length > 0) {
    lines.push('Cartridge directives:');
    for (const item of cartridgeDirectives.slice(-5)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const type = typeof row['type'] === 'string' ? row['type'] : 'hero/profile';
      const prompt = typeof row['prompt'] === 'string' ? row['prompt'] : '';
      if (!prompt) continue;
      lines.push(`  - ${type}: ${prompt.slice(0, 500)}`);
    }
  }
  if (inv.rows.length > 0) {
    lines.push('Inventory:');
    for (const row of inv.rows) {
      lines.push(`  - ${row.display_name}${row.count > 1 ? ` x${row.count}` : ''}`);
    }
  }

  const traumaRow = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'trauma'`,
    [player.entity_id],
  );
  const traumas = Array.isArray(traumaRow.rows[0]?.value)
    ? (traumaRow.rows[0]!.value as unknown[]).filter(
        (t): t is string => typeof t === 'string',
      )
    : [];
  if (traumas.length > 0) {
    lines.push(`Trauma (${traumas.length}/4): ${traumas.join(', ')}`);
  }

  const combatRow = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'combat_state'`,
    [player.entity_id],
  );
  const combatState = String(combatRow.rows[0]?.value ?? '"active"').replace(
    /"/g,
    '',
  );
  if (combatState && combatState !== 'active') {
    const succRow = await query<{value: unknown}>(
      `SELECT rv.value FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = 'death_save_successes'`,
      [player.entity_id],
    );
    const failRow = await query<{value: unknown}>(
      `SELECT rv.value FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = 'death_save_failures'`,
      [player.entity_id],
    );
    const succ = Number(succRow.rows[0]?.value ?? 0);
    const fail = Number(failRow.rows[0]?.value ?? 0);
    if (combatState === 'downed') {
      lines.push(`- COMBAT: DOWNED - death saves ${succ} ok / ${fail} fail`);
    } else {
      lines.push(`- COMBAT: ${combatState.toUpperCase()}`);
    }
  }

  return lines.join('\n');
}
