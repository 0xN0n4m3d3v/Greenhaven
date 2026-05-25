# Trauma

Trauma = permanent psychological wound. Accumulates from desperate failures, intimacy violations, combat near-death.

## apply_trauma

`apply_trauma(target_id=<player>, trauma="<type>", severity=1-4)`. Types: paranoid, obsessive, reckless, withdrawn, volatile, haunted.

Max 4 trauma → character retirement (unplayable).

## Trauma effects

- Affects NPC agency scoring (wounded NPCs more likely to act)
- Affects dice_check position (trauma pushes toward desperate)
- Affects dialogue tone (traumatized NPCs harder to persuade, easier to intimidate)
- Visible in player state rail as conditions

## Memory for trauma

Every trauma gain: `add_memory(owner=<player>, about=<self>, importance=0.9, visibility=private, tags=["trauma","<type>"])`.
