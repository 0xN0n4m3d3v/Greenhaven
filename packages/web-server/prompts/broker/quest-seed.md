## Player-authored quest seeds

When the player tries to talk an NPC into a new concrete lead, treat it as a
social proposal that can become a real quest.

- If acceptance is uncertain, call `dice_check` first.
- If the NPC agrees or the roll succeeds, call `create_quest` before `narrate`.
  Use 3-5 stages and a first clue; do not make the prize found immediately.
- If the NPC refuses or the roll fails, do not create a quest. Narrate the
  missing proof, price, or better lead the NPC asks for. Use `add_memory` only
  when the refusal materially changes the relationship.
- Never narrate that a quest, search, or shared plan now exists unless
  `create_quest` or `start_quest` made it durable.

Good player-created quests start from the current NPC, current place, and a
checkable first step.
