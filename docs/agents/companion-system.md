# Companion system (specs 52 + 53)

The companion system is two specs joined: **spec 52** ships the `set_companion`
tool plus companion presence on every player `move_player`; **spec 53** adds an
async post-turn engine that evaluates cartridge-declared `profile.depart_when`
predicates and auto-unbonds companions when they match.

## Goal

Make companions a first-class state. Once an NPC bonds with the player (sworn to
follow, joined the party, accepted a deal that requires travel), the engine
carries them through player movement via roster state, context placement, and
`npc:moved_with_player` cards so the narrator can't desync them. When a
cartridge-declared exit condition is met, the engine unbonds them server-side
and emits `companion:auto_departed` so the narrator must treat the parting as
canonical.

The contract is in
[packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md)
"Companion contract": **never narrate a companion at a different location than
the player** — Movement Warden rejects. If they need to be elsewhere, unbond
first.

## set_companion tool

Source:
[packages/web-server/src/tools/companion.ts](../../packages/web-server/src/tools/companion.ts).

```ts
set_companion({
  npc: string,                              // display_name or entity id
  action: 'follow' | 'stop_following',
  reason?: string,                          // ≤240 chars; surfaces on SSE card
})
```

- Validates the target is `kind='person'`.
- `'follow'` → adds the NPC id to `players.metadata.companions[]` and emits
  `companion:added` SSE.
- `'stop_following'` → removes from the array and emits `companion:removed`.
- Idempotent on the (player, npc) pair — repeated `follow` for an already-bonded
  NPC is a no-op.

The roster is a JSON array of NPC ids on `players.metadata.companions`. Read by:

- `move_player` for companion follow cards and dialogue-focus continuity.
- `buildTurnContext` for `## PEOPLE HERE` placement.
- Companion Depart Engine for predicate evaluation.

## Auto-follow

Implemented inside `move_player` in
[packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts).

Flow:

1. `move_player` validates the destination, resolves player movement.
2. Reads `players.metadata.companions[]`.
3. For each companion, emits `npc:moved_with_player` SSE with
   `{npcId, npcName, fromLocation, toLocation}`.
4. The next preamble's `## PEOPLE HERE` lookup
   ([turnContext.ts](../../packages/web-server/src/turnContext.ts)) overrides
   the NPC's `profile.home_id` when the NPC is a companion — they appear at the
   player's `current_location_id` regardless.

The auto-follow only fires for `intent_source='user_command'` and
`'specialist_forced'`. `'follow_player'` is a reserved/internal sentinel for a
direct companion-follow move and is excluded from further companion propagation
to prevent loops.

The narrator therefore **cannot** desync companions from the player — their
"location" is implicit (= player's). If a companion needs to be elsewhere,
broker MUST call `set_companion(stop_following)` first. Movement Warden
([movement-warden.md](movement-warden.md)) hard-rejects narrate calls that place
a companion elsewhere.

## Auto-depart engine

Source:
[packages/web-server/src/agents/companionDepartEngine.ts](../../packages/web-server/src/agents/companionDepartEngine.ts).

Async post-turn hook. For each companion in the roster:

1. Read NPC's `profile.depart_when` predicate.
2. Evaluate against current world state (strings, conditions, runtime fields,
   completed quests).
3. On match: call `set_companion(stop_following, reason='auto: <why>')`
   server-side via `dispatch` so the same SSE / metadata path runs as for a
   broker-initiated unbond, plus emit `companion:auto_departed` SSE for a
   distinct EventCard.

Predicate types (deterministic — no LLM call):

| Kind                      | Schema                                              | Example                                                            |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `string_threshold`        | `{kind, op: '<'/'<='/'>'/'>='/'==', value: number}` | `{string_threshold, op: '<', value: -2}` (string drops below -2)   |
| `condition_present`       | `{kind, tag: string}`                               | `{condition_present, tag: 'betrayed'}`                             |
| `runtime_field_threshold` | `{kind, field_key: string, op, value}`              | `{runtime_field_threshold, field_key: 'trust', op: '<', value: 0}` |
| `quest_completed`         | `{kind, quest_display_name: string}`                | `{quest_completed, quest_display_name: "Mikka's Trust"}`           |

Cartridges that don't set `profile.depart_when` are unaffected — companions stay
bonded forever until broker manually unbonds. See
[cartridge/depart-conditions.md](../cartridge/depart-conditions.md) for
authoring.

## Where it's wired

- Tool:
  [packages/web-server/src/tools/companion.ts](../../packages/web-server/src/tools/companion.ts)
  — registered in
  [packages/web-server/src/tools/index.ts:30](../../packages/web-server/src/tools/index.ts#L30).
- Auto-follow cards and context continuity:
  [packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts)
  inside `move_player`.
- Depart Engine: `companionDepartEngineHook` at
  [packages/web-server/src/agents/companionDepartEngine.ts](../../packages/web-server/src/agents/companionDepartEngine.ts);
  imported into the post-turn pipeline at
  [packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts).
- `## PEOPLE HERE` override:
  [packages/web-server/src/turnContext.ts](../../packages/web-server/src/turnContext.ts).
- Movement Warden contract:
  [packages/web-server/src/agents/movementWardenPreTool.ts](../../packages/web-server/src/agents/movementWardenPreTool.ts)
  checks companions stay co-located.

## Failure & fail-open

- `set_companion` is a tool — failures bubble through `dispatch`'s standard
  fail-soft (audited error in `tool_invocations`, broker reads
  `{ok: false, error}` and retries).
- Companion follow card emission in `move_player` reads all companion names in
  one query; an empty or missing roster does not block the player's move.
- Depart Engine: per-companion try/catch
  ([packages/web-server/src/agents/companionDepartEngine.ts:96-103](../../packages/web-server/src/agents/companionDepartEngine.ts#L96-L103)).
  One malformed predicate doesn't poison the others.
- Unknown predicate kind → log warning + skip (the companion stays bonded).
- DB query failure during predicate evaluation → log warning + skip.

The fail-open path leaves the companion bonded longer than they should be. The
broker can still narrate a parting and call `set_companion(stop_following)`
manually.

## Sources

- [packages/web-server/src/tools/companion.ts](../../packages/web-server/src/tools/companion.ts)
  — `set_companion` tool
- [packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts)
  — companion follow cards and movement dialogue lifecycle
- [packages/web-server/src/agents/companionDepartEngine.ts](../../packages/web-server/src/agents/companionDepartEngine.ts)
  — async predicate evaluator
- [packages/web-server/plans/execution-roadmap/specs/52-companion-auto-follow.md](../../packages/web-server/plans/execution-roadmap/specs/52-companion-auto-follow.md)
- [packages/web-server/plans/execution-roadmap/specs/53-companion-auto-depart.md](../../packages/web-server/plans/execution-roadmap/specs/53-companion-auto-depart.md)
