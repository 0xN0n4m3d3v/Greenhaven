/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Tiny V4 Flash call that classifies a free-text turn into a narrator
// tier. T0 (scripted) is decided upstream by the runner; this module
// resolves T1/T2/T3/T4 for free text.
//
// LANGUAGE-AGNOSTIC by construction: classifier IS itself a multilingual
// LLM. No regex / lexical heuristics — those silently discriminate
// against languages we forgot to add. Few-shot prompt covers top
// languages by intent, not by token presence.

import {generateText} from 'ai';
import type {RunnerProviders} from './providers.js';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4';

const PROMPT = `You are a turn-intent classifier for a multilingual immersive RPG. Output EXACTLY one label and nothing else.

Labels:
T1_TRIVIAL  — pure acknowledgment or short reaction with no specific intent (any language). E.g. "yes", "ok", "go on", "nod", "да", "ок", "はい", "sí", "ja", "好的", "ठीक है".
T2_ROUTINE  — exploration, looking around, ambient questions, casual NPC chat WITHOUT explicit state change.
T3_DRAMATIC — confrontation, intense dialogue, emotional reveal, narration of dramatic beat WITHOUT explicit state-mutating commitment.
T4_MUTATION — ANY action that commits the player to a state change: give / take / buy / sell / pay / attack / use / equip / drop / throw / drink / eat an item; deal or take damage; accept or commit to a quest; transfer money or items; cast a spell with effect; move physically. Classify by INTENT, not by language. If the player commits to a physical or transactional action, the answer is T4.

Crucial rule: when ambiguous between T2 and T4, prefer T4. A false T4 wastes one cheap broker call (~$0.0003); a missed T4 silently breaks the game (no inventory transfer, no HP change, no quest progress).

Examples are deliberately cartridge-agnostic. <NPC>, <ITEM>, <FOE> are
placeholders; in real input the player will name actual entities via
@-mention or plain text — match by INTENT, not by token presence.

Multilingual examples (label after each):
"yes" → T1
"да" → T1
"はい" → T1
"好的" → T1
"vale" → T1
"I look around" → T2
"осматриваюсь" → T2
"miro alrededor" → T2
"je regarde autour" → T2
"我环顾四周" → T2
"@<NPC>, how are you?" → T2
"@<NPC>, как дела?" → T2
"@<NPC> ¿qué tal?" → T2
"@<NPC>, この街はどう?" → T2
"this <ITEM> looks expensive" → T2
"эта <ITEM> выглядит дорогой" → T2
"the merchant glares at me" → T3
"торговец бросает на меня тяжёлый взгляд" → T3
"<NPC> усмехается, опуская руку на нож" → T3
"I give <NPC> 5 gold" → T4
"плачу 5 монет за <ITEM>" → T4
"держи 10 золотых" → T4
"doy 5 monedas a <NPC>" → T4
"5枚の金貨を渡す" → T4
"我给<NPC> 5金币" → T4
"Ich gebe <NPC> 5 Goldstücke" → T4
"je donne 5 pièces d'or à <NPC>" → T4
"मैं 5 सोने के सिक्के देता हूं" → T4
"بأعطي <NPC> 5 قطع ذهبية" → T4
"I attack the <FOE>" → T4
"атакую <FOE>" → T4
"用剑刺向<FOE>" → T4
"I drink the potion" → T4
"использую <ITEM>" → T4
"pick up the <ITEM>" → T4
"забираю <ITEM>" → T4
"I accept the quest" → T4
"беру квест" → T4

Turn:
`;

export async function classifyIntent(args: {
  providers: RunnerProviders;
  userText: string;
  signal: AbortSignal;
}): Promise<Tier> {
  const r = await generateText({
    model: args.providers.broker,
    prompt: PROMPT + args.userText.slice(0, 600),
    temperature: 0.0,
    maxOutputTokens: 16,
    abortSignal: args.signal,
  });
  const out = r.text.trim().toUpperCase();
  if (out.startsWith('T1') || out.includes('TRIVIAL')) return 'T1';
  if (out.startsWith('T3') || out.includes('DRAMATIC')) return 'T3';
  if (out.startsWith('T4') || out.includes('MUTATION')) return 'T4';
  if (out.startsWith('T2') || out.includes('ROUTINE')) return 'T2';
  return 'T4';
}

// Spec 32 — mode classifier. Same shape as classifyIntent: tiny V4
// Flash call, language-agnostic by construction, no regex / lexical
// heuristics. Output drives ModeBanner UI + intimacy scriptedActions
// injection (spec 35 mode-classifier branch).

export type Mode = 'combat' | 'intimacy' | 'dialogue' | 'exploration' | 'travel' | 'rest';

