-- Spec 36 §1 — mechanical-vocabulary i18n. Cartridge text already
-- localizes via entities.i18n / entity_instructions.i18n (spec 0017).
-- This layer covers the UI/mechanic labels: condition slugs, surface
-- types, trauma tags, string bands, item slugs, mode names, skills,
-- stats, and combat states.
--
-- Storage: i18n_keys is the registry; i18n_translations is the flat
-- (key, lang, value) lookup. UI dropdown switches lang; engine reads
-- 'en' as fallback when the requested lang has no row.

CREATE TABLE IF NOT EXISTS i18n_keys (
  key       TEXT PRIMARY KEY,
  category  TEXT NOT NULL,
  notes     TEXT
);

CREATE TABLE IF NOT EXISTS i18n_translations (
  key        TEXT NOT NULL REFERENCES i18n_keys(key) ON DELETE CASCADE,
  lang       TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, lang)
);
CREATE INDEX IF NOT EXISTS idx_i18n_lang ON i18n_translations(lang);

-- ---------- Conditions (spec 17) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('condition.bleeding','condition'),
  ('condition.stunned','condition'),
  ('condition.prone','condition'),
  ('condition.charmed','condition'),
  ('condition.frightened','condition'),
  ('condition.poisoned','condition'),
  ('condition.exhausted','condition'),
  ('condition.restrained','condition'),
  ('condition.off-balance','condition')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('condition.bleeding','en','Bleeding'),('condition.bleeding','ru','Кровотечение'),
  ('condition.stunned','en','Stunned'),('condition.stunned','ru','Оглушён'),
  ('condition.prone','en','Prone'),('condition.prone','ru','На земле'),
  ('condition.charmed','en','Charmed'),('condition.charmed','ru','Очарован'),
  ('condition.frightened','en','Frightened'),('condition.frightened','ru','Напуган'),
  ('condition.poisoned','en','Poisoned'),('condition.poisoned','ru','Отравлен'),
  ('condition.exhausted','en','Exhausted'),('condition.exhausted','ru','Изнурён'),
  ('condition.restrained','en','Restrained'),('condition.restrained','ru','Связан'),
  ('condition.off-balance','en','Off-balance'),('condition.off-balance','ru','Сбит с ног')
ON CONFLICT (key, lang) DO NOTHING;

-- ---------- Surfaces (spec 33 + §7 extensions) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('surface.fire','surface'),('surface.oil','surface'),('surface.water','surface'),
  ('surface.ice','surface'),('surface.electric','surface'),('surface.poison','surface'),
  ('surface.blood','surface'),('surface.smoke','surface'),
  ('surface.steam','surface'),('surface.acid','surface'),('surface.web','surface'),('surface.lava','surface')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('surface.fire','en','Fire'),('surface.fire','ru','Огонь'),
  ('surface.oil','en','Oil'),('surface.oil','ru','Масло'),
  ('surface.water','en','Water'),('surface.water','ru','Вода'),
  ('surface.ice','en','Ice'),('surface.ice','ru','Лёд'),
  ('surface.electric','en','Electrified'),('surface.electric','ru','Под током'),
  ('surface.poison','en','Poison'),('surface.poison','ru','Яд'),
  ('surface.blood','en','Blood'),('surface.blood','ru','Кровь'),
  ('surface.smoke','en','Smoke'),('surface.smoke','ru','Дым'),
  ('surface.steam','en','Steam'),('surface.steam','ru','Пар'),
  ('surface.acid','en','Acid'),('surface.acid','ru','Кислота'),
  ('surface.web','en','Web'),('surface.web','ru','Паутина'),
  ('surface.lava','en','Lava'),('surface.lava','ru','Лава')
ON CONFLICT (key, lang) DO NOTHING;

-- ---------- Trauma tags (spec 20 + 35) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('trauma.first_time','trauma'),('trauma.betrayed','trauma'),
  ('trauma.witnessed_death','trauma'),('trauma.violated','trauma'),
  ('trauma.abandoned','trauma'),('trauma.humiliated','trauma')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('trauma.first_time','en','First time'),('trauma.first_time','ru','Первый раз'),
  ('trauma.betrayed','en','Betrayed'),('trauma.betrayed','ru','Предан'),
  ('trauma.witnessed_death','en','Witnessed death'),('trauma.witnessed_death','ru','Видел смерть'),
  ('trauma.violated','en','Violated'),('trauma.violated','ru','Использован'),
  ('trauma.abandoned','en','Abandoned'),('trauma.abandoned','ru','Оставлен'),
  ('trauma.humiliated','en','Humiliated'),('trauma.humiliated','ru','Унижен')
ON CONFLICT (key, lang) DO NOTHING;

-- ---------- String bands (spec 18) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('string_band.hostile','string_band'),('string_band.wary','string_band'),
  ('string_band.neutral','string_band'),('string_band.friendly','string_band'),
  ('string_band.trusted','string_band'),('string_band.bonded','string_band')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('string_band.hostile','en','Hostile'),('string_band.hostile','ru','Враждебно'),
  ('string_band.wary','en','Wary'),('string_band.wary','ru','Настороже'),
  ('string_band.neutral','en','Neutral'),('string_band.neutral','ru','Нейтрально'),
  ('string_band.friendly','en','Friendly'),('string_band.friendly','ru','Дружелюбно'),
  ('string_band.trusted','en','Trusted'),('string_band.trusted','ru','Доверие'),
  ('string_band.bonded','en','Bonded'),('string_band.bonded','ru','Связан клятвой')
ON CONFLICT (key, lang) DO NOTHING;

