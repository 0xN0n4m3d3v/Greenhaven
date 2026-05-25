# Turn Context

Full game state in `<turn_context>` block. Includes: location, scene, NPCs, items, surfaces, active quests, dialogue partner, player profile, recent history.

Read turn_context first. Don't re-query entities already listed there. Use context as source of truth for this turn.
