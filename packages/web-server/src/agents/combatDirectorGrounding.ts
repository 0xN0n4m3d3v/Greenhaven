import {telemetry} from '../telemetry/index.js';
import type {SpecialistContext} from './base.js';
import type {
  CombatEnvironmentItem,
  CombatInventoryItem,
  DirectorBrief,
  DirectorInput,
} from './combatDirectorTypes.js';

type GroundedSource =
  | {kind: 'equipped_weapon' | 'carried_weapon' | 'carried_tool'; item: CombatInventoryItem}
  | {kind: 'environment'; item: CombatEnvironmentItem}
  | {kind: 'unarmed'}
  | null;

export function groundCombatBriefing(
  brief: DirectorBrief,
  input: DirectorInput,
): DirectorBrief {
  const requested = brief.damage_plan.source?.trim() ?? '';
  const grounded = resolveGroundedSource(requested, input);
  const fallback = chooseFallbackSource(input);
  const source = grounded ?? fallback;
  const originalSource = requested || null;

  const damagePlan = {...brief.damage_plan};
  let sourceChanged = false;
  switch (source?.kind) {
    case 'equipped_weapon':
    case 'carried_weapon':
      sourceChanged =
        normalizeSource(originalSource ?? '') !== normalizeSource(source.item.slug);
      damagePlan.source = source.item.slug;
      damagePlan.type = source.item.damage_type ?? 'physical';
      damagePlan.amount = capDamage(
        damagePlan.amount,
        source.kind === 'equipped_weapon' ? 60 : 32,
      );
      break;
    case 'carried_tool':
      sourceChanged =
        normalizeSource(originalSource ?? '') !== normalizeSource(source.item.slug);
      damagePlan.source = source.item.slug;
      damagePlan.type = source.item.damage_type ?? 'physical';
      damagePlan.amount = capDamage(
        damagePlan.amount,
        brief.effect === 'great' ? 14 : 10,
      );
      break;
    case 'environment':
      sourceChanged =
        normalizeSource(originalSource ?? '') !==
        normalizeSource(source.item.display_name);
      damagePlan.source = source.item.display_name;
      damagePlan.type = 'physical';
      damagePlan.amount = capDamage(
        damagePlan.amount,
        brief.effect === 'great' ? 24 : 14,
      );
      break;
    case 'unarmed':
    default:
      sourceChanged = normalizeSource(originalSource ?? '') !== 'unarmed strike';
      damagePlan.source = 'unarmed_strike';
      damagePlan.type = 'bludgeoning';
      damagePlan.amount = capDamage(
        damagePlan.amount,
        brief.effect === 'great' ? 10 : 6,
      );
      break;
  }

  return {
    ...brief,
    damage_plan: damagePlan,
    conditions: filterConditionsForGroundedSource(brief.conditions ?? [], damagePlan.source),
    memory_canon: sourceChanged
      ? []
      : filterMemoryCanonForGroundedSource(brief.memory_canon, damagePlan.source),
    language: input.language_hint ?? brief.language,
  };
}

export async function recordCombatSourceGrounding(
  ctx: SpecialistContext,
  before: DirectorBrief,
  after: DirectorBrief,
): Promise<void> {
  const requested = before.damage_plan.source ?? null;
  const grounded = after.damage_plan.source ?? null;
  if (normalizeSource(requested ?? '') === normalizeSource(grounded ?? '')) {
    return;
  }
  telemetry.record({
    channel: 'performance',
    name: 'source_grounding.rewritten',
    sessionId: ctx.sessionId,
    playerId: ctx.playerId,
    turnId: ctx.turnId,
    kind: 'agent',
    phase: 'source_grounding.rewritten',
    status: 'ok',
    metadata: {
      agent: 'combat_director',
      guard: 'combat_source_grounding',
      requested_source: requested,
      grounded_source: grounded,
      damage_type: after.damage_plan.type ?? null,
      target: after.damage_plan.target,
    },
  });
}

function resolveGroundedSource(
  requestedSource: string,
  input: DirectorInput,
): GroundedSource {
  const source = normalizeSource(requestedSource);
  if (!source || source === 'unarmed strike') return {kind: 'unarmed'};

  const equipped = matchInventoryItem(source, input.inventory.equipped_weapons);
  if (equipped) return {kind: 'equipped_weapon', item: equipped};

  const carriedWeapon = matchInventoryItem(source, input.inventory.carried_weapons);
  if (carriedWeapon && proseMentionsItem(input.player_prose, carriedWeapon, source)) {
    return {kind: 'carried_weapon', item: carriedWeapon};
  }

  const carriedTool = matchInventoryItem(source, input.inventory.carried_tools);
  if (carriedTool && proseMentionsItem(input.player_prose, carriedTool, source)) {
    return {kind: 'carried_tool', item: carriedTool};
  }

  const environment = matchEnvironmentItem(source, input.environment.items_here);
  if (
    environment &&
    proseMentionsEnvironmentItem(input.player_prose, environment, source)
  ) {
    return {kind: 'environment', item: environment};
  }

  return null;
}

function chooseFallbackSource(input: DirectorInput): GroundedSource {
  const equipped = input.inventory.equipped_weapons[0];
  if (equipped) return {kind: 'equipped_weapon', item: equipped};
  return {kind: 'unarmed'};
}

function matchInventoryItem(
  source: string,
  items: CombatInventoryItem[],
): CombatInventoryItem | null {
  for (const item of items) {
    const slug = normalizeSource(item.slug);
    const name = normalizeSource(item.item_name);
    if (source === slug || source === name) {
      return item;
    }
  }
  return null;
}

function matchEnvironmentItem(
  source: string,
  items: CombatEnvironmentItem[],
): CombatEnvironmentItem | null {
  for (const item of items) {
    const name = normalizeSource(item.display_name);
    const slug = normalizeSource(item.slug ?? '');
    if (source === name || source === slug) {
      return item;
    }
  }
  return null;
}

function proseMentionsItem(
  prose: string,
  item: CombatInventoryItem,
  requestedSource: string,
): boolean {
  const text = normalizeSource(prose);
  const names = [requestedSource, item.slug, item.item_name]
    .map(normalizeSource)
    .filter(name => name.length >= 3);
  return names.some(name => text.includes(name));
}

function proseMentionsEnvironmentItem(
  prose: string,
  item: CombatEnvironmentItem,
  requestedSource: string,
): boolean {
  const text = normalizeSource(prose);
  const names = [requestedSource, item.display_name, item.slug ?? '']
    .map(normalizeSource)
    .filter(name => name.length >= 3);
  return names.some(name => text.includes(name));
}

function normalizeSource(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/["'`]/g, '')
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}

function capDamage(amount: number, max: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.min(Math.trunc(amount), max));
}

function filterConditionsForGroundedSource(
  conditions: NonNullable<DirectorBrief['conditions']>,
  source: string | undefined,
): NonNullable<DirectorBrief['conditions']> {
  if (source !== 'unarmed_strike') return conditions;
  const blocked = new Set(['bleeding', 'burning', 'dying']);
  return conditions.filter(condition => !blocked.has(condition.tag));
}

function filterMemoryCanonForGroundedSource(
  memories: DirectorBrief['memory_canon'],
  source: string | undefined,
): DirectorBrief['memory_canon'] {
  if (!source) return [];
  return memories.filter(memory => memory.tags.includes(source));
}
