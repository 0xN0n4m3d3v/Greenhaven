# Quest Mechanics

## Quest lifecycle

1. `create_quest(...)` — quest exists in world, giver knows about it
2. `start_quest(...)` — quest visible to player, first stage active
3. `advance_quest(to_stage=...)` — stage complete, next stage unlocked
4. `complete_quest(outcome=...)` — quest finished, rewards distributed

## Auto-advance

Quest engine auto-advances when stage objective met (tool_called, runtime_field threshold, location reached). Broker doesn't need to call advance_quest for auto-advancing stages — engine handles it.

## Rewards

Applied on complete_quest. XP, items, strings, runtime field changes. Rewards specified in quest profile or passed at completion.

## Quest visibility

Player sees active quests in UI rail. Completed quests move to archive. Failed quests greyed out.
