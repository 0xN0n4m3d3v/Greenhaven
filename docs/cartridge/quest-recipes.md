# Quest recipes

Worked authoring patterns for the quest schema in [db/quest-schema.md](../db/quest-schema.md). Three full examples (Mikka's Private Price, Lost Cache, Captain Brass duel) plus the predicate / reward / branch / timer reference.

## Stage anatomy

A stage is one entry in the quest profile's `stages[]`:

```json
{
  "id": "initiation",
  "name": "Initiation",
  "description": "The active player commits to the encounter.",
  "objectives": [/* predicates */],
  "advance_on": "all" | "any" | "all_objectives_complete" | "any_objective_complete",
  "next_stage": "escalation"            // null = final stage
}
```

The **id** is the FK from `player_quests.current_stage_id`. Once published, never rename — `path_taken` arrays referencing the old id break.

The **name** + **description** appear in UI quest panels and in the broker preamble.

The **objectives** are an array of predicates evaluated each turn by [packages/web-server/src/quest/objectiveEvaluators.ts](../../packages/web-server/src/quest/objectiveEvaluators.ts). All evaluate against the player's tool history, narrative buffer, and runtime field state.

**advance_on** decides AND-vs-OR semantics. **next_stage = null** flags the terminal — auto-complete on advance.

Each stage may carry optional per-stage `rewards`, `branches`, and `timers.turns_max`.

## Objective predicates

Six kinds, all evaluated by [packages/web-server/src/quest/objectiveEvaluators.ts](../../packages/web-server/src/quest/objectiveEvaluators.ts):

```jsonc
// 1. tool_called — broker fired a tool with matching args this session
{"kind": "tool_called", "tool": "string_award",
 "args_match": {"npc": "Mikka Quickgrin", "delta_min": 1}}

// 2. field_threshold — declared runtime field crossed
{"kind": "field_threshold", "owner_entity_id": 400,
 "field_key": "payment_confirmed", "op": "==", "value": true}

// 3. inventory_has — holder has at least qty of item
{"kind": "inventory_has", "holder_id": "<active player entity id>", "item": "Lockpick", "qty": 1}

// 4. quest_completed — another quest is in status='completed'
{"kind": "quest_completed", "quest_display_name": "Mikka's Trust"}

// 5. entity_visited — player ever visited a location
{"kind": "entity_visited", "entity_id": 100}

// 6. flag_set — accumulated_state[key] === value
{"kind": "flag_set", "flag_key": "lockpick_attempted", "value": true}
```

`args_match` for `tool_called` supports nested path matching (`{"args.target.id": 200}`) and bounds (`delta_min`, `amount_min`). The evaluator AND-merges every key.

## Reward shapes

Top-level `profile.rewards` (applied on `complete_quest`):

```json
{
  "xp": 75,
  "strings": [{"npc": "Mikka Quickgrin", "delta": 1}],
  "memory": {
    "owner": "Mikka Quickgrin",
    "about": "<active player entity id>",
    "text": "A real one. Paid in body and felt every coin.",
    "importance": 0.85,
    "tags": ["intimate-aftermath"]
  },
  "inventory": [{"item": "Marked Coin", "qty": 1}],
  "sex_move_eligible": true        // unlocks the partner's profile.sex_move
}
```

Per-stage `rewards` follow the same shape and apply on advance. Reward Calibrator (spec 47) audits; broker can override any reward but must pass `calibrator_override_reason`.

`applyQuestRewards` ([packages/web-server/src/tools/quest.ts](../../packages/web-server/src/tools/quest.ts)) translates the block into `award_xp` / `string_award` / `add_memory` / `inventory_transfer` calls.

## Branches

Stage-level forks. Surface in UI as click affordances:

```json
{
  "branches": [
    {"id": "accept", "label": "Take the deal",
     "set_state": {"deal_taken": true}, "advance_to": "escalation"},
    {"id": "refuse", "label": "Walk away",
     "fail": true, "rewards": {"strings": [{"npc": "Mikka Quickgrin", "delta": -1}]}},
    {"id": "haggle", "label": "Negotiate",
     "applies_when": [{"kind": "field_threshold",
                       "owner_entity_id": 200, "field_key": "mood_string",
                       "op": "==", "value": "warm"}],
     "advance_to": "haggle_phase"}
  ]
}
```

Spec 25 routing: when the player picks `Haggle`, the message arrives as `[quest:Mikka's Private Price] Haggle`. `maybeApplyQuestChoice` matches the label, writes `accumulated_state.pending_choice='haggle'`, the next-turn evaluator picks it up.

`applies_when` predicates gate visibility — branches with unmet predicates don't render in the UI.

## Timers

Per-stage timer lives in `accumulated_state.turns_remaining`:

```json
{
  "id": "escalation",
  "timers": {"turns_max": 5, "timeout_branch": "cool_off"},
  "next_stage": "climax"
}
```

`tickQuestTimers` ([packages/web-server/src/quest/questEngine.ts](../../packages/web-server/src/quest/questEngine.ts)) decrements each turn. At 0:
- If `timeout_branch` set → set `pending_choice` to that branch.
- Else mark `failure_reason='timeout'` and apply `failure_conditions`.

Profile-root `timers.stage_turns_max` sets a default for every stage that doesn't override.

## Worked examples

### Mikka's Private Price (intimacy quest)

The original spec-21 version used placeholder arousal/satisfaction fields. Spec 95 replaces it with the current deterministic stage shape: `approach → consent → foreplay → climax → aftermath`, plus the existing payment fields on scene `400` (`offered_gold`, `payment_confirmed`, `service_tier`, `next_step`) when literal gold is involved. Top-level rewards: 75 XP, +1 string, intimate-aftermath memory, `sex_move_eligible: true` (unlocks the post-climax leverage memo). Current cleanup lives in [packages/web-server/migrations/0058_intimacy_runtime_field_cleanup.sql](../../packages/web-server/migrations/0058_intimacy_runtime_field_cleanup.sql).

### Lost Cache of Quickgrin Lane (exploration quest)

Author pattern: cellar-discovery arc with `hidden_until_stage` gating. Stages: `investigate → find_entrance → open_lock → loot → exit`. Stage-3 objective is `tool_called: dice_check, label: '<player name> pick lock'` with `outcome: success`. Stage-2 spawns the cellar location with `spawn_entities[]` on `create_quest`. The cellar exists in the cartridge from day one (id stable) but `hidden_until_stage='find_entrance'` keeps it out of preamble until the player reaches that stage.

### Captain Brass duel (boss combat)

Significant-combat pattern from [packages/web-server/prompts/greenhaven.md:113](../../packages/web-server/prompts/greenhaven.md#L113). Stages: `engage → first_blood → turn_of_battle → finishing_blow → aftermath`. Each stage's objective is a `tool_called: damage` matched on `target` + `amount_min`. `hidden_until_stage` gates secondary foes (the NPC's bodyguards spawn at `turn_of_battle`). Rewards weighted heavily on the final stage: a memorable XP bump + a relic item + a cross-NPC string adjustment for witnesses.

The pattern: trivial scuffles skip the quest machinery (just `damage` + `narrate`); boss-level fights wrap in a dynamic quest so combat memory persists.

## Sources

- [packages/web-server/migrations/0029_quest_schema.sql](../../packages/web-server/migrations/0029_quest_schema.sql) — quest schema migration + Mikka's Private Price + Mikka's Trust seeds
- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md) — combat/intimacy/dynamic-quest authoring rules
