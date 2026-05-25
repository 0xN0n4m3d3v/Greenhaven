-- Spec 37 §1 — persona-keyed bubble taxonomy.
--
-- Each entity has a persona_slug pointing into persona_archetypes.
-- The UI dispatches to one of seven bubble shapes based on the slug;
-- defaults are inferred from kind on first INSERT but the cartridge
-- author can override per entity.

CREATE TABLE IF NOT EXISTS persona_archetypes (
  slug         TEXT PRIMARY KEY,
  bubble_shape TEXT NOT NULL,
  font_family  TEXT NOT NULL,
  prose_style  TEXT NOT NULL,
  position     TEXT NOT NULL,
  decoration   JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes        TEXT
);

INSERT INTO persona_archetypes (slug, bubble_shape, font_family, prose_style, position, decoration) VALUES
  ('narrator_parchment',    'parchment',     'serif-prose',  'prose',    'centered',      '{"drop_cap":true,"max_ch":70}'::jsonb),
  ('narrator_disco_prose',  'none',          'serif-prose',  'prose',    'centered',      '{"italic":true,"max_ch":70,"voice_label":true}'::jsonb),
  ('npc_rounded_tail',      'rounded_tail',  'serif-prose',  'dialogue', 'left',          '{"avatar":true,"voice_hue_var":"--persona-hue"}'::jsonb),
  ('player_echo',           'rounded',       'sans-chrome',  'echo',     'right',         '{"avatar":false,"muted":true}'::jsonb),
  ('system_pill',           'pill',          'mono-system',  'system',   'inline-center', '{"hairline_divider":true,"small_caps":true}'::jsonb),
  ('dice_capsule',          'capsule_d20',   'mono-system',  'inline',   'inline-center', '{"d20_glyph":true,"crit_glow":true}'::jsonb),
  ('lore_torn_paper',       'torn_paper',    'serif-display','prose',    'centered',      '{"texture":"parchment","drop_cap":true}'::jsonb),
  ('message_letter',        'letter',        'serif-prose',  'prose',    'centered',      '{"wax_seal":true,"signature_line":true}'::jsonb),
  ('terminal_holo',         'holographic',   'mono-system',  'system',   'centered',      '{"scanlines":true,"rim_glow":true}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE entities ADD COLUMN IF NOT EXISTS persona_slug TEXT
  REFERENCES persona_archetypes(slug);

UPDATE entities SET persona_slug = 'npc_rounded_tail'
  WHERE kind = 'person' AND persona_slug IS NULL;
UPDATE entities SET persona_slug = 'player_echo'
  WHERE kind = 'player' AND persona_slug IS NULL;
