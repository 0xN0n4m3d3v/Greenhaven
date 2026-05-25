/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Build the list of quick-action buttons the UI shows under the
// composer. Each button is one tap-to-act affordance derived from the
// CURRENT cartridge state for this player:
//
//   * item-check : every item in the player's location whose profile
//                  has a `check` block (push the crate, drag the cart,
//                  relight the lamp). Click → pre-canned player message
//                  describing the action.
//   * social     : every social_dcs entry on every NPC in the player's
//                  location (persuade/seduce/intimidate/deceive/insight).
//                  One button per (NPC, action).
//   * attack     : every NPC at the player's location that has HP +
//                  AC declared. Lets the player drop straight into
//                  combat regardless of dialogue state.
//
// The shape is intentionally language-neutral. `kind` + message_key +
// message_vars are the playable contract; labels are only display hints.
// The UI already renders the `dice-chip` "d20 · DC X" badge when
// `dice_check` is present.

import {query} from './db.js';
import {loadVisibleReachableLocations} from './locationGraph.js';

// ARCH-17 — explicit union of every affordance kind currently emitted
// by `buildAffordances`. Adding a new kind here forces the matching
// switch/branch in `BubbleMenu`, `mentions.tsx`, `actionText.ts`, and
// `isAffordanceAction` to be revisited. Social check sub-kinds vary
// per cartridge (seduce, persuade, intimidate, deceive, insight, …)
// so the social slot stays open via the `social-${string}` literal,
// which is still narrower than plain `string` and still pattern-checks
// with `kind.startsWith('social-')`.
export type AffordanceKind =
  | 'item-check'
  | 'attack'
  | 'travel'
  | 'string-spend'
  | 'quest-choice'
  | 'inspiration-spend'
  | `social-${string}`;

export interface AffordanceAction {
  id: string;
  /** The entity this action targets — used by the UI to filter the
   *  per-bubble menu to only this entity's affordances. */
  entity_id: number;
  /** Kind of action — drives UI label translation:
   *    'social-<key>'      e.g. 'social-seduce', 'social-persuade'
   *    'item-check'        a generic item interaction (push/drag/light)
   *    'attack'            start combat against an NPC
   *    'travel'            move to a location/district
   *    'string-spend'      spend a String on an NPC (Spec 18)
   *    'quest-choice'      branch a quest pending an awaiting_choice
   *    'inspiration-spend' spend Inspiration for the next exchange */
  kind: AffordanceKind;
  /** Ability score involved, if any (STR/DEX/CON/INT/WIS/CHA). */
  ability?: string;
  /** Display hint. The UI derives localized labels from kind/label_key
   *  and uses this mostly to recover @mention names. */
  label: string;
  /** Optional protocol payload for non-prose actions. Player-facing
   *  quick actions must use message_key/message_vars instead. */
  message?: string;
  label_key?: string;
  label_vars?: Record<string, string | number>;
  message_key?: string;
  message_vars?: Record<string, string | number>;
  primary: boolean;
  dice_check?: {dc: number; description: string};
  /** Cartridge-authored verb (kept for item-check actions where the
   *  exact wording was hand-written by the author). UI's localizer
   *  uses this when translating item-check labels. */
  action_verb?: string;
}

interface ProfileBlob {
  check?: {
    ability?: string;
    dc?: number;
    action?: string;
  };
  social_dcs?: Record<string, {ability?: string; dc?: number}>;
}

interface ItemRow {
  id: number;
  display_name: string;
  profile: ProfileBlob | null;
}

interface NpcRow {
  id: number;
  display_name: string;
  profile: ProfileBlob | null;
}