-- ---------- Items (spec 35 baseline catalogue) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('item.oil_flask','item'),('item.healing_potion','item'),('item.torch','item'),
  ('item.shortsword','item'),('item.water_skin','item'),('item.rope_50ft','item')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('item.oil_flask','en','Oil flask'),('item.oil_flask','ru','Фляга масла'),
  ('item.healing_potion','en','Healing potion'),('item.healing_potion','ru','Зелье лечения'),
  ('item.torch','en','Torch'),('item.torch','ru','Факел'),
  ('item.shortsword','en','Shortsword'),('item.shortsword','ru','Короткий меч'),
  ('item.water_skin','en','Waterskin'),('item.water_skin','ru','Бурдюк с водой'),
  ('item.rope_50ft','en','Rope (50 ft)'),('item.rope_50ft','ru','Верёвка (15 м)')
ON CONFLICT (key, lang) DO NOTHING;

-- ---------- Modes (spec 32) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('mode.combat','mode'),('mode.dialogue','mode'),('mode.exploration','mode'),
  ('mode.travel','mode'),('mode.rest','mode'),('mode.intimacy','mode')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('mode.combat','en','Combat'),('mode.combat','ru','Бой'),
  ('mode.dialogue','en','Dialogue'),('mode.dialogue','ru','Разговор'),
  ('mode.exploration','en','Exploration'),('mode.exploration','ru','Исследование'),
  ('mode.travel','en','Travel'),('mode.travel','ru','Путешествие'),
  ('mode.rest','en','Rest'),('mode.rest','ru','Отдых'),
  ('mode.intimacy','en','Intimacy'),('mode.intimacy','ru','Близость')
ON CONFLICT (key, lang) DO NOTHING;

-- ---------- Skills (spec 27, all 18 D&D 5e) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('skill.acrobatics','skill'),('skill.animal_handling','skill'),('skill.arcana','skill'),
  ('skill.athletics','skill'),('skill.deception','skill'),('skill.history','skill'),
  ('skill.insight','skill'),('skill.intimidation','skill'),('skill.investigation','skill'),
  ('skill.medicine','skill'),('skill.nature','skill'),('skill.perception','skill'),
  ('skill.performance','skill'),('skill.persuasion','skill'),('skill.religion','skill'),
  ('skill.sleight_of_hand','skill'),('skill.stealth','skill'),('skill.survival','skill')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('skill.acrobatics','en','Acrobatics'),('skill.acrobatics','ru','Акробатика'),
  ('skill.animal_handling','en','Animal Handling'),('skill.animal_handling','ru','Уход за животными'),
  ('skill.arcana','en','Arcana'),('skill.arcana','ru','Магия'),
  ('skill.athletics','en','Athletics'),('skill.athletics','ru','Атлетика'),
  ('skill.deception','en','Deception'),('skill.deception','ru','Обман'),
  ('skill.history','en','History'),('skill.history','ru','История'),
  ('skill.insight','en','Insight'),('skill.insight','ru','Проницательность'),
  ('skill.intimidation','en','Intimidation'),('skill.intimidation','ru','Запугивание'),
  ('skill.investigation','en','Investigation'),('skill.investigation','ru','Расследование'),
  ('skill.medicine','en','Medicine'),('skill.medicine','ru','Медицина'),
  ('skill.nature','en','Nature'),('skill.nature','ru','Природа'),
  ('skill.perception','en','Perception'),('skill.perception','ru','Внимательность'),
  ('skill.performance','en','Performance'),('skill.performance','ru','Выступление'),
  ('skill.persuasion','en','Persuasion'),('skill.persuasion','ru','Убеждение'),
  ('skill.religion','en','Religion'),('skill.religion','ru','Религия'),
  ('skill.sleight_of_hand','en','Sleight of Hand'),('skill.sleight_of_hand','ru','Ловкость рук'),
  ('skill.stealth','en','Stealth'),('skill.stealth','ru','Скрытность'),
  ('skill.survival','en','Survival'),('skill.survival','ru','Выживание')
ON CONFLICT (key, lang) DO NOTHING;

-- ---------- Stats (spec 27) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('stat.STR','stat'),('stat.DEX','stat'),('stat.CON','stat'),
  ('stat.INT','stat'),('stat.WIS','stat'),('stat.CHA','stat')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('stat.STR','en','STR'),('stat.STR','ru','СИЛ'),
  ('stat.DEX','en','DEX'),('stat.DEX','ru','ЛОВ'),
  ('stat.CON','en','CON'),('stat.CON','ru','ТЕЛ'),
  ('stat.INT','en','INT'),('stat.INT','ru','ИНТ'),
  ('stat.WIS','en','WIS'),('stat.WIS','ru','МДР'),
  ('stat.CHA','en','CHA'),('stat.CHA','ru','ХАР')
ON CONFLICT (key, lang) DO NOTHING;

-- ---------- Combat states (spec 35) ----------
INSERT INTO i18n_keys (key, category) VALUES
  ('combat_state.active','combat_state'),
  ('combat_state.downed','combat_state'),
  ('combat_state.stable','combat_state'),
  ('combat_state.dead','combat_state')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('combat_state.active','en','Active'),('combat_state.active','ru','В строю'),
  ('combat_state.downed','en','Downed'),('combat_state.downed','ru','Без сознания'),
  ('combat_state.stable','en','Stable'),('combat_state.stable','ru','Стабилен'),
  ('combat_state.dead','en','Dead'),('combat_state.dead','ru','Мёртв')
ON CONFLICT (key, lang) DO NOTHING;
