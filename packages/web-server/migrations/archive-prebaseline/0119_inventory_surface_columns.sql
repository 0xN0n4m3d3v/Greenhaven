-- FEAT-INV-1 — structured fields needed by the player-facing
-- Inventory surface.
--
-- Adds three idempotent columns on top of the pre-existing
-- `items` / `player_inventory` schema (migration 0038):
--   * `player_inventory.equipped_slot TEXT` — when a row is
--     `equipped = true`, this names the slot the item occupies
--     ("main_hand" / "off_hand" / "armor" / "ring1" / "ring2" /
--     "necklace" / etc.). The UI groups equipped rows by slot;
--     `NULL` means "equipped but unslotted" (the pre-SEC-9
--     `equipped = true` rows are kept that way and will be
--     classified into a generic "equipped" group by the read
--     service until the slot is set explicitly by a later
--     equip mutation pass).
--   * `items.rarity TEXT` — optional Tier-8-style rarity tag
--     ("common", "uncommon", "rare", "epic", "legendary"). The
--     read service surfaces it to the UI for the rarity badge;
--     `NULL` is treated as "common" client-side.
--   * `items.icon_key TEXT` — optional opaque icon name the UI
--     can use to pick a lucide-icon glyph. `NULL` falls back to
--     the category default (sword for weapons, shirt for armor,
--     potion bottle for consumables, etc.).
--
-- Forward-only. Existing rows keep NULL values; the inventory
-- read DTO classifies a NULL `equipped_slot` as the generic
-- "equipped" group, a NULL `rarity` as "common", and a NULL
-- `icon_key` as the category default — no data backfill required
-- for the read-model slice. Later mutation work (use / equip /
-- give / drop) will populate these columns through
-- `tools/inventoryExt.ts`.

ALTER TABLE player_inventory
  ADD COLUMN IF NOT EXISTS equipped_slot TEXT;

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS rarity TEXT;

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS icon_key TEXT;
