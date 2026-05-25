-- 0019_quiet_lantern_inn.sql — cartridge content extension.
--
-- Adds one location adjacent to Quickgrin Lane (the Quiet Lantern Inn),
-- one new NPC (Borek the innkeeper), and one new item (Wooden Mug of
-- Ale). Wires the inn into the existing world via two-way exits, gives
-- Borek a runtime mood + HP/AC/proficiency + ability scores, and seeds
-- his inventory (intake bag for gold + 20 mugs in stock).
--
-- Cartridge_meta updates: bumps version to 0.2.0, extends
-- reset_inventory_seeds and reset_runtime_overrides so /api/debug/reset-world
-- restores the new content correctly.
--
-- Pure data — engine code wasn't touched. Cartridge #2 would ship the
-- same shape of migration with its own ids.
--
-- Non-ASCII translations live in cartridge.ts seedCartridgeI18n() — see
-- the PGlite-Windows encoding note in 0018_cartridge_meta.sql.
--
-- ID space (per 0004 comment):
--   locations  100-199 → 110
--   NPCs       200-299 → 220
--   items      300-399 → 310
--   runtime    2000-2999 → 2300-2313

-- ── Inn ────────────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(110, 'location', 'Quiet Lantern Inn',
 'A small lantern-lit common room just off Quickgrin Lane. Smells of warm malt and woodsmoke; a low fire crackles in the corner.',
 jsonb_build_object(
   'narrator_brief',
     'You are the AMBIENT NARRATOR of the Quiet Lantern Inn — a small tavern tucked off the market. Wooden benches polished by decades of elbows, soft amber lantern light, the smell of warm malt and the slow crackle of a low fire. The street noise from Quickgrin Lane is muffled here. Speak FROM the place, never as Borek or any patron — describe what the player senses, the mood of the room.',
   'narrator_style', 'warm, slow, fireside'
 ),
 ARRAY['location','tavern','rest','quest hub'])
ON CONFLICT (id) DO NOTHING;

-- ── Borek ──────────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(220, 'person', 'Borek',
 'A weathered human innkeeper with a grizzled beard and patient eyes. Knows a quiet truth or two; trades them for coin or company.',
 jsonb_build_object(
   'species', 'human man',
   'age', 56,
   'profession', 'innkeeper at the Quiet Lantern',
   'self_description',
     'Broad shoulders gone slightly stooped. Grey-streaked beard, eyes that have watched a lot of customers come and go. Faded apron over a heavy linen shirt; sleeves rolled to forearms scarred from years of hot kettles and broken pottery.',
   'narrator_brief',
     'You ARE Borek. Voice: slow, thoughtful, low. Few words; lets silence carry weight. You serve drinks, listen more than you talk, share rumours when paid in coin or honest curiosity. NEVER narrate yourself in third person — speak as ''I''.',
   'temper', 'patient with quiet customers, short with loud ones',
   'speech_style', 'unhurried, low, occasional dry humour',
   'home_id', 110,
   'aliases', jsonb_build_array('the innkeeper', 'old man', 'barkeep', 'innkeep')
 ),
 ARRAY['person','npc','innkeeper','adult'])
ON CONFLICT (id) DO NOTHING;

-- ── Item: Wooden Mug of Ale ────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(310, 'item', 'Wooden Mug of Ale',
 'A heavy wooden mug, foam still settling. Smells of malt and a hint of woodsmoke.',
 jsonb_build_object(
   'price', 2,
   'effects', jsonb_build_object('heal_hp', 1),
   'aliases', jsonb_build_array('mug', 'ale', 'beer', 'drink', 'pint')
 ),
 ARRAY['item','consumable','tavern'])
ON CONFLICT (id) DO NOTHING;

-- ── Exits: bidirectional Quickgrin Lane ⇄ Quiet Lantern Inn ────────────

UPDATE entities
   SET profile = profile || jsonb_build_object(
     'exits', COALESCE(profile->'exits','[]'::jsonb) || jsonb_build_array(110)
   )
 WHERE id = 100 AND NOT (COALESCE(profile->'exits','[]'::jsonb) @> '[110]'::jsonb);