// X-3 classifier-hint refactor — the broker tool-profile selector and
// the dialogue-focus farewell branch used to inspect raw player text
// with en+ru regex lists. Those have been removed. Instead the mode
// classifier now returns a structured `TurnRouteDecision` the routing
// layer can read directly. PROFILE picks one of the focused broker
// tool profiles; DIALOGUE_ACT names whether the player is saying
// goodbye in dialogue mode. Both stay language-agnostic by construction
// — the LLM classifies by INTENT, not by token presence. See
// `feedback_no_language_hardcode`.
export type ProfileHint =
  | 'default'
  | 'state_recap'
  | 'scene_trade'
  | 'commerce_bargain';

export type DialogueAct = 'none' | 'farewell' | 'action';

export interface TurnClassifierDecision {
  mode: Mode;
  profile: ProfileHint;
  dialogueAct: DialogueAct;
}

const TURN_ROUTE_PROMPT = `You are a turn-intent classifier for a multilingual immersive RPG. Output EXACTLY three lines and nothing else, in this exact order and format:
MODE=<one of: COMBAT | INTIMACY | DIALOGUE | EXPLORATION | TRAVEL | REST>
PROFILE=<one of: DEFAULT | STATE_RECAP | SCENE_TRADE | COMMERCE_BARGAIN>
DIALOGUE_ACT=<one of: NONE | FAREWELL | ACTION>

MODE labels:
COMBAT      — the player is engaging in violence: striking, shooting, parrying, defending, killing. Includes preparing a grounded held item or guard stance while a foe is present.
INTIMACY    — sexual or sensual contact: kissing, caressing, undressing, sex acts, erotic teasing. Also: accepting an intimacy offer that an NPC made on the previous turn ("yes", "all of you", "lead me to the room" — any language — when the NPC just offered a paid scene or a kiss).
DIALOGUE    — direct verbal exchange with an NPC (asking, telling, replying, persuading, arguing, lying). Quoted speech ("…") is the strong signal.
EXPLORATION — looking, searching, examining, observing surroundings, picking up unattended things, eavesdropping.
TRAVEL      — physically moving from one location to another (entering, leaving, walking-to, riding, sailing). NOT this when the NPC's previous offer was to lead the player to a private room — that's INTIMACY.
REST        — sleeping, meditating, eating, drinking, waiting, recovering.

If multiple modes apply, pick the MOST DRAMATIC (combat > intimacy > dialogue > exploration > travel > rest).

PROFILE labels (pick DEFAULT unless one of the focused profiles matches; classify by INTENT, not by token presence):
DEFAULT          — anything that doesn't match the focused profiles below.
STATE_RECAP      — the player is asking the broker to verify, check, or recap durable world state (promises, debts, threats, quests, inventory, memory) before continuing.
SCENE_TRADE      — the player is picking something off the scene/floor and offering or selling it to an NPC for currency in the same beat.
COMMERCE_BARGAIN — the player is buying or bargaining for goods with explicit currency (gold, silver, coin, etc).

DIALOGUE_ACT labels:
FAREWELL — the player is saying goodbye, ending the conversation, or otherwise signalling they want to release the current NPC focus. Any language. Only emit FAREWELL when the player's actual intent is to part ways; "see you" inside narrative speech to a different audience is NOT a farewell.
ACTION   — the player is committing to a transactional/physical/movement step that should release dialogue focus (give, take, move, attack, drink, etc).
NONE     — any other case: continued conversation, observation, exploration, ambient remark, intimacy beat, rest.

Plain NPC names without @ are still valid references to the current or named
partner. If the player says goodbye to a plain named NPC, emit FAREWELL.

Classify by INTENT in any language; the examples are in English purely for compactness.

Examples:
"I attack @<FOE>"
MODE=COMBAT
PROFILE=DEFAULT
DIALOGUE_ACT=ACTION

"I kiss her, slow"
MODE=INTIMACY
PROFILE=DEFAULT
DIALOGUE_ACT=NONE

[NPC: "I'm yours for the night, forty silver."] "Yes, take me."
MODE=INTIMACY
PROFILE=DEFAULT
DIALOGUE_ACT=NONE

"@<NPC>, you owe me an answer"
MODE=DIALOGUE
PROFILE=DEFAULT
DIALOGUE_ACT=NONE

"@<NPC1> @<NPC2> sweep the ledger with me — what promises, debts, threats and quests are real right now?"
MODE=DIALOGUE
PROFILE=STATE_RECAP
DIALOGUE_ACT=NONE

"I pick up the brass lens from the stage and offer it to @<NPC> for 4 gold."
MODE=DIALOGUE
PROFILE=SCENE_TRADE
DIALOGUE_ACT=ACTION

"@<NPC>, I'll buy the ale — one coin for the drink, one for the rumour."
MODE=DIALOGUE
PROFILE=COMMERCE_BARGAIN
DIALOGUE_ACT=ACTION

"Goodbye, @<NPC>. I have to go."
MODE=DIALOGUE
PROFILE=DEFAULT
DIALOGUE_ACT=FAREWELL

"Goodbye Vex"
MODE=DIALOGUE
PROFILE=DEFAULT
DIALOGUE_ACT=FAREWELL

"I head to the docks"
MODE=TRAVEL
PROFILE=DEFAULT
DIALOGUE_ACT=ACTION

"I sleep until dawn"
MODE=REST
PROFILE=DEFAULT
DIALOGUE_ACT=NONE

"I look around the tavern"
MODE=EXPLORATION
PROFILE=DEFAULT
DIALOGUE_ACT=NONE
`;

