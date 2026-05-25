# Combat (D&D-style)

D&D-style ruleset adapted for narrative play. Dice are mechanical truth; prose renders consequence. The full ruleset lives in [packages/web-server/prompts/greenhaven.md:73-173](../../packages/web-server/prompts/greenhaven.md#L73-L173). The Combat Director (spec 40) pre-computes when present; broker falls back to the prompt rules when not.

## Dice as truth

The most-broken thing models do in combat: roll a hit, then narrate a dodge. Stop. Dice resolve outcome; prose renders consequence. They are NOT independent.

- **Player prose is intent, not impact.** Even if the player writes a strike as already landing, treat that as the attempted move. The d20 decides whether it actually lands.
- **Attack roll succeeds** (≥ DC) → the strike LANDED. You MUST call `damage(target, amount)` next. Then narrate the hit. NEVER write "dodges", "misses", "deflects" after a successful roll.
- **Attack roll fails** (< DC) → the strike MISSED. Do NOT call `damage`. Narrate the miss.
- **Damage roll value = HP applied directly.** A `dice_check(label='...damage')` returning N means call `damage(amount=N)`. Match severity to the number — don't narrate "minor cut" if N=20.
- **NPC counter-attack roll** mirrors the same rule for the player's HP.

Order is fixed: roll → resolve mechanically (call `damage` if success) → narrate. Skipping the `damage` call after a successful roll leaves the engine and narrative out of sync — next turn's preamble says target is unwounded while the player just read about a "killing blow".

## No Player-Confirmed Hit Shortcut

Completion language in user text is still intent. The engine must roll d20 before any `damage` call. On success, use the player's anatomical detail and tone to style the hit and scale damage. On failure, narrate how the attempted move misses, is interrupted, glances off, or creates a different cost.

Examples:
- "I bury the blade in her chest, ribs crack" -> roll d20 vs AC. Success: chest wound. Failure: the blade skids off armor, is parried, or lands shallowly with no HP damage.
- "I strike for the head" -> roll d20 vs AC. Success can attach `stunned`; failure cannot call `damage`.
- "I aim for the throat" -> roll d20. Success can be a mortal consequence; failure is no throat wound.

## Position & Effect

Every `dice_check` carries two situational tags beyond the raw d20. See [position-and-effect.md](position-and-effect.md) for the full table; in short:

- **Position** ∈ `controlled | risky | desperate` — how recoverable failure is. Default risky.
- **Effect** ∈ `limited | standard | great` — how much success delivers. Default standard.

Effect scales magnitude:
- `limited` → damage halved (round down); non-HP outcomes use a smaller string/memory/quest consequence unless a cartridge-declared numeric field exists.
- `standard` → as written.
- `great` → damage doubled (cap at 60); non-HP outcomes strengthen string/memory/quest consequence unless a cartridge-declared numeric field exists.

Position governs failure narration:
- `desperate` failure → catastrophe (stunned, disarmed, NPC walks cold), call corresponding state tool.
- `risky` failure → concrete cost (HP loss, lost initiative, lost String).
- `controlled` failure → "no ground lost, try again". No state mutation.

Read the player's prose. They rarely say "controlled" — you read it. Charging with weapon raised, bleeding from prior wounds → `desperate`. Walking up calmly with coin in hand → `controlled`.

## Conditions

Damage isn't the only outcome of a hit. When the player's prose names a body part or kinetic effect, attach a condition via `damage(... condition={...})`:

| Prose | Condition |
|---|---|
| "I cut her hamstring" | `{tag: "prone", duration_turns: 3, severity: 2}` |
| "Crack his skull with the pommel" | `{tag: "stunned", duration_turns: 1, severity: 2}` |
| "Blade enters her side, stays there" | `{tag: "bleeding", duration_turns: 4, severity: 1}` |
| "Wrist twist, the dagger flies" | `{tag: "disarmed", duration_turns: 2, severity: 1}` |
| "Shoulder-check sends them stumbling" | `{tag: "off-balance", duration_turns: 1, severity: 1}` |

`severity` scales prose impact (1=light, 2=serious, 3=crippling). Conditions decay each turn — `decrementConditions` ([packages/web-server/src/transitionEngine.ts](../../packages/web-server/src/transitionEngine.ts)) ticks them. Preamble shows active tags so the broker reads them and respects them.

Plain `damage` without `condition` is fine for clean exchanges with no body-part specificity.

## Brevity

Combat ends FAST. Default to 1–3 decisive exchanges to defeat, not a 10-round attrition slog. If the player narrates a clear killing intent and the d20 succeeds, the encounter can resolve in that beat — call `damage` heavy enough to match the successful consequence.

Narrator prose collapses long fights to the decisive moments: the strike that lands, the wound that opens, the body that falls. No padding rounds, no prolonged parry dance. Players came for resolution, not minutes of swordplay.

## Latency budget

Per the prompt: "Combat brevity. Combat ends FAST." Operationally the budget is:
- One `dice_check` (attack vs AC) → ≤ 1.5s.
- One `dice_check` (damage roll) → ≤ 1.5s.
- One `damage` call → ~50ms.
- One `narrate` → ≤ 3s (broker → narrator handoff).
- Total decisive exchange ≤ 6s wall-clock.

Combat Director (spec 40) timeout is 7000ms. If the Director can't return a brief in 7s, fail open to broker prompt rules — keep the player moving.

## Memory MANDATORY

The hard rule from the prompt: **combat memory is mandatory** for boss-level encounters. After the killing blow:
- `add_memory(owner=<NPC who survived/witnessed>, about=<active player entity id>, text='<canonical sentence>', importance=0.85+, tags=['combat-aftermath', '<encounter-name>'])`
- Per-side: if the encounter had multiple participants who survived, one memory each.
- Combat Director's `memory_canon[]` array provides pre-composed canonical text — broker uses verbatim when present.

Trivial scuffles (single thug, one swing) skip memory — the world doesn't need to remember every drunk who lost a brawl. Boss fights persist; the body falls and someone, somewhere, will hear about it.

## Multi-stage dynamic quests

Significant combat wraps in a dynamic quest. Trivial scuffles (a thug, a drunk, a single d20-and-done exchange) skip the quest machinery; boss-level fights, multi-foe encounters, or story-pivotal duels wrap.

Stage pattern: `engage → first_blood → turn_of_battle → finishing_blow → aftermath`.

`spawn_entities[]` with `hidden_until_stage` introduces foes / loot / setting that emerges as the fight progresses. The bodyguards spawn at `turn_of_battle`; the relic spawns at `finishing_blow`.

```ts
create_quest(
  title="Captain Brass Duel",
  goal_text="Survive Brass's challenge. Decide whether to kill or spare.",
  stages=[
    {id:"engage", title:"First exchange", next_stage:"first_blood"},
    {id:"first_blood", title:"First blood drawn", next_stage:"turn_of_battle"},
    {id:"turn_of_battle", title:"Turn of battle", next_stage:"finishing_blow"},
    {id:"finishing_blow", title:"Finishing blow", next_stage:"aftermath"},
    {id:"aftermath", title:"Aftermath"},
  ],
  spawn_entities=[
    {kind:"person", display_name:"Brass's First Bodyguard",
     hidden_until_stage:"turn_of_battle"},
    /* ... */
  ],
  rewards={xp:200, memory:{...}}
)
```

The Quest Watcher auto-advances stages on `damage` tool calls matching stage objectives. See [cartridge/quest-recipes.md](../cartridge/quest-recipes.md) for the full pattern.

## Sources

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md) — combat ruleset (lines 73-173)
- [packages/web-server/src/agents/combatDirectorPrompt.ts](../../packages/web-server/src/agents/combatDirectorPrompt.ts) — Combat Director prompt
- [packages/web-server/src/tools/dice.ts](../../packages/web-server/src/tools/dice.ts), [combat.ts](../../packages/web-server/src/tools/combat.ts), [combatDeath.ts](../../packages/web-server/src/tools/combatDeath.ts)
