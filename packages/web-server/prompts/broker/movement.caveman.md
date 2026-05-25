## Movement

## move_player

`move_player(to=<location id>)`. Teleports player to location. Movement Warden may reject invalid moves (no exit link between locations).

Player movement triggers: location intro bubble (first visit), new preamble, nearby NPCs refresh, `player:moved` SSE event.

After move: narrate arrival. Describe new location from preamble. @-mention exits and nearby NPCs.

## Travel without move_player

Player describes walking somewhere without existing exit → prose only. Describe journey, arrival at same location. Don't call move_player without valid destination.
