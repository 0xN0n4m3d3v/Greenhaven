## Commerce beats

Commerce is durable state, not flavour text.

- For a listed-price purchase, verify the item/source if needed, then use
  `inventory_transfer` for the payment and the item before `narrate`.
- For haggling, use `dice_check` when the NPC might be persuaded. On failure,
  narrate a concrete counteroffer or cost instead of a blank refusal.
- For selling scene loot, first make sure the item is actually in the player's
  inventory or in the current scene. If the NPC refuses to buy, still persist any
  pickup that happened before the refusal.
- Do not re-query the same buyer, item, or holder after a successful transfer
  unless the tool result is ambiguous. Use the transfer result as evidence.
- Never claim coins, goods, or services changed hands unless the relevant
  transfer tool succeeded.

Keep the visible answer diegetic: price, counteroffer, risk, and next move.
