-- Spec 35 — scripted intimacy rules. When the mode-classifier tags a
-- turn 'intimacy' AND a trigger_tag matches the broker's intimacy-tag
-- output, fire the field_patches + string_delta + trauma_tag.
-- Determinism floor: ensures intimate scenes leave mechanical marks
-- even when the model writes prose without explicit tool calls.

CREATE TABLE IF NOT EXISTS scripted_intimacy_rules (
  id            SERIAL PRIMARY KEY,
  trigger_tag   TEXT NOT NULL,
  field_patches JSONB NOT NULL DEFAULT '[]'::jsonb,
  string_delta  INTEGER NOT NULL DEFAULT 0,
  trauma_tag    TEXT,
  one_shot      BOOLEAN NOT NULL DEFAULT true,
  cartridge_id  INTEGER
);

INSERT INTO scripted_intimacy_rules (trigger_tag, field_patches, string_delta, trauma_tag, one_shot) VALUES
  ('first_kiss',        '[]'::jsonb, 1, NULL,         true),
  ('first_penetration', '[]'::jsonb, 1, 'first_time', true),
  ('climax',            '[]'::jsonb, 1, NULL,         false),
  ('aftercare',         '[]'::jsonb, 1, NULL,         false)
ON CONFLICT DO NOTHING;
