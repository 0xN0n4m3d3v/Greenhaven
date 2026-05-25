# GreenHaven Player-Facing Overview

## Short Pitch

GreenHaven is a living adult LitRPG where the player creates a character and steps into a reactive post-steampunk fantasy city built around portals, bargains, danger, intimacy, and consequences. It plays like a tabletop RPG run by an always-on game master: the player writes what their character tries to do, the game tracks the world state, rolls dice when outcomes are uncertain, remembers what happened, and lets NPCs react over time.

The core promise is simple: the world does not reset when a chat bubble scrolls away.

## What The Game Is

GreenHaven is not a linear visual novel and not a static chatbot. It is an RPG sandbox with authored cartridge content, dynamic quests, persistent characters, runtime state, inventory, relationships, dice, and narrative specialists that coordinate the scene.

The current main layer of play is GreenHaven itself: a former steampunk world entering a second industrial revolution after millennia of portal contact with other worlds. The first portal brought demonic/succubus influence into the setting, and that ancestry still shapes culture: social bargaining, sensuality, power, debt, flirtation, manipulation, and intimacy are normal parts of public life. The game is intended for adult players.

The early playable area focuses on Quickgrin Lane, Mikka Quickgrin, Borek and the Quiet Lantern Inn, faction tension, private deals, exploration hooks, social leverage, hidden rooms, and dangerous street-level conflicts.

## Core Player Fantasy

The player is not selecting dialogue options from a small menu. They are playing a created protagonist and can write direct actions, speech, threats, bargains, seduction, investigation, travel, combat, or quiet roleplay.

The game then does four things:

1. Treats the player's text as intent, not automatic success.
2. Uses dice, tools, state, inventory, quests, and NPC memory to decide what becomes canon.
3. Rewrites player action bubbles into more literary in-character prose without changing the meaning.
4. Lets the world remember consequences through future scenes.

That means "I smash the bottle into his head" is not instantly true. It becomes an attempted action. A visible d20 roll decides whether it lands, damage is applied only after success, and the narration follows the mechanics.

## Main Gameplay Loop

1. The player sends an action or dialogue line.
2. The game forms a player bubble, optionally polishing it into character-appropriate prose.
3. The backend builds the current scene context: player, location, NPCs, inventory, quests, runtime fields, memory, and nearby opportunities.
4. Specialist systems classify the turn: combat, dialogue, intimacy, exploration, travel, rest, quest progress, or adventure hook.
5. Tools mutate the world only when mechanics justify it: dice, inventory transfer, quest transition, memory write, XP award, movement, runtime field change.
6. The GUI releases visible messages and system cards in deterministic order so events do not arrive out of sequence.
7. Post-turn systems can advance quests, seed adventure opportunities, refresh UI cards, and record memories without mixing old messages into the chat.

## Mechanics

### Character And Progression

Players have a created protagonist with name, profile, level, XP, HP, skills, stats, inventory, and current location. The game uses id-first targeting internally so progress belongs to the actual active character, not to placeholder names.

Progression includes:

- XP awards and level-ups.
- HP and combat state.
- Inventory and currency.
- Skills/classes/proficiencies.
- Conditions and status effects.
- Memories and relationship state.
- Quest completion and rewards.

### LitRPG Feedback

The frontend can show system cards for meaningful mechanical events: XP, level-up, dice rolls, damage, quest progress, discoveries, adventure hooks, inventory changes, relationship changes, and other state updates.

The point is not to spam the player. The point is to make the RPG layer visible: when the world changes, the player sees that the game actually recorded it.

### Dice And Combat

Combat follows a D&D-style d20 truth rule:

- Player prose is intent.
- d20 resolves hit or miss.
- Damage is only applied after a successful roll.
- Conditions can apply when the action justifies them.
- Memories record serious fights, wounds, kills, flight, surrender, and lasting grudges.

Combat can be small and immediate, or it can become a multi-stage dynamic quest for major fights: engage, first blood, turn of battle, finishing blow, aftermath.

### Quests

GreenHaven supports cartridge-authored quests and dynamic quests created during play.

Quest types include:

- Payment and negotiation quests.
- Investigation quests.
- Exploration and hidden-location quests.
- Combat arcs.
- Delivery and errand quests.
- Social leverage quests.
- Intimacy quests.
- Random adventure hooks generated from current context.

Quests have stages, objectives, rewards, hidden entities, and post-turn progression. The Quest Watcher can advance stages after the player clearly completes them, while guards prevent duplicate stage changes.

### Adventure Queue

The adventure system acts like a game master that can propose opportunities without forcing them into canon.

It can generate hooks such as:

- A hidden object or clue nearby.
- A new quest lead.
- An NPC encounter.
- A dangerous ambush setup.
- A strange event in the current location.
- A newly placed item.
- A location or threat that fits the present narrative.

