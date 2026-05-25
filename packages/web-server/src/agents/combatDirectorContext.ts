import {query} from '../db.js';
import type {
  CombatEnvironmentItem,
  DirectorInput,
} from './combatDirectorTypes.js';

export async function buildCombatDirectorInput(args: {
  playerId: number;
  sessionId: string;
  text: string;
  language: string | null | undefined;
}): Promise<DirectorInput | null> {
  const targetName = await resolveCombatTarget(args.playerId, args.text);
  if (!targetName) return null;

  const target = await loadTargetState(targetName);
  if (!target) return null;

  const player = await loadPlayerState(args.playerId);
  if (!player) return null;

  const recentDamage = await loadRecentDamage(args.sessionId);
  const combatContext = await loadCombatContext(args.playerId);
  return {
    player_prose: args.text,
    player,
    target,
    recent_damage: recentDamage,
    ...combatContext,
    language_hint: args.language ?? null,
  };
}

async function loadCombatContext(
  playerId: number,
): Promise<Pick<DirectorInput, 'inventory' | 'environment'>> {
  const playerRow = await query<{
    current_location_id: number | string | null;
    location_name: string | null;
    location_summary: string | null;
  }>(
    `SELECT p.current_location_id,
            loc.display_name AS location_name,
            loc.summary AS location_summary
       FROM players p
       LEFT JOIN entities loc ON loc.id = p.current_location_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  const player = playerRow.rows[0];
  const currentLocationId =
    player?.current_location_id == null
      ? null
      : Number(player.current_location_id);

  const inventoryRows = await query<{
    slug: string;
    item_name: string | null;
    category: string;
    quantity: number | string;
    equipped: boolean;
    damage_die: string | null;
    damage_type: string | null;
  }>(
    `SELECT i.slug,
            COALESCE(e.display_name, i.slug) AS item_name,
            i.category,
            pi.quantity,
            pi.equipped,
            i.behaviour->>'damage_die' AS damage_die,
            i.behaviour->>'damage_type' AS damage_type
       FROM player_inventory pi
       JOIN items i ON i.id = pi.item_id
       LEFT JOIN entities e ON e.id = i.legacy_entity_id
      WHERE pi.player_id = $1
        AND pi.quantity > 0
        AND i.category IN ('weapon', 'tool')
      ORDER BY pi.equipped DESC, i.category, i.slug`,
    [playerId],
  );
  const inventoryItems = inventoryRows.rows.map(row => ({
    slug: row.slug,
    item_name: row.item_name ?? row.slug,
    category: row.category,
    quantity: Number(row.quantity) || 0,
    equipped: row.equipped,
    damage_die: row.damage_die,
    damage_type: row.damage_type,
  }));

  let itemsHere: CombatEnvironmentItem[] = [];
  let activeSurfaces: unknown[] = [];
  if (currentLocationId != null && Number.isFinite(currentLocationId)) {
    const envRows = await query<{
      id: number | string;
      display_name: string;
      kind: string;
      summary: string | null;
      count: number | string;
      slug: string | null;
      category: string | null;
    }>(
      `SELECT e.id,
              e.display_name,
              e.kind,
              e.summary,
              ie.count,
              i.slug,
              i.category
         FROM inventory_entries ie
         JOIN entities e ON e.id = ie.item_entity_id
         LEFT JOIN items i ON i.legacy_entity_id = e.id
        WHERE ie.holder_entity_id = $1
          AND ie.count > 0
        ORDER BY e.display_name
        LIMIT 20`,
      [currentLocationId],
    );
    itemsHere = envRows.rows.map(row => ({
      id: Number(row.id),
      display_name: row.display_name,
      kind: row.kind,
      summary: row.summary,
      slug: row.slug,
      category: row.category,
      count: Number(row.count) || 0,
    }));

    const surfaceRows = await query<{value: unknown}>(
      `SELECT COALESCE(rv.value, f.default_value) AS value
         FROM runtime_fields f
         LEFT JOIN runtime_values rv ON rv.field_id = f.id
        WHERE f.owner_entity_id = $1
          AND f.field_key = 'active_surfaces'
        LIMIT 1`,
      [currentLocationId],
    );
    const surfaceValue = surfaceRows.rows[0]?.value;
    if (Array.isArray(surfaceValue)) {
      activeSurfaces = surfaceValue;
    } else if (surfaceValue && typeof surfaceValue === 'object') {
      activeSurfaces = [surfaceValue];
    }
  }

  return {
    inventory: {
      equipped_weapons: inventoryItems.filter(
        item => item.category === 'weapon' && item.equipped,
      ),
      carried_weapons: inventoryItems.filter(
        item => item.category === 'weapon' && !item.equipped,
      ),
      carried_tools: inventoryItems.filter(item => item.category === 'tool'),
      unarmed_source: 'unarmed_strike',
    },
    environment: {
      location_name: player?.location_name ?? null,
      location_summary: player?.location_summary ?? null,
      items_here: itemsHere,
      active_surfaces: activeSurfaces,
    },
  };
}

async function resolveCombatTarget(
  playerId: number,
  prose: string,
): Promise<string | null> {
  const mention = prose.match(/@([\p{L}][\p{L}\p{N}_' -]+?)(?=[\s.,!?;:]|$)/u);
  if (mention) {
    const name = mention[1]!.trim();
    const r = await query<{display_name: string}>(
      `SELECT display_name FROM entities
        WHERE display_name = $1 AND kind = 'person' LIMIT 1`,
      [name],
    );
    if (r.rows.length > 0) return r.rows[0]!.display_name;
  }

  const r = await query<{display_name: string | null}>(
    `SELECT e.display_name FROM players p
       LEFT JOIN entities e ON e.id = p.dialogue_partner_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  return r.rows[0]?.display_name ?? null;
}

interface TargetState {
  name: string;
  hp: number;
  max_hp: number;
  ac?: number;
  prof?: number;
  conditions: Array<{tag: string; severity: number}>;
}

async function loadTargetState(name: string): Promise<TargetState | null> {
  const idRow = await query<{id: number; display_name: string}>(
    `SELECT id, display_name FROM entities
      WHERE display_name = $1 AND kind = 'person' LIMIT 1`,
    [name],
  );
  if (idRow.rows.length === 0) return null;
  const {id, display_name} = idRow.rows[0]!;

  const fields = await query<{
    field_key: string;
    effective_value: unknown;
  }>(
    `SELECT f.field_key,
            COALESCE(rv.value, f.default_value) AS effective_value
       FROM runtime_fields f
       LEFT JOIN runtime_values rv ON rv.field_id = f.id
      WHERE f.owner_entity_id = $1
        AND f.field_key IN ('current_hp', 'max_hp', 'armor_class', 'proficiency_bonus', 'conditions')`,
    [id],
  );
  let hp = 0;
  let max_hp = 0;
  let ac: number | undefined;
  let prof: number | undefined;
  let conditions: Array<{tag: string; severity: number}> = [];
  for (const row of fields.rows) {
    const v = row.effective_value;
    switch (row.field_key) {
      case 'current_hp':
        hp = Number(v) || 0;
        break;
      case 'max_hp':
        max_hp = Number(v) || 0;
        break;
      case 'armor_class':
        ac = Number(v) || undefined;
        break;
      case 'proficiency_bonus':
        prof = Number(v) || undefined;
        break;
      case 'conditions':
        if (Array.isArray(v)) {
          conditions = (v as Array<Record<string, unknown>>)
            .filter(c => typeof c['tag'] === 'string')
            .map(c => ({
              tag: String(c['tag']),
              severity: Number(c['severity'] ?? 1),
            }));
        }
        break;
    }
  }
  return {name: display_name, hp, max_hp, ac, prof, conditions};
}

interface PlayerState {
  id: number;
  name: string;
  hp: number;
  max_hp: number;
}

async function loadPlayerState(playerId: number): Promise<PlayerState | null> {
  const r = await query<{
    display_name: string;
    current_hp: number;
    max_hp: number;
  }>(
    `SELECT e.display_name, p.current_hp, p.max_hp
       FROM players p JOIN entities e ON e.id = p.entity_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: playerId,
    name: row.display_name,
    hp: row.current_hp,
    max_hp: row.max_hp,
  };
}

async function loadRecentDamage(
  sessionId: string,
): Promise<DirectorInput['recent_damage']> {
  const r = await query<{
    invoked_at: string;
    args: Record<string, unknown> | null;
  }>(
    `SELECT invoked_at::text AS invoked_at, args
       FROM tool_invocations
      WHERE tool_name = 'damage'
      ORDER BY invoked_at DESC
      LIMIT 10`,
    [],
  );
  void sessionId; // future: filter by session
  return r.rows.slice(0, 5).map(row => ({
    when: row.invoked_at,
    amount: Number((row.args ?? {})['amount'] ?? 0),
    target: String((row.args ?? {})['target'] ?? '?'),
  }));
}
