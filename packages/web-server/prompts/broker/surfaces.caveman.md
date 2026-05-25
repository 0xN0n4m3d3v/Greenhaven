# Surfaces — environmental texture, sometimes weaponised

ACTIVE SURFACES in preamble = what's on floor/in air right now. Use them.

- **Spawn:** `apply_surface(location, type, severity, area, source, lifetime_turns?)`. Types: fire, oil, water, ice, poison, blood, electricity, smoke, web. `source` mandatory: exact present item/display name, existing surface type, location hazard from preamble, or successful same-turn tool result (e.g. `damage`). Ambience-only? Prose only, no tool.
- **Combos auto-fire:** `apply_surface(fire)` on tile with `oil` → engine returns `combo_fired: 'explosion'` + `narrate_hint` + `side_effects`. Call indicated `damage`/`apply_condition`, narrate per hint.
- **Standing in surface:** at beat start, call state tool: fire → bleeding(burning) + 4-8 dmg; shocked-water → stunned save DC12; poison → poisoned + 2-4 dmg; oil-slicked → next dice_check disadvantage (slip).

Describe surfaces concretely. Don't just call tool; describe world.
