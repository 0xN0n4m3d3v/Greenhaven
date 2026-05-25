-- Spec 38 §5.1 — The Examiner: 10 new classes (602-611) + i18n keys.
--
-- Class taxonomy expansion. Existing 600 (Wanderer/Fighter) + 601 (Rogue)
-- stay; the Examiner LLM picks from any of {600..611}. Each new class has
-- profile JSONB matching the existing schema (hit_die, saving_throws,
-- skill_choices {from, pick}, level_1_features, stat_biases, npc_hook_*,
-- hidden_hunger).
--
-- i18n entries cover the Phase-1 conversational questions + Phase-2 panel
-- chrome. Anything not seeded here is hard-coded English in components.

-- ───────────────────────────────────────────── Classes 602–611 ─────

INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES
(602, 'class', 'Hexweaver',
 'Knot-witch who ties intent into braided thread. Magic by knot, payback by snag.',
 jsonb_build_object(
   'hit_die', 6,
   'saving_throws', jsonb_build_array('INT', 'CHA'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Arcana', 'Sleight of Hand', 'Deception', 'Insight', 'Investigation'),
     'pick', 3
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Knot-binding', 'Snag Hex'),
   'stat_biases', jsonb_build_object('INT', 2, 'CHA', 1),
   'npc_hook_en', 'Show me what you''ve been carrying. I''ll tell you who tied it for you.',
   'npc_hook_ru', 'Покажи, что носишь. Я скажу, кто это для тебя завязал.',
   'hidden_hunger', 'Cannot pass an unraveling thread without retying it.'
 ),
 ARRAY['class', 'arcane', 'int-based']::text[]),

(603, 'class', 'Brass Monk',
 'Pious bare-knuckle servant of the Brass Order. Body is the prayer.',
 jsonb_build_object(
   'hit_die', 8,
   'saving_throws', jsonb_build_array('STR', 'WIS'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Athletics', 'Religion', 'Insight', 'Intimidation', 'Medicine'),
     'pick', 3
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Unarmed Strike', 'Brass Vow'),
   'stat_biases', jsonb_build_object('STR', 1, 'WIS', 2),
   'npc_hook_en', 'Sit. Eat. Then we talk about what your hands have done.',
   'npc_hook_ru', 'Садись. Ешь. Потом поговорим, что натворили твои руки.',
   'hidden_hunger', 'Counts heartbeats during silence and cannot stop.'
 ),
 ARRAY['class', 'martial', 'wis-based']::text[]),

(604, 'class', 'Lampwright',
 'Keeper of the gas-mantle. Reads a city by its lamps and what they refuse to burn.',
 jsonb_build_object(
   'hit_die', 8,
   'saving_throws', jsonb_build_array('WIS', 'DEX'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Perception', 'Investigation', 'Arcana', 'Insight', 'Survival'),
     'pick', 3
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Lamp Sense', 'Steady Hand'),
   'stat_biases', jsonb_build_object('WIS', 2, 'DEX', 1),
   'npc_hook_en', 'You''re standing in my light. Step aside or speak.',
   'npc_hook_ru', 'Ты на моём свете стоишь. Отойди или говори.',
   'hidden_hunger', 'Compelled to relight any flame that gutters in their presence.'
 ),
 ARRAY['class', 'wis-based']::text[]),

(605, 'class', 'Wirewitch',
 'Mechanist-cum-occultist. Builds thaumic devices that whisper before they spark.',
 jsonb_build_object(
   'hit_die', 6,
   'saving_throws', jsonb_build_array('INT', 'DEX'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Investigation', 'Arcana', 'Sleight of Hand', 'History', 'Perception'),
     'pick', 3
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Sparker''s Touch', 'Read the Coil'),
   'stat_biases', jsonb_build_object('INT', 2, 'DEX', 1),
   'npc_hook_en', 'Hold this — don''t flinch. I want to see what your pulse does to it.',
   'npc_hook_ru', 'Возьми — не дёргайся. Хочу посмотреть, что твой пульс с этим делает.',
   'hidden_hunger', 'Strips broken devices for parts even when not their own.'
 ),
 ARRAY['class', 'arcane', 'int-based']::text[]),

(606, 'class', 'Charmer',
 'Lover, liar, listener. Trades in the parts of people they wish were never seen.',
 jsonb_build_object(
   'hit_die', 8,
   'saving_throws', jsonb_build_array('CHA', 'WIS'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Persuasion', 'Deception', 'Insight', 'Performance', 'Investigation'),
     'pick', 4
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Honeyed Tongue', 'Read the Want'),
   'stat_biases', jsonb_build_object('CHA', 2, 'WIS', 1),
   'npc_hook_en', 'Sit. Tell me why you came. No — let me guess.',
   'npc_hook_ru', 'Сядь. Скажи зачем пришёл. Нет — дай угадаю.',
   'hidden_hunger', 'Hears the truth in foreign-language voices.'
 ),
 ARRAY['class', 'social', 'cha-based']::text[]),

(607, 'class', 'Smuggler',
 'Lane-runner with a fist of false bottoms. Knows every ferry that doesn''t take a passenger list.',
 jsonb_build_object(
   'hit_die', 8,
   'saving_throws', jsonb_build_array('DEX', 'CON'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Stealth', 'Sleight of Hand', 'Athletics', 'Deception', 'Perception'),
     'pick', 3
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('False Bottom', 'Quiet Door'),
   'stat_biases', jsonb_build_object('DEX', 2, 'CON', 1),
   'npc_hook_en', 'Walk three paces ahead of me. Don''t look back when I cough.',
   'npc_hook_ru', 'Иди в трёх шагах впереди. Не оборачивайся, когда я кашляю.',
   'hidden_hunger', 'Counts watchmen on every street out of habit.'
 ),
 ARRAY['class', 'dex-based', 'criminal']::text[]),

(608, 'class', 'Thaumaturge',
 'Academy-trained reader of thaumic theory. Knows the why of magic; mistrusts the how.',
 jsonb_build_object(
   'hit_die', 6,
   'saving_throws', jsonb_build_array('INT', 'CON'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Arcana', 'History', 'Religion', 'Investigation', 'Insight'),
     'pick', 3
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Theoretical Casting', 'Marginalia'),
   'stat_biases', jsonb_build_object('INT', 2, 'CON', 1),
   'npc_hook_en', 'Quote me your last reading. Translate as you go.',
   'npc_hook_ru', 'Процитируй последнее, что ты читал. Переводи на ходу.',
   'hidden_hunger', 'Annotates other people''s books in pencil, returns them.'
 ),
 ARRAY['class', 'arcane', 'int-based']::text[]),

(609, 'class', 'Veteran',
 'Came back from a war the maps lie about. Slow to anger, slower to forgive.',
 jsonb_build_object(
   'hit_die', 10,
   'saving_throws', jsonb_build_array('STR', 'CON'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Athletics', 'Survival', 'Intimidation', 'Medicine', 'Perception'),
     'pick', 3
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Field Triage', 'Steady Under Fire'),
   'stat_biases', jsonb_build_object('STR', 2, 'CON', 1),
   'npc_hook_en', 'Sit by the door. We''ll talk where I can see who comes in.',
   'npc_hook_ru', 'Садись у двери. Поговорим там, где я вижу входящих.',
   'hidden_hunger', 'Counts exits in any room before they''ll order a drink.'
 ),
 ARRAY['class', 'martial', 'str-based']::text[]),

(610, 'class', 'Witness',
 'Sees the small things — the second cup, the unwritten letter, the door that opened wrong.',
 jsonb_build_object(
   'hit_die', 6,
   'saving_throws', jsonb_build_array('WIS', 'INT'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Insight', 'History', 'Investigation', 'Religion', 'Perception'),
     'pick', 4
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Eye for the Detail', 'Patient Memory'),
   'stat_biases', jsonb_build_object('WIS', 2, 'INT', 1),
   'npc_hook_en', 'I saw you come in twice today. Once now, once an hour ago. Which was real?',
   'npc_hook_ru', 'Я видела, как ты сегодня вошёл дважды. Сейчас и час назад. Что было настоящим?',
   'hidden_hunger', 'Cannot stop describing rooms in inventory order, aloud.'
 ),
 ARRAY['class', 'wis-based']::text[]),

(611, 'class', 'Lover',
 'Heart on the sleeve, knife in the boot. Reads people by what they reach for in sleep.',
 jsonb_build_object(
   'hit_die', 8,
   'saving_throws', jsonb_build_array('CHA', 'WIS'),
   'skill_choices', jsonb_build_object(
     'from', jsonb_build_array('Persuasion', 'Insight', 'Performance', 'Medicine', 'Deception'),
     'pick', 3
   ),
   'starting_equipment', jsonb_build_array(),
   'level_1_features', jsonb_build_array('Tender Knife', 'Recovery Touch'),
   'stat_biases', jsonb_build_object('CHA', 2, 'WIS', 1),
   'npc_hook_en', 'You eat alone. I''ll fix that. Sit.',
   'npc_hook_ru', 'Ты ешь один. Это поправимо. Садись.',
   'hidden_hunger', 'Buys two of every meal — one for whoever isn''t there yet.'
 ),
 ARRAY['class', 'social', 'cha-based']::text[])
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────── i18n keys + values ─────

INSERT INTO i18n_keys (key, category) VALUES
  ('examiner.opening', 'examiner'),
  ('examiner.q1.name', 'examiner'),
  ('examiner.q2.from_where', 'examiner'),
  ('examiner.q3.appearance', 'examiner'),
  ('examiner.q4.business', 'examiner'),
  ('examiner.q5.skills', 'examiner'),
  ('examiner.q6.anything_else', 'examiner'),
  ('examiner.classic_link', 'examiner'),
  ('examiner.edit_panel_title', 'examiner'),
  ('examiner.commit', 'examiner'),
  ('examiner.appearance_let_examiner', 'examiner'),
  ('examiner.continue', 'examiner'),
  ('examiner.synthesizing', 'examiner'),
  ('examiner.placeholder_short', 'examiner')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('examiner.opening', 'en', 'You take a seat next to me. Long road. Mind a few questions to pass the time?'),
  ('examiner.opening', 'ru', 'Ты садишься рядом. Дорога длинная. Не против парой вопросов скоротать время?'),
  ('examiner.q1.name', 'en', 'What''s your name? How do you want me to call you?'),
  ('examiner.q1.name', 'ru', 'Как тебя зовут? Как мне к тебе обращаться?'),
  ('examiner.q2.from_where', 'en', 'Where are you from? What were you doing before the road?'),
  ('examiner.q2.from_where', 'ru', 'Откуда едешь? Чем занимался до дороги?'),
  ('examiner.q3.appearance', 'en', 'What do you look like? Or tell me to describe you and I''ll do my best.'),
  ('examiner.q3.appearance', 'ru', 'А выглядишь как? Или скажи "придумай сам" — я постараюсь.'),
  ('examiner.q4.business', 'en', 'What''s your business in Greenhaven? Why this place, why now?'),
  ('examiner.q4.business', 'ru', 'Что у тебя за дело в Гринхейвене? Почему сейчас, почему здесь?'),
  ('examiner.q5.skills', 'en', 'What are you good with? Sword, words, locks, coin? Something else?'),
  ('examiner.q5.skills', 'ru', 'А с чем хорошо управляешься? Меч, слово, замок, кошелёк? Что-то другое?'),
  ('examiner.q6.anything_else', 'en', 'Anything else you want me to know? While we''ve got time.'),
  ('examiner.q6.anything_else', 'ru', 'Что-то ещё про себя хочешь сказать? Пока время есть.'),
  ('examiner.classic_link', 'en', 'Skip the conversation — use classic builder'),
  ('examiner.classic_link', 'ru', 'Пропустить разговор — классический редактор'),
  ('examiner.edit_panel_title', 'en', 'Review & adjust your character'),
  ('examiner.edit_panel_title', 'ru', 'Проверь и поправь героя'),
  ('examiner.appearance_let_examiner', 'en', 'You decide — describe me'),
  ('examiner.appearance_let_examiner', 'ru', 'Решай сам — опиши меня'),
  ('examiner.commit', 'en', 'Step into Greenhaven'),
  ('examiner.commit', 'ru', 'Войти в Гринхейвен'),
  ('examiner.continue', 'en', 'Continue'),
  ('examiner.continue', 'ru', 'Дальше'),
  ('examiner.synthesizing', 'en', 'Reading you…'),
  ('examiner.synthesizing', 'ru', 'Сужу о тебе…'),
  ('examiner.placeholder_short', 'en', 'Answer in your language…'),
  ('examiner.placeholder_short', 'ru', 'Отвечай на своём языке…')
ON CONFLICT (key, lang) DO NOTHING;
