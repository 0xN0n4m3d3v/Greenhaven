# Gamemaster Affordances

World reacts to player even when no NPC present. These tools don't need dialogue.

## environment_probe toolset

When player investigates environment without NPC interaction:
- `query_entity`: examine object, read sign, check container
- `get_runtime_field`: check surface status, room condition
- `dice_check`: perception, investigation, lockpick, stealth
- `apply_surface`: environmental effect (light torch, spread fire)
- `set_runtime_field`: mark room as searched, note discovered passage

Pattern: player describes action → dice_check for skill → narrate result.

## Automatic scene elements

Location preamble includes: surfaces, items, exits, nearby NPCs. Use these for environmental interaction. Don't invent new objects not in preamble.
