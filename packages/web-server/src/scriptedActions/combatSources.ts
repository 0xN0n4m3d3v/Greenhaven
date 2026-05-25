import type {TxClient} from '../db.js';

export interface CombatAttackSource {
  source: string;
  displayName: string;
  damageSides: number;
  damageType: string;
  kind: 'held_item' | 'unarmed';
}

export const UNARMED_ATTACK_SOURCE = 'unarmed_strike';

const DEFAULT_UNARMED_DAMAGE_SIDES = 4;
const DEFAULT_WEAPON_DAMAGE_SIDES = 6;

function behaviourString(behaviour: unknown, key: string): string | null {
  if (!behaviour || typeof behaviour !== 'object' || Array.isArray(behaviour)) {
    return null;
  }
  const value = (behaviour as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function damageSidesFromBehaviour(
  behaviour: unknown,
  fallback: number,
): number {
  const die = behaviourString(behaviour, 'damage_die');
  const match = die?.match(/^1d(\d+)$/i);
  if (!match) return fallback;
  const sides = Number(match[1]);
  return Number.isInteger(sides) && sides >= 2 && sides <= 20 ? sides : fallback;
}

function damageTypeFromBehaviour(
  behaviour: unknown,
  fallback = 'bludgeoning',
): string {
  return behaviourString(behaviour, 'damage_type') ?? fallback;
}

export async function loadPlayerAttackSource(
  client: TxClient,
  playerId: number,
): Promise<CombatAttackSource> {
  const rows = await client.query<{
    slug: string;
    item_name: string;
    category: string;
    equipped: boolean;
    behaviour: unknown;
  }>(
    `SELECT i.slug,
            COALESCE(e.display_name, i.slug) AS item_name,
            i.category,
            pi.equipped,
            i.behaviour
       FROM player_inventory pi
       JOIN items i ON i.id = pi.item_id
       LEFT JOIN entities e ON e.id = i.legacy_entity_id
      WHERE pi.player_id = $1
        AND pi.quantity > 0
        AND i.category IN ('weapon', 'tool')
      ORDER BY pi.equipped DESC,
               CASE WHEN i.category = 'weapon' THEN 0 ELSE 1 END,
               i.slug
      LIMIT 1`,
    [playerId],
  );
  const item = rows.rows[0];
  if (!item) return unarmedAttackSource();
  const fallbackSides =
    item.category === 'weapon'
      ? DEFAULT_WEAPON_DAMAGE_SIDES
      : DEFAULT_UNARMED_DAMAGE_SIDES;
  return {
    source: item.slug,
    displayName: item.item_name,
    damageSides: damageSidesFromBehaviour(item.behaviour, fallbackSides),
    damageType: damageTypeFromBehaviour(item.behaviour),
    kind: 'held_item',
  };
}

export async function loadNpcAttackSource(
  client: TxClient,
  npcId: number,
): Promise<CombatAttackSource> {
  const rows = await client.query<{
    display_name: string;
    slug: string | null;
    category: string | null;
    tags: string[] | null;
    behaviour: unknown;
  }>(
    `SELECT e.display_name,
            i.slug,
            i.category,
            e.tags,
            COALESCE(i.behaviour, '{}'::jsonb) AS behaviour
       FROM inventory_entries ie
       JOIN entities e ON e.id = ie.item_entity_id
       LEFT JOIN items i ON i.legacy_entity_id = e.id
      WHERE ie.holder_entity_id = $1
        AND ie.count > 0
      ORDER BY CASE
                 WHEN i.category = 'weapon' OR 'weapon' = ANY(e.tags) THEN 0
                 WHEN i.category = 'tool' OR 'tool' = ANY(e.tags) THEN 1
                 ELSE 2
               END,
               COALESCE(i.slug, e.display_name)`,
    [npcId],
  );
  const item = rows.rows.find(row => {
    const tags = row.tags ?? [];
    return (
      row.category === 'weapon' ||
      row.category === 'tool' ||
      tags.includes('weapon') ||
      tags.includes('tool')
    );
  });
  if (!item) return unarmedAttackSource();
  const source = item.slug ?? item.display_name;
  const fallbackSides =
    item.category === 'weapon' || (item.tags ?? []).includes('weapon')
      ? DEFAULT_WEAPON_DAMAGE_SIDES
      : DEFAULT_UNARMED_DAMAGE_SIDES;
  return {
    source,
    displayName: item.display_name,
    damageSides: damageSidesFromBehaviour(item.behaviour, fallbackSides),
    damageType: damageTypeFromBehaviour(item.behaviour),
    kind: 'held_item',
  };
}

export function unarmedAttackSource(): CombatAttackSource {
  return {
    source: UNARMED_ATTACK_SOURCE,
    displayName: UNARMED_ATTACK_SOURCE,
    damageSides: DEFAULT_UNARMED_DAMAGE_SIDES,
    damageType: 'bludgeoning',
    kind: 'unarmed',
  };
}

export function describeAttackSource(source: CombatAttackSource): string {
  return source.kind === 'unarmed'
    ? `${UNARMED_ATTACK_SOURCE} (unarmed body attack)`
    : `${source.source} (${source.displayName})`;
}
