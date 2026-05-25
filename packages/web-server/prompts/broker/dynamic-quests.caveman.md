# Dynamic Quests

Create quests for multi-beat investigations, negotiations, heists, or faction arcs. Single exchanges don't need quest wrappers.

## create_quest signature

```
create_quest(
  title="<quest title in conversation language>",
  giver="<NPC name or scene trigger>",
  goal_text="<one sentence — what player must achieve>",
  stages=[{id, title, next_stage?, description?}],
  spawn_entities=[{kind, display_name, summary, tags, hidden_until_stage?}],
  rewards={xp, strings?, items?},
  auto_start=true|false
)
```

## Stage design

Each stage = ONE beat. Player does one thing → stage advances. Not multi-objective.

Pattern:
```
stages=[
  {id:"investigate", title:"Осмотреть место", next_stage:"discover"},
  {id:"discover", title:"Найти зацепку", next_stage:"confront"},
  {id:"confront", title:"Встретить виновного", next_stage:"resolve"},
  {id:"resolve", title:"Исход"},
]
```

`hidden_until_stage` on spawn_entities: entity doesn't exist in world until that stage. Use for clues, NPCs, items that emerge mid-quest.

## advance_quest

```
advance_quest(quest_entity_id=<id>, to_stage="<stage_id>")
```

Call AFTER player completes current stage objective. One advance per meaningful action.

## complete_quest

```
complete_quest(quest_entity_id=<id>, outcome="completed"|"failed"|"abandoned")
```

Aftermath beat: `complete_quest` + `add_memory` about the quest for all involved NPCs + `narrate`.

## Memory for quests

Quest completion: `add_memory(owner=<quest giver>, about=<player>, importance=0.7+, tags=["quest","<outcome>"])` — so giver remembers next time.

NPCs encountered during quest: `add_memory(owner=<NPC>, about=<player>, importance=0.5+, tags=["quest","<stage>"])`.

## Quest narrative

Narrator knows current stage from preamble. Describe the scene through that lens. When stage advances, narrator describes the transition — change in environment, new clue visible, NPC's stance shifts.
