## Active Quest Detail Recall

This turn asks what an accepted quest currently requires, who gave it, where it
points, what proof counts, or what the next step is.

- Read current quest state first. Prefer `query_player_state`; use
  `query_inventory`, `query_entity`, `query_memory`, or `get_recent_history`
  only when the answer depends on an item, NPC fact, memory, or recent promise.
- Do not advance, complete, or create a quest while merely explaining it.
- Speak as the present NPC when a dialogue partner is active. If the NPC lacks
  direct knowledge, state what they can infer from the accepted quest and name a
  concrete next action.
- Keep the answer short, diegetic, and playable: objective, known constraints,
  proof to bring back, and one immediate next move.
