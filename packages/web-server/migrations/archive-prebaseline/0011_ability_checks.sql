-- 0011_ability_checks.sql — D&D-style ability-check conventions on
-- items and NPCs.
--
-- Convention 1: items that resist physical or skill interaction
-- declare a `check` block on their profile:
--   profile.check = {
--     "ability": "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA",
--     "dc": <integer>,
--     "action": <short label>,        // e.g. "shove the crate"
--     "on_success": <one-line outcome>,
--     "on_failure": <one-line outcome>
--   }
-- The turn-context preamble surfaces this. The model is required by
-- prompt to dice_check before letting the player succeed.
--
-- Convention 2: NPCs declare `social_dcs` on profile, a flat map of
-- canonical social actions to DCs (CHA-based unless noted). Examples:
--   profile.social_dcs = {
--     "persuade":   {"ability": "CHA", "dc": 13},
--     "intimidate": {"ability": "CHA", "dc": 12},
--     "deceive":    {"ability": "CHA", "dc": 14},
--     "seduce":     {"ability": "CHA", "dc": 14},
--     "insight":    {"ability": "WIS", "dc": 13}     // player rolling
--   }
-- The check resolves vs the printed DC. NPCs with high WIS / INT are
-- harder to fool; with low CHA they're easier to bully.

-- ── New items in Quickgrin Lane ────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(302, 'item', 'Heavy Crate',
 'A weathered wooden crate, stamped with old shipping marks. Heavy enough that nobody''s in a hurry to move it.',
 jsonb_build_object(
   'description', 'A weathered wooden crate, half-blocking a side path. The wood has gone grey from years of rain.',
   'fixture', true,
   'aliases', jsonb_build_array('Тяжёлый ящик', 'Ящик'),
   'check', jsonb_build_object(
     'ability', 'STR',
     'dc', 14,
     'action', 'shove the crate aside',
     'on_success', 'the crate grinds across the cobbles, opening the path behind it',
     'on_failure', 'your feet skid on the wet stone — the crate barely shifts'
   )
 ),
 ARRAY['item','fixture','obstacle']),

(303, 'item', 'Vendor''s Cart',
 'A two-wheeled handcart loaded with empty barrels — abandoned mid-aisle by someone who got distracted.',
 jsonb_build_object(
   'description', 'A two-wheeled handcart loaded with stacked empty barrels. Tilted at an awkward angle, blocking traffic.',
   'fixture', true,
   'aliases', jsonb_build_array('Тележка торговца', 'Тележка'),
   'check', jsonb_build_object(
     'ability', 'CON',
     'dc', 12,
     'action', 'haul the cart out of the way',
     'on_success', 'lungs burning, you wrestle the cart upright and walk it to the verge',
     'on_failure', 'your grip slips, the barrels rattle, and you have to step back panting'
   )
 ),
 ARRAY['item','fixture','obstacle'])
ON CONFLICT (id) DO NOTHING;

-- Place them in Quickgrin Lane (location 100) inventory.
INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count) VALUES
  (100, 302, 1),
  (100, 303, 1)
ON CONFLICT (holder_entity_id, item_entity_id) DO NOTHING;

-- ── Existing items get checks where they make sense ──────────────────

-- Extinguished Lamp — relighting it is a DEX (steady-hand) check.
UPDATE entities
   SET profile = profile || jsonb_build_object(
     'check', jsonb_build_object(
       'ability', 'DEX',
       'dc', 12,
       'action', 'coax the wick back to flame',
       'on_success', 'a tiny flame catches; the booth is suddenly warmer',
       'on_failure', 'the spark fades; the wick is colder than before'
     )
   )
 WHERE id = 301;

-- ── NPC social DCs ────────────────────────────────────────────────────

-- Mikka: streetwise, sharp, but tickled by genuine charm. Easy to
-- bully on the surface (low STR, light frame), hard to actually
-- deceive (sharp INT 12).
UPDATE entities
   SET profile = profile || jsonb_build_object(
     'social_dcs', jsonb_build_object(
       'persuade',   jsonb_build_object('ability', 'CHA', 'dc', 13),
       'intimidate', jsonb_build_object('ability', 'CHA', 'dc', 11),
       'deceive',    jsonb_build_object('ability', 'CHA', 'dc', 15),
       'seduce',     jsonb_build_object('ability', 'CHA', 'dc', 14),
       'insight',    jsonb_build_object('ability', 'WIS', 'dc', 12)
     )
   )
 WHERE id = 200;
