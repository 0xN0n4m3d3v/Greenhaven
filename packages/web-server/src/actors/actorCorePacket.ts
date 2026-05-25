/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 138: compact actor packet. This reads existing Greenhaven state and
// never creates a second persona or memory store.

import {query} from '../db.js';
import {
  behaviorHintForFamily,
  selectActorMemoryFamilies,
  selectActorPromiseMemories,
  type ActorMemoryFamilyRow,
  type MemoryFamily,
} from '../domain/memory/index.js';
import {getEntityRuntimeContext} from '../tools/runtimeContext.js';

export type ActorRoleInScene =
  | 'player'
  | 'focused_npc'
  | 'nearby_npc'
  | 'quest_giver'
  | 'companion'
  | 'antagonist'
  | 'location'
  | 'item';

export interface ActorCorePacket {
  actorId: number;
  actorName: string;
  kind: string;
  roleInScene: ActorRoleInScene;
  profile: {
    summary?: string;
    speechStyle?: string;
    persona?: string;
    keyTraits: string[];
  };
  relationship: {
    strings?: number;
    band?: string;
    activePromises: string[];
    openDebts: string[];
  };
  memoryFamilies: Array<{
    family: string;
    count: number;
    topMemoryIds: number[];
    behaviorHint: string;
  }>;
  runtime: Array<{
    fieldKey: string;
    value: unknown;
    source: 'global' | 'player_overlay' | 'default';
  }>;
  constraints: string[];
  warnings: string[];
}

interface EntityRow {
  id: number;
  kind: string;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown> | null;
  tags: string[] | null;
}

type MemoryFamilyRow = ActorMemoryFamilyRow & {
  memory_family: MemoryFamily | string | null;
};

const MAX_FAMILIES = 6;
const MAX_MEMORY_IDS_PER_FAMILY = 3;
const MAX_RUNTIME_FIELDS = 5;
const MAX_FOCUSED_RUNTIME_FIELDS = 10;
const MAX_RELATIONSHIP_FACTS = 4;
const MAX_CONSTRAINTS = 6;

export async function buildActorCorePacket(args: {
  actorId: number;
  playerId: number;
  roleInScene?: ActorRoleInScene;
  focused?: boolean;
}): Promise<ActorCorePacket | null> {
  const entity = await loadEntity(args.actorId);
  if (!entity) return null;

  const profile = entity.profile ?? {};
  const memories = await loadMemoryFamilies(entity.id, args.playerId);
  const relationship = await loadRelationshipSlice(entity.id, args.playerId);
  const runtime = await loadRuntimeSlice(
    entity.id,
    args.playerId,
    args.focused === true,
  );

  const warnings: string[] = [];
  if (memories.length === 0 && entity.kind === 'person') {
    warnings.push('no memory-family signal for this actor');
  }
  if (!profile['persona'] && !profile['speech_style'] && entity.kind === 'person') {
    warnings.push('actor profile has no persona/speech_style');
  }

  return {
    actorId: entity.id,
    actorName: entity.display_name,
    kind: entity.kind,
    roleInScene: args.roleInScene ?? inferRole(entity.kind, args.actorId, args.playerId),
    profile: {
      summary: trimText(entity.summary ?? stringField(profile['summary']), 220),
      speechStyle: trimText(stringField(profile['speech_style']), 180),
      persona: trimText(stringField(profile['persona']), 240),
      keyTraits: keyTraits(profile, entity.tags ?? []),
    },
    relationship,
    memoryFamilies: memories,
    runtime,
    constraints: constraintsFromProfile(profile).slice(0, MAX_CONSTRAINTS),
    warnings: warnings.slice(0, MAX_CONSTRAINTS),
  };
}

export function renderActorCorePacket(packet: ActorCorePacket): string {
  const lines = [
    `## ACTOR CORE: ${packet.actorName} (${packet.kind}, ${packet.roleInScene}, id ${packet.actorId})`,
  ];
  if (packet.profile.summary) lines.push(`- Summary: ${packet.profile.summary}`);
  if (packet.profile.speechStyle) {
    lines.push(`- Speech: ${packet.profile.speechStyle}`);
  }
  if (packet.profile.persona) lines.push(`- Persona: ${packet.profile.persona}`);
  if (packet.profile.keyTraits.length > 0) {
    lines.push(`- Traits: ${packet.profile.keyTraits.join(', ')}`);
  }
  if (packet.relationship.strings != null || packet.relationship.band) {
    lines.push(
      `- Relationship: strings=${packet.relationship.strings ?? 'n/a'}${packet.relationship.band ? ` (${packet.relationship.band})` : ''}`,
    );
  }
  if (packet.relationship.activePromises.length > 0) {
    lines.push(`- Promises: ${packet.relationship.activePromises.join(', ')}`);
  }
  if (packet.memoryFamilies.length > 0) {
    lines.push('- Memory families:');
    for (const family of packet.memoryFamilies) {
      lines.push(
        `  - ${family.family}: ${family.count} memories; top ids ${family.topMemoryIds.join(', ')}; ${family.behaviorHint}`,
      );
    }
  }
  if (packet.runtime.length > 0) {
    lines.push(
      `- Runtime: ${packet.runtime
        .map(field => `${field.fieldKey}=${formatValue(field.value)} [${field.source}]`)
        .join('; ')}`,
    );
  }
  if (packet.constraints.length > 0) {
    lines.push(`- Constraints: ${packet.constraints.join(' | ')}`);
  }
  if (packet.warnings.length > 0) {
    lines.push(`- Warnings: ${packet.warnings.join(' | ')}`);
  }
  return lines.join('\n');
}

