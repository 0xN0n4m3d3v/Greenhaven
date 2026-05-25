-- 0058_intimacy_runtime_field_cleanup.sql
--
-- Spec 95: remove stale prompt-facing intimacy objectives that named
-- runtime fields never declared by the cartridge. Mikka's Private Price
-- is driven by explicit quest stages plus the existing payment runtime
-- fields on scene 400, not invented arousal/satisfaction meters.

UPDATE entities
   SET tags = ARRAY(
         SELECT DISTINCT tag
           FROM unnest(COALESCE(tags, ARRAY[]::text[]) || ARRAY['quest','payment_exchange','intimacy']::text[]) AS t(tag)
       ),
       profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
         'tags', jsonb_build_array('intimacy', 'payment_exchange'),
         'partner', 'Mikka Quickgrin',
         'giver', 'Mikka Quickgrin',
         'giver_id', 200,
         'scene_id', 400,
         'stages', jsonb_build_array(
           jsonb_build_object(
             'id', 'approach',
             'name', 'Approach',
             'description', 'The player opens the private negotiation or intimate offer. Start the quest if the player commits; do not claim payment or consent before tools establish it.',
             'objectives', '[]'::jsonb,
             'next_stage', 'consent'
           ),
           jsonb_build_object(
             'id', 'consent',
             'name', 'Consent and price',
             'description', 'Mikka accepts a concrete bargain, payment, or mutually agreed substitution. If literal gold is paid, use the PAYMENT-ACCEPTED RECIPE fields on scene 400.',
             'objectives', '[]'::jsonb,
             'next_stage', 'foreplay'
           ),
           jsonb_build_object(
             'id', 'foreplay',
             'name', 'Escalation',
             'description', 'The scene escalates through mutual action and recorded memory/string changes. No arousal or satisfaction runtime fields exist for this quest.',
             'objectives', '[]'::jsonb,
             'next_stage', 'climax'
           ),
           jsonb_build_object(
             'id', 'climax',
             'name', 'Climax',
             'description', 'The decisive beat lands. Advance here only when the fiction reaches the peak; complete the quest on the aftermath beat.',
             'objectives', '[]'::jsonb,
             'next_stage', 'aftermath'
           ),
           jsonb_build_object(
             'id', 'aftermath',
             'name', 'Aftermath',
             'description', 'Close the encounter with complete_quest, rewards, memories, strings, and the partner sex_move if eligible.',
             'objectives', '[]'::jsonb,
             'next_stage', NULL
           )
         ),
         'rewards', jsonb_build_object(
           'xp', 75,
           'strings', jsonb_build_array(jsonb_build_object('npc', 'Mikka Quickgrin', 'delta', 1)),
           'memory', jsonb_build_object(
             'owner', 'Mikka Quickgrin',
             'about', NULL,
             'text', 'A real one. The private price became a memory I can use later.',
             'importance', 0.85,
             'tags', jsonb_build_array('intimate-aftermath', 'leverage')
           ),
           'sex_move_eligible', true
         )
       )
 WHERE id = 500
   AND kind = 'quest'
   AND display_name = 'Mikka''s Private Price';

UPDATE player_quests
   SET current_stage_id = CASE current_stage_id
       WHEN 'initiation' THEN 'approach'
       WHEN 'escalation' THEN 'foreplay'
       ELSE current_stage_id
     END
 WHERE quest_entity_id = 500
   AND current_stage_id IN ('initiation', 'escalation');

UPDATE entity_instructions
   SET instruction_json = jsonb_build_object(
         'text',
         E'PAYMENT-ACCEPTED RECIPE - when the active player offers >= 10 gold and Mikka accepts, run these tools IN ORDER, then narrate. None of them is optional; skipping any leaves the quest stuck in the pricing phase.\n' ||
         E'\n' ||
         E'  1. inventory_transfer(from_player_id=<active player entity id>, to="Mikka Quickgrin", item="Gold Coin", count=N, reason="Paid for {tier}")\n' ||
         E'  2. apply_runtime_field_patch(patches=[\n' ||
         E'       {field_id: 2001, value: N},                          // offered_gold (per-player)\n' ||
         E'       {field_id: 2002, value: true},                       // payment_confirmed (per-player)\n' ||
         E'       {field_id: 2003, value: "base"|"upgrade"|"extended"},// service_tier (per-player)\n' ||
         E'       {field_id: 2008, value: "service"},                  // next_step (per-player)\n' ||
         E'     ], source="payment_accepted")\n' ||
         E'  3. set_runtime_field(field_id=2101, value="paid")          // Mikka status enum, not a numeric meter\n' ||
         E'  4. award_xp(amount=50, reason="first_payment")\n' ||
         E'  5. add_memory(owner="Mikka Quickgrin", about=<active player entity id>, text="Paid N gold for {tier}", importance=0.7)\n' ||
         E'  6. start_quest(quest="Mikka''s Private Price")              // if not already active\n' ||
         E'  7. narrate(text="...", author="Mikka Quickgrin", tone="npc", done=true)\n' ||
         E'\n' ||
         E'Use only these listed field_id values and their allowed values. Do not write arousal_level, satisfaction_level, or any guessed field id.'
       )
 WHERE id = 50;
