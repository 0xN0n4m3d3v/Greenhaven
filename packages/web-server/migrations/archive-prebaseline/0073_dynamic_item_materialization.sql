-- Spec 113 - backfill runtime item entities into the inventory catalogue.
--
-- Before this migration a dynamic `entities.kind='item'` row could exist only
-- as world prose. Inventory tools resolve through `items`, so take/give/use
-- actions failed even when the entity had been spawned. Fixtures and obstacles
-- stay entity-only holders.

ALTER TABLE items ADD COLUMN IF NOT EXISTS legacy_entity_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_legacy_entity
  ON items(legacy_entity_id) WHERE legacy_entity_id IS NOT NULL;

INSERT INTO items
  (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
SELECT
  LOWER(REGEXP_REPLACE(REGEXP_REPLACE(e.display_name, '''', '', 'g'), '\s+', '_', 'g')) AS slug,
  CASE
    WHEN 'currency' = ANY(e.tags) THEN 'currency'
    WHEN 'consumable' = ANY(e.tags) THEN 'consumable'
    WHEN 'weapon' = ANY(e.tags) THEN 'weapon'
    WHEN 'armor' = ANY(e.tags) THEN 'armor'
    WHEN 'quest' = ANY(e.tags)
      OR 'quest_hook' = ANY(e.tags)
      OR 'quest-item' = ANY(e.tags)
      OR 'quest_item' = ANY(e.tags)
      OR 'quest-reward' = ANY(e.tags)
      OR 'quest_reward' = ANY(e.tags)
      THEN 'quest'
    WHEN 'material' = ANY(e.tags) THEN 'material'
    ELSE 'tool'
  END AS category,
  CASE
    WHEN e.profile->>'weight_kg' ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (e.profile->>'weight_kg')::numeric(5,2)
    ELSE 0::numeric(5,2)
  END AS weight_kg,
  CASE
    WHEN LOWER(COALESCE(e.profile->>'stackable', '')) IN ('true', 't', '1', 'yes')
      THEN true
    WHEN LOWER(COALESCE(e.profile->>'stackable', '')) IN ('false', 'f', '0', 'no')
      THEN false
    ELSE 'currency' = ANY(e.tags)
      OR 'consumable' = ANY(e.tags)
      OR 'material' = ANY(e.tags)
  END AS stackable,
  CASE
    WHEN e.profile->>'max_stack' ~ '^[0-9]+$'
      THEN GREATEST((e.profile->>'max_stack')::int, 1)
    WHEN 'currency' = ANY(e.tags) THEN 9999
    ELSE 1
  END AS max_stack,
  COALESCE(e.profile->'behaviour', '{}'::jsonb) AS behaviour,
  e.id AS legacy_entity_id
FROM entities e
WHERE e.kind = 'item'
  AND NOT (
    'fixture' = ANY(e.tags)
    OR 'obstacle' = ANY(e.tags)
    OR 'container' = ANY(e.tags)
    OR 'scene_fixture' = ANY(e.tags)
    OR 'scenery' = ANY(e.tags)
    OR 'decorative' = ANY(e.tags)
  )
  AND LOWER(COALESCE(e.profile->>'inventory_item', 'true')) NOT IN ('false', 'f', '0', 'no')
  AND LOWER(COALESCE(e.profile->>'inventory', 'true')) NOT IN ('false', 'f', '0', 'no')
ON CONFLICT (slug)
DO UPDATE SET
  legacy_entity_id =
    CASE
      WHEN items.legacy_entity_id IS NULL THEN EXCLUDED.legacy_entity_id
      ELSE items.legacy_entity_id
    END;

WITH placements AS (
  SELECT
    e.id AS item_entity_id,
    CASE
      WHEN e.profile->>'holder_entity_id' ~ '^[0-9]+$'
        THEN (e.profile->>'holder_entity_id')::bigint
      WHEN e.profile->>'home_id' ~ '^[0-9]+$'
        THEN (e.profile->>'home_id')::bigint
      ELSE NULL
    END AS holder_entity_id,
    CASE
      WHEN e.profile->>'count' ~ '^[0-9]+$'
        THEN GREATEST((e.profile->>'count')::int, 1)
      WHEN e.profile->>'quantity' ~ '^[0-9]+$'
        THEN GREATEST((e.profile->>'quantity')::int, 1)
      ELSE 1
    END AS count
  FROM entities e
  WHERE e.kind = 'item'
    AND NOT (
      'fixture' = ANY(e.tags)
      OR 'obstacle' = ANY(e.tags)
      OR 'container' = ANY(e.tags)
      OR 'scene_fixture' = ANY(e.tags)
      OR 'scenery' = ANY(e.tags)
      OR 'decorative' = ANY(e.tags)
    )
    AND LOWER(COALESCE(e.profile->>'inventory_item', 'true')) NOT IN ('false', 'f', '0', 'no')
    AND LOWER(COALESCE(e.profile->>'inventory', 'true')) NOT IN ('false', 'f', '0', 'no')
)
INSERT INTO inventory_entries
  (holder_entity_id, item_entity_id, count, metadata)
SELECT
  p.holder_entity_id,
  p.item_entity_id,
  p.count,
  jsonb_build_object('source', 'dynamic_item_materialization_backfill')
FROM placements p
LEFT JOIN players pl ON pl.entity_id = p.holder_entity_id
WHERE p.holder_entity_id IS NOT NULL
  AND pl.entity_id IS NULL
ON CONFLICT (holder_entity_id, item_entity_id)
DO UPDATE SET
  count = GREATEST(inventory_entries.count, EXCLUDED.count),
  metadata = COALESCE(inventory_entries.metadata, '{}'::jsonb) ||
             COALESCE(EXCLUDED.metadata, '{}'::jsonb);
