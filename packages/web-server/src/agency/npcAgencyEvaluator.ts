/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 34 — NpcAgencyEvaluator.
//
// Runs after every turn.end. For each candidate NPC in the player's
// location, computes an initiative score from runtime signals (HP,
// mood, strings, surface threats, quest hooks). If the highest-scoring
// NPC clears the threshold AND no NPC has acted in the last K turns,
// the evaluator fires a synthetic player message of the form
//   "[Mikka Quickgrin takes initiative — reason]"
// and the turn pipeline re-enters with that input.
//
// This is what turns the chat from a reactive REPL into a scene with
// people who have their own intent.

import {query} from '../db.js';
import type {Session} from '../sessionManager.js';

// Module-scoped WeakMap avoids `as unknown as` property injection on Session.
const npcInitiativeState = new WeakMap<Session, {lastTurnWasNpcInitiated: boolean}>();

function getNpcInitiativeState(session: Session): {lastTurnWasNpcInitiated: boolean} {
  let state = npcInitiativeState.get(session);
  if (!state) {
    state = {lastTurnWasNpcInitiated: false};
    npcInitiativeState.set(session, state);
  }
  return state;
}

/** Test/smoke helper: reset agency back-to-back guard for a session. */
export function clearNpcAgencyState(session: Session): void {
  npcInitiativeState.delete(session);
}

export interface NpcInitiativeIntent {
  npcId: number;
  npcName: string;
  /** Free-text reason; appended to the synthetic user message so the
   *  narrator has narrative seed for the unprompted action. */
  reason: string;
  /** 0.0 quiet to 1.0 dramatic. Drives narrator's intensity. */
  urgency: number;
  /** The score that won the evaluator pass. Logged for tuning. */
  score: number;
}

const THRESHOLD = 0.7;
const COOLDOWN_TURNS = 2;
// Hard rule from spec 34: if last turn was NPC-initiated, this turn
// is the player's by default. Prevents NPC monologue spirals.
const NO_BACK_TO_BACK_NPC = true;

interface CandidateRow {
  id: number;
  display_name: string;
  /** entities.profile.aggression — cartridge knob, default 0.5 */
  aggression: number;
  /** entities.profile.initiative_cooldown_turns — cartridge knob, default COOLDOWN_TURNS */
  cooldown: number;
  current_hp: number | null;
  max_hp: number | null;
}

interface CandidateDbRow extends Omit<CandidateRow, 'current_hp' | 'max_hp'> {
  current_hp: unknown;
  max_hp: unknown;
}

interface ScoreInputs {
  npc: CandidateRow;
  mood: string | null;
  statuses: ActorStatusSignal[];
  /** Strings from this NPC about the player. ≥|3| → strong bond, more
   *  initiative. */
  stringsToPlayer: number;
  /** Active surfaces in the scene matching the NPC's standing tile. */
  threatSurfaces: string[];
  /** Turns since the last time THIS NPC acted unprompted. */
  turnsSinceOwnInitiative: number;
  /** True if the LAST turn was NPC-initiated by ANY NPC. */
  lastTurnWasNpcInitiated: boolean;
  /** Stable 0..0.1499 liveliness nudge. Keeps replay/playtests deterministic. */
  jitter: number;
}

interface ActorStatusSignal {
  kind: string;
  value: string;
  intensity: number;
}

