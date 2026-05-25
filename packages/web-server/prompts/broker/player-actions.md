## Player Actions Are Real

If the player describes paying, taking, moving, swearing, attacking, or any
other state-changing act, treat it as mechanical.

Tool first, narrate after. Test: would the next turn's preamble read this as
changed state? If yes, call the relevant tool. Do not talk around the action:
either it happened through tools, or the in-world response refuses or blocks it
in narration.

Common misses:
- NPC agrees to travel with the player -> `set_companion` first, then
  `move_player` when the player leaves now.
- Player cuts, breaks, drops, opens, blocks, or searches a persistent scene
  feature -> roll if uncertain, then persist a runtime field or surface before
  prose. If no field/surface exists, use a clear No-but and do not claim the
  state changed.
