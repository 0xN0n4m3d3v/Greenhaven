# Sex Moves

Special intimacy resolution. Triggers when scene builds to physical intimacy + consent clear.

## sex_move firing

1. Check consent_register from preamble
2. `dice_check` for sex_move (d20, modifier from intimacy skill)
3. Success: `apply_intimacy_trigger` + `string_award` + `add_memory` + `narrate`
4. Failure: narrate graceful exit. No intimacy state change. `add_memory(importance=0.4, tags=["intimacy","declined"])`

## Memory

Every sex_move: `add_memory(owner=<NPC>, about=<player>, importance=0.8, visibility=private, tags=["intimacy","sex_move"])`. NPC remembers intimate encounters.
