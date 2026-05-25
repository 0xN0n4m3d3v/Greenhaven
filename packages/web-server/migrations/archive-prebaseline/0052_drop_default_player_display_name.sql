-- 0052_drop_default_player_display_name.sql
--
-- Character creation now owns player identity. Cartridge metadata must
-- not seed a localized protagonist placeholder; anonymous bootstrap
-- accounts use a technical non-canonical name until the player creates
-- the actual character profile.

DELETE FROM cartridge_meta
 WHERE key = 'default_player_display_name_i18n';
