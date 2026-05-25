/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 137: canonical gameplay memory vocabulary. Importance is durable
// weight; salience is live recall heat.
//
// ARCH-6 — formerly `memoryKinds.ts` / `MEMORY_KINDS` / `MemoryKind`.
// Renamed to `memoryCategories.ts` / `MEMORY_CATEGORIES` /
// `MemoryCategory` so the "Kind" word is reserved for entity/quest/tool
// schema discriminators. The DB column (`memory_kind`) and the public
// tool argument (`kind: z.enum(...)`) keep their wire/storage names —
// only the internal TypeScript surface was renamed.

export const MEMORY_CATEGORIES = [
  'bond_memory',
  'quest_lesson',
  'trauma_memory',
  'promise',
  'world_fact',
  'failure_pattern',
  'desire_or_boundary',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_FAMILIES = [
  'relationship',
  'quest',
  'safety',
  'commitment',
  'world',
  'lesson',
  'preference',
] as const;

export type MemoryFamily = (typeof MEMORY_FAMILIES)[number];

const CATEGORY_TO_FAMILY: Record<MemoryCategory, MemoryFamily> = {
  bond_memory: 'relationship',
  quest_lesson: 'quest',
  trauma_memory: 'safety',
  promise: 'commitment',
  world_fact: 'world',
  failure_pattern: 'lesson',
  desire_or_boundary: 'preference',
};

const CATEGORY_ALIASES: Record<string, MemoryCategory> = {
  bond: 'bond_memory',
  relationship: 'bond_memory',
  relation: 'bond_memory',
  quest: 'quest_lesson',
  quest_memory: 'quest_lesson',
  lesson: 'quest_lesson',
  stage: 'quest_lesson',
  trauma: 'trauma_memory',
  wound: 'trauma_memory',
  harm: 'trauma_memory',
  safety: 'trauma_memory',
  debt: 'promise',
  commitment: 'promise',
  oath: 'promise',
  fact: 'world_fact',
  world: 'world_fact',
  lore: 'world_fact',
  failure: 'failure_pattern',
  failed: 'failure_pattern',
  blocked: 'failure_pattern',
  route_around: 'failure_pattern',
  desire: 'desire_or_boundary',
  boundary: 'desire_or_boundary',
  preference: 'desire_or_boundary',
};

export function memoryFamilyForCategory(category: MemoryCategory): MemoryFamily {
  return CATEGORY_TO_FAMILY[category];
}

export function normalizeMemoryCategory(value: unknown): MemoryCategory | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if ((MEMORY_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as MemoryCategory;
  }
  return CATEGORY_ALIASES[normalized];
}

export function inferMemoryCategory(input: {
  explicitCategory?: unknown;
  tags?: readonly string[];
  text?: string;
  sensitive?: boolean;
}): MemoryCategory {
  const explicit = normalizeMemoryCategory(input.explicitCategory);
  if (explicit) return explicit;

  const tags = new Set(
    (input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  );

  // X-3 — the previous fallback inspected `text` with an English-only
  // `/\b(hurt|wound|injur|threat|betray|harm)\b/` regex. That silently
  // skipped trauma classification for every non-English memory. Memories
  // are emitted by the LLM tools with structured `tags`; trust those.
  // The `input.sensitive` flag stays because tool callers pass it
  // explicitly when they already know the memory is sensitive.
  if (
    input.sensitive ||
    hasAny(tags, ['trauma', 'harm', 'wound', 'sensitive'])
  ) {
    return 'trauma_memory';
  }
  if (hasAny(tags, ['promise', 'debt', 'commitment', 'oath'])) {
    return 'promise';
  }
  if (hasAny(tags, ['quest', 'stage', 'objective', 'quest_lesson'])) {
    return 'quest_lesson';
  }
  if (hasAny(tags, ['failure', 'failed', 'blocked', 'route_around'])) {
    return 'failure_pattern';
  }
  if (hasAny(tags, ['desire', 'boundary', 'preference'])) {
    return 'desire_or_boundary';
  }
  if (hasAny(tags, ['bond', 'relationship', 'strings', 'trust'])) {
    return 'bond_memory';
  }
  return 'world_fact';
}

export function behaviorHintForFamily(family: string): string {
  switch (family) {
    case 'relationship':
      return 'Use this to keep bonds, trust, attraction, leverage, and grudges consistent.';
    case 'quest':
      return 'Use this to avoid losing quest intent, stage proof, and prior resolution lessons.';
    case 'safety':
      return 'Use this to preserve consequences of harm, fear, trauma, and danger.';
    case 'commitment':
      return 'Use this before making new bargains; unresolved promises should shape offers.';
    case 'lesson':
      return 'Use this to avoid repeating a failed route or broken assumption.';
    case 'preference':
      return 'Use this to respect desire, boundaries, tastes, and refusal patterns.';
    default:
      return 'Use this as grounded world continuity, not as a new instruction by itself.';
  }
}

export function salienceBump(before: number, bump: number): number {
  const current = clamp01(before);
  const delta = clamp01(bump);
  return clamp01(1 - (1 - current) * (1 - delta));
}

export function salienceDecay(before: number, decay: number): number {
  return clamp01(clamp01(before) * (1 - clamp01(decay)));
}

function hasAny(values: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
