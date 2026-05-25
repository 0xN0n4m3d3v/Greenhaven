# Quest schema

Quests are entities (`kind='quest'`); the per-player state lives in `player_quests`. The body — stages, objectives, rewards, branches, timers — is JSONB on the quest entity's `profile`. Authoring contract from [packages/web-server/migrations/0029_quest_schema.sql](../../packages/web-server/migrations/0029_quest_schema.sql).

## Quest entity profile

A `kind='quest'` entity in the `entities` table; its `profile` JSONB carries the body. Top-level keys:

```ts
{
  tags: ['intimacy' | 'social' | 'combat' | 'exploration' | ...],
  partner: '<NPC display_name>',         // optional, the giver / focal NPC
  goal: 'Free-text goal for the player',
  stages: [Stage, ...],                  // ordered
  rewards: { xp, strings, memory, sex_move_eligible? },  // top-level final rewards
  failure_conditions: [Predicate, ...],  // any-match → failed
  branches: [Branch, ...],               // optional choice / split points
  prereq: [Predicate, ...],              // gating before status='active'
  timers: { stage_turns_max?: number, ... },
}
```

Worked example — Mikka's Private Price profile:

```json
{
  "tags": ["intimacy"],
  "partner": "Mikka Quickgrin",
  "stages": [
    {
      "id": "initiation",
      "name": "Initiation",
      "description": "The active player commits …",
      "objectives": [
        {"kind": "tool_called", "tool": "string_award",
         "args_match": {"npc": "Mikka Quickgrin", "delta_min": 1}}
      ],
      "advance_on": "all_objectives_complete",
      "next_stage": "escalation"
    },
    /* … */
  ],
  "rewards": {"xp": 75, "strings": [...], "memory": {...}, "sex_move_eligible": true},
  "failure_conditions": [
    {"kind": "field_threshold", "owner_entity_id": 200,
     "field_key": "mood_string", "op": "==", "value": "reluctant"}
  ]
}
```

## player_quests state

Per-player state. Defined at [packages/web-server/migrations/0002_litrpg.sql](../../packages/web-server/migrations/0002_litrpg.sql); extended by [packages/web-server/migrations/0029_quest_schema.sql](../../packages/web-server/migrations/0029_quest_schema.sql).

| Column | Type | Notes |
|---|---|---|
| `player_id`, `quest_entity_id` | `BIGINT` | composite PK |
| `status` | `TEXT` | `'unseen' \| 'offered' \| 'active' \| 'completed' \| 'failed'` |
| `current_stage_id` | `TEXT` | matches `entities[id=quest_entity_id].profile.stages[].id` |
| `accumulated_state` | `JSONB` | scratchpad — `pending_choice`, branch trackers, stage timers (`turns_remaining`), per-stage tags |
| `path_taken` | `JSONB` | array of `{stage_id, at}`; chronological path through the FSM |
| `started_at`, `completed_at` | `TIMESTAMPTZ` |  |

Status transitions:
- `unseen` → cartridge author's seed default; quest exists but player hasn't been offered it.
- `offered` → cartridge or broker shows the quest hook; player can accept.
- `active` → `start_quest` fired; engine evaluates objectives every turn.
- `completed`/`failed` → `complete_quest` fired or auto-completer terminated.

Quest mutation tools are idempotent after Spec 78:

- `start_quest` on an existing active/terminal row returns `changed:false` and emits no duplicate card.
- `advance_quest` on a terminal quest, inactive quest, or same target stage/phase returns `changed:false`.
- `complete_quest` applies rewards only on the first terminal transition.
- Quest targeting is id-first after Spec 87: pass `quest_id` to `start_quest`, `advance_quest`, and `complete_quest`; legacy `quest` title/id strings are fallback only.
- Player targeting is id-first: pass `player_id` or omit it for the current session player; string `player` is legacy compatibility.

The auto-evaluator at [packages/web-server/src/quest/questEngine.ts](../../packages/web-server/src/quest/questEngine.ts) runs once per turn before the model fires:
1. Read each active quest's profile + current stage.
2. Tick stage timers in `accumulated_state.turns_remaining`.
3. Evaluate `failure_conditions` — any match → `failed`.
4. Evaluate stage `objectives` — `advance_on='all'`/`'any'` decides advance.
5. `next_stage === null` → auto-complete via `applyQuestRewards`.

Spec 39 Quest Watcher catches *narrative* progress that hard predicates miss; spec 49 Quest Pacer flags overload/stale.

