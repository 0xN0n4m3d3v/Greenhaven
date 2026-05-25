-- Cartridge data: i18n translations for Heavy Crate (302) and Vendor's Cart (303).
-- These items existed in cartridge but had no localized display_name, so the
-- UI's affordance labels and the narrator's preamble couldn't surface their
-- ru/ja names. Cartridge translations belong in the database, not in code.
--
-- jsonb_set with create_missing=true; idempotent (re-run-safe — overwrites
-- the same path with the same value).

UPDATE entities
   SET i18n = jsonb_set(
                jsonb_set(
                  COALESCE(i18n, '{}'::jsonb),
                  '{display_name,ru}', to_jsonb('Тяжёлый ящик'::text), true),
                '{display_name,ja}', to_jsonb('重い木箱'::text), true)
 WHERE id = 302;

UPDATE entities
   SET i18n = jsonb_set(
                jsonb_set(
                  COALESCE(i18n, '{}'::jsonb),
                  '{display_name,ru}', to_jsonb('Тележка торговца'::text), true),
                '{display_name,ja}', to_jsonb('商人の荷車'::text), true)
 WHERE id = 303;
