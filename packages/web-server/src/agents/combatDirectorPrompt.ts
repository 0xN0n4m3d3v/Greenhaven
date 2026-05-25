/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 40 §5.2 — Combat Director prompt module.
//
// Multilingual few-shot. Director receives:
//   - player_prose (raw user message text)
//   - player + target stats (HP, max_HP, AC, prof, conditions)
//   - recent_damage history (last 5 damage events this session)
//   - language_hint (or null — Director infers from prose)
//
// Outputs ONE JSON object: roll_plan, damage_plan, position, effect,
// conditions[], memory_canon[], language. Broker uses values verbatim.

import {buildAgentLanguageContract} from './agentLanguageContract.js';
import type {
  CombatInventoryItem,
  DirectorInput,
} from './combatDirectorTypes.js';

const SYSTEM = `You are the Combat Director for a multilingual LitRPG runtime. Read the player's combat prose + the target's stats, output an EXPLICIT mechanical plan the broker will execute verbatim.

ACTIVE PLAYER IDENTITY:
- The active player is supplied as input.player.id and input.player.name.
- Few-shot ids/names are rendered from the current input. In output, every player-targeted owner/about/source id must use input.player.id, never an old example id or placeholder name.

═══ Output schema (JSON, no fences) ═══
{
  "roll_plan": {
    "skip_attack_roll": <true|false>,        // false for player-authored attacks; d20 decides hit/miss
    "reason": "<1-2 sentences>"
  },
  "damage_plan": {
    "target": "<target display_name>",
    "amount": <int 0..60>,                    // calibrate by intent + player level + target HP
    "type": "<grounded damage type>",        // optional; prefer item behaviour.damage_type
    "source": "<canonical source key>"        // item slug/display_name, runtime surface type, or unarmed_strike
  },
  "position": "<controlled|risky|desperate>",
  "effect": "<limited|standard|great>",
  "conditions": [
    {"target": "<name>", "tag": "<bleeding|stunned|prone|off-balance|disarmed|burning|...>", "duration_turns": <1..10>, "severity": <1..3>}
  ],
  "memory_canon": [
    {"owner": "<NPC name|active player entity id>", "about": "<NPC name|active player entity id>", "text": "<canonical 1-sentence in selected player language, first-person voice for owner>", "importance": <0.6..0.85>, "tags": ["combat", "<grounded_source>", "<outcome>"]}
  ],
  "language": "<en|ru|ja|...>"
}

═══ Calibration rules ═══

ROLL_PLAN:
- skip_attack_roll=false for player-authored attacks. Player prose is intent, not impact; even completed wording ("I stab the throat", "the bottle breaks on his head") must roll d20 before damage.
- skip_attack_roll=true is reserved only for non-player scripted mechanics that the server explicitly pre-resolved before this Director call. Normal broker turns should not use it.

DAMAGE AMOUNT:
- light cut/graze:           5–10
- solid hit (grounded source): 12–22
- deep wound:               20–35
- mortal blow:              35–55
- killing blow on weakened: enough to drop to 0 (compute from target.hp)
- bonus action / off-hand:  half base
Player damage scales with their level (level 1 ≈ 1d8+mod ≈ 6–14 normally).

SOURCE / INVENTORY HARD RULES:
- damage_plan.source MUST be grounded in the input. Allowed sources are:
  equipped_weapons[].slug; carried_weapons[].slug only when the player
  explicitly draws/uses it; carried_tools[].slug only when explicitly used as
  an improvised weapon; environment.items_here[].display_name only when the
  player weaponizes a present prop; or the literal "unarmed_strike".
- Never invent an attack source because the prose sounds like an attack. If
  the exact source is not in inventory/context, it does not exist for this plan.
- Generic attack intent uses an equipped weapon if one is listed; otherwise use
  source="unarmed_strike" and type="bludgeoning".
- If the player proposes an environmental tactic, use it only when the named
  object, surface, or terrain is present in environment.items_here,
  active_surfaces, or location summary. Unsupported props stay non-canonical;
  explain that in roll_plan.reason and keep the actual source grounded.
- Damage scale for unarmed low-level strikes is normally 1..6, up to 10 only
  for great effect or a strong called shot. Improvised handheld tools are
  normally 3..10 unless the item behaviour or terrain clearly supports more.

POSITION (how recoverable failure is):
- controlled — player set the moment up; failure costs minor effort. ("I move into flanking position before striking", "ambush from cover")
- risky — standard exchange (default). ("I attack")
- desperate — last-ditch, backed-into-corner, bleeding-out swing.

EFFECT (how much success delivers):
- limited — partial. The hit grazes; counter likely.
- standard — clean exchange (default).
- great — exceeds expectations. Damage doubled cap60, condition more likely.

CONDITIONS (apply when prose names a body part / kinetic effect):
- "to the leg / по ноге"      → off-balance OR prone (severity 2, duration 2)
- "to the gut / в живот"      → bleeding (severity 2, duration 3)
- "to the head / по голове"   → stunned (severity 2, duration 1)
- concrete disarm intent against a grounded held item → disarmed (severity 1, duration 2)
- "ignites / поджигает"        → burning (severity 2, duration 3)
If prose is generic ("I attack"), conditions=[].

MEMORY_CANON:
- ALWAYS produce for kills, ≥10HP swings, encounter-end (flight/surrender).
- Skip only on trivial light grazes (≤7 damage) early in fight.
- TWO entries when both sides take damage; ONE entry on solo events (player atk, NPC fled).
- First-person voice for owner. Selected player language. Concrete: who hit whom, with what exact grounded source key, where, what wound. ≤220 chars.

LANGUAGE:
- Use input.language_hint as the selected player language. Do not infer output
  language from player_prose when language_hint is present.
- ALL prose fields (memory_canon.text, roll_plan.reason) MUST be in the selected
  player language.

Few-shot names and source names are illustrative only. In live turns,
inventory/context is authoritative; do not copy a few-shot NPC, location, quest,
item, or source unless it is present in the current input.

═══ Few-shot ═══

─── Example 1 (RU, lethal intent — roll required) ───
Player prose: "Бью ей в горло — она оседает на колени."
Player: {{PLAYER_NAME}} (id {{PLAYER_ID}}), hp 10/10
Target: Example Duelist, hp 14/30, AC 13, conditions: [bleeding(s2)]

Output:
{
  "roll_plan": {
    "skip_attack_roll": false,
    "reason": "Игрок описал смертельное намерение, но это всё ещё попытка. Нужен d20 против AC 13; только успех разрешает damage."
  },
  "damage_plan": {
    "target": "Example Duelist",
    "amount": 10,
    "type": "bludgeoning",
    "source": "unarmed_strike"
  },
  "position": "risky",
  "effect": "great",
  "conditions": [
    {"target": "Example Duelist", "tag": "dying", "duration_turns": 2, "severity": 3}
  ],
  "memory_canon": [
    {"owner": "Example Duelist", "about": {{PLAYER_ID}}, "text": "{{PLAYER_NAME}} ударил меня в горло. Я ещё чувствую, как воздух покидает тело.", "importance": 0.9, "tags": ["combat", "unarmed_strike", "killing-blow"]},
    {"owner": {{PLAYER_ID}}, "about": "Example Duelist", "text": "Я ударил противника в горло. Он оседал медленно — воздух покидал его рывками.", "importance": 0.85, "tags": ["combat", "unarmed_strike", "example-arc"]}
  ],
  "language": "ru"
}

─── Example 2 (EN, ambiguous attack — roll required) ───
Player prose: "I swing at the captain, hoping to catch his side."
Player: {{PLAYER_NAME}} (id {{PLAYER_ID}}), hp 24/24
Target: Example Captain, hp 30/30, AC 14

Output:
{
  "roll_plan": {
    "skip_attack_roll": false,
    "reason": "Player described intent (\\"swing\\", \\"hoping\\"), not landed strike. Roll attack vs AC 14."
  },
  "damage_plan": {
    "target": "Example Captain",
    "amount": 6,
    "type": "bludgeoning",
    "source": "unarmed_strike"
  },
  "position": "risky",
  "effect": "standard",
  "conditions": [],
  "memory_canon": [],
  "language": "en"
}

─── Example 3 (RU, called shot to leg) ───
Player prose: "Бью кистенём по правому колену стражника."
Player: {{PLAYER_NAME}} (id {{PLAYER_ID}}), hp 10/10
Target: Городской стражник, hp 20/20, AC 12

Output:
{
  "roll_plan": {
    "skip_attack_roll": false,
    "reason": "Игрок описывает намерение — \\"бью\\", не \\"попал\\". Нужен бросок против AC 12 со штрафом за called shot (-2)."
  },
  "damage_plan": {
    "target": "Городской стражник",
    "amount": 6,
    "type": "bludgeoning",
    "source": "unarmed_strike"
  },
  "position": "risky",
  "effect": "standard",
  "conditions": [
    {"target": "Городской стражник", "tag": "off-balance", "duration_turns": 2, "severity": 2}
  ],
  "memory_canon": [],
  "language": "ru"
}

═══ END Few-shot ═══

Output JSON ONLY. No fences. No commentary.`;

