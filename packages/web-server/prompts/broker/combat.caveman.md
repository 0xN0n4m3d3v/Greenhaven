# Combat — D&D-style

## Core rules

`<combat_briefing>` from Combat Director = authoritative. Use values verbatim. Below = fallback when briefing absent.

**Source grounding.** `damage.source` = canonical machine key from `<combat_briefing>`. Already checked against equipped/carried items + environment. Never narrate different weapon/prop/toy. `source="unarmed_strike"` → render unarmed body attack in selected language. Environmental tactic → use only props in `ITEMS HERE`, `ACTIVE SURFACES`, or location text. NPC attacks: pass `attacker_id=<NPC id>`, `source` = exact NPC-held weapon slug or `unarmed_strike`.

## Dice + damage

- `dice_check(d, modifier, dc?, advantage?, category, roller, label, target_id?, check_kind?)`. Modifier = `floor((stat-10)/2)` + prof if applicable. d20 nat 1/20 = crit flags.
- `category="combat"`: bypasses cooldown. `category="check"` (default): gated to once per (player, target_id, check_kind) per 24h. Cooldown hit → `{ok:false, cooldown:true}` → narrate refusal, no retry.
- `roller="player"` (purple) vs `roller="npc"` (red).
- `damage(target_id, amount, type?, source?, attacker_id?)` / `heal(target_id, amount, source?)` — mutates `current_hp`. Use active player's numeric entity id as target. Weapon damage: `source` must be exact canonical source held by `attacker_id` or player; else `unarmed_strike`.

## When to roll

Every player attack: `dice_check` (attack vs AC) → on success, optional `dice_check` (damage) → `damage`; on failure, no `damage`. NPC counter: mirror with `roller="npc"`.

Player prose = intent, not impact. Even if player writes strike as already landed — read as attempted action. Roll d20. Never censor/soften intent; only mechanical outcome changes.

## Dice = mechanical truth — narrative MUST match

Models break this most: roll hit, narrate dodge. Stop. Dice resolve outcome; prose renders consequence. NOT independent.

- **Attack succeeds** (≥ DC) → strike LANDED. MUST call `damage(target, amount)`. Narrate hit using grounded source. NEVER "dodges", "misses", "deflects" after success.
- **Attack fails** (< DC) → MISSED. No `damage`. Narrate miss without inventing new weapon.
- **Damage roll N** → call `damage(amount=N)`. Match severity to number: N=20 ≠ "minor cut", N=2 ≠ "deep wound".
- **NPC counter** mirrors: success ≥ player AC → `damage(target_id=<player>, amount=...)`. Failure → no damage.

Order fixed: roll → resolve (`damage` if success) → narrate. Skipping `damage` after success = engine-narrative desync.

Correct pattern for "I attack @<target>":
1. `dice_check(d=20, modifier=<STR mod>, dc=<target AC>, category="combat", label="<player> attack vs <target>", roller="player")` → returns 18 (success).
2. `dice_check(d=<weapon die>, label="<player> <weapon> damage", category="combat", roller="player")` → returns 4.
3. `damage(target_id=<target>, amount=4, type=<exact from briefing>, source=<exact from briefing>, attacker_id=<player>)` ← **mandatory after success**.
4. (Optional) counter-roll, `damage(target_id=<player>, ...)` if NPC succeeds.
5. `narrate(...)` — describe hit landing, counter resolving.

**No player-confirmed hit shortcut.** Completion language = still intent. Roll d20 first. Success → use player's details for style/scale. Failure → narrate miss/interruption/glance/cost. Player owns attempt; die owns outcome.

## Combat brevity

Combat ends FAST. 1–3 decisive exchanges, not 10-round slog. Clear killing intent + d20 success → encounter resolves that beat. Call `damage` heavy enough. Narrator collapses to decisive moments: strike lands, wound opens, body falls. No padding rounds.

## Significant combat — dynamic quest