## Objectives

Each stage's `objectives[]` is an array of predicates. The predicate kinds and shapes are evaluated by [packages/web-server/src/quest/objectiveEvaluators.ts](../../packages/web-server/src/quest/objectiveEvaluators.ts).

| Kind | Schema | Meaning |
|---|---|---|
| `tool_called` | `{kind, tool, args_match: {…}}` | At least one tool call this session matches the tool name AND every key/value in args_match. |
| `field_threshold` | `{kind, owner_entity_id, field_key, op: '<'/'<='/'>'/'>='/'==', value}` | A runtime field crosses the threshold. |
| `inventory_has` | `{kind, holder, item, qty?}` | Holder has ≥ qty of item. |
| `quest_completed` | `{kind, quest_display_name}` | Another quest is in status='completed'. |
| `entity_visited` | `{kind, entity_id}` | Player's `current_location_id` ever equalled the target. |
| `flag_set` | `{kind, flag_key, value?}` | `accumulated_state[flag_key] === value`. |

`advance_on` (one of the four aliases below; null/missing defaults to AND):
- `'all'` / `'all_objectives_complete'` → AND of all objectives.
- `'any'` / `'any_objective_complete'` → OR.

To advance on a broker / Quest Watcher decision instead of objective
evaluation, omit `objectives` or set them to a `tool_called` kind and
have the broker / Quest Watcher call `advance_quest` directly — there
is no `'manual'` advance mode at the runtime layer.

## Rewards

`rewards` block at the quest profile root applies on `status='completed'`. Per-stage `rewards` (optional) apply on advance.

```ts
{
  xp: number,
  strings: [{npc: string, delta: number}, ...],
  memory: {
    owner_entity_id?: number,
    about_entity_id?: number,
    owner?: string,
    about?: string,
    text: string,
    importance?: number
  },
  inventory: [{item: string, qty: number}, ...],
  sex_move_eligible: boolean,                  // unlocks profile.sex_move firing
}
```

`applyQuestRewards` ([packages/web-server/src/tools/quest.ts](../../packages/web-server/src/tools/quest.ts)) translates the block into durable state writes (`players`, `player_xp_log`, `strings`, `npc_memories`, runtime fields). It runs only once when `complete_quest` transitions into `completed`; repeated completion calls return no-op data. Memory rewards prefer numeric `owner_entity_id` / `about_entity_id`; omitted `owner` means the active player id, and string refs are legacy fallback.

## Branches & timers

**Branches** ([packages/web-server/src/quest/objectiveEvaluators.ts](../../packages/web-server/src/quest/objectiveEvaluators.ts)) are stage-level forks. A branch carries:

```ts
{
  id: string,                   // matches the option label shown to the player
  label: string,                // displayed in UI
  applies_when?: [Predicate],   // gating; branch hidden if false
  set_state?: {…},              // accumulated_state patches
  advance_to?: string,          // next stage to jump to
  fail?: boolean,               // mark quest failed
  rewards?: {...},              // optional per-branch
}
```

Spec 25 quest-choice routing is the wire: when the player picks a branch, the message arrives as `[quest:Quest Name] Option Label`. `maybeApplyQuestChoice` matches the label to an option and writes `accumulated_state.pending_choice`. The downstream `evaluateActiveQuests` picks it up next turn.

**Timers**:
- Stage-level `turns_remaining` in `accumulated_state.turns_remaining` (set on advance, decremented every turn). At 0 → either fail the stage or follow `advance_to` of a `timeout_branch` if defined.
- `timers.stage_turns_max` at the profile root sets a default for every stage that doesn't override.
- Decrementer: `tickQuestTimers` in [packages/web-server/src/quest/questEngine.ts](../../packages/web-server/src/quest/questEngine.ts).

See [cartridge/quest-recipes.md](../cartridge/quest-recipes.md) for full authoring patterns and worked examples (Mikka's Private Price, Lost Cache, Captain Brass duel).

## Sources

- [packages/web-server/migrations/0029_quest_schema.sql](../../packages/web-server/migrations/0029_quest_schema.sql) — schema migration + Mikka's Private Price + Mikka's Trust seeds
- [packages/web-server/src/quest/questEngine.ts](../../packages/web-server/src/quest/questEngine.ts) — `evaluateActiveQuests`, timer tick, auto-advance
- [packages/web-server/src/quest/objectiveEvaluators.ts](../../packages/web-server/src/quest/objectiveEvaluators.ts) — predicate kind dispatchers
