-- 0005_fix_payment_recipe.sql — rewrite the cartridge's PAYMENT-ACCEPTED
-- RECIPE so it references real, registered tool signatures. The
-- original 0003 seed was written against a planned tool surface
-- (`set_runtime_field(... scope=per-player)`, `inventory_transfer(hero,
-- mikka, gold-coin, N)`, etc.) that diverged from what eventually
-- shipped:
--   * scope param values are 'per_player' / 'global', not 'per-player'
--   * inventory_transfer takes display_name strings (or numeric ids),
--     not the bare tokens 'hero' / 'mikka' / 'gold-coin'
--   * apply_runtime_field_patch (added 0429) lets us collapse four
--     set_runtime_field calls into one atomic write
--
-- The previous text was also unreachable from the model — query_entity
-- didn't surface entity_instructions. That's now fixed by
-- runtimeContext.ts. Combined with this rewrite, when the model loads
-- Mikka's quest (id 500) it will see a recipe it can actually execute
-- step by step.

UPDATE entity_instructions
   SET instruction_json = jsonb_build_object(
         'text',
         E'PAYMENT-ACCEPTED RECIPE — when the player offers >= 10 gold and you accept, run these tools IN ORDER, then narrate. None of them is optional; skipping any leaves the quest stuck in the pricing phase.\n' ||
         E'\n' ||
         E'  1. inventory_transfer(from=<player display_name or numeric player id>, to="Mikka Quickgrin", item="Gold Coin", count=N, reason="Paid for {tier}")\n' ||
         E'  2. apply_runtime_field_patch(patches=[\n' ||
         E'       {field_id: 2001, value: N},                          // offered_gold (per-player)\n' ||
         E'       {field_id: 2002, value: true},                       // payment_confirmed (per-player)\n' ||
         E'       {field_id: 2003, value: "base"|"upgrade"|"extended"},// service_tier (per-player)\n' ||
         E'       {field_id: 2008, value: "service"},                  // next_step (per-player)\n' ||
         E'     ])\n' ||
         E'  3. set_runtime_field(field_id=2101, value="paid")          // Mikka''s global mood\n' ||
         E'  4. award_xp(amount=50, reason="first_payment")\n' ||
         E'  5. add_memory(owner="Mikka Quickgrin", about=<player display_name or id>, text="Paid N gold for {tier}", importance=0.7)\n' ||
         E'  6. start_quest(quest="Mikka''s Private Price")              // if not already active\n' ||
         E'  7. narrate(text="...", author="Mikka Quickgrin", tone="npc", done=true)\n' ||
         E'\n' ||
         E'After step 2 the cartridge transition (id 900) auto-fires and the scene flips into service mode. If you only do step 1 (transfer gold) without step 2 (the field patch), the world thinks Mikka was robbed — gold moved but the quest never advanced.'
       )
 WHERE id = 50;
