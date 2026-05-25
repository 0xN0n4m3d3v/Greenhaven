-- Spec 139: living world around the player.
-- Location visits and first-entry bubbles are deterministic and grounded in
-- cartridge data. Actor statuses are a compact player-scoped ledger for UI and
-- prompt context; they do not replace detailed runtime fields or memory.

-- Fix-forward for early 0085 Memory Palace builds that created
-- memory_clusters before about_entity_id/tags/metadata were added. Keep this
-- here because a database that already recorded 0085 will not replay it.
ALTER TABLE memory_clusters
  ADD COLUMN IF NOT EXISTS about_entity_id BIGINT NULL REFERENCES entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS player_location_visits (
  player_id BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
  location_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  visit_count INTEGER NOT NULL DEFAULT 1,
  last_intro_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (player_id, location_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_player_location_visits_last_seen
  ON player_location_visits (player_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS location_intro_bubbles (
  location_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  bubble_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seeded_from_location_i18n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_entity_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_location_intro_bubbles_lang
  ON location_intro_bubbles (lang, location_entity_id);

CREATE TABLE IF NOT EXISTS actor_statuses (
  player_id BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
  actor_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  status_kind TEXT NOT NULL,
  status_value TEXT NOT NULL,
  intensity REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'system',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, actor_entity_id, status_kind),
  CHECK (status_kind <> ''),
  CHECK (status_value <> ''),
  CHECK (intensity >= 0 AND intensity <= 1)
);

CREATE INDEX IF NOT EXISTS idx_actor_statuses_actor
  ON actor_statuses (actor_entity_id, updated_at DESC);

WITH supported_lang(lang) AS (
  VALUES
    ('en'), ('ru'), ('uk'), ('bg'), ('sr'), ('es'), ('fr'), ('de'), ('it'),
    ('pt'), ('ro'), ('he'), ('ar'), ('fa'), ('ur'), ('hi'), ('mr'), ('ne'),
    ('bn'), ('th'), ('el'), ('hy'), ('ka'), ('ko'), ('ja'), ('zh')
),
localized AS (
  SELECT
    e.id AS location_entity_id,
    l.lang,
    COALESCE(NULLIF(e.i18n->'display_name'->>l.lang, ''), e.display_name) AS name,
    COALESCE(NULLIF(e.i18n->'summary'->>l.lang, ''), e.summary, '') AS summary
  FROM entities e
  CROSS JOIN supported_lang l
  WHERE e.kind IN ('location', 'district')
)
INSERT INTO location_intro_bubbles (location_entity_id, lang, bubble_text)
SELECT
  location_entity_id,
  lang,
  CASE
    WHEN trim(summary) <> '' THEN '@' || name || ' - ' || summary
    ELSE '@' || name
  END AS bubble_text
FROM localized
WHERE trim(name) <> ''
ON CONFLICT (location_entity_id, lang) DO UPDATE SET
  bubble_text = EXCLUDED.bubble_text,
  updated_at = now();
