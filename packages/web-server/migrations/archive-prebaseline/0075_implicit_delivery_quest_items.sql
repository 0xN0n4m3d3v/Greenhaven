-- Spec 115 - materialize implicit delivery quest items.
--
-- Some social-hook adventures create a delivery quest from prose/goal text
-- without an explicit itemPlacements[] block. Those quests need the same
-- backend item state as explicit delivery placements.

WITH candidate_quests AS (
  SELECT
    q.id AS quest_id,
    (q.profile->>'giver_entity_id')::bigint AS holder_entity_id,
    CASE
      WHEN LOWER(COALESCE(q.profile->>'goal', '') || ' ' || COALESCE(q.summary, '')) LIKE '%конверт%'
        THEN 'Запечатанный конверт'
      WHEN LOWER(COALESCE(q.profile->>'goal', '') || ' ' || COALESCE(q.summary, '')) LIKE '%письм%'
        THEN 'Запечатанное письмо'
      WHEN LOWER(COALESCE(q.profile->>'goal', '') || ' ' || COALESCE(q.summary, '')) LIKE '%envelope%'
        THEN 'Sealed Envelope'
      WHEN LOWER(COALESCE(q.profile->>'goal', '') || ' ' || COALESCE(q.summary, '')) LIKE '%letter%'
        THEN 'Sealed Letter'
      WHEN LOWER(COALESCE(q.profile->>'goal', '') || ' ' || COALESCE(q.summary, '')) LIKE '%parcel%'
        THEN 'Delivery Parcel'
      WHEN LOWER(COALESCE(q.profile->>'goal', '') || ' ' || COALESCE(q.summary, '')) LIKE '%package%'
        THEN 'Delivery Package'
      ELSE 'Delivery Item'
    END AS item_name
  FROM entities q
  WHERE q.kind = 'quest'
    AND q.profile->>'giver_entity_id' ~ '^[0-9]+$'
    AND EXISTS (
      SELECT 1
        FROM player_quests pq
       WHERE pq.quest_entity_id = q.id
         AND pq.status = 'active'
    )
    AND jsonb_array_length(
      CASE
        WHEN jsonb_typeof(COALESCE(q.profile->'quest_items', '[]'::jsonb)) = 'array'
          THEN COALESCE(q.profile->'quest_items', '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) = 0
    AND (
      'delivery' = ANY(q.tags)
      OR LOWER(COALESCE(q.profile->>'goal', '') || ' ' || COALESCE(q.summary, '') || ' ' || q.profile::text)
           ~ '(deliver|delivery|courier|carry|letter|envelope|parcel|package|достав|переда|отнес|нести|письм|конверт|посылк)'
    )
),
deduped AS (
  SELECT *
    FROM candidate_quests c
   WHERE NOT EXISTS (
     SELECT 1
       FROM entities existing
      WHERE existing.kind = 'item'
        AND existing.profile->>'source_quest_id' = c.quest_id::text
   )
),
inserted_entities AS (
  INSERT INTO entities (kind, display_name, summary, profile, tags)
  SELECT
    'item',
    d.item_name,
    'A delivery quest item materialized from quest state.',
    jsonb_build_object(
      'origin', 'migration_0075',
      'holder_entity_id', d.holder_entity_id,
      'count', 1,
      'source_quest_id', d.quest_id
    ),
    ARRAY['dynamic', 'adventure', 'placed', 'delivery', 'quest-item']
  FROM deduped d
  RETURNING
    id,
    display_name,
    (profile->>'source_quest_id')::bigint AS quest_id,
    (profile->>'holder_entity_id')::bigint AS holder_entity_id
),
inserted_items AS (
  INSERT INTO items
    (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
  SELECT
    LOWER(REGEXP_REPLACE(REGEXP_REPLACE(e.display_name, '''', '', 'g'), '\s+', '_', 'g')) AS slug,
    'quest',
    0::numeric(5,2),
    false,
    1,
    '{}'::jsonb,
    e.id
  FROM inserted_entities e
  ON CONFLICT (slug)
  DO UPDATE SET
    legacy_entity_id =
      CASE
        WHEN items.legacy_entity_id IS NULL THEN EXCLUDED.legacy_entity_id
        ELSE items.legacy_entity_id
      END
  RETURNING id, slug, legacy_entity_id
),
placed_inventory AS (
  INSERT INTO inventory_entries
    (holder_entity_id, item_entity_id, count, metadata)
  SELECT
    e.holder_entity_id,
    e.id,
    1,
    jsonb_build_object('source', 'implicit_delivery_quest_item_backfill')
  FROM inserted_entities e
  LEFT JOIN players pl ON pl.entity_id = e.holder_entity_id
  WHERE pl.entity_id IS NULL
  ON CONFLICT (holder_entity_id, item_entity_id)
  DO UPDATE SET
    count = GREATEST(inventory_entries.count, EXCLUDED.count),
    metadata = COALESCE(inventory_entries.metadata, '{}'::jsonb) ||
               COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING item_entity_id
),
links AS (
  SELECT
    e.quest_id,
    jsonb_agg(
      jsonb_build_object(
        'entity_id', e.id,
        'display_name', e.display_name,
        'item_id', i.id,
        'slug', i.slug,
        'holder_entity_id', e.holder_entity_id,
        'placed_count', 1,
        'source', 'implicit_delivery_quest_item',
        'migration', '0075_implicit_delivery_quest_items'
      )
    ) AS quest_items
  FROM inserted_entities e
  LEFT JOIN inserted_items i ON i.legacy_entity_id = e.id
  GROUP BY e.quest_id
)
UPDATE entities q
   SET profile = jsonb_set(
     COALESCE(q.profile, '{}'::jsonb),
     '{quest_items}',
     CASE
       WHEN jsonb_typeof(COALESCE(q.profile->'quest_items', '[]'::jsonb)) = 'array'
         THEN COALESCE(q.profile->'quest_items', '[]'::jsonb) || links.quest_items
       ELSE links.quest_items
     END,
     true
   )
  FROM links
 WHERE q.id = links.quest_id
   AND q.kind = 'quest';

UPDATE chat_messages
   SET text = 'На мгновение мир замирает: действие не удалось обработать. Повтори намерение или выбери видимый переход.'
 WHERE text LIKE 'Ð%'
   AND text LIKE '%Ð¼Ð³Ð½%'
   AND text LIKE '%Ð´ÐµÐ¹%';
