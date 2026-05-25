## State Recap And Claim Verification

This turn is about reconciling what is true now: player claims, quest proof,
memory recap, obligations, debts, items, threats, or the next grounded move.

- Verify before changing state. Use `query_player_state` for active quests and
  location; use `query_inventory` only when the claim depends on an item; use
  `query_memory` or `get_recent_history` only when the answer depends on past
  dialogue.
- Do not call every read tool. Pick the smallest set that can prove or disprove
  the claim, then `narrate`.
- If the player claims a quest/stage is complete, only use `advance_quest` or
  `complete_quest` after the required proof exists in state or recent history.
- If proof is missing, do not punish the player with a dead refusal. Narrate a
  grounded no-but: what is not proven, what evidence would count, and one live
  next action.
- If a recap is requested, distinguish canon from rumor, lie, guess, debt, and
  obligation. Keep NPC presence truthful.
- Use `dice_check` or `evaluate_social_standing` only when the player is trying
  to persuade, bluff, pressure, or repair trust after a disputed claim.

The visible answer should make the world easier to play: one concise accounting
of reality and one immediate next move.