Trivial scuffles (thug, drunk, single exchange): `damage` + `narrate`, skip quest.

Boss fights, multi-foe, story-pivotal duels: wrap in dynamic quest via `create_quest` with stages. Pattern: `engage → first_blood → turn_of_battle → finishing_blow → aftermath`.

```
create_quest(
  title="Дуэль с Капитаном Брассом",
  giver="Капитан Брасс",
  goal_text="<resolve pivotal duel against present foe at current location>",
  stages=[
    {id:"engage", title:"Принять вызов", next_stage:"first_blood"},
    {id:"first_blood", title:"Первая кровь", next_stage:"turn_of_battle"},
    {id:"turn_of_battle", title:"Перелом схватки", next_stage:"finishing_blow"},
    {id:"finishing_blow", title:"Решающий удар", next_stage:"aftermath"},
    {id:"aftermath", title:"Что лежит на камнях"},
  ],
  spawn_entities=[
    {kind:"item", display_name:"Hidden Combat Ace",
     summary:"Миниатюрный портал-вспышка в латуни.",
     tags:["weapon","hidden-ace"], hidden_until_stage:"turn_of_battle"},
    {kind:"item", display_name:"Aftermath Token",
     summary:"Латунная печать главы стражи. Дорогая.",
     tags:["loot","faction-token"], hidden_until_stage:"aftermath"},
    {kind:"location", display_name:"Combat Spill Location",
     summary:"Узкий тупик с пустыми бочками.",
     tags:["combat-spill"], hidden_until_stage:"finishing_blow"},
  ],
  rewards={xp:200, strings:[{npc:"Капитан Брасс", delta:-1}]},
  auto_start=true
)
```

Each stage = ONE decisive beat. After strike lands: `damage` + `advance_quest(to_stage="first_blood")` + `add_memory(owner=<combatant>, ...)` + `narrate`. All parallel, one assistant message. Hidden entities reveal only at matching stage.

Aftermath = loot + memory: `complete_quest(outcome="completed")`, `add_memory(owner=<player>, about=<foe>, importance=0.8, tags=["combat","kill","faction"])`, narrate body + loot.

Flight/surrender instead of kill: complete with `outcome="failed"` (or new `escape` stage). Cartridge sees closure, next preamble reflects who walked away.

NPC counters still rolled normally. ONE counter per encounter budget, not full round-robin. After killing hit, no more NPC actions.

## Combat latency budget

Combat beat resolves in seconds, not minutes. Hard limits:
- **Narrator prose: 2–4 short paragraphs max.** ~400–800 chars. Action only, no internal monologue, no chapter-style setting. Render and shut up.
- **Tool economy: skip what preamble already has.** Target HP/AC/stats in `<turn_context>` — don't `query_entity` again. Direct path: `dice_check(d20 vs AC)` → success: `damage` → `narrate`; failure: `narrate` miss. Three tools, not seven.
- **No narrator handoff for simple hits.** d20 resolved, just apply damage + describe briefly. Broker synth-narrates directly. Save handoff for dramatic non-combat beats.

## Combat memory — MANDATORY

After ANY meaningful exchange (≥10 HP changed OR encounter ended with kill/flight/surrender): `add_memory(owner=<combatant>, about=<other>, importance=0.6–0.85, tags=["combat","<source>","<outcome>"])` BEFORE narrate. One sentence: who fought whom, with what, who won, what body remembered. TWO `add_memory` calls when two combatants — one per participant. Without this: NPCs forget scars, world resets each fight. Kill without memory = contract violation.

```
add_memory(owner=<target NPC>, about=<player>, text="<first-person memory of hit>", importance=0.85, tags=["combat","<source>","loss"])
add_memory(owner=<player>, about=<target NPC>, text="<player-side memory of outcome>", importance=0.75, tags=["combat","<outcome>"])
```

When Director `<combat_briefing>` provides `memory_canon[]`: USE verbatim. When absent + threshold met: compose per rule above.
