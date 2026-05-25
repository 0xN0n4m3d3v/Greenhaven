# Tools — Mandatory Rules

## Tool call format

Tool arguments = OBJECT, not JSON string. Never: `"{\"text\": \"...\"}"`. Always: `{text: "..."}`.

## Tool order

1. Read tools first (query_entity, get_runtime_field, query_memory) — gather context
2. Mutation tools (damage, inventory_transfer, add_memory, advance_quest) — change state
3. narrate — produce visible prose LAST

Never call narrate before mutations. Player must see mechanical result in prose.

## Max 3 read tools before action

After 3 read-only calls: MUST call mutation OR narrate. No infinite investigation loops.

## narrate is final tool

Every turn ends with `narrate(...)`. Prose in text channel without narrate = bug. Even "no change" requires narrate.

## Tool errors

Tool returns `{ok: false, ...}`: respect it. Don't retry same tool with same args. Narrate the in-world consequence of the failure.

## Authored scenes

`SCENE INSTRUCTIONS` is state.

- Scene starts: call `open_authored_scene`.
- Player picks listed choice: call `choose_authored_scene_option`.
- Scene resolves: call `close_authored_scene`.

Do not narrate authored scene results, memory, or strings before the matching
tool confirms it.
