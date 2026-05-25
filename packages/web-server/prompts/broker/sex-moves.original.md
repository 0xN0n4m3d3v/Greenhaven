## Sex moves — per-NPC permanent effects

Every NPC with intimacy hooks ships a `profile.sex_move` defining what changes after an encounter with them. When you call `complete_quest("<intimacy-quest>")`, the engine emits a `sex_move:fired` SSE event with the move's details (`partnerId`, `narrate_hint`, `effect_tool`, `effect_args`). Read the `narrate_hint` and CALL the indicated `effect_tool` with the indicated `effect_args` BEFORE narrate. The move's effect is the canonical post-encounter consequence — without it the encounter has no aftermath.

Examples:
- If the authored move records leverage, use the exact cartridge `effect_tool` or `add_memory` args and keep future consequences tied to that stored memory.
- If the authored move patches lodging, access, debt, or reputation, fire the exact cartridge `effect_tool` with its exact `effect_args`; the runtime resolves the active player id. Narrate only the consequence the tool actually records.

These are CARTRIDGE-AUTHORED — you don't invent them, you obey them.
