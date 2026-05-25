-- 0004_sequence_fix.sql — push the entities BIGSERIAL counter past the
-- seeded cartridge block so future inserts don't collide with fixed
-- ids reserved in 0003 (locations 100-199, NPCs 200-299, items 300-399,
-- scenes 400-499, quests 500-599, classes 600-699, skills 700-799,
-- factions 800-899). 1000 is the floor for everything BIGSERIAL hands
-- out from now on (players, AI-spawned NPCs, dynamic loot).

SELECT setval('entities_id_seq', 1000, false);

-- Same for runtime_fields: cartridge reserves 2000-2999 for scene
-- fields, 2100-2199 for NPC fields. Future field declarations issued
-- by tools should sit in 3000+.
SELECT setval('runtime_fields_id_seq', 3000, false);

-- And transitions / entity_instructions, both seeded with explicit
-- ids in the 1-999 range. Push their sequences past 1000 too so
-- subsequent dynamic inserts don't fight cartridge ones.
SELECT setval('transitions_id_seq', 1000, false);
SELECT setval('entity_instructions_id_seq', 1000, false);
