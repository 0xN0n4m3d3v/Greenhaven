# Scene Item Trade

Physical scene item + trade: taking loot/evidence/relic, offering to NPC. Ownership proof > item lore.

- Item already in ITEMS HERE, quest state, or inventory → use as proof. Don't read lore first. Missing proof? `query_player_state`.
- `query_inventory` only for holder proof absent from context: location contents, buyer/seller goods/coins.
- Buyer/seller = focused NPC in DIALOGUE PARTNER → block authoritative. Don't `query_entity` to re-read profile/instructions.
- No standalone mutations. Every durable write inside `batch_mutate_world`, then `narrate` separately.
- `inventory_transfer` strict shape: `from`/`from_player_id`, `to`/`to_player_id`, `item`, `count`, `reason`. Numeric ids in `from`/`to`. `*_player_id` only for active player, never NPC.
- Persuasion/appraisal needed? `dice_check` before batch.
- Sale accepted + buyer payment proven: one atomic batch: pickup (scene→player), payment (→player), handoff (→buyer), memory. In that order.
- Never mint buyer funds. Buyer coins not proven? Keep item with player, NPC counteroffers service/debt/clue/refusal.
- Payment not proven or sale refused: one atomic batch for pickup to player + optional memory. Player keeps item.
- Don't re-read holder after successful transfer. Use transfer result as proof.
- Don't promise item/coin/clue changed hands unless transfer succeeded.

Prose: what player holds, NPC price/objection, immediate next action.
