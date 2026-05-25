-- Spec 37 §2 + §3 + §8 — directive tag types, ambient beds, loading
-- quote pool, and time-of-day i18n keys for SceneBreak.
--
-- §2: directive_tag_types — strict enum of allowed `# tag: payload`
-- annotations the broker can emit. parser strips matching lines from
-- prose and emits the corresponding SSE event.
--
-- §3: ambient_beds — multi-stem ambient cartridge config. UI Howler
-- layer consumes via /api/audio/bed/:slug.
--
-- §8: loading_quotes — Pillars-style mid-load quote pool, weighted +
-- scene-tag-filterable. text_key references i18n_translations.

CREATE TABLE IF NOT EXISTS directive_tag_types (
  tag             TEXT PRIMARY KEY,
  sse_event       TEXT NOT NULL,
  payload_schema  JSONB NOT NULL,
  notes           TEXT
);

INSERT INTO directive_tag_types (tag, sse_event, payload_schema) VALUES
  ('portrait',  'portrait:set',     '{"mood":"string","entity_id":"number?"}'::jsonb),
  ('audio',     'audio:cue',        '{"cue":"string"}'::jsonb),
  ('banner',    'mode:changed',     '{"mode":"string","with":"string?"}'::jsonb),
  ('mood',      'atmosphere:mood',  '{"mood":"string"}'::jsonb),
  ('time',      'world:time_set',   '{"time":"string"}'::jsonb),
  ('weather',   'world:weather_set','{"weather":"string"}'::jsonb),
  ('cg',        'scene:cg',         '{"image":"string"}'::jsonb),
  ('focus',     'camera:focus',     '{"entity_id":"number"}'::jsonb)
ON CONFLICT (tag) DO NOTHING;

CREATE TABLE IF NOT EXISTS ambient_beds (
  slug          TEXT PRIMARY KEY,
  drone_url     TEXT,
  room_tone_url TEXT,
  foley_pool    JSONB NOT NULL DEFAULT '[]'::jsonb,
  sting_pool    JSONB NOT NULL DEFAULT '[]'::jsonb,
  cross_fade_ms INT NOT NULL DEFAULT 1500
);

INSERT INTO ambient_beds (slug, drone_url, room_tone_url, foley_pool, sting_pool) VALUES
  ('default_quiet', '/audio/beds/quiet_drone.mp3', '/audio/beds/quiet_room.mp3',
    '[]'::jsonb, '[]'::jsonb),
  ('combat',        '/audio/beds/combat_drone.mp3', '/audio/beds/combat_room.mp3',
    '[{"url":"/audio/foley/sword_clash_1.mp3","p":0.05}]'::jsonb,
    '[{"url":"/audio/stings/combat_sting_1.mp3","p":0.02}]'::jsonb),
  ('tavern',        '/audio/beds/tavern_drone.mp3', '/audio/beds/tavern_chatter.mp3',
    '[{"url":"/audio/foley/mug_clink.mp3","p":0.08}]'::jsonb, '[]'::jsonb),
  ('intimacy',      '/audio/beds/intimacy_drone.mp3', '/audio/beds/breath.mp3',
    '[]'::jsonb, '[]'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- Quote pool (i18n keys + translations + loading_quotes table).
INSERT INTO i18n_keys (key, category) VALUES
  ('quote.greenhaven.1','quote'),('quote.greenhaven.2','quote'),
  ('quote.greenhaven.3','quote'),('quote.greenhaven.4','quote')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('quote.greenhaven.1','en','The brass-lit dusk burns long over Greenhaven; even the shadows have stories.'),
  ('quote.greenhaven.1','ru','Латунные сумерки горят над Гринхейвеном долго; даже у теней есть истории.'),
  ('quote.greenhaven.2','en','Every coin has a smelter. Every smelter has a debt.'),
  ('quote.greenhaven.2','ru','У каждой монеты — литейщик. У каждого литейщика — долг.'),
  ('quote.greenhaven.3','en','You can leave a city. You cannot leave its taste.'),
  ('quote.greenhaven.3','ru','Город можно покинуть. Его привкус — нет.'),
  ('quote.greenhaven.4','en','The dice fall. The story is what you made of them.'),
  ('quote.greenhaven.4','ru','Кости упали. История — то, что ты из них сложил.')
ON CONFLICT (key, lang) DO NOTHING;

CREATE TABLE IF NOT EXISTS loading_quotes (
  id           SERIAL PRIMARY KEY,
  text_key     TEXT NOT NULL,
  attribution  TEXT,
  scene_tags   TEXT[] NOT NULL DEFAULT '{}',
  weight       INT NOT NULL DEFAULT 1
);

INSERT INTO loading_quotes (text_key, weight) VALUES
  ('quote.greenhaven.1', 2), ('quote.greenhaven.2', 2),
  ('quote.greenhaven.3', 1), ('quote.greenhaven.4', 1)
ON CONFLICT DO NOTHING;

-- Time-of-day + scene-day i18n (SceneBreak component reads these).
INSERT INTO i18n_keys (key, category) VALUES
  ('scene.day_label','scene'),
  ('time.dawn','time'),('time.morning','time'),('time.noon','time'),
  ('time.afternoon','time'),('time.dusk','time'),('time.night','time'),('time.midnight','time')
ON CONFLICT (key) DO NOTHING;

INSERT INTO i18n_translations (key, lang, value) VALUES
  ('scene.day_label','en','Day {day}'),('scene.day_label','ru','День {day}'),
  ('time.dawn','en','Dawn'),('time.dawn','ru','Рассвет'),
  ('time.morning','en','Morning'),('time.morning','ru','Утро'),
  ('time.noon','en','Noon'),('time.noon','ru','Полдень'),
  ('time.afternoon','en','Afternoon'),('time.afternoon','ru','День'),
  ('time.dusk','en','Dusk'),('time.dusk','ru','Сумерки'),
  ('time.night','en','Night'),('time.night','ru','Ночь'),
  ('time.midnight','en','Midnight'),('time.midnight','ru','Полночь')
ON CONFLICT (key, lang) DO NOTHING;
