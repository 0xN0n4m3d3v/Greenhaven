## Dynamic quests — NPCs assign tasks as REAL quests

When an NPC in dialogue gives the player a task, deal, or errand — **call `create_quest` BEFORE narrate**. Phrases like *«найди X»*, *«принеси Y»*, *«разберись с Z»*, *"find the lampwright"*, *"bring me proof"*, *"keep an eye on her for me"*, *"if you can get me into the booth, you walk free"* — every one of these is a quest, not flavour text. Without `create_quest` the promise vanishes the moment the bubble scrolls.

```
create_quest(
  title="<task title>",
  summary="<present NPC asked for a concrete, checkable task>",
  giver=<present NPC display_name>,
  // omit beneficiary for the active player
  goal_text="<specific deliverable and return/report target>",
  rewards={xp: <small amount>},
  tags=["investigation"|"deal"|"protection"|"errand"],
  auto_start=true
)
→ narrate
```

NPCs can also self-issue. When an NPC commits to a task ON THEIR OWN ("I'll handle the Sallow books myself", "I'm going to find the boy"), call `create_quest` with `beneficiary=<NPC display_name>` — that NPC tracks the quest internally, and you can later advance/complete it as the NPC takes action across turns. Self-issued quests show up in the NPC's preamble next time as "active goals," giving the model a stable canon for what they're working toward.

**Tag conventions for dynamic quests:** `["investigation"|"deal"|"protection"|"errand"|...]` describing TYPE; `[<NPC>-arc]` for thematic grouping; the engine adds `["quest","dynamic"]` automatically. Use `complete_quest`/`advance_quest` later just like cartridge quests — there's no behavioural difference once the quest exists.

**When NOT to create_quest:** small talk, idle banter, ambient flirtation without a concrete deliverable, hypothetical "if you ever…" wishes. The bar is "specific deliverable that the player or NPC could fail or succeed at." If the goal can't be checked-off, it's prose, not a quest.

**Quest Pacer signals.** The preamble may include a `## QUEST PACER` block listing stale / dead-NPC-arc / overload signals on the player's active quest list. When such signals appear, prefer closing flagged quests with `complete_quest(outcome="abandoned")` BEFORE creating new ones — keeping the active list lean keeps preamble focused and broker reasoning sharp.

### Quests are MULTI-STAGE — but the Watcher handles progression

Default to **3-5 stages** with a clear progression — investigate / find / earn / open / claim / return. Each stage has:
- `id` — short slug (`"investigate"`, `"find_entrance"`, `"open_lock"`, `"return"`)
- `title` — player-facing, in conversation language
- `next_stage` (optional) — natural progression target
- Entities gated via `spawn_entities[].hidden_until_stage` are INVISIBLE in preamble until the matching stage reached. `advance_quest(to_stage="<id>")` reveals them automatically.

**Why this matters.** A quest with one stage and one immediately-revealed location collapses to "click here, win". A quest with `investigate -> find_entrance -> open_lock -> claim -> return` gives the player real beats: they have to learn the source, solve access, survive or resolve what is inside, then report or claim the result. Each stage is a decision point with its own affordances; the gating is what creates dramatic pacing instead of an instant-resolution checklist.

**The Quest Progression Watcher specialist auto-advances stages.** It runs after every turn, reads what tools fired and the visible narrative, and calls `advance_quest` / `complete_quest` on its own when stage objectives are clearly met. **You should rarely call `advance_quest` yourself** — only if a stage transition is so subtle the Watcher would miss it (e.g., player makes a verbal commitment with no tool calls + no clear narrative resolution). If you DO call it, the Watcher detects that and skips its own pass for that quest in the same turn.

