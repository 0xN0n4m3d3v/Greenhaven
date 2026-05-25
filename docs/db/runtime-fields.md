# Runtime field system

Greenhaven's state machine. Every "live" property of every entity — Mikka's mood, the door's locked-ness, the current world time, the player's stunned counter — lives in a triple of tables: `runtime_fields` (the *schema*), `runtime_values` (the *global current value*), `runtime_player_overlay` (the *per-player override*).

## Concept

A runtime field is a **declared** state slot on an entity. The cartridge ships the declaration in seed migrations; the engine reads/writes through tools (`get_runtime_field`, `set_runtime_field`, `apply_runtime_field_patch`).

Two read paths:
- **Global** — `runtime_values.value` for `field_id`. Shared across all players. Used for canonical world state (the door's state, Mikka's reputation arc).
- **Per-player overlay** — `runtime_player_overlay.value` for `(field_id, player_id)`. Used for state that must differ between players (did THIS player pay Mikka?).

The flag `runtime_fields.scope_per_player` (added by [packages/web-server/migrations/0002_litrpg.sql:20-21](../../packages/web-server/migrations/0002_litrpg.sql#L20-L21)) decides which table writes hit. Readers union the two with **overlay winning**:

```
effective_value(player) =
  runtime_player_overlay[field, player]
    ?? runtime_values[field]
    ?? runtime_fields[field].default_value
```

This three-tier resolution is shared by `get_runtime_field`, the transition engine's predicate eval, and `buildTurnContext`'s preamble assembly.

The field's `value_type` constrains writes: `'int' | 'float' | 'bool' | 'string' | 'enum' | 'entity_ref' | 'json' | 'dice'`. `allowed_values` is optional for enum constraints. `scope` is informational: `'turn' | 'scene' | 'session' | 'journey' | 'permanent'` — drives lifecycle decay (turn-scoped fields are wiped on `decrementConditions`/etc).

## runtime_fields / runtime_values

Schema declarations + their global values. See [schema.md](schema.md) for column-level details.

Common usage patterns:
- **NPC HP** (migration `0009`) — every damageable NPC has `current_hp` and `max_hp` runtime fields, both `scope_per_player=false` (HP is shared canon — player A's blow weakens Mikka for player B). Combat tools (`damage`, `heal`) read/write these directly.
- **NPC strings** (migration `0027`) — `strings` JSONB on every `kind='person'`, per-player overlay so each player has their own string score with each NPC.
- **NPC mood** (`mood_string` enum) — global; the cartridge author decides whether a single mood is shared canon or per-player.
- **Door / scene state** (`is_open`, `examined_count`) — global, scope='session'.
- **Player conditions** (migration `0026`) — `conditions[]` JSONB on the player entity, global (players in MVP are 1:1 with entity_id, no overlay needed).
- **World clock** (migration `0032`) — `world_time_minutes` on the world entity, global, scope='journey'. Ticked by `tickWorldClock` once per turn.

`runtime_values.source` records who wrote: `'cartridge_seed' | 'transition' | 'tool_apply' | 'manual'`. Useful for telemetry.

The `set_runtime_field` and `apply_runtime_field_patch` tools at [packages/web-server/src/tools/runtime.ts](../../packages/web-server/src/tools/runtime.ts) are the canonical write path. Both honour `scope_per_player`: writes route to `runtime_values` or `runtime_player_overlay` automatically based on the field declaration.

## runtime_player_overlay

Per-player state for fields with `scope_per_player=true`. Defined at [packages/web-server/migrations/0002_litrpg.sql:23-33](../../packages/web-server/migrations/0002_litrpg.sql#L23-L33).

Composite PK `(field_id, player_id)`. One row per player per overlaid field. Writers create-or-update; readers fall through to `runtime_values` if no overlay exists.

Examples:
- **`payment_paid`** on a quest entity — did this player pay Mikka? Per-player.
- **`strings`** on an NPC — each player has their own string graph with the NPC.
- **`active_dialogue_partner_id`** is on `players.dialogue_partner_id` directly (not an overlay) because it's purely per-player.

The overlay is the "instanced state" mechanism without instancing the whole NPC. One Mikka row in `entities`; her HP / current dialogue / mood is shared canon (so the broker sees a single coherent story); her strings with the player is overlay (so two players have independent relationships).

## Transitions

The forward-chaining rule engine. Defined in [packages/web-server/src/transitionEngine.ts](../../packages/web-server/src/transitionEngine.ts).

Cartridge declares transitions in the `transitions` table:

```ts
{
  when_json: [{field_id, op, value}, ...],   // AND of predicates
  set_json:  [{field_id, value}, ...],        // patches to apply on match
  priority:  number,                           // higher fires first within a pass
}
```

After every runtime-field write (`set_runtime_field`, `apply_runtime_field_patch`), the engine runs a **fixpoint pass**: scan all transitions, fire those whose predicates match, repeat until no transition changes any value. Capped at `MAX_ITERATIONS=50` to defend against contradicting rules in malformed cartridges.

Predicate ops: `'==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'not_contains'`. Patch values can be literals or `{op: 'inc'/'dec', delta: N}` for atomic increments.

Predicates and patches operate against the **same** three-tier value resolution as `get_runtime_field`: per-player overlay > global > default. Writes route by the field's `scope_per_player`.

The engine also drives:
- **`tickWorldClock(sessionId)`** — increments `world_time_minutes` by 10 per turn; emits `runtime:field` event for time-of-day so the UI atmosphere layer cross-fades.
- **`decrementConditions(sessionId)`** — spec 17 timed conditions tick. `conditions[]` entries with `duration_turns` decrement and drop at 0.
- **`decrementSurfaces(sessionId)`** — spec 33 environmental surface decay.

Each of these is called once per turn before the preamble is built ([packages/web-server/src/turnRunnerV2.ts:271-282](../../packages/web-server/src/turnRunnerV2.ts#L271-L282)).

The `runtimeFieldEvents` module ([packages/web-server/src/runtimeFieldEvents.ts](../../packages/web-server/src/runtimeFieldEvents.ts)) is the canonical `runtime:field` SSE owner. It can emit from a full `{owner_entity_id, field_key, value}` payload or from a field id. Field-id emission looks up the owner/key and, for raw JSONB ops like `append`, reads the final stored value so `useRuntimeFields` receives the complete array/object rather than the patch argument.

Current event-covered writers:

- `set_runtime_field` emits the written value.
- `apply_runtime_field_patch` emits final state after commit; `append`, `remove`, and `merge` read back the stored value.
- `evaluateTransitions(playerId, sessionId)` emits fields changed by fixpoint transition patches.
- `decrementConditions(sessionId)` and `decrementSurfaces(sessionId)` emit final arrays when decay changes state.
- Direct surface/condition helpers (`apply_surface`, combat condition append, item `applies_surface`) reuse the same field-id helper.

## Sources

- [packages/web-server/src/transitionEngine.ts](../../packages/web-server/src/transitionEngine.ts) — fixpoint evaluator, world clock, condition/surface decay
- [packages/web-server/src/runtimeFieldEvents.ts](../../packages/web-server/src/runtimeFieldEvents.ts) — runtime:field SSE emission
- [packages/web-server/src/tools/runtime.ts](../../packages/web-server/src/tools/runtime.ts) — `get_runtime_field`, `set_runtime_field`, `apply_runtime_field_patch`
- [packages/web-server/migrations/0001_cartridge.sql](../../packages/web-server/migrations/0001_cartridge.sql) — runtime_fields, runtime_values, transitions
- [packages/web-server/migrations/0002_litrpg.sql](../../packages/web-server/migrations/0002_litrpg.sql) — runtime_player_overlay, scope_per_player flag