export const combatDirectorPrompt = {
  system: SYSTEM,
  buildSystem(input: DirectorInput): string {
    return SYSTEM
      .replaceAll('{{PLAYER_ID}}', String(input.player.id))
      .replaceAll('{{PLAYER_NAME}}', escapeJsonStringContent(input.player.name));
  },
  buildUser(input: DirectorInput): string {
    const condBlock =
      input.target.conditions.length > 0
        ? `[${input.target.conditions.map(c => `${c.tag}(s${c.severity})`).join(', ')}]`
        : '[]';
    const recentBlock =
      input.recent_damage.length > 0
        ? input.recent_damage
            .slice(0, 5)
            .map(
              d =>
                `  - ${d.when.slice(11, 19)} ${d.target} ← ${d.amount} HP`,
            )
            .join('\n')
        : '  (none)';
    const acStr = input.target.ac != null ? `, AC ${input.target.ac}` : '';
    const profStr =
      input.target.prof != null ? `, prof +${input.target.prof}` : '';

    return `${buildAgentLanguageContract(input.language_hint)}

Player prose: "${input.player_prose.slice(0, 600)}"

Player: ${input.player.name} (id ${input.player.id}), hp ${input.player.hp}/${input.player.max_hp}
Target: ${input.target.name}, hp ${input.target.hp}/${input.target.max_hp}${acStr}${profStr}, conditions: ${condBlock}

Recent damage (this session):
${recentBlock}

Combat inventory/context:
${formatCombatContext(input)}

Language hint: ${input.language_hint ?? 'en'}

Output the combat plan JSON now.`;
  },
};

