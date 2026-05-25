# Movement rules

The Movement Warden contract from [packages/web-server/prompts/greenhaven.md:67](../../packages/web-server/prompts/greenhaven.md#L67): never narrate the player at a location they aren't actually at. The `move_player` tool is the canonical state mutation. Companions auto-follow.

## Movement Warden contract

When `narrate` is called, the Warden checks whether the prose places the player at a location !== `current_location_id`. If yes AND `move_player` wasn't called this turn → the narrate dispatch returns:

```ts
{
  ok: false,
  rejected: true,
  error: "narrator teleport blocked: …",
  suggestion: {
    flagged_location_id: <id>,
    action: "Either call move_player(target_location_id=<id>, intent_source='user_command') first, or rewrite the narrate so the player STAYS at their current location and the other location is referenced as a destination/topic — not a place they ARE."
  }
}
```

Broker reads the suggestion and retries. Validator is idempotent. Two enforcement layers:

- **Pre-tool validator (spec 51)** — hard rejection at dispatch time.
- **Post-turn observer (spec 46)** — emits `movement:teleport_detected` SSE if a teleport slipped through. Defense-in-depth.

See [agents/movement-warden.md](../agents/movement-warden.md) for the runtime side. The check is multilingual — `@`-mention extraction is Unicode-aware (`\p{L}\p{N}`), placement-vs-reference distinction is delegated to the LLM.

## move_player intent_source

Source: [packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts). Args:

```ts
move_player({
  target_location_id: number,
  intent_source: 'user_command' | 'follow_player' | 'specialist_forced'
})
```

Three semantic cases:

| `intent_source` | When | Auto-follow companions? |
|---|---|---|
| `'user_command'` | Player explicitly chose — clicked an exit, said "go to X", confirmed travel | Yes |
| `'follow_player'` | Reserved/internal sentinel for a direct companion-follow move; not the common roster-presence path | No (would loop) |
| `'specialist_forced'` | Combat Director / Quest Watcher / cartridge transition forces a relocation | Yes |

`intent_source` is required. Why: player movement emits companion follow cards
and may be extended by direct follow moves, but those internal follow moves must
exclude `'follow_player'` from any further companion propagation to avoid loops.

The exit list comes from `entities[id=current_location_id].profile.exits` (an
array of entity ids), plus parent/child topology. Playable targets are
`kind='location'` or `kind='district'`. Only valid adjacencies pass; unknown ids
return error. After the move, `players.current_location_id` is updated and
`player:moved` SSE fires. The frontend re-fetches
`/api/session/:id/locations` for the sidebar/map. Dialogue focus is not inferred
from `player:moved`; it is updated through `dialogue:participants_updated`.

## Companion follow

Companion follow is represented by the player's move plus
`npc:moved_with_player` events and presence/context overrides. The common path
does not issue a recursive `move_player` for every companion. The next preamble
treats active companions as present with the player and also adds them to
`## DIALOGUE PARTICIPANTS`; if the focused dialogue partner is a companion,
focus can persist across movement. Ordinary local NPC focus is released by the
dialogue lifecycle.

For each following companion, movement emits `npc:moved_with_player` SSE with
`{npcId, npcName, fromLocation, toLocation}`. The next preamble's
`## PEOPLE HERE` lookup treats the companion as colocated with the player even
if the cartridge home location is elsewhere.

The narrator therefore **cannot** desync companions. If a companion needs to be elsewhere, broker MUST call `set_companion(stop_following)` first. Movement Warden hard-rejects narrate calls that place a companion at a different location.

See [agents/companion-system.md](../agents/companion-system.md).

## Auto-depart

Spec 53. Some companions carry a `profile.depart_when` predicate (low strings, condition, runtime field threshold, completed quest). When matched, the post-turn engine ([packages/web-server/src/agents/companionDepartEngine.ts](../../packages/web-server/src/agents/companionDepartEngine.ts)) fires `set_companion(stop_following, reason='auto: …')` server-side AND emits `companion:auto_departed` SSE.

The narrator MUST treat the parting as canonical:
- Render the goodbye / quiet exit / betrayal — match the predicate's tone.
- Do NOT keep the NPC at the player's side; they're gone.
- To re-bond later, broker calls `set_companion(action='follow')` again.

Predicate types are in [cartridge/depart-conditions.md](../cartridge/depart-conditions.md). Cartridges that don't declare `profile.depart_when` keep companions bonded forever until manual unbond.

## Worked examples

### Player commands a move

Input: `я иду в @Quiet Lantern Inn`.

Right flow:
```ts
move_player(target_location_id=110, intent_source='user_command')
narrate(author='Quiet Lantern Inn', tone='narrator',
  text='Дверь со скрипом отворяется. Внутри тёплый свет лампы, запах эля и потрескивание камина.', done=true)
```

`current_location_id` updates to 110. Companions auto-follow. `player:moved` + per-companion `npc:moved_with_player` fires.

Wrong flow (no `move_player`): narrate body references `@Quiet Lantern Inn` placement → Movement Warden rejects → broker retries with `move_player` first.

### Player references a location they aren't at

Input: `What's the gossip about @The Docks lately?`.

Right flow (single narrate):
```ts
narrate(author='Quickgrin Lane', tone='narrator',
  text='Микка хмыкает: "Доки шевелятся, говорят, новый барон скупает грузы."', done=true)
```

`@The Docks` is mentioned but the prose doesn't place the player there — it's a topic. Warden lets through. The mention is still clickable, but it's a destination, not a placement.

### Companion departs after a betrayal

Player betrays their companion Skiv (string drops to -2). Skiv has `profile.depart_when = {kind: 'string_threshold', op: '<', value: -1}`.

Post-turn (after the betrayal beat resolves):
- Companion Depart Engine evaluates → match.
- Server-side `set_companion(action='stop_following', reason='auto: string < -1 (betrayal)')`.
- `companion:auto_departed` SSE fires.

Next turn:
- `## PEOPLE HERE` no longer surfaces Skiv as a companion (he reverts to his `profile.home_id`).
- Broker reads `companion:auto_departed` event in the preamble.
- Broker narrates Skiv's departure (in some form — quiet exit, parting curse) but does NOT keep him at the player's side.

Movement Warden + Voice Warden both gate any prose that contradicts the departure.

## Sources

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md) — Movement Warden + Companion contracts (lines 67-71)
- [packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts) — `move_player`, dialogue focus release, companion follow events
- [packages/web-server/src/agents/movementWardenPreTool.ts](../../packages/web-server/src/agents/movementWardenPreTool.ts) — pre-tool validator