const MODE_VALUES: readonly Mode[] = [
  'combat',
  'intimacy',
  'dialogue',
  'exploration',
  'travel',
  'rest',
];
const PROFILE_VALUES: readonly ProfileHint[] = [
  'default',
  'state_recap',
  'scene_trade',
  'commerce_bargain',
];
const DIALOGUE_ACT_VALUES: readonly DialogueAct[] = ['none', 'farewell', 'action'];

export async function classifyTurnRoute(args: {
  providers: RunnerProviders;
  userText: string;
  signal: AbortSignal;
  /** Optional last NPC bubble (truncated by caller) to disambiguate short
   * or referential player replies like "yes" / "lead me". */
  lastNpcLine?: string | null;
}): Promise<TurnClassifierDecision> {
  const contextBlock =
    args.lastNpcLine && args.lastNpcLine.trim()
      ? `Prior NPC line: ${args.lastNpcLine.trim().slice(0, 400)}\n\n`
      : '';
  const prompt = `${TURN_ROUTE_PROMPT}
${contextBlock}Turn:
${args.userText.slice(0, 600)}`;
  const r = await generateText({
    model: args.providers.broker,
    prompt,
    temperature: 0.0,
    maxOutputTokens: 48,
    abortSignal: args.signal,
  });
  return parseTurnRouteDecision(r.text);
}

/**
 * Parse the classifier's free-text output into a `TurnRouteDecision`.
 * Tolerant by design — the broker model occasionally emits a stray
 * leading label ("MODE: DIALOGUE"), extra whitespace, or only the bare
 * mode label (e.g. `DIALOGUE`). The parser scans line-by-line for
 * `MODE=`, `PROFILE=`, `DIALOGUE_ACT=` (case-insensitive, `:` or `=`
 * accepted), and falls back to substring inference for legacy bare
 * outputs. Missing fields default to safe values: mode → exploration,
 * profile → default, dialogue act → none.
 */
export function parseTurnRouteDecision(raw: string): TurnClassifierDecision {
  const normalised = raw.trim();
  let mode: Mode | null = null;
  let profile: ProfileHint | null = null;
  let dialogueAct: DialogueAct | null = null;

  for (const rawLine of normalised.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([A-Z_]+)\s*[:=]\s*(.+)$/i);
    if (!match) continue;
    const key = match[1]!.toUpperCase();
    const value = match[2]!.trim().toUpperCase();
    if (key === 'MODE' && mode == null) {
      mode = matchEnum(value, MODE_VALUES);
    } else if (key === 'PROFILE' && profile == null) {
      profile = matchEnum(value, PROFILE_VALUES);
    } else if (
      (key === 'DIALOGUE_ACT' ||
        key === 'DIALOGUEACT' ||
        key === 'DIALOGUE') &&
      dialogueAct == null
    ) {
      dialogueAct = matchEnum(value, DIALOGUE_ACT_VALUES);
    }
  }

  if (mode == null) {
    mode = matchEnum(normalised.toUpperCase(), MODE_VALUES) ?? 'exploration';
  }
  return {
    mode,
    profile: profile ?? 'default',
    dialogueAct: dialogueAct ?? 'none',
  };
}

function matchEnum<T extends string>(
  value: string,
  options: readonly T[],
): T | null {
  const upper = value.toUpperCase();
  for (const option of options) {
    if (upper === option.toUpperCase()) return option;
  }
  for (const option of options) {
    if (upper.includes(option.toUpperCase())) return option;
  }
  return null;
}

/**
 * Compatibility wrapper for callers that still want just the mode.
 * Production callers go through `classifyTurnRoute` now; this stays
 * exported so other modules (and tests) can ask the same classifier
 * for a single mode without learning the structured shape.
 */
export async function classifyMode(args: {
  providers: RunnerProviders;
  userText: string;
  signal: AbortSignal;
  lastNpcLine?: string | null;
}): Promise<Mode> {
  const decision = await classifyTurnRoute(args);
  return decision.mode;
}
