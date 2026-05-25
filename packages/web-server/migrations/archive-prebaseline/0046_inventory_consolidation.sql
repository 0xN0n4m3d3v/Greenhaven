-- Spec follow-up — consolidate the dual inventory systems found by the audit.
--
-- Legacy system (specs 01-15):
--   inventory_entries(holder_entity_id, item_entity_id, count, metadata)
--   player_equipment(player_id, slot, item_entity_id)
--   Items live as entities[kind='item'].
--
-- New system (spec 35):
--   items(id, slug, category, weight_kg, stackable, max_stack, behaviour)
--   player_inventory(id, player_id, item_id, quantity, equipped, meta)
--
-- This migration:
--   1. Adds idempotency guards: UNIQUE on (player_id, item_id, equipped) and
--      legacy_entity_id link column on items.
--   2. Backfills items from kind='item' entities that look like INVENTORY items
--      (have 'inventory' / 'consumable' / 'currency' / 'quest_hook' tags).
--      Skips scene fixtures (Heavy Crate, Vendor's Cart) — those stay legacy.
--   3. Backfills player_inventory from inventory_entries where holder is a player.
--   4. Sets equipped=true on rows matching player_equipment.
--
-- Legacy tables stay in place (data preserved). Tools that wrote to them are
-- removed in code (src/tools/progression.ts equip_item, src/tools/inventory.ts
-- query_inventory + inventory_transfer). New tools (use_item, give_to_npc,
-- equip_inventory_item) are the only path going forward.

-- 1a. Idempotency: link items.legacy_entity_id → entities.id (nullable, UNIQUE).
ALTER TABLE items ADD COLUMN IF NOT EXISTS legacy_entity_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_legacy_entity ON items(legacy_entity_id) WHERE legacy_entity_id IS NOT NULL;

-- 1b. Idempotency: prevent duplicate (player, item, equipped) rows.
-- Drop the old anonymous-tuple UNIQUE if it exists from spec 35 (which used
-- (player_id, item_id, equipped, meta) — meta breaks idempotency since it
-- contains acquired_at-like timestamps).
-- We rebuild as (player_id, item_id) when equipped=false (stack), unique pair
-- per (player_id, item_id, true) when equipped=true (single equipped instance).
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_player_item_unequipped
  ON player_inventory(player_id, item_id) WHERE equipped = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_player_item_equipped
  ON player_inventory(player_id, item_id) WHERE equipped = true;

-- 2. Backfill items from inventory-like entities.
-- slug = lowercase, spaces → underscores, apostrophes stripped.
INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
SELECT
  LOWER(REGEXP_REPLACE(REGEXP_REPLACE(e.display_name, '''', '', 'g'), '\s+', '_', 'g')) AS slug,
  CASE
    WHEN 'currency' = ANY(e.tags)   THEN 'currency'
    WHEN 'consumable' = ANY(e.tags) THEN 'consumable'
    WHEN 'weapon' = ANY(e.tags)     THEN 'weapon'
    WHEN 'armor' = ANY(e.tags)      THEN 'armor'
    WHEN 'quest_hook' = ANY(e.tags) THEN 'quest'
    WHEN 'material' = ANY(e.tags)   THEN 'material'
    ELSE 'tool'
  END AS category,
  COALESCE((e.profile->>'weight_kg')::numeric, 0)::numeric(5,2) AS weight_kg,
  COALESCE((e.profile->>'stackable')::boolean,
           'currency' = ANY(e.tags) OR 'consumable' = ANY(e.tags)) AS stackable,
  COALESCE((e.profile->>'max_stack')::int,
           CASE WHEN 'currency' = ANY(e.tags) THEN 9999 ELSE 1 END) AS max_stack,
  COALESCE(e.profile, '{}'::jsonb) AS behaviour,
  e.id AS legacy_entity_id
FROM entities e
WHERE e.kind = 'item'
  AND (
    'inventory'  = ANY(e.tags)
    OR 'consumable' = ANY(e.tags)
    OR 'currency'   = ANY(e.tags)
    OR 'quest_hook' = ANY(e.tags)
    OR 'weapon'     = ANY(e.tags)
    OR 'armor'      = ANY(e.tags)
    OR 'material'   = ANY(e.tags)
  )
  AND NOT (
    'fixture'  = ANY(e.tags)
    OR 'obstacle' = ANY(e.tags)
  )
ON CONFLICT (slug) DO UPDATE SET legacy_entity_id = EXCLUDED.legacy_entity_id
  WHERE items.legacy_entity_id IS NULL;

-- 3. Backfill player_inventory from inventory_entries (player holders only).
-- Items that don't have a row in `items` after step 2 are skipped (fixtures).
INSERT INTO player_inventory (player_id, item_id, quantity, equipped, meta, acquired_at)
SELECT
  ie.holder_entity_id AS player_id,
  i.id AS item_id,
  ie.count AS quantity,
  EXISTS (
    SELECT 1 FROM player_equipment pe
    WHERE pe.player_id = ie.holder_entity_id
      AND pe.item_entity_id = ie.item_entity_id
  ) AS equipped,
  COALESCE(ie.metadata, '{}'::jsonb) AS meta,
  now() AS acquired_at
FROM inventory_entries ie
JOIN items i ON i.legacy_entity_id = ie.item_entity_id
JOIN players p ON p.entity_id = ie.holder_entity_id
WHERE ie.count > 0
ON CONFLICT (player_id, item_id) WHERE equipped = false DO UPDATE
  SET quantity = EXCLUDED.quantity;

-- 4. Telemetry — record what we migrated. Helps the next audit confirm.
DO $$
DECLARE
  items_count INT;
  inv_count INT;
BEGIN
  SELECT COUNT(*) INTO items_count FROM items WHERE legacy_entity_id IS NOT NULL;
  SELECT COUNT(*) INTO inv_count FROM player_inventory;
  RAISE NOTICE '[migration 0046] backfilled items: %, player_inventory rows: %', items_count, inv_count;
END $$;
