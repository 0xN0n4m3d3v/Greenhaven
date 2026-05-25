# Sex moves authoring

A sex move is a permanent post-encounter effect declared on an NPC's `profile.sex_move`. After the matching intimacy quest completes, the broker reads the sex_move and fires the indicated `effect_tool` with the indicated `effect_args`. Migration: [packages/web-server/migrations/0028_sex_moves_and_trauma.sql](../../packages/web-server/migrations/0028_sex_moves_and_trauma.sql).

## Schema

```ts
profile.sex_move = {
  trigger: 'post_climax' | 'post_aftercare' | 'on_first_strings_unlock',
  narrate_hint: string,           // shown to the broker as guidance for the post-encounter beat
  effect_tool: string,            // the tool to fire (must be a registered tool name)
  effect_args: object,            // args for the effect_tool — fully resolved (entity ids, field keys, values)
}
```

The `effect_tool` can be any registered tool. Common choices:
- `add_memory` — leave a leverage memo (Mikka).
- `apply_runtime_field_patch` — flip a permanent state flag (Borek's free lodging).
- `string_award` — give a permanent string bump.
- `inventory_transfer` — gift a token item.

The narrate_hint is **not** consumed by code — it's text the broker sees and uses to weave the effect into the next narrative beat.

## Trigger

Three trigger keys today:

| Trigger | When it fires |
|---|---|
| `post_climax` | After the matching intimacy quest reaches its terminal "climax" stage. |
| `post_aftercare` | After the post-climax aftercare beat. Used when the effect should reference what was said in aftercare. |
| `on_first_strings_unlock` | When the player crosses a string threshold with the NPC for the first time (independent of intimacy quest). |

The cartridge author picks one. The Intimacy Coordinator (spec 41) routes — when its FSM crosses the matching transition AND `rewards.sex_move_eligible: true` is set on the quest profile, broker is told to fire the `effect_tool`.

`profile.sex_move` without `rewards.sex_move_eligible` on the quest is harmless — broker won't fire it. The flag is the explicit unlock.

## Worked example: Mikka

From [packages/web-server/migrations/0028_sex_moves_and_trauma.sql:14-29](../../packages/web-server/migrations/0028_sex_moves_and_trauma.sql#L14-L29):

```json
{
  "trigger": "post_climax",
  "narrate_hint": "Mikka now holds a piece of intel about the active player character. She decides whether to keep it private or sell it on the next public scene where the topic could come up. Roll d20+CHA against DC 12 when that scene fires.",
  "effect_tool": "add_memory",
  "effect_args": {
    "owner": "Mikka Quickgrin",
    "about": "<active player entity id>",
    "text": "Knows something about the active player character from intimate exposure. Pending: roll vs DC 12 on next public bargain.",
    "importance": 0.7,
    "tags": ["intimate-aftermath", "leverage", "pending-roll"]
  }
}
```

Effect: a high-importance NPC memory tagged `pending-roll`. Future preambles surface it; the next time Mikka is in a public bargain scene, the broker reads the tag and rolls. The narrate_hint guides this — broker sees it on the encounter resolution turn and threads "Mikka noted something" into the aftermath prose.

The mechanic is durable. Even ten in-game days later, the memo is in `npc_memories` with high salience. Mikka has leverage; the game remembers.

## Worked example: Borek

Originally seeded in `0028`, then corrected by [packages/web-server/migrations/0050_fix_borek_sex_move_effect_args.sql](../../packages/web-server/migrations/0050_fix_borek_sex_move_effect_args.sql):

```json
{
  "trigger": "post_climax",
  "narrate_hint": "The active player character now sleeps free at the Quiet Lantern Inn. Borek will not ask, and neither will the player. Persists until the player crosses Borek (then revoked).",
  "effect_tool": "apply_runtime_field_patch",
  "effect_args": {
    "patches": [
      {"field_id": 8110, "op": "append", "value": "add_current_player"}
    ],
    "source": "sex_move_borek_free_lodging"
  }
}
```

Effect: appends the current player's id to a runtime field on the Lantern (location 110). Migration `0028` declares the field at id 8110 with `value_type='json'`, scope `'permanent'`. The cartridge then provides `entity_instructions` on the Lantern that surface "Free Bed" as an affordance when the current player's id is in the array.

`"add_current_player"` is a sentinel value the runtime patch tool resolves at fire-time using the active `ctx.playerId`. Cartridge author writes the sentinel; the broker calls `apply_runtime_field_patch` with it; the runtime tool appends the player's actual numeric id.

Revocation: Borek's `entity_instructions` include rules for revoking the lodging if a hostile threshold (string < -2) is crossed. The "persists until the player crosses Borek" clause from `narrate_hint` is enforced via that hook + the cartridge's transition table.

## Sources

- [packages/web-server/migrations/0028_sex_moves_and_trauma.sql](../../packages/web-server/migrations/0028_sex_moves_and_trauma.sql) — schema + Mikka + Borek sex_move seeds
- [packages/web-server/migrations/0029_quest_schema.sql](../../packages/web-server/migrations/0029_quest_schema.sql) — quest profile `rewards.sex_move_eligible` flag
- [packages/web-server/src/tools/intimacy.ts](../../packages/web-server/src/tools/intimacy.ts) — `apply_intimacy_trigger` tool
