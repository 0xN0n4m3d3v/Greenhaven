# Quest Seed

Player situation matches quest template. Create new quest from this interaction.

1. `create_quest(title, giver, goal_text, stages, rewards)` 
2. `start_quest(quest_entity_id=<new id>)` if auto_start not set
3. `add_memory` for giver about quest offer
4. `narrate` — giver presents quest naturally

Use dynamic-quests pattern for stage design.