Hooks are queued, shown to the player, can expire, and can be accepted by UI action or clear natural player prose. Acceptance materializes the adventure through existing world systems instead of a separate quest engine.

Important rule: combat-adjacent hooks can create setup, enemies, or danger, but they cannot damage the player before dice resolve harm.

### NPCs, Relationships, And Memory

NPCs are not just text voices. They have profiles, speech style, relationship strings, memories, runtime state, home locations, quests, and instructions.

Memories are one of GreenHaven's main selling points. If the player cheats Mikka, saves Borek, injures a guard, pays someone, refuses a bargain, shares a secret, or completes an intimate encounter, the game can record that fact. Later, the NPC can reference it, react to it, or change future offers.

Relationship mechanics include strings and social standing. Strings represent leverage, trust, attraction, debt, or emotional hold. They can be gained through intimacy, vulnerability, betrayal, useful help, or dramatic moments.

### Multi-NPC Dialogue

The game supports scenes where the player addresses or affects multiple NPCs at once. It keeps a focused dialogue partner while tracking other participants, so a scene can include more than a single speaker.

The system tries to keep one authored speaker per visible bubble. If multiple NPCs speak, the game should split them into separate messages or use narrator/location voice for scene framing.

### Intimacy

GreenHaven includes adult intimacy as a mechanical part of the RPG, not as isolated prose.

Intimacy scenes are quest-tracked state machines: approach, consent, foreplay, climax, aftermath, or skip/refusal. They can affect memories, strings, XP, quest state, payment substitution, social leverage, and permanent NPC-specific sex moves.

The important design rule is durability: if intimacy matters in the story, it should leave state behind. A scene should not become "nothing happened" on the next turn.

### Inventory, Economy, And Payment

Inventory and currency are real mechanics. If a character pays, gives, steals, receives, or loses an item, the corresponding inventory tool must succeed before narration treats it as canon.

Payment guardrails prevent failed transfers from being followed by canonical quest completion, XP, or memories that pretend the payment happened.

### Locations And Exploration

The world has actual entities for locations, scenes, items, exits, NPCs, and hidden spaces. Generated locations must be mentioned with `@Name` after creation so the player can navigate to them through the UI.

Locations can hold items, NPCs, surfaces, hazards, and runtime fields. Hidden locations can be gated behind quest stages and revealed later.

### State And Runtime Fields

GreenHaven uses runtime fields as the live state machine for scenes, NPCs, quests, and locations. These fields have exact ids, types, allowed values, scope, and current values. The AI cannot safely invent them; it must mutate only fields that exist.

This is what makes the world consistent: payment status, scene mode, lamp state, conditions, surfaces, free lodging, NPC HP, and similar mechanics are not just words.

## Why It Is Interesting For Players

GreenHaven's appeal is the combination of freedom and consequence.

A player can:

- Speak naturally instead of choosing canned options.
- Push social scenes hard and see NPCs remember it.
- Start fights where dice matter.
- Discover generated quests and events that fit the current context.
- Build relationships through bargains, favors, intimidation, intimacy, and betrayal.
- Watch small choices become persistent world facts.
- Create a protagonist and act through free text that remains the canonical player intent.

The game is strongest for players who want:

- A tabletop-like RPG without needing a human GM.
- A living city that reacts to roleplay.
- Adult themes with mechanics rather than detached scenes.
- Emergent quests and consequences.
- Narrative freedom with RPG structure underneath.

## Current Selling Angle

GreenHaven can be presented as:

> A living adult LitRPG sandbox where every bargain, wound, secret, payment, and intimate choice can become permanent world state.

Short store-style copy:

> Create a character and enter GreenHaven, a portal-scarred post-steampunk city of deals, danger, desire, and old debts. Speak and act freely; the game master rolls dice, tracks quests, remembers consequences, and lets NPCs react to what you actually did. Explore hidden places, make dangerous bargains, fight, seduce, investigate, betray, and survive in a world where chat is not just chat: it is state.

## Player Promise

The player should feel:

- "I can try anything reasonable."
- "The game will not confuse my current character with an old one."
- "If I pay, fight, discover, or betray, the world records it."
- "NPCs are not blank voices; they carry memory."
- "The game can surprise me with adventures, but it will not force hidden outcomes without mechanics."
- "My actions become better prose without the AI changing what I meant."

## What To Keep Improving Before A Sales Push

The strongest next polish areas are:

- More authored starting content and quest chains.
- More visible LitRPG event cards for all major state changes.
- Cleaner onboarding that explains freeform input, dice, and consequences without feeling like a manual.
- More NPC profiles with distinct voices, memories, secrets, and sex moves.
- More adventure tables and encounter variety.
- A stable demo cartridge showing the whole loop in 20-30 minutes: create character, talk, accept a hook, roll dice, gain memory/XP, reveal a location, resolve a quest.
