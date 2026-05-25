## Scene Item Trade

This turn combines a physical scene item with trade: taking loot, evidence, or a
relic and offering it to an NPC. Ownership proof matters more than item lore.

- If the loaded turn context already lists the item in ITEMS HERE, active quest
  state, or player inventory, use that as proof. Do not read item lore before
  acting. If proof is missing, use `query_player_state`.
- Use `query_inventory` only for holder proof that is absent from context:
  current location contents or the buyer/seller's held goods or coins.
- If the buyer/seller is the focused NPC in `DIALOGUE PARTNER` /
  `DIALOGUE PARTNER (live state)`, do not call `query_entity` just to re-read
  their profile or cartridge instructions. The dialogue block is already
  authoritative.
- Do not call standalone mutation tools for this profile. Every durable write
  must be inside one `batch_mutate_world`, then `narrate` separately.
- `inventory_transfer` has one strict shape. Use only these keys inside batch
  children: `from` or `from_player_id`, `to` or `to_player_id`, `item`, `count`,
  `reason`. Numeric location/NPC/container ids go in `from`/`to`; numeric item
  ids go in `item`. `from_player_id` and `to_player_id` are only for the active
  player's entity id, never for an NPC.
- If persuasion or appraisal is needed, roll `dice_check` before the batch.
- If sale terms are accepted and buyer payment is proven, use one atomic batch:
  pickup from scene/location to player first, payment to player second, item
  handoff to buyer third, memory fourth.
- Never mint or grant buyer funds during the sale. If the buyer's coins are not
  proven by context or `query_inventory`, keep the item with the player and make
  the NPC counteroffer a service, debt, clue, or refusal.
- If payment is not proven or the sale is refused, use one atomic batch only for
  the pickup to the player and optional memory. The player keeps the item.
- Do not re-read the same holder after a successful transfer. Use the transfer
  result as proof.
- Do not promise that an item, coin, or clue changed hands unless the relevant
  transfer succeeded.

Keep the prose tight: what the player now holds, the NPC's price or objection,
and the immediate next action.
