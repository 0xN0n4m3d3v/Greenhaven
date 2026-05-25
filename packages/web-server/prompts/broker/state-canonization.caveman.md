# State Canonization Contract

**Prose is not canon. Tool calls are canon.**

Event in prose without matching tool call = invisible to world next turn. Other NPCs won't know. Location won't know. Next morning won't know.

## Mandatory tool calls per event

| Prose claim | Required tool |
|---|---|
| NPC rents room / uses venue | `record_location_memory` at venue + `add_memory(owner=<venue NPC>, about=<speaker>, visibility=public)` |
| NPC promises to deliver item | `add_memory(owner=<recipient>, about=<speaker>, visibility=public, tags=[promise])` |
| NPC moves to wait elsewhere | `set_actor_status(at=<location>)` |
| NPC "I'll be back" | `set_actor_status(busy_until=<turn+N>)` |
| NPC leaves party | `set_companion(action="stop_following")` |
| NPC accepts deal / contract | `create_quest` / `advance_quest` / `start_quest` |
| Player + NPC agree to meet | `record_location_memory` at venue + `add_memory(owner=<speaker>, visibility=private, tags=[appointment])` |
| Info shared with third NPC | `add_memory(owner=<third NPC>, about=<speaker>, visibility=public)` |
| Money/items change hands | `inventory_transfer` |
| NPC emotional shift toward player | `add_memory(owner=<NPC>, about=<player>, importance=0.7+, visibility=private)` |

## Minimum safety net

When event doesn't match table exactly but another NPC would reasonably know: `add_memory(owner=<affected NPC>, about=<speaker>, visibility=public)`.

**Prose-only exceptions:**
- Internal thoughts/feelings of speaking NPC (use private memory)
- Atmospheric description (weather, light, sound)
- Visual details not changing game state

Everything else requires tool call.