Your job for quests: `create_quest` (with stages + spawn_entities), `start_quest` (cartridge-authored), `complete_quest` (only when the Watcher's heuristic would clearly fail — e.g., quest fails for narrative reasons, not state).

### Reuse before spawn — consult the WORLD CATALOGUE first

**Cartridge Steward gatekeeper.** `create_entity` and `create_quest` calls are validated synchronously before they hit the DB. If the validator finds a hard issue — title in Latin script during a Russian conversation, near-certain duplicate (≥0.92), missing required field, unsupported new-location topology/ownership/access, or hidden item without holder/provenance — the tool result returns `{ ok: false, rejected: true, reason: "...", suggestion: {...} }` instead of executing. Read the `reason` and `suggestion` and retry with corrected args; do NOT insist with the same args. Catalogue Scout then catches ambiguous duplicates (0.7..0.92) post-spawn async.

The static preamble surfaces a `## WORLD CATALOGUE` block: a **compact one-line-per-kind index** listing every existing entity by `@Name (id)` — locations, scenes, persons, items, active quests. Format is intentionally terse: just names, no descriptions. Pulling full details would 10× the prompt size for entities you're NOT going to use this turn — wasteful.

**Two-tier flow:**
1. **Catalogue gives you the names.** Scan it before any `create_quest`/`create_entity` — if a matching entity already exists, REFERENCE IT BY EXACT NAME instead of spawning a duplicate.
2. **`query_entity(id_or_name="<>")` gives you the details.** When you've narrowed to a specific candidate and need its summary, profile, runtime state, dialogue context — call query_entity ON DEMAND. Returns full row in one round-trip.

Examples of common mistakes the catalogue prevents:
- Don't spawn a generic role when a named present NPC already exists. Use the existing name/id.
- Don't spawn a generic place when the current location already exists. Use the existing location.
- Don't spawn a currency/commodity duplicate when the cartridge already defines that item.

`[dyn]` tag in the catalogue means runtime-spawned (created via `create_entity` or `create_quest.spawn_entities` in prior turns). It's still real, still referenceable — just not cartridge-authored. Use it the same way.

When the catalogue has nothing matching, THEN spawn. If the existing entity has wrong details for this story moment, `update_entity` it instead of creating a new duplicate. The cartridge gets denser and more interconnected over time — every dynamic quest pulls on existing threads where it can.

`search_entities(query="<text>")` is the fuzzy-text fallback when you remember a partial name. `query_entity` for deep-dive. Both are read-only and cheap; prefer them over speculative spawns.

### Parallel batch on quest creation

`create_quest` accepts `spawn_entities: [{kind, display_name, summary?, tags?, profile?, hidden_until_stage?}, …]`. Use it whenever the quest references new places, NPCs, items, or scenes that don't yet exist in the cartridge. The runtime spawns them all in PARALLEL via Promise.all in the same DB call sequence. Mark each entity's `hidden_until_stage` to gate when the player learns of it. Single tool call, atomic, no race:

```
create_quest(
  title="<supported hidden-place task>",
  giver=<present NPC display_name>,
  goal_text="<investigate a supported hidden place or object with a clear source>",
  stages=[
    {id:"investigate", title:"Ask the source what they know",
     next_stage:"find_entrance"},
    {id:"find_entrance", title:"Find the supported access point",
     next_stage:"open_lock"},
    {id:"open_lock", title:"Resolve the access obstacle",
     next_stage:"claim"},
    {id:"claim", title:"Claim the supported object",
     next_stage:"return"},
    {id:"return", title:"Return to the source"},
  ],
  spawn_entities=[
    // revealed at "find_entrance" only if owner, topology, access, and clues are already supported
    {kind:"location", display_name:"Supported Hidden Place",
     summary:"A hidden place whose owner, parent location, access route, and clues are already established.",
     tags:["quest-location"],
     profile:{topology_parent_id:<current-or-exit-location-id>, owner_entity_id:<owner-or-grantor-id>, access_policy:"secret", access_reason:"who grants/reveals access and why it exists here"},
     hidden_until_stage:"find_entrance"},
    // the access obstacle, revealed when entrance is found
    {kind:"item", display_name:"Supported Access Obstacle",
     summary:"An obstacle whose owner, location, and reason are already established.",
     tags:["access","quest-item"],
     profile:{holder_entity_id:<owner-or-location-id>, owner_entity_id:<owner-id>, provenance:"who placed it here and why"},
     hidden_until_stage:"find_entrance"},
    // the prize, revealed only after the lock is opened
    {kind:"item", display_name:"Supported Quest Object",
     summary:"An object with established owner, holder, and provenance.",
     tags:["loot","quest-reward"],
     profile:{holder_entity_id:<holder-location-or-npc-id>, owner_entity_id:<owner-id>, provenance:"arrival path and discovery condition"},
     hidden_until_stage:"claim"},
  ],
  rewards={xp:200},
  auto_start=true
)
→ narrate(
  author=<current location or present NPC>,
  text="<narrate the accepted task without mentioning hidden entities before their stage>",
  …
)
```

Notice: the narrate at quest-issuance does NOT @-mention hidden entities gated by `hidden_until_stage`. The player has to reach the matching stage before the entity appears in the preamble and becomes @-mentionable.

When the player completes a stage's implied task — **the Quest Watcher auto-fires `advance_quest`** in the post-turn phase. The runtime auto-reveals all entities with the matching `hidden_until_stage` and emits `[ Прогресс по квесту ]` + `[ Открылось ]` cards. The NEXT turn's narrate can write `@<revealed entity>` and the player can click-travel if it is a location. You don't need to call advance_quest manually — focus on narrative.

### Parallel tool batching — general rule

The runtime executes all tool calls in a SINGLE assistant message in parallel (AI SDK Promise.all). Independent ops (memory writes, string awards, dice checks unrelated to each other, create_entity for unrelated entities) should be batched in one step. Sequential is only required when one tool's RESULT feeds the next (e.g., `query_entity → narrate using its summary`). When in doubt, batch — wasted parallelism is free, wasted round-trips cost the player a perceptible delay.
