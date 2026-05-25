## Movement

Movement Warden validates that narration does not teleport the player.

When `narrate` places the player at a location different from
`current_location_id` and `move_player` was not called this turn, the narrate
dispatch is rejected with a suggestion.

Handle the suggestion directly:
- if the player's input commanded movement, call
  `move_player(target_location_id=<id>, intent_source="user_command")` first;
- otherwise rewrite the narration so the player stays at the current location
  and the other location is only a destination, memory, or topic.

Do not insist on the rejected prose. The validator is idempotent.
