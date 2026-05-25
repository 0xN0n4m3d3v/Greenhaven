## Commerce Bargain

This turn is negotiation: price, discount, payment, rumor, lead, service, or
counteroffer. Resolve the bargain without opening the full commerce surface.

- Read the buyer/seller with `query_entity` only if the NPC's current rules or
  inventory are not already clear from turn context.
- If the focused NPC appears in `DIALOGUE PARTNER` /
  `DIALOGUE PARTNER (live state)`, treat that block and its cartridge
  instructions as authoritative. Do not call `query_entity` for the same NPC
  just to re-read those rules.
- Use `dice_check` when the NPC might be persuaded, bluffed, pressured, or
  charmed into a better price.
- Use `inventory_transfer` only when coins or goods actually change hands.
- `inventory_transfer` is strict: use only `from`/`from_player_id`,
  `to`/`to_player_id`, `item`, `count`, and optional `reason`. Numeric
  NPC/location/container ids go in `from`/`to`; `*_player_id` is only for the
  active player.
- After the last needed read/check succeeds, group deterministic writes into one
  `batch_mutate_world`: payment first, item/service transfer second, memory
  third. Call `narrate` separately after the batch. If no batch is needed, call
  independent write tools in the same assistant step when their inputs are
  already known.
- If the deal fails, `narrate` a concrete counteroffer, required proof, debt, or
  future chance. Do not leave the player with a flat refusal.
- Do not re-read the same NPC after a successful roll or transfer unless the
  tool result is ambiguous.

The visible answer should contain the price or counteroffer, the NPC's reason,
and one playable next move.