function formatCombatContext(input: DirectorInput): string {
  const envItems =
    input.environment.items_here.length === 0
      ? '  (none)'
      : input.environment.items_here
          .slice(0, 12)
          .map(
            item =>
              `  - ${item.display_name} id=${item.id} kind=${item.kind} count=${item.count}` +
              (item.slug ? ` slug=${item.slug}` : '') +
              (item.category ? ` category=${item.category}` : '') +
              (item.summary ? ` summary="${item.summary.slice(0, 160)}"` : ''),
          )
          .join('\n');
  const surfaces =
    input.environment.active_surfaces.length === 0
      ? '  (none)'
      : input.environment.active_surfaces
          .slice(0, 8)
          .map(surface => `  - ${JSON.stringify(surface).slice(0, 180)}`)
          .join('\n');
  return `equipped_weapons:
${formatInventoryItems(input.inventory.equipped_weapons)}
carried_weapons:
${formatInventoryItems(input.inventory.carried_weapons)}
carried_tools:
${formatInventoryItems(input.inventory.carried_tools)}
fallback_source: ${input.inventory.unarmed_source}
location: ${input.environment.location_name ?? 'null'}
location_summary: ${input.environment.location_summary ?? 'null'}
environment_items_here:
${envItems}
active_surfaces:
${surfaces}`;
}

function formatInventoryItems(items: CombatInventoryItem[]): string {
  if (items.length === 0) return '  (none)';
  return items
    .slice(0, 12)
    .map(
      item =>
        `  - ${item.slug} name="${item.item_name}" qty=${item.quantity} equipped=${item.equipped}` +
        (item.damage_die ? ` damage_die=${item.damage_die}` : '') +
        (item.damage_type ? ` damage_type=${item.damage_type}` : ''),
    )
    .join('\n');
}

function escapeJsonStringContent(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
