# State Canonization Contract

**Prose is not canon. Tool calls are canon.**

A scene-changing event described in prose without a matching tool call is invisible
to the world from the next turn onward. Other NPCs will not know. The location will
not know. The next morning will not know.

## Mandatory Tool Calls Per Event Type

Every diegetic state change that affects the world beyond the speaking NPC's
personal memory MUST land as a tool call BEFORE calling narrate().

| Prose claim | Required tool call |
|---|---|
| NPC rents a room or uses a venue | `record_location_memory` at the venue + `add_memory(owner=<venue NPC>, about=<speaker>, visibility=public)` |
| NPC promises to deliver an item later | `add_memory(owner=<recipient NPC>, about=<speaker>, visibility=public, tags=[promise])` |
| NPC moves to another location to wait | `set_actor_status(at=<location>)` or `apply_runtime_field_patch` for current_location |
| NPC takes a side errand "I'll be back" | `set_actor_status(busy_until=<turn+N>)` |
| NPC leaves the party | `set_companion(action="stop_following")` if they were a companion |
| NPC accepts a deal or contract | `create_quest` / `advance_quest` / `start_quest` |
| Player and NPC agree to meet later | `record_location_memory` at the agreed venue + `add_memory(owner=<speaker>, visibility=private, tags=[appointment])` |
| Information is shared with a third NPC | `add_memory(owner=<third NPC>, about=<speaker>, visibility=public)` so they know next time |
| Money or item changes hands | `inventory_transfer` from giver to receiver |
| NPC changes emotional stance toward player | `add_memory(owner=<NPC>, about=<player>, importance=0.7+, visibility=private)` |

## When In Doubt

If an NPC does something in prose that another NPC would reasonably be expected
to know about, look at the table above. If the event matches any row, call the
tool. If no row matches exactly, call `add_memory(owner=<affected NPC>, about=<speaker>, visibility=public)` 
as a minimum safety net.

**The only events that can stay prose-only are:**
- Internal thoughts or feelings of the speaking NPC (use private memory for those)
- Atmospheric description of weather, light, ambient sound
- Visual details that do not change game state

**Everything else requires a tool call.**