export async function buildAffordances(playerId: number): Promise<AffordanceAction[]> {
  // Find the player's location.
  const playerRows = await query<{current_location_id: number | null}>(
    `SELECT current_location_id FROM players WHERE entity_id = $1`,
    [playerId],
  );
  const locId = playerRows.rows[0]?.current_location_id;
  if (!locId) return [];

  const items = await query<ItemRow>(
    `SELECT e.id, e.display_name, e.profile
       FROM inventory_entries i
       JOIN entities e ON e.id = i.item_entity_id
      WHERE i.holder_entity_id = $1 AND i.count > 0
        AND e.kind = 'item'`,
    [locId],
  );
  const npcs = await query<NpcRow>(
    `SELECT id, display_name, profile
       FROM entities
      WHERE kind = 'person'
        AND (
          profile->>'home_id' = $1::text
          OR profile->>'current_location_id' = $1::text
          OR profile->>'location_id' = $1::text
        )
        AND NOT EXISTS (
          SELECT 1 FROM actor_statuses s
           WHERE s.player_id = $2
             AND s.actor_entity_id = entities.id
             AND s.intensity > 0
             AND s.status_kind IN ('dead', 'missing')
        )`,
    [locId, playerId],
  );

  // Shared movement graph: authored exits plus visible runtime
  // topology children/parents. This must match move_player reachability
  // or generated locations can exist in DB without a clickable route.
  const exits = await loadVisibleReachableLocations(locId);

  // Look up which (target, check_kind) combos are still on cooldown
  // for this player so we can suppress those buttons (or label them).
  // Fetch all cooldowns in one query, filter in JS.
  const cooldownRows = await query<{
    target_entity_id: number;
    check_kind: string;
    last_rolled_at: string;
  }>(
    `SELECT target_entity_id, check_kind, last_rolled_at
       FROM dice_check_cooldowns WHERE player_id = $1`,
    [playerId],
  );
  const COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const onCooldown = new Set<string>();
  const now = Date.now();
  for (const r of cooldownRows.rows) {
    const elapsed = now - new Date(r.last_rolled_at).getTime();
    if (elapsed < COOLDOWN_MS) {
      onCooldown.add(`${r.target_entity_id}:${r.check_kind}`);
    }
  }

  const out: AffordanceAction[] = [];

  // Item-check affordances.
  for (const it of items.rows) {
    const c = it.profile?.check;
    if (!c?.ability || typeof c.dc !== 'number') continue;
    const checkKind = `${c.ability}_${(c.action ?? 'interact').split(/\s+/)[0]}`.toLowerCase();
    if (onCooldown.has(`${it.id}:${checkKind}`)) continue;
    out.push({
      id: `item-check:${it.id}:${checkKind}`,
      entity_id: it.id,
      kind: 'item-check',
      ability: c.ability,
      label: `@${it.display_name}`,
      label_key: 'ui.actions.item_check',
      label_vars: {name: it.display_name},
      message_key: 'item.check',
      message_vars: {name: it.display_name},
      primary: false,
      dice_check: {dc: c.dc, description: `${c.ability} check`},
      action_verb: c.action,
    });
  }

  // Social affordances per NPC.
  for (const npc of npcs.rows) {
    const social = npc.profile?.social_dcs;
    if (!social) continue;
    for (const [kind, def] of Object.entries(social)) {
      if (!def?.ability || typeof def.dc !== 'number') continue;
      if (onCooldown.has(`${npc.id}:${kind}`)) continue;
      out.push({
        id: `social:${npc.id}:${kind}`,
        entity_id: npc.id,
        kind: `social-${kind}`,
        ability: def.ability,
        label: `@${npc.display_name}`,
        label_key: `ui.actions.${kind}`,
        label_vars: {name: npc.display_name},
        message_key: `social.${kind}`,
        message_vars: {name: npc.display_name},
        primary: false,
        dice_check: {dc: def.dc, description: `${def.ability} check`},
      });
    }

    // Attack affordance: NPC with HP+AC declared = a valid combat target.
    const hp = await query<{value: unknown}>(
      `SELECT COALESCE(rv.value, f.default_value) AS value
         FROM runtime_fields f
         LEFT JOIN runtime_values rv ON rv.field_id = f.id
        WHERE f.owner_entity_id = $1 AND f.field_key = 'current_hp'`,
      [npc.id],
    );
    if (hp.rows.length > 0 && Number(hp.rows[0]?.value ?? 0) > 0) {
      out.push({
        id: `attack:${npc.id}`,
        entity_id: npc.id,
        kind: 'attack',
        label: `@${npc.display_name}`,
        label_key: 'ui.actions.attack',
        label_vars: {name: npc.display_name},
        message_key: 'attack',
        message_vars: {name: npc.display_name},
        primary: false,
        // No dice_check chip — attack rolls bypass cooldown anyway and
        // the model picks the actual DC from the NPC's AC.
      });
    }
  }

  // Spec 18 — Spend String affordance. One per NPC the player has
  // ≥ 1 string on. Click → broker calls string_spend then runs the
  // social roll with +1d advantage.
  for (const npc of npcs.rows) {
    const strRow = await query<{value: unknown}>(
      `SELECT rv.value FROM runtime_values rv
         JOIN runtime_fields rf ON rf.id = rv.field_id
        WHERE rf.owner_entity_id = $1 AND rf.field_key = 'strings'`,
      [npc.id],
    );
    const v = strRow.rows[0]?.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const map = v as Record<string, number>;
    const myStrings = Number(map[String(playerId)] ?? 0);
    if (myStrings <= 0) continue;
    out.push({
      id: `string-spend:${npc.id}`,
      entity_id: npc.id,
      kind: 'string-spend',
      label: `@${npc.display_name}`,
      label_key: 'ui.actions.string_spend',
      label_vars: {name: npc.display_name, count: myStrings},
      message_key: 'string.spend',
      message_vars: {name: npc.display_name, count: myStrings},
      primary: false,
    });
  }

  // Spec 25 — quest branch-choice affordances. For every active quest
  // whose accumulated_state.awaiting_choice is true AND the current
  // stage's next_stage is `{kind:'choice', options:[...]}`, surface
  // one button per option. Picking writes accumulated_state.pending_
  // choice = target_stage_id; the engine advances on the next turn.
  const pendingChoices = await query<{
    quest_entity_id: number;
    current_stage_id: string | null;
    display_name: string;
    profile: unknown;
  }>(
    `SELECT pq.quest_entity_id, pq.current_stage_id, e.display_name, e.profile
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status = 'active'
        AND (pq.accumulated_state->>'awaiting_choice')::boolean = true`,
    [playerId],
  );
  for (const p of pendingChoices.rows) {
    const profile = (p.profile ?? {}) as Record<string, unknown>;
    const stages = Array.isArray(profile['stages'])
      ? (profile['stages'] as Array<Record<string, unknown>>)
      : [];
    const stage = stages.find(s => s['id'] === p.current_stage_id);
    const ns = stage?.['next_stage'] as Record<string, unknown> | undefined;
    if (!ns || ns['kind'] !== 'choice' || !Array.isArray(ns['options'])) continue;
    for (const opt of ns['options'] as Array<Record<string, unknown>>) {
      const label = String(opt['label'] ?? '');
      const target = String(opt['target_stage_id'] ?? '');
      if (!label || !target) continue;
      out.push({
        id: `quest-choice:${p.quest_entity_id}:${target}`,
        entity_id: p.quest_entity_id,
        kind: 'quest-choice',
        label,
        label_vars: {quest: p.display_name, choice: label},
        message_key: 'quest.choice',
        message_vars: {quest: p.display_name, choice: label},
        primary: true,
      });
    }
  }

  // Spec 33 — Spend Inspiration affordance.
  const inspRow = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'inspiration'`,
    [playerId],
  );
  const insp = Number(inspRow.rows[0]?.value ?? 0);
  if (insp > 0) {
    out.push({
      id: 'inspiration-spend',
      entity_id: playerId,
      kind: 'inspiration-spend',
      label: 'inspiration-spend',
      label_key: 'ui.actions.inspiration_spend',
      label_vars: {count: insp},
      message_key: 'inspiration.spend',
      message_vars: {count: insp},
      primary: false,
    });
  }

  // Travel affordances. One per exit. UI uses these both for the
  // travel quick-action AND for resolving @-mentions of exit names
  // into clickable buttons inside narrator prose.
  for (const ex of exits) {
    out.push({
      id: `travel:${ex.id}`,
      entity_id: ex.id,
      kind: 'travel',
      label: `@${ex.display_name}`,
      label_key: 'ui.actions.travel',
      label_vars: {name: ex.display_name},
      message_key: 'travel.location',
      message_vars: {name: ex.display_name},
      primary: false,
    });
  }

  return out;
}
