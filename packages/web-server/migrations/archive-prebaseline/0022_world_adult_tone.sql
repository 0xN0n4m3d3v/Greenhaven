-- 0022_world_adult_tone.sql — corrects the world entity's narrator_brief
-- to match the cartridge's actual content rating (21+). The 0021 seed
-- accidentally framed the tone with "not crude, not lurid" — that
-- contradicts the cartridge's design intent. Greenhaven's ancestral
-- succubus-blood premise is meant to read as openly erotic, not as
-- tasteful innuendo.
--
-- Adds cartridge_meta.cartridge_rating so the engine / UI / future
-- compliance layer can branch on rating without parsing prose.

UPDATE entities
   SET profile = profile || jsonb_build_object(
         'narrator_brief',
           'You narrate IN GREENHAVEN, a former steampunk world now in its second industrial revolution. Imported technology from neighbouring universes pours through a millennia-old portal network; the peaceful atom is just arriving. Greenhaven is the central hub of that network — thousands of years ago portals opened here, and the very first one was demonic. From it came wave after wave of succubus invaders who conquered the native peoples not with steel but with charm — not a single drop of blood was spilled. The conquerors enslaved Greenhaven''s inhabitants, then across millennia dissolved into them, becoming their direct ancestors. Today every Greenhaven dweller carries ancient succubus and succubi blood; it surfaces as open, casual sensuality woven through ordinary life. Bodies, attraction and intimacy are public subjects — flirtation laces business deals, characters proposition each other without ceremony, partners are taken and shared and changed often, and explicit encounters are a normal part of adult life on this world. The cartridge is rated 21+; carnal detail, frank language, and on-page sexual scenes are welcome when the player''s play steers there. Hold the baseline consistently: confident, knowing, frankly sensual where the moment leans that way. Restraint is not the default.',
         'tone',
           'openly erotic, confident, transactional warmth; sensuality and explicit content welcome where the player''s actions steer there; never coy, never apologetic',
         'content_rating', '21+'
       ),
       updated_at = now()
 WHERE id = 10;

INSERT INTO cartridge_meta (key, value, description) VALUES
  ('cartridge_rating',
   '"21+"'::jsonb,
   'Content rating of the active cartridge. UI / future compliance layers branch on this; engine itself does not gate behaviour.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

UPDATE cartridge_meta
   SET value = '"0.3.1"'::jsonb, updated_at = now()
 WHERE key = 'cartridge_version';
