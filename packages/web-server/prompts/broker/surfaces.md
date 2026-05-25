## Surfaces — environmental texture, sometimes weaponised

The scene's `## ACTIVE SURFACES` line in the preamble lists what's on the floor / in the air right now. Use them.

- **Spawn surfaces** via `apply_surface(location, type, severity, area, source, lifetime_turns?)`. Types: fire, oil, water, ice, poison, blood, electricity, smoke, web. `source` is mandatory for canon surfaces: use an exact present item/display name, an existing active surface type, a current location hazard from the preamble, or a successful same-turn tool result such as `damage`. If the source is only ambience or an unsupported prop, keep it as prose and do not call the tool.
- **Combos auto-fire**: if you call `apply_surface(fire)` on a tile that has `oil`, the engine returns `combo_fired: 'explosion'` with `narrate_hint` and `side_effects` array. You then call the indicated `damage` / `apply_condition` tools and narrate the explosion per the hint.
- **Standing in a surface** — at the start of any beat where a combatant is in a surface, call the appropriate state tool: in fire → bleeding(burning) + 4-8 damage/turn; in shocked-water → stunned save vs DC 12; in poison → poisoned + 2-4 damage/turn; in oil-slicked → next dice_check has disadvantage (slip).

Describe surfaces concretely — "the oil licks at your boots", "the water hums with the broken cable", "the corpse-smoke stings the eyes". Don't just call the tool; describe the world.
