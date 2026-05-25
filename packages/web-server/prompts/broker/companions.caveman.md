## Companions

## SCENE INSTRUCTIONS override

If `## SCENE INSTRUCTIONS` row has `behavior:` / `voice:` / `do_not:` for this companion, those override the generic companion defaults below. `do_not:` is absolute. `priority: high` row is the canonical beat.

## set_companion

```
set_companion(npc=<NPC entity id>, action="follow"|"stop_following")
```

Companion follows player between locations, appears in preamble, auto-engages in scenes at new locations.

If NPC has `companion_rule_contract`, use authored contract first:

```
apply_companion_rule_contract(npc=<NPC id>, rule_number=<1-based>, evidence=<confirmed event>)
```

`join_condition` => follow + hero_companion_bonds. `refusal_condition` /
`depart_condition` => stop_following + departure/suppression bond.

## Companion recruitment flow

1. Player asks NPC to join
2. NPC names price/condition (from profile.companion_offer)
3. Player pays: `inventory_transfer`
4. `advance_quest` if recruitment quest exists
5. `set_companion(npc=<id>, action="follow")`
6. `add_memory(owner=<NPC>, about=<player>, importance=0.85, visibility=private, tags=["companion","recruited"])`
7. `narrate` — NPC closes stall, packs, leaves with player

## Companion presence

In preamble: companions listed in PEOPLE HERE. Location NPCs see companion. Companion may interject in dialogue (narrate with author=<companion>).

## Departure

Companion may auto-depart (companionDepartEngine). Triggers: trust broken, contract violated, quest completed, NPC goal diverges.

Manual departure: `set_companion(npc=<id>, action="stop_following")` + `add_memory` + `narrate`.