async function loadEntity(id: number): Promise<EntityRow | null> {
  const rows = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags
       FROM entities
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return rows.rows[0] ?? null;
}

async function loadMemoryFamilies(
  actorId: number,
  playerId: number,
): Promise<ActorCorePacket['memoryFamilies']> {
  const rows: MemoryFamilyRow[] = await selectActorMemoryFamilies({
    ownerEntityId: actorId,
    aboutEntityId: playerId,
    limit: 48,
  });
  const grouped = new Map<string, {count: number; topMemoryIds: number[]}>();
  for (const row of rows) {
    const family = row.memory_family ?? fallbackFamily(row.memory_kind);
    const current = grouped.get(family) ?? {count: 0, topMemoryIds: []};
    current.count += 1;
    if (current.topMemoryIds.length < MAX_MEMORY_IDS_PER_FAMILY) {
      current.topMemoryIds.push(Number(row.id));
    }
    grouped.set(family, current);
  }
  return [...grouped.entries()].slice(0, MAX_FAMILIES).map(([family, data]) => ({
    family,
    count: data.count,
    topMemoryIds: data.topMemoryIds,
    behaviorHint: behaviorHintForFamily(family),
  }));
}

async function loadRelationshipSlice(
  actorId: number,
  playerId: number,
): Promise<ActorCorePacket['relationship']> {
  const ctx = await getEntityRuntimeContext(actorId, playerId);
  const stringsField = ctx.runtime_fields.find(field => field.field_key === 'strings');
  const strings = readStringsForPlayer(stringsField?.value, playerId);
  const promises = await selectActorPromiseMemories({
    ownerEntityId: actorId,
    aboutEntityId: playerId,
    limit: MAX_RELATIONSHIP_FACTS,
  });
  return {
    strings,
    band: stringsBand(strings),
    activePromises: promises
      .filter(row => !(row.tags ?? []).includes('resolved'))
      .map(row => `#${row.id}`)
      .slice(0, MAX_RELATIONSHIP_FACTS),
    openDebts: promises
      .filter(row => (row.tags ?? []).includes('debt'))
      .map(row => `#${row.id}`)
      .slice(0, MAX_RELATIONSHIP_FACTS),
  };
}

async function loadRuntimeSlice(
  actorId: number,
  playerId: number,
  focused: boolean,
): Promise<ActorCorePacket['runtime']> {
  const max = focused ? MAX_FOCUSED_RUNTIME_FIELDS : MAX_RUNTIME_FIELDS;
  const ctx = await getEntityRuntimeContext(actorId, playerId);
  return ctx.runtime_fields.slice(0, max).map(field => ({
    fieldKey: field.field_key,
    value: field.value,
    source: field.source === 'overlay' ? 'player_overlay' : field.source,
  }));
}

function keyTraits(
  profile: Record<string, unknown>,
  tags: readonly string[],
): string[] {
  const rawTraits = [
    ...arrayOfStrings(profile['traits']),
    ...arrayOfStrings(profile['key_traits']),
    ...tags,
  ];
  return [...new Set(rawTraits.map(tag => tag.trim()).filter(Boolean))]
    .slice(0, 8)
    .map(tag => trimText(tag, 48))
    .filter((tag): tag is string => Boolean(tag));
}

function constraintsFromProfile(profile: Record<string, unknown>): string[] {
  return [
    ...arrayOfStrings(profile['constraints']),
    ...arrayOfStrings(profile['hard_rules']),
    ...arrayOfStrings(profile['model_instructions']).slice(0, 4),
  ]
    .map(item => trimText(item, 180))
    .filter((item): item is string => Boolean(item));
}

function readStringsForPlayer(value: unknown, playerId: number): number | undefined {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record[String(playerId)] ?? record[playerId];
  const n = Number(direct);
  return Number.isFinite(n) ? n : undefined;
}

function stringsBand(value: number | undefined): string | undefined {
  if (value == null) return undefined;
  if (value <= -3) return 'hostile';
  if (value < 0) return 'strained';
  if (value === 0) return 'neutral';
  if (value < 3) return 'warm';
  return 'trusted';
}

function inferRole(kind: string, actorId: number, playerId: number): ActorRoleInScene {
  if (actorId === playerId || kind === 'player') return 'player';
  if (kind === 'location') return 'location';
  if (kind === 'item') return 'item';
  return 'nearby_npc';
}

function fallbackFamily(kind: string | null): string {
  if (kind === 'promise') return 'commitment';
  if (kind === 'trauma_memory') return 'safety';
  if (kind === 'failure_pattern') return 'lesson';
  if (kind === 'quest_lesson') return 'quest';
  if (kind === 'bond_memory') return 'relationship';
  if (kind === 'desire_or_boundary') return 'preference';
  return 'world';
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function trimText(value: string | undefined | null, max: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return trimText(value, 80) ?? '';
  const encoded = JSON.stringify(value);
  return trimText(encoded, 80) ?? String(value);
}
