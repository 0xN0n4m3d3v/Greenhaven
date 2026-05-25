-- Spec 35 — cartridge item catalogue + per-player inventory beyond
-- the Gold Coin currency loop. Six baseline items seeded; cartridge
-- author can extend.
--
-- Note: existing inventory_entries (0001_cartridge.sql) is the
-- holder-keyed item-counts table used by Gold and the cartridge's
-- raw inventory. The new player_inventory table layers on top with
-- per-instance metadata (durability, identified flag, equipped) so
-- the broker tools can distinguish two healing-potions with different
-- enchant levels. inventory_entries stays the source-of-truth for
-- counts; player_inventory is the structured-meta lens.

CREATE TABLE IF NOT EXISTS items (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('weapon','armor','consumable','tool','quest','material','currency')),
  weight_kg   NUMERIC(5,2) NOT NULL DEFAULT 0,
  stackable   BOOLEAN NOT NULL DEFAULT false,
  max_stack   INTEGER NOT NULL DEFAULT 1,
  behaviour   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);

CREATE TABLE IF NOT EXISTS player_inventory (
  id          SERIAL PRIMARY KEY,
  player_id   BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  equipped    BOOLEAN NOT NULL DEFAULT false,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_player ON player_inventory(player_id);

INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour) VALUES
  ('oil_flask',      'tool',       0.5, true,  10, '{"applies_surface":"oil","radius":1}'::jsonb),
  ('healing_potion', 'consumable', 0.3, true,  5,  '{"effect":"heal","amount":"2d4+2"}'::jsonb),
  ('torch',          'tool',       1.0, true,  10, '{"applies_surface":"fire","radius":1,"duration_turns":10}'::jsonb),
  ('shortsword',     'weapon',     1.5, false, 1,  '{"damage_die":"1d6","damage_type":"slashing"}'::jsonb),
  ('water_skin',     'tool',       0.8, true,  3,  '{"applies_surface":"water","radius":1}'::jsonb),
  ('rope_50ft',      'tool',       2.0, false, 1,  '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;
