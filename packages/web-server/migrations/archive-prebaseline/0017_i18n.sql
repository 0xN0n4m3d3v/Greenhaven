-- 0017_i18n.sql — multilingual cartridge text fields.
--
-- The cartridge stores entity / instruction text in a single canonical
-- string (display_name, summary, profile.*, instruction_json.text). To
-- serve players in any language without forking the cartridge per
-- locale, we add a sparse JSONB column on each row:
--
--   entities.i18n              :: { <fieldName>: { <lang>: <value> } }
--   entity_instructions.i18n   :: same shape
--
-- Convention: `fieldName` is the canonical name of the localized field
-- — 'display_name', 'summary', or a profile key like 'narrator_brief'
-- / 'speech_style'. Empty object means "no translations exist; fall
-- back to the base column".
--
-- Engine resolves via src/i18n.ts: locale → 'en' → base column. Cartridge
-- authors fill `i18n` as they translate; nothing breaks for entries
-- that stay monolingual.
--
-- players.preferred_language stores the player's chosen locale (ISO 639
-- short code: 'en', 'ru', 'ja', 'zh', …). Per-turn `language` param in
-- POST /turn overrides; this column is the persistent fallback.

ALTER TABLE entities
    ADD COLUMN IF NOT EXISTS i18n JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE entity_instructions
    ADD COLUMN IF NOT EXISTS i18n JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS preferred_language TEXT;