export async function evaluateNpcAgency(
  session: Session,
  playerId: number,
): Promise<NpcInitiativeIntent | null> {
  // Hard rule — don't fire two NPC turns back-to-back.
  if (NO_BACK_TO_BACK_NPC && getNpcInitiativeState(session).lastTurnWasNpcInitiated) {
    getNpcInitiativeState(session).lastTurnWasNpcInitiated = false;
    return null;
  }

  // 1. Find candidate NPCs in the player's location. Cartridge-authored
  //    profile.aggression (0..1) gates participation: 0 = pacifist,
  //    never fires; 1 = always fires when threshold passes.
  const playerRow = await query<{current_location_id: number | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const locationId = playerRow.rows[0]?.current_location_id;
  if (!locationId) return null;
  const companionIds = await loadCompanionIds(playerId);

  const candidates = await query<CandidateDbRow>(
    `SELECT
       e.id,
       e.display_name,
       COALESCE((e.profile->>'aggression')::float, 0.5) AS aggression,
       COALESCE((e.profile->>'initiative_cooldown_turns')::int, $2) AS cooldown,
       COALESCE(current_hp_value.value, current_hp_field.default_value) AS current_hp,
       COALESCE(max_hp_value.value, max_hp_field.default_value) AS max_hp
     FROM entities e
     LEFT JOIN runtime_fields current_hp_field
       ON current_hp_field.owner_entity_id = e.id
      AND current_hp_field.field_key = 'current_hp'
     LEFT JOIN runtime_values current_hp_value
       ON current_hp_value.field_id = current_hp_field.id
     LEFT JOIN runtime_fields max_hp_field
       ON max_hp_field.owner_entity_id = e.id
      AND max_hp_field.field_key = 'max_hp'
     LEFT JOIN runtime_values max_hp_value
       ON max_hp_value.field_id = max_hp_field.id
     WHERE e.kind = 'person'
       AND (
         COALESCE((e.profile->>'home_id')::int, 0) = $1
         OR COALESCE((e.profile->>'current_location_id')::int, 0) = $1
         OR COALESCE((e.profile->>'location_id')::int, 0) = $1
         OR e.id = ANY($3::bigint[])
       )
       AND COALESCE((e.profile->>'aggression')::float, 0.5) > 0`,
    [locationId, COOLDOWN_TURNS, companionIds],
  );
  if (candidates.rows.length === 0) return null;

  // 2. Per candidate, compute score.
  const lastTurn = await getLastTurnNumber(session.id);
  let best: NpcInitiativeIntent | null = null;

  for (const npc of candidates.rows.map(normaliseCandidateRow)) {
    const lastOwn = await getLastNpcInitiativeTurn(session.id, npc.id);
    const turnsSince = lastTurn - lastOwn;
    if (turnsSince < npc.cooldown) continue;

    const mood = await readRuntimeFieldString(npc.id, 'mood');
    const statuses = await readActorStatusSignals(playerId, npc.id);
    if (hasUnavailableStatus(statuses)) continue;
    const stringsToPlayer = await readStringsToPlayer(npc.id, playerId);
    const threatSurfaces = await readThreatSurfaces(locationId, npc.id);

    const scoreOut = scoreCandidate({
      npc,
      mood,
      statuses,
      stringsToPlayer,
      threatSurfaces,
      turnsSinceOwnInitiative: turnsSince,
      lastTurnWasNpcInitiated: false,
      jitter: stableNpcAgencyJitter(session.id, npc.id, lastTurn),
    });

    if (scoreOut.score >= THRESHOLD && (!best || scoreOut.score > best.score)) {
      best = {
        npcId: npc.id,
        npcName: npc.display_name,
        reason: scoreOut.reason,
        urgency: Math.min(1, scoreOut.score),
        score: scoreOut.score,
      };
    }
  }

  if (best) {
    // Mark this NPC as having just initiated; bump turn counter so cooldown
    // window applies to next eval.
    await markNpcInitiative(session.id, best.npcId, lastTurn + 1);
    getNpcInitiativeState(session).lastTurnWasNpcInitiated = true;
  }

  return best;
}

function normaliseCandidateRow(row: CandidateDbRow): CandidateRow {
  return {
    ...row,
    current_hp: readOptionalNumber(row.current_hp),
    max_hp: readOptionalNumber(row.max_hp),
  };
}

function readOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/^"|"$/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ── Scoring ────────────────────────────────────────────────────────────

function scoreCandidate(inputs: ScoreInputs): {score: number; reason: string} {
  const reasons: string[] = [];
  let score = 0;

  // (a) Wounded → wants to retreat / lash out / call ally.
  if (inputs.npc.current_hp != null && inputs.npc.max_hp != null && inputs.npc.max_hp > 0) {
    const fraction = inputs.npc.current_hp / inputs.npc.max_hp;
    if (fraction < 0.3) {
      score += 0.7 * (1 - fraction);
      reasons.push('wounded — needs to act');
    } else if (fraction < 0.6) {
      score += 0.3 * (1 - fraction);
      reasons.push('hurting');
    }
  }

  // (b) Hostile surface threatens this NPC's tile.
  const hostileSurfaces = inputs.threatSurfaces.filter(s =>
    ['fire', 'lava', 'electric', 'poison', 'acid', 'web'].includes(s),
  );
  if (hostileSurfaces.length > 0) {
    score += 0.5;
    reasons.push(`stuck in ${hostileSurfaces.join('+')}`);
  }

  // (c) Mood pushes toward action.
  if (inputs.mood) {
    const aroused = ['aroused', 'needy', 'flirtatious', 'desperate'].includes(inputs.mood.toLowerCase());
    const angry = ['angry', 'furious', 'wrathful', 'enraged'].includes(inputs.mood.toLowerCase());
    if (aroused) {
      score += 0.6;
      reasons.push(`mood: ${inputs.mood}`);
    } else if (angry) {
      score += 0.5;
      reasons.push(`mood: ${inputs.mood}`);
    }
  }

  // (d) Strong bond → wants to interject.
  // (c2) Player-scoped actor statuses make the status ledger behavioral,
  // not just decorative. Trust and companion ties invite initiative; fear,
  // hostility, and wounds create urgent interruptions.
  for (const status of inputs.statuses) {
    if (status.kind === 'companion' && status.value === 'following') {
      score += 0.2 * status.intensity;
      reasons.push('following companion');
    } else if (status.kind === 'trust') {
      score += 0.25 * status.intensity;
      reasons.push(`trust status: ${status.value}`);
    } else if (status.kind === 'hostile') {
      score += 0.45 * status.intensity;
      reasons.push(`hostile status: ${status.value}`);
    } else if (status.kind === 'fear') {
      score += 0.35 * status.intensity;
      reasons.push(`fear status: ${status.value}`);
    } else if (status.kind === 'wounded') {
      score += 0.3 * status.intensity;
      reasons.push(`wounded status: ${status.value}`);
    }
  }

  if (Math.abs(inputs.stringsToPlayer) >= 3) {
    score += 0.4;
    reasons.push(inputs.stringsToPlayer > 0 ? 'bonded enough to speak first' : 'bitter — stirs trouble');
  }

  // (e) Aggression knob — multiplicative bias.
  score *= 0.5 + inputs.npc.aggression;

  // (f) Stable liveliness kicker. It keeps low-score NPCs occasionally
  //     active without making replay diagnostics depend on Math.random().
  score += inputs.jitter;

  return {score, reason: reasons.join(' · ') || 'restless'};
}

function stableNpcAgencyJitter(
  sessionId: string,
  npcId: number,
  turnNumber: number,
): number {
  const input = `${sessionId}:${npcId}:${turnNumber}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1500) / 10000;
}

function hasUnavailableStatus(statuses: ActorStatusSignal[]): boolean {
  return statuses.some(
    status =>
      status.intensity > 0 &&
      (status.kind === 'dead' || status.kind === 'missing'),
  );
}

// ── DB helpers ─────────────────────────────────────────────────────────

async function getLastTurnNumber(sessionId: string): Promise<number> {
  const r = await query<{n: number | null}>(
    `SELECT MAX(turn_index)::int AS n FROM chat_messages WHERE session_id = $1`,
    [sessionId],
  );
  return r.rows[0]?.n ?? 0;
}

async function getLastNpcInitiativeTurn(sessionId: string, npcId: number): Promise<number> {
  void sessionId;
  const r = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'last_initiative_turn'`,
    [npcId],
  );
  return Number(r.rows[0]?.value ?? -COOLDOWN_TURNS - 1);
}

