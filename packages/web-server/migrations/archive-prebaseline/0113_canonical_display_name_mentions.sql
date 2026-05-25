-- Canonical runtime mention keys.
--
-- Historical i18n migrations translated entities.i18n.display_name. That made
-- some non-English runtime paths surface @translated names, while mention
-- parsing resolves exact canonical display_name / aliases. From this point on,
-- display_name is an Obsidian-style stable @mention key: i18n may repeat it for
-- coverage, but it must not translate it.

WITH translated_location_names AS (
  SELECT
    e.id AS location_entity_id,
    e.display_name AS canonical_name,
    translated.value AS localized_name
  FROM entities e
  CROSS JOIN LATERAL jsonb_each_text(
    CASE
      WHEN jsonb_typeof(e.i18n->'display_name') = 'object'
        THEN e.i18n->'display_name'
      ELSE '{}'::jsonb
    END
  ) AS translated(lang, value)
  WHERE e.kind IN ('location', 'district')
    AND translated.value <> e.display_name
),
rewritten_intro_bubbles AS (
  UPDATE location_intro_bubbles b
     SET bubble_text =
           '@' || n.canonical_name ||
           substring(b.bubble_text FROM char_length('@' || n.localized_name) + 1),
         source = CASE
           WHEN b.source LIKE '%canonical_mention%' THEN b.source
           ELSE b.source || '+canonical_mention'
         END,
         updated_at = now()
    FROM translated_location_names n
   WHERE b.location_entity_id = n.location_entity_id
     AND left(b.bubble_text, char_length('@' || n.localized_name)) =
         '@' || n.localized_name
  RETURNING b.location_entity_id
),
supported_lang(lang) AS (
  VALUES
    ('en'), ('ru'), ('uk'), ('bg'), ('sr'), ('es'), ('fr'), ('de'), ('it'),
    ('pt'), ('ro'), ('he'), ('ar'), ('fa'), ('ur'), ('hi'), ('mr'), ('ne'),
    ('bn'), ('th'), ('el'), ('hy'), ('ka'), ('ko'), ('ja'), ('zh')
),
canonical_display_names AS (
  SELECT
    e.id,
    jsonb_object_agg(l.lang, to_jsonb(e.display_name) ORDER BY l.lang)
      AS display_name_i18n
  FROM entities e
  CROSS JOIN supported_lang l
  WHERE trim(e.display_name) <> ''
  GROUP BY e.id
)
UPDATE entities e
   SET i18n =
         COALESCE(e.i18n, '{}'::jsonb) ||
         jsonb_build_object('display_name', c.display_name_i18n)
  FROM canonical_display_names c
 WHERE e.id = c.id;
