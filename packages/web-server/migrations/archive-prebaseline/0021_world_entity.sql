-- 0021_world_entity.sql — adds the WORLD entity that holds the
-- cartridge's setting / lore / tone in one canonical place.
--
-- Until now setting was scattered across location and NPC narrator_briefs.
-- That fragments worldbuilding (each scene re-improvises lore) and means
-- the model has no single source of truth for "what kind of world is this".
--
-- One entity (kind='world', id=10) carries:
--   display_name        — world name shown in HUD / chat header.
--   summary             — one-paragraph elevator pitch.
--   profile.narrator_brief — full setting text the model reads every turn.
--   profile.tech_level / genre / species_origin / recent_history / tone /
--     currency  — structured facets the model can quote consistently.
--
-- Engine integration (src/turnContext.ts): prepends ## WORLD to every
-- turn's static block so the model sees the cartridge identity before
-- anything else.
--
-- Cartridge_meta.world_entity_id points at the row so a different
-- cartridge can ship its own world entity at any id.
--
-- Russian + Japanese translations live in cartridge.ts seedCartridgeI18n
-- (PGlite-Windows misdecodes UTF-8 in SQL files as cp1251).

-- ID 10: reserved low-number range for cartridge meta-entities. Below
-- the 100+ block used for cartridge content (locations 100-199, NPCs
-- 200-299, items 300-399, quests 500+, classes 600+).

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(10, 'world', 'Greenhaven',
 'A central portal-hub world in its second industrial revolution. Steampunk machinery yields to imported tech from neighbouring universes; the peaceful atom is dawning. Every inhabitant carries ancient succubus blood — legacy of a millennia-old conquest by charm, not steel.',
 jsonb_build_object(
   'narrator_brief',
     'You narrate IN GREENHAVEN, a former steampunk world now undergoing its second industrial revolution. Imported technology from neighbouring universes pours in through a millennia-old portal network; the peaceful atom is just arriving. Greenhaven is the central hub of that network — thousands of years ago portals opened here, and the very first one was demonic. From it came wave after wave of succubus invaders who conquered the native peoples not with steel but with charm — not a single drop of blood was spilled. The conquerors enslaved Greenhaven''s inhabitants, then across millennia dissolved into them, becoming their direct ancestors. Today every Greenhaven dweller carries ancient succubus blood; it surfaces as an open, casual sensuality woven through ordinary life — warmth in business deals, easy flirtation in greetings, a charge to small daily encounters that travellers from less-touched worlds find disorienting. Hold this tone consistently: not crude, not lurid — a baseline of confident affection that is simply how this world breathes.',
   'genre', 'steampunk-to-second-industrial portal fantasy',
   'tech_level', 'second industrial revolution layered over surviving steampunk; imported tech from sister-universes; peaceful atom dawning. No firearms beyond brass-and-steam pistols. Lantern-and-gas lighting still common.',
   'magic', 'thinned by tech but real; portal-magic is the world''s defining miracle',
   'species_origin', 'humans, goblins, dwarves and others — every native lineage carries ancestral succubus blood from the original demonic conquest. Pure off-worlders sometimes pass through but stand out.',
   'recent_history', 'Thousands of years ago portals opened in Greenhaven, the central hub world. First portal was demonic. Wave after wave of succubus invaders conquered the native peoples by charm, no bloodshed. Over millennia the conquerors dissolved into the conquered, becoming their direct ancestors. Now portal-imported technology from sister-universes is driving a second industrial revolution and the peaceful atom is arriving.',
   'tone', 'sensual, transactional warmth; casual amorousness as a baseline of daily life; never crude, always confident',
   'currency', 'gold, silver, copper coins (canonical currency item 300 = gold coin)',
   'ruling_power', 'no single crown — independent merchant guilds, portal authorities, district councils'
 ),
 ARRAY['world','setting','lore','steampunk','portal-hub','succubus-ancestry'])
ON CONFLICT (id) DO NOTHING;

-- Bookkeeping pointer.
INSERT INTO cartridge_meta (key, value, description) VALUES
  ('world_entity_id',
   '10'::jsonb,
   'entity_id of the kind=world entity that holds the cartridge''s overall setting / lore / tone. turnContext.ts surfaces it as the leading ## WORLD block in every turn''s static prompt.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

UPDATE cartridge_meta
   SET value = '"0.3.0"'::jsonb, updated_at = now()
 WHERE key = 'cartridge_version';
