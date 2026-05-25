-- Spec 32 — atmospheric runtime fields + per-NPC portrait scaffold.
--
-- Adds time_of_day / weather / world_time_minutes runtime fields on
-- the world entity (id=10, seeded by 0021_world_entity.sql). The
-- transition engine ticks world_time_minutes by ~10 per turn and
-- recomputes time_of_day. Each runtime mutation emits SSE so the UI
-- atmosphere overlay smooth-transitions.
--
-- Each kind='person' entity gets a `profile.portrait_set` with a single
-- 'default' slot pre-populated null. Cartridge author overrides per-
-- emotion URLs.

UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) ||
                 jsonb_build_object('portrait_set', jsonb_build_object('default', null))
 WHERE kind = 'person'
   AND NOT (profile ? 'portrait_set');

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
VALUES
  (10010, 10, 'time_of_day', 'string', '"dusk"'::jsonb, NULL,
    'session', false,
    'World time-of-day. Rotates: dawn → morning → noon → afternoon → dusk → night → midnight → dawn.'),
  (10011, 10, 'weather', 'string', '"clear"'::jsonb, NULL,
    'session', false,
    'World weather: clear, overcast, rain, fog, storm, smog (post-industrial signal).'),
  (10012, 10, 'world_time_minutes', 'int', '450'::jsonb, NULL,
    'session', false,
    'World time accumulator (minutes since session start). Drives time_of_day.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (10010, '"dusk"'::jsonb, 'init'),
  (10011, '"clear"'::jsonb, 'init'),
  (10012, '450'::jsonb, 'init')
ON CONFLICT (field_id) DO NOTHING;

INSERT INTO cartridge_meta (key, value, description)
VALUES (
  'atmosphere_presets',
  jsonb_build_object(
    'time_palettes', jsonb_build_object(
      'dawn',      jsonb_build_object('tint', '350 60% 70%', 'particle', 'mist'),
      'morning',   jsonb_build_object('tint', '50 70% 75%',  'particle', null),
      'noon',      jsonb_build_object('tint', '210 30% 92%', 'particle', null),
      'afternoon', jsonb_build_object('tint', '40 50% 80%',  'particle', 'dust'),
      'dusk',      jsonb_build_object('tint', '20 70% 55%',  'particle', 'embers'),
      'night',     jsonb_build_object('tint', '230 40% 35%', 'particle', null),
      'midnight',  jsonb_build_object('tint', '250 50% 18%', 'particle', null)
    ),
    'weather_palettes', jsonb_build_object(
      'clear',    jsonb_build_object('overlay', null,                  'particle', null),
      'overcast', jsonb_build_object('overlay', '220 10% 35% / 0.15', 'particle', null),
      'rain',     jsonb_build_object('overlay', '210 30% 25% / 0.25', 'particle', 'rain'),
      'fog',      jsonb_build_object('overlay', '0 0% 80% / 0.2',     'particle', 'mist'),
      'storm',    jsonb_build_object('overlay', '230 30% 18% / 0.35', 'particle', 'rain'),
      'smog',     jsonb_build_object('overlay', '30 40% 30% / 0.2',   'particle', 'smog')
    )
  ),
  'Per-cartridge atmospheric palette. UI mixes time + weather presets to compute the chat background tint and active particle layer.'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