UPDATE entities
   SET profile = profile || jsonb_build_object('exits', jsonb_build_array(100))
 WHERE id = 110;

-- ── Runtime fields for Borek ───────────────────────────────────────────

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
VALUES
(2300, 220, 'mood', 'enum',
 '"tired"'::jsonb,
 '["tired","attentive","wary","warm"]'::jsonb,
 'session', false,
 'Borek''s general demeanour. Affects how chatty he is and how he reads strangers.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, scope, scope_per_player, description)
VALUES
(2310, 220, 'current_hp',         'int', '15'::jsonb, 'session',  false, 'Borek current HP'),
(2311, 220, 'max_hp',              'int', '15'::jsonb, 'permanent', false, 'Borek max HP'),
(2312, 220, 'armor_class',         'int', '11'::jsonb, 'permanent', false, 'Borek armor class'),
(2313, 220, 'proficiency_bonus',   'int', '2'::jsonb,  'permanent', false, 'Borek proficiency bonus')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (2300, '"tired"'::jsonb, 'cartridge_seed'),
  (2310, '15'::jsonb,       'cartridge_seed'),
  (2311, '15'::jsonb,       'cartridge_seed'),
  (2312, '11'::jsonb,       'cartridge_seed'),
  (2313, '2'::jsonb,        'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;

-- ── Borek ability scores ───────────────────────────────────────────────

INSERT INTO npc_stats (npc_entity_id, stat_key, base, current) VALUES
  (220, 'STR', 12, 12),
  (220, 'DEX', 10, 10),
  (220, 'CON', 13, 13),
  (220, 'INT', 11, 11),
  (220, 'WIS', 14, 14),
  (220, 'CHA', 12, 12)
ON CONFLICT (npc_entity_id, stat_key) DO NOTHING;

-- ── Borek's inventory: intake bag + ale stock ──────────────────────────

INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count) VALUES
  (220, 300, 0),    -- gold intake
  (220, 310, 20)    -- 20 mugs in stock
ON CONFLICT (holder_entity_id, item_entity_id) DO NOTHING;

-- ── Borek narrative rule ───────────────────────────────────────────────

INSERT INTO entity_instructions
  (id, owner_entity_id, priority, applies_when, instruction_json)
VALUES
(2, 220, 10,
 '[]'::jsonb,
 jsonb_build_object(
   'text',
   'Borek is the active character at the Quiet Lantern Inn. He sells ale at 2 gold per mug. When a player offers gold:' ||
   E'\n' ||
   '  1. inventory_transfer(from=<player>, to="Borek", item="Gold Coin", count=N, reason="Bought N mug(s) of ale")' ||
   E'\n' ||
   '  2. inventory_transfer(from="Borek", to=<player>, item="Wooden Mug of Ale", count=floor(N/2))' ||
   E'\n' ||
   '  3. heal(target=<player>, amount=floor(N/2)) — drinking restores 1 HP per mug' ||
   E'\n' ||
   '  4. add_memory(owner="Borek", about=<player display_name>, text="Drank N mugs", importance=0.3)' ||
   E'\n' ||
   '  5. narrate(text="...", author="Borek", tone="npc", done=true)'
 ))
ON CONFLICT (id) DO NOTHING;

-- ── Cartridge meta updates ─────────────────────────────────────────────

UPDATE cartridge_meta
   SET value = '[
         {"holder_entity_id":200,"item_entity_id":300,"count":0},
         {"holder_entity_id":220,"item_entity_id":300,"count":0},
         {"holder_entity_id":220,"item_entity_id":310,"count":20}
       ]'::jsonb,
       updated_at = now()
 WHERE key = 'reset_inventory_seeds';

UPDATE cartridge_meta
   SET value = '[
         {"field_id":2101,"value":"pricing"},
         {"field_id":2102,"value":"dark"},
         {"field_id":2300,"value":"tired"},
         {"field_id":2310,"value":15}
       ]'::jsonb,
       updated_at = now()
 WHERE key = 'reset_runtime_overrides';

UPDATE cartridge_meta
   SET value = '"0.2.0"'::jsonb, updated_at = now()
 WHERE key = 'cartridge_version';
