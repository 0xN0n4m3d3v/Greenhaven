-- Spec 114: accepted adventure delivery quests need durable links to the
-- concrete item placements they created. Older accepted rows already have the
-- item creation result in the durable adventure:accepted GUI event.

WITH accepted AS (
  SELECT
    ge.payload,
    ge.payload #>> '{questResult,quest_id}' AS quest_id_text,
    ge.payload ->> 'queueId' AS queue_id_text,
    ge.payload ->> 'adventureKind' AS adventure_kind,
    COALESCE(ge.payload -> 'spawnResults', '[]'::jsonb) AS spawn_results
  FROM gui_events ge
  WHERE ge.event_type = 'adventure:accepted'
),
spawn_links AS (
  SELECT
    accepted.quest_id_text::bigint AS quest_id,
    jsonb_build_object(
      'entity_id', (spawn ->> 'id')::bigint,
      'display_name', spawn ->> 'display_name',
      'item_id',
        CASE
          WHEN COALESCE(spawn #>> '{inventory_item,item_id}', '') ~ '^[0-9]+$'
            THEN (spawn #>> '{inventory_item,item_id}')::bigint
          ELSE NULL
        END,
      'slug', spawn #>> '{inventory_item,slug}',
      'holder_entity_id',
        CASE
          WHEN COALESCE(spawn #>> '{inventory_item,holder_entity_id}', '') ~ '^[0-9]+$'
            THEN (spawn #>> '{inventory_item,holder_entity_id}')::bigint
          ELSE NULL
        END,
      'placed_count',
        CASE
          WHEN COALESCE(spawn #>> '{inventory_item,placed_count}', '') ~ '^[0-9]+$'
            THEN (spawn #>> '{inventory_item,placed_count}')::int
          ELSE NULL
        END,
      'source', 'adventure_item_placement',
      'queue_id',
        CASE
          WHEN COALESCE(accepted.queue_id_text, '') ~ '^[0-9]+$'
            THEN accepted.queue_id_text::bigint
          ELSE NULL
        END,
      'adventure_kind', accepted.adventure_kind
    ) AS item_link
  FROM accepted
  CROSS JOIN LATERAL jsonb_array_elements(accepted.spawn_results) AS spawn
  WHERE COALESCE(accepted.quest_id_text, '') ~ '^[0-9]+$'
    AND spawn ->> 'kind' = 'item'
    AND COALESCE(spawn ->> 'id', '') ~ '^[0-9]+$'
),
grouped AS (
  SELECT quest_id, jsonb_agg(item_link ORDER BY item_link ->> 'display_name') AS quest_items
  FROM spawn_links
  GROUP BY quest_id
)
UPDATE entities e
SET profile = jsonb_set(
  COALESCE(e.profile, '{}'::jsonb),
  '{quest_items}',
  grouped.quest_items,
  true
)
FROM grouped
WHERE e.id = grouped.quest_id
  AND e.kind = 'quest'
  AND NOT (COALESCE(e.profile, '{}'::jsonb) ? 'quest_items');
