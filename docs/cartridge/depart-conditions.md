# Companion auto-depart predicates (spec 53)

Cartridge-declared conditions on `profile.depart_when` that auto-unbond a companion server-side. Evaluated by [packages/web-server/src/agents/companionDepartEngine.ts](../../packages/web-server/src/agents/companionDepartEngine.ts) post-turn. Deterministic — no LLM call. See [agents/companion-system.md](../agents/companion-system.md) for the runtime side.

## Predicate types

Four kinds, declared on the NPC's `profile.depart_when`:

```ts
profile.depart_when: DepartPredicate
```

```ts
type DepartPredicate =
  | { kind: 'string_threshold',
      op: '<' | '<=' | '>' | '>=' | '==',
      value: number }
  | { kind: 'condition_present',
      tag: string }
  | { kind: 'runtime_field_threshold',
      field_key: string,
      op: '<' | '<=' | '>' | '>=' | '==',
      value: number | string }
  | { kind: 'quest_completed',
      quest_display_name: string };
```

Schema at [packages/web-server/src/agents/companionDepartEngine.ts:47-66](../../packages/web-server/src/agents/companionDepartEngine.ts#L47-L66).

When matched, the engine fires `set_companion(stop_following, reason='auto: <why>')` server-side and additionally emits `companion:auto_departed` SSE for a distinct EventCard. The narrator MUST treat the parting as canonical.

Cartridges that don't declare `profile.depart_when` are unaffected — the companion stays bonded forever until broker manually unbonds.

## string_threshold

The simplest case: companion leaves when the player↔NPC string drops too low.

```json
"depart_when": {"kind": "string_threshold", "op": "<", "value": -2}
```

Reads via `readStrings(playerId, npcId)` at [packages/web-server/src/tools/strings.ts](../../packages/web-server/src/tools/strings.ts). The string is a per-player overlay on the NPC's `strings` runtime field; betraying the companion drives the score down past -2 → auto-depart.

Use for: companions with low loyalty thresholds (mercenaries, reluctant allies).

## condition_present

Match on a condition tag in the NPC's `conditions[]` runtime field.

```json
"depart_when": {"kind": "condition_present", "tag": "betrayed"}
```

The cartridge can set the `betrayed` condition via a transition triggered by the player's quest betrayal beat. Once the condition is present, next post-turn pass — auto-depart.

Use for: companions whose departure is gated by a discrete narrative event (betrayed, oathbroken, exiled). Usually paired with a transition rule that sets the condition when the event happens.

## runtime_field_threshold

Match on a numeric or string runtime field threshold.

```json
"depart_when": {
  "kind": "runtime_field_threshold",
  "field_key": "trust",
  "op": "<",
  "value": 0
}
```

Reads `runtime_values` (or `runtime_player_overlay` if `scope_per_player`) for the named field on the companion entity. Comparison via the op.

Use for: companions whose loyalty is tracked in a custom runtime field (not the standard `strings`). E.g. an NPC with a `trust` field that decays over time.

For string equality on enum fields, use `op='=='` and a string value:
```json
{"kind": "runtime_field_threshold", "field_key": "mood_string", "op": "==", "value": "betrayed"}
```

## quest_completed

Match on a quest reaching `status='completed'`.

```json
"depart_when": {"kind": "quest_completed", "quest_display_name": "Find Mikka's Brother"}
```

Reads `player_quests` for the named quest in the player's roster. When `status='completed'`, auto-depart.

Use for: temporary companions tied to a single arc. The companion follows for the duration of the rescue mission; once the brother is found and the quest completes, they go their way.

## Worked examples

### Mercenary with low loyalty

```json
{
  "id": 230,
  "kind": "person",
  "display_name": "Skiv the Mercenary",
  "profile": {
    "speech_style": "Curt, profession-first, no warmth.",
    "depart_when": {"kind": "string_threshold", "op": "<", "value": -1}
  }
}
```

Skiv stays bonded as long as the player keeps his string above -1. One betrayal, two cold shoulders → auto-depart. Narrator gets the `companion:auto_departed` SSE and threads "Skiv slips away without a word" into the next beat.

### Quest-tied rescue companion

```json
{
  "id": 231,
  "kind": "person",
  "display_name": "Lila the Apprentice",
  "profile": {
    "depart_when": {"kind": "quest_completed", "quest_display_name": "Lila's Last Lesson"}
  }
}
```

Lila joins for the duration of her arc quest. Once the quest completes (good or bad ending), she departs — the engine doesn't care about the outcome, just the status.

### Oath-broken paladin

```json
{
  "id": 240,
  "kind": "person",
  "display_name": "Sir Kael",
  "profile": {
    "depart_when": {"kind": "condition_present", "tag": "oathbroken"}
  }
}
```

Sir Kael departs the moment `conditions[]` carries `oathbroken`. The cartridge ships a transition that sets that condition when the player commits a specific atrocity. The condition + depart_when combo is the wire.

### Health-gated companion

```json
{
  "id": 232,
  "kind": "person",
  "display_name": "Old Henrik",
  "profile": {
    "depart_when": {"kind": "runtime_field_threshold", "field_key": "current_hp", "op": "<=", "value": 0}
  }
}
```

When Henrik drops to 0 HP, he auto-departs. Narrative reading: "downed in combat, left behind". Combine with `mark_downed` semantics for a full death-leaves-arc loop.

## Sources

- [packages/web-server/src/agents/companionDepartEngine.ts](../../packages/web-server/src/agents/companionDepartEngine.ts) — predicate evaluator + dispatch
- [packages/web-server/plans/execution-roadmap/specs/53-companion-auto-depart.md](../../packages/web-server/plans/execution-roadmap/specs/53-companion-auto-depart.md) — original spec
