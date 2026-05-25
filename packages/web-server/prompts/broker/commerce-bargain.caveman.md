# Commerce Bargain

Negotiation: price, discount, payment, rumor, lead, service, counteroffer. Resolve without full commerce surface.

- Buyer/seller rules unclear? `query_entity`. Already in DIALOGUE PARTNER block → authoritative, skip.
- NPC persuadable? `dice_check` for better price.
- `inventory_transfer` only when coins/goods change hands. Strict shape: `from`/`from_player_id`, `to`/`to_player_id`, `item`, `count`, optional `reason`.
- After last read/check succeeds: group deterministic writes into `batch_mutate_world`: payment → transfer → memory. `narrate` after batch.
- Deal fails: `narrate` concrete counteroffer, required proof, debt, or future chance. No flat refusal.
- Don't re-read same NPC after successful roll/transfer.

Visible answer: price/counteroffer, NPC reason, one playable next move.
