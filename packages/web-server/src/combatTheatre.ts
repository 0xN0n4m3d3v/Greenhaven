/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {query} from './db.js';
import {emitGuiEventForSession} from './guiEventOutbox.js';
import type {Session} from './sessionManager.js';

export const CombatPositionSchema = z.enum(['front', 'mid', 'back']);
export type CombatPosition = z.infer<typeof CombatPositionSchema>;
export type CombatActorKind = 'player' | 'npc' | 'companion';

interface CombatTheatreState {
  encounterId: string;
  positions: Record<string, CombatPosition>;
}

type SessionWithCombatTheatre = Session & {
  combatTheatre?: CombatTheatreState;
};

export interface CombatInitiativeEntry {
  entityId: number;
  kind: CombatActorKind;
  name: string;
  initiative: number;
  position: CombatPosition;
  portraitPersonaId?: string | null;
}

export function normalizeCombatPosition(
  value: unknown,
  fallback: CombatPosition,
): CombatPosition {
  const parsed = CombatPositionSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function defaultCombatPosition(kind: CombatActorKind): CombatPosition {
  if (kind === 'player') return 'mid';
  if (kind === 'companion') return 'mid';
  return 'front';
}

export function currentCombatEncounterId(args: {
  session?: Session | null;
  sessionId: string;
  turnId?: string | null;
}): string {
  const state = (args.session as SessionWithCombatTheatre | null)?.combatTheatre;
  return state?.encounterId ?? `encounter_${args.sessionId}_${args.turnId ?? 'active'}`;
}

export function clearCombatTheatre(session: Session): void {
  delete (session as SessionWithCombatTheatre).combatTheatre;
}

export async function emitCombatInitiativeSet(args: {
  session: Session;
  playerId: number;
  turnId: string;
}): Promise<void> {
  const session = args.session as SessionWithCombatTheatre;
  const encounterId = session.combatTheatre?.encounterId ?? `encounter_${args.turnId}`;
  const entries = await buildInitiativeEntries(args.playerId, encounterId);
  if (entries.length === 0) return;

  session.combatTheatre = {
    encounterId,
    positions: Object.fromEntries(
      entries.map(entry => [String(entry.entityId), entry.position]),
    ),
  };

  await emitGuiEventForSession(
    args.session.id,
    'combat:initiative_set',
    {
      encounterId,
      turnId: args.turnId,
      order: entries,
    },
    {
      playerId: args.playerId,
      turnId: args.turnId,
      lane: 'pre_response',
      phase: 'pre_turn',
      dedupeKey: `combat:initiative_set:${encounterId}`,
    },
  );
}

export async function emitCombatPositionChanged(args: {
  session: Session | null;
  sessionId: string;
  playerId: number;
  turnId?: string | null;
  entityId: number;
  from: CombatPosition;
  to: CombatPosition;
  reason: string;
}): Promise<void> {
  if (args.from === args.to) return;
  const encounterId = currentCombatEncounterId({
    session: args.session,
    sessionId: args.sessionId,
    turnId: args.turnId,
  });
  const state = (args.session as SessionWithCombatTheatre | null)?.combatTheatre;
  if (state) state.positions[String(args.entityId)] = args.to;

  await emitGuiEventForSession(
    args.sessionId,
    'combat:position_changed',
    {
      encounterId,
      entityId: args.entityId,
      from: args.from,
      to: args.to,
      reason: args.reason,
      turnId: args.turnId ?? null,
    },
    {
      playerId: args.playerId,
      turnId: args.turnId ?? null,
      lane: 'pre_response',
      phase: 'mutation',
    },
  );
}

async function buildInitiativeEntries(
  playerId: number,
  encounterId: string,
): Promise<CombatInitiativeEntry[]> {
  const player = await query<{
    entity_id: number | string;
    display_name: string;
    persona_slug: string | null;
    metadata: unknown;
    dex: number | string | null;
  }>(
    `SELECT p.entity_id,
            e.display_name,
            e.persona_slug,
            p.metadata,
            ps.current AS dex
       FROM players p
       JOIN entities e ON e.id = p.entity_id
       LEFT JOIN player_stats ps ON ps.player_id = p.entity_id AND ps.stat_key = 'DEX'
      WHERE p.entity_id = $1`,
    [playerId],
  );
  const playerRow = player.rows[0];
  if (!playerRow) return [];

  const companionIds = readCompanionIds(playerRow.metadata);
  const npcRows = await query<{
    id: number | string;
    display_name: string;
    persona_slug: string | null;
    dex: number | string | null;
  }>(
    `SELECT DISTINCT e.id,
            e.display_name,
            e.persona_slug,
            ns.current AS dex
       FROM players p
       JOIN entities e ON e.kind = 'person'
       LEFT JOIN npc_stats ns ON ns.npc_entity_id = e.id AND ns.stat_key = 'DEX'
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
        )
      ORDER BY e.display_name, e.id
      LIMIT 12`,
    [playerId],
  );

  const entries: CombatInitiativeEntry[] = [
    initiativeEntry({
      entityId: Number(playerRow.entity_id),
      kind: 'player',
      name: playerRow.display_name,
      personaSlug: playerRow.persona_slug,
      dex: Number(playerRow.dex ?? 10),
      encounterId,
    }),
  ];

  for (const npc of npcRows.rows) {
    const entityId = Number(npc.id);
    if (!Number.isFinite(entityId) || entityId === playerId) continue;
    const kind: CombatActorKind = companionIds.has(entityId) ? 'companion' : 'npc';
    entries.push(
      initiativeEntry({
        entityId,
        kind,
        name: npc.display_name,
        personaSlug: npc.persona_slug,
        dex: Number(npc.dex ?? 10),
        encounterId,
      }),
    );
  }

  return entries.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return a.entityId - b.entityId;
  });
}

function initiativeEntry(args: {
  entityId: number;
  kind: CombatActorKind;
  name: string;
  personaSlug: string | null;
  dex: number;
  encounterId: string;
}): CombatInitiativeEntry {
  const dex = Number.isFinite(args.dex) ? args.dex : 10;
  const dexMod = Math.floor((dex - 10) / 2);
  return {
    entityId: args.entityId,
    kind: args.kind,
    name: args.name,
    initiative: deterministicD20(`${args.encounterId}:${args.entityId}`) + dexMod,
    position: defaultCombatPosition(args.kind),
    portraitPersonaId: args.personaSlug,
  };
}

function deterministicD20(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash) % 20) + 1;
}

function readCompanionIds(metadata: unknown): Set<number> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return new Set();
  }
  const companions = (metadata as Record<string, unknown>)['companions'];
  if (!Array.isArray(companions)) return new Set();
  return new Set(
    companions
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value > 0),
  );
}
