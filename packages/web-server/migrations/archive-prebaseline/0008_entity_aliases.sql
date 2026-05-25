-- 0008_entity_aliases.sql — store alternate names for cartridge
-- entities so the model can call them in the player's language and
-- still hit a buttonable @-mention.
--
-- Schema convention: `entities.profile.aliases` is a flat string[] of
-- alternative names the substring-scan in narrate.ts / synthesiseNarrate
-- accepts in addition to display_name. Keep them in the language(s)
-- you expect players to play in. Add more later as the cartridge
-- grows multilingual.
--
-- The scan in narrate.ts treats every alias the same as display_name:
-- if the narrate text contains `@<alias>` exactly (substring match,
-- no normalisation), the entity is resolved by id and the matched
-- string becomes the @-button label in the UI.

UPDATE entities
   SET profile = profile || jsonb_build_object('aliases', jsonb_build_array(
     'Микка Хитрогрин', 'Микка'
   ))
 WHERE id = 200;  -- Mikka Quickgrin

UPDATE entities
   SET profile = profile || jsonb_build_object('aliases', jsonb_build_array(
     'Переулок Хитрогрин', 'Куикгрин Лейн'
   ))
 WHERE id = 100;  -- Quickgrin Lane

UPDATE entities
   SET profile = profile || jsonb_build_object('aliases', jsonb_build_array(
     'Бархатные Кабинки'
   ))
 WHERE id = 101;  -- Velvet Booths

UPDATE entities
   SET profile = profile || jsonb_build_object('aliases', jsonb_build_array(
     'Золотая Монета', 'Монета'
   ))
 WHERE id = 300;  -- Gold Coin

UPDATE entities
   SET profile = profile || jsonb_build_object('aliases', jsonb_build_array(
     'Потухший Фонарь', 'Тёмный Фонарь'
   ))
 WHERE id = 301;  -- Extinguished Lamp

UPDATE entities
   SET profile = profile || jsonb_build_object('aliases', jsonb_build_array(
     E'Личная цена Микки', E'Цена Микки'
   ))
 WHERE id = 500;  -- Mikka's Private Price (quest)

UPDATE entities
   SET profile = profile || jsonb_build_object('aliases', jsonb_build_array(
     E'Частные переговоры с Миккой'
   ))
 WHERE id = 400;  -- Mikka's Private Negotiation (scene)