async function markNpcInitiative(
  sessionId: string,
  npcId: number,
  turnNumber: number,
): Promise<void> {
  void sessionId;
  await query(
    `INSERT INTO runtime_fields
       (owner_entity_id, field_key, value_type, default_value, scope, description)
     VALUES ($1, 'last_initiative_turn', 'int', '-1'::jsonb, 'session',
             'Spec 34: turn number of NPC last unprompted action')
     ON CONFLICT (owner_entity_id, field_key) DO NOTHING`,
    [npcId],
  );
  await query(
    `INSERT INTO runtime_values (field_id, value, source)
     SELECT id, $2::jsonb, 'agency'
       FROM runtime_fields rf
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'last_initiative_turn'
     ON CONFLICT (field_id) DO UPDATE SET value = EXCLUDED.value, source = 'agency', updated_at = now()`,
    [npcId, JSON.stringify(turnNumber)],
  );
}

async function readRuntimeFieldString(
  entityId: number,
  key: string,
): Promise<string | null> {
  const r = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = $2`,
    [entityId, key],
  );
  const v = r.rows[0]?.value;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) return null;
  return v != null ? String(v).replace(/^"|"$/g, '') : null;
}

async function readStringsToPlayer(
  npcId: number,
  playerId: number,
): Promise<number> {
  const r = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'strings'`,
    [npcId],
  );
  const map = r.rows[0]?.value as Record<string, unknown> | undefined;
  return Number(map?.[String(playerId)] ?? 0);
}

async function readActorStatusSignals(
  playerId: number,
  npcId: number,
): Promise<ActorStatusSignal[]> {
  const rows = await query<{
    status_kind: string;
    status_value: string;
    intensity: unknown;
  }>(
    `SELECT status_kind, status_value, intensity
       FROM actor_statuses
      WHERE player_id = $1
        AND actor_entity_id = $2
        AND intensity > 0
      ORDER BY updated_at DESC
      LIMIT 8`,
    [playerId, npcId],
  );
  return rows.rows.map(row => ({
    kind: row.status_kind,
    value: row.status_value,
    intensity: Math.max(0, Math.min(1, Number(row.intensity ?? 0))),
  }));
}

async function loadCompanionIds(playerId: number): Promise<number[]> {
  const row = await query<{companions: unknown}>(
    `SELECT metadata->'companions' AS companions
       FROM players
      WHERE entity_id = $1`,
    [playerId],
  );
  const value = row.rows[0]?.companions;
  if (!Array.isArray(value)) return [];
  return value
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && item > 0);
}

async function readThreatSurfaces(locationId: number, npcId: number): Promise<string[]> {
  const r = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'active_surfaces'`,
    [locationId],
  );
  const surfaces = r.rows[0]?.value as Array<{type?: string; affected?: number[]}> | undefined;
  if (!Array.isArray(surfaces)) return [];
  return surfaces
    .filter(s => Array.isArray(s.affected) ? s.affected.includes(npcId) : true)
    .map(s => s.type ?? '')
    .filter(s => s.length > 0);
}
